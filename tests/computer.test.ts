import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComputerFoundationError,
  type Clock,
  type ComputerIdentity,
  type ComputerProvider,
} from '../src/server/computer/contracts';
import { E2BComputerAdapter, type E2BConfiguration, type E2BTransport } from '../src/server/computer/e2b-adapter';
import { normalizeExportPath, validateComputerAction, validateDestination, validateExportedFile, type WorkspacePolicy } from '../src/server/computer/policy';
import { InMemoryResourceLeaseRepository, ResourceLeaseManager, desktopResource } from '../src/server/computer/resources';
import { pauseOneIdleComputer, shouldPauseComputer } from '../src/server/computer/lifecycle';
import { assertActiveWatch, expireWatches, WatchedComputerSession } from '../src/server/computer/watch';
import { attachmentHeaders, downloadArtifact, exportArtifact, type ArtifactMetadata, type ArtifactRepository, type PrivateArtifactStore } from '../src/server/computer/artifacts';
import { FencedComputerSession } from '../src/server/computer/session';
import { verifyPrivateStorageBucket } from '../src/server/computer/storage-policy';

const noOpAuthorizer = {
  begin: async () => ({ id: crypto.randomUUID(), deadline: new Date('2026-09-06T12:00:30Z') }),
  finish: async () => {},
};

const policy: WorkspacePolicy = {
  workspaceRoot: '/workspace',
  exportRoot: '/workspace/exports',
  maxExportBytes: 1024,
  allowedHosts: new Set(['docs.example.com']),
  maxRedirects: 3,
};

function unavailableConfig(): E2BConfiguration {
  return { enabled: false, templateVerified: false, allowedHosts: [] };
}

test('E2B fails closed before any provider transport call', async () => {
  let calls = 0;
  const transport = new Proxy({}, { get: () => async () => { calls++; throw new Error('provider called'); } }) as E2BTransport;
  const adapter = new E2BComputerAdapter(unavailableConfig(), transport);
  await assert.rejects(adapter.ensure('owner-a'), (error: unknown) => error instanceof ComputerFoundationError && error.code === 'INTEGRATION_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('E2B rejects an unsafe destination before DNS or provider transport', async () => {
  let providerCalls = 0, resolverCalls = 0;
  const transport = new Proxy({}, { get: () => async () => { providerCalls++; } }) as E2BTransport;
  const config: E2BConfiguration = {
    enabled: true, apiKey: 'server-secret', templateId: 'template', templateVerified: true,
    templateVersion: 'v1', networkPolicyVersion: 'policy-v1', allowedHosts: ['docs.example.com'],
  };
  const adapter = new E2BComputerAdapter(config, transport, async () => { resolverCalls++; return ['8.8.8.8']; });
  await assert.rejects(adapter.act({ providerReference: 'private-ref', templateVersion: 'v1' }, { type: 'navigate', url: 'https://evil.example.com' }), /UNSAFE_DESTINATION/);
  assert.equal(resolverCalls, 0); assert.equal(providerCalls, 0);
});

test('storage bucket verification rejects missing and public buckets', async () => {
  const inspector = (value: { public: boolean } | null, error: unknown = null) => ({ storage: { getBucket: async () => ({ data: value, error }) } });
  await assert.rejects(verifyPrivateStorageBucket(undefined, inspector(null)), /INTEGRATION_UNAVAILABLE/);
  await assert.rejects(verifyPrivateStorageBucket('artifacts', inspector({ public: true })), /INTEGRATION_UNAVAILABLE/);
  await assert.rejects(verifyPrivateStorageBucket('artifacts', inspector(null, new Error('missing'))), /INTEGRATION_UNAVAILABLE/);
  assert.equal(await verifyPrivateStorageBucket('artifacts', inspector({ public: false })), 'artifacts');
});

test('export paths are normalized and canonical provider evidence rejects symlinks', () => {
  assert.equal(normalizeExportPath('reports/result.pdf', policy), '/workspace/exports/reports/result.pdf');
  for (const invalid of ['../secret', '/etc/passwd', 'reports\\secret', '', '.']) {
    assert.throws(() => normalizeExportPath(invalid, policy), /INVALID_PATH/);
  }
  assert.throws(() => validateExportedFile({
    canonicalPath: '/workspace/private/secret', bytes: new Uint8Array([1]), mimeType: 'text/plain', symlinkFree: false,
  }, 'result.txt', policy), /UNSAFE_PATH/);
  assert.throws(() => validateExportedFile({
    canonicalPath: '/workspace/exports/result.txt', bytes: new Uint8Array(1025), mimeType: 'text/plain', symlinkFree: true,
  }, 'result.txt', policy), /ARTIFACT_INVALID/);
});

test('destination validation checks allowlist, redirects and resolved public addresses', () => {
  assert.equal(validateDestination('https://docs.example.com/guide', ['8.8.8.8'], 1, policy).hostname, 'docs.example.com');
  for (const input of [
    () => validateDestination('http://docs.example.com', ['8.8.8.8'], 0, policy),
    () => validateDestination('https://evil.example.com', ['8.8.8.8'], 0, policy),
    () => validateDestination('https://docs.example.com', ['127.0.0.1'], 0, policy),
    () => validateDestination('https://docs.example.com', ['8.8.8.8'], 4, policy),
  ]) assert.throws(input, /UNSAFE_DESTINATION/);
  assert.deepEqual(validateComputerAction({ type: 'click', x: 10, y: 20 }), { type: 'click', x: 10, y: 20 });
  assert.throws(() => validateComputerAction({ type: 'click', x: -1, y: 20 }), /LEASE_LOST/);
  assert.throws(() => validateComputerAction({ type: 'type', text: 'x'.repeat(4001) }), /LEASE_LOST/);
  for (const blocked of ['::1', '0:0:0:0:0:0:0:1', 'FC00::1', 'fe80:0:0:0::1',
    '::ffff:127.0.0.1', '0:0:0:0:0:ffff:c0a8:101', '::ffff:8.8.8.8',
    '64:ff9b::808:808', '64:ff9b:1::808:808', '100::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:2::1', '2001:20::1',
    '2002:0808:0808::1', '2002:0a00:0001::1', '2620:4f:8000::1', '3fff::1']) {
    assert.throws(() => validateDestination('https://docs.example.com', [blocked], 0, policy), /UNSAFE_DESTINATION/);
  }
  assert.equal(validateDestination('https://docs.example.com', ['2606:4700:4700::1111'], 0, policy).hostname, 'docs.example.com');
});

test('resource leases serialize shared computer actions and fence expired holders', async () => {
  let now = new Date('2026-09-06T12:00:00Z');
  const clock: Clock = { now: () => now };
  const repository = new InMemoryResourceLeaseRepository();
  const manager = new ResourceLeaseManager(repository, clock);
  const base = { ownerId: 'owner-a', runId: 'run-a', executionVersion: 1, holderId: 'holder-a', resourceKey: desktopResource(), ttlMs: 1000 };
  const first = await manager.acquire(base);
  const renewal = await manager.acquire(base);
  assert.equal(renewal.fencingToken, first.fencingToken);
  await assert.rejects(manager.acquire({ ...base, runId: 'run-b', holderId: 'holder-b' }), /RESOURCE_BUSY/);
  now = new Date(now.getTime() + 1001);
  const second = await manager.acquire({ ...base, runId: 'run-b', holderId: 'holder-b' });
  assert.ok(second.fencingToken > first.fencingToken);
  await assert.rejects(manager.assertCurrent(first), /LEASE_LOST/);
  await manager.assertCurrent(second);
});

test('fenced session blocks stale provider actions and discards results after lease loss', async () => {
  let now = new Date('2026-09-06T12:00:00Z'); let calls = 0;
  const repository = new InMemoryResourceLeaseRepository();
  const manager = new ResourceLeaseManager(repository, { now: () => now });
  const lease = await manager.acquire({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1, holderId: 'holder-a', resourceKey: 'desktop', ttlMs: 1000 });
  const provider = { act: async () => { calls++; now = new Date(now.getTime() + 1001); } } as unknown as ComputerProvider;
  let authorizations = 0;
  const session = new FencedComputerSession(provider, { providerReference: 'private-ref', templateVersion: 'v1' }, lease, manager, {
    begin: async () => { authorizations++; return { id: 'operation-a', deadline: new Date(now.getTime() + 30_000) }; },
    finish: async () => {},
  });
  await assert.rejects(session.action({ type: 'click', x: 1, y: 2 }), /LEASE_LOST/);
  assert.equal(calls, 1); assert.equal(authorizations, 1);
  await assert.rejects(session.action({ type: 'click', x: 1, y: 2 }), /LEASE_LOST/);
  assert.equal(calls, 1); assert.equal(authorizations, 1);
});

test('provider ambiguity leaves the durable operation uncertain', async () => {
  const now = new Date('2026-09-06T12:00:00Z'); const outcomes: string[] = [];
  const repository = new InMemoryResourceLeaseRepository();
  const manager = new ResourceLeaseManager(repository, { now: () => now });
  const lease = await manager.acquire({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1, holderId: 'holder-a', resourceKey: 'desktop', ttlMs: 30_000 });
  const provider = { act: async () => { throw new Error('connection lost'); } } as unknown as ComputerProvider;
  const session = new FencedComputerSession(provider, { providerReference: 'private-ref', templateVersion: 'v1' }, lease, manager, {
    begin: async () => ({ id: 'operation-a', deadline: new Date(now.getTime() + 10_000) }),
    finish: async (_operation, outcome) => { outcomes.push(outcome); },
  });
  await assert.rejects(session.action({ type: 'click', x: 1, y: 2 }), /connection lost/);
  assert.deepEqual(outcomes, ['UNCERTAIN']);
});

test('idle lifecycle pauses only after user-wide work, resource and watch checks', async () => {
  const now = new Date('2026-09-06T12:00:20Z');
  assert.equal(shouldPauseComputer({ state: 'READY', lastUsedAt: new Date('2026-09-06T12:00:00Z'), activeComputerRuns: 0, activeResourceLeases: 0, activeWatchLeases: 0 }, now), true);
  assert.equal(shouldPauseComputer({ state: 'READY', lastUsedAt: new Date('2026-09-06T12:00:00Z'), activeComputerRuns: 1, activeResourceLeases: 0, activeWatchLeases: 0 }, now), false);
  let pauses = 0; let completed: boolean | undefined;
  const computer = { providerReference: 'private-ref', templateVersion: 'v1' };
  const provider = { pause: async () => { pauses++; } } as unknown as ComputerProvider;
  const result = await pauseOneIdleComputer({
    claimIdle: async cutoff => { assert.equal(cutoff.toISOString(), '2026-09-06T12:00:05.000Z'); return { ownerId: 'owner-a', version: 2, computer }; },
    finishPause: async (_claim, paused) => { completed = paused; },
  }, provider, { now: () => now });
  assert.equal(result, true); assert.equal(pauses, 1); assert.equal(completed, true);
});

test('watch ownership and expiry cleanup remove every temporary frame object', async () => {
  const clock: Clock = { now: () => new Date('2026-09-06T12:01:00Z') };
  const lease = { id: 'watch-a', ownerId: 'owner-a', runId: 'run-a', expiresAt: new Date('2026-09-06T12:00:59Z'), closedAt: null };
  assert.throws(() => assertActiveWatch(lease, 'owner-a', clock), /WATCH_EXPIRED/);
  assert.throws(() => assertActiveWatch({ ...lease, expiresAt: new Date('2026-09-06T12:02:00Z') }, 'owner-b', clock), /WATCH_EXPIRED/);
  const deleted: string[] = []; const finished: string[] = [];
  const count = await expireWatches({
    claimExpired: async () => [{ lease, frames: [{ objectPath: 'private/a' }, { objectPath: 'private/b' }] }],
    finishExpiry: async id => { finished.push(id); },
  }, { delete: async objectPath => { deleted.push(objectPath); } }, clock);
  assert.equal(count, 1); assert.deepEqual(deleted, ['private/a', 'private/b']); assert.deepEqual(finished, ['watch-a']);
});

test('expired watch stops capture before a provider call', async () => {
  const now = new Date('2026-09-06T12:01:00Z'); let captures = 0;
  const resourceRepository = new InMemoryResourceLeaseRepository();
  const leases = new ResourceLeaseManager(resourceRepository, { now: () => now });
  const resource = await leases.acquire({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1, holderId: 'holder-a', resourceKey: 'desktop', ttlMs: 30_000 });
  const provider = { captureFrame: async () => { captures++; return { bytes: new Uint8Array([1]), contentType: 'image/png', capturedAt: now }; } } as unknown as ComputerProvider;
  const computer = new FencedComputerSession(provider, { providerReference: 'private-ref', templateVersion: 'v1' }, resource, leases, noOpAuthorizer);
  const watch = new WatchedComputerSession({ current: async () => ({ id: 'watch-a', ownerId: 'owner-a', runId: 'run-a', expiresAt: new Date(now.getTime() - 1), closedAt: null }) }, computer, { authorize: async () => {} }, { now: () => now });
  await assert.rejects(watch.capture('owner-a', 'watch-a'), /WATCH_EXPIRED/);
  assert.equal(captures, 0);
});

test('disabling watch authorization immediately blocks provider capture', async () => {
  const now = new Date('2026-09-06T12:00:00Z'); let captures = 0; let authorizations = 0;
  const repository = new InMemoryResourceLeaseRepository();
  const leases = new ResourceLeaseManager(repository, { now: () => now });
  const resource = await leases.acquire({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1, holderId: 'holder-a', resourceKey: 'desktop', ttlMs: 30_000 });
  const provider = { captureFrame: async () => { captures++; return { bytes: new Uint8Array([1]), contentType: 'image/png', capturedAt: now }; } } as unknown as ComputerProvider;
  const computer = new FencedComputerSession(provider, { providerReference: 'private-ref', templateVersion: 'v1' }, resource, leases, noOpAuthorizer);
  const watch = new WatchedComputerSession({ current: async () => ({ id: 'watch-a', ownerId: 'owner-a', runId: 'run-a', expiresAt: new Date(now.getTime() + 60_000), closedAt: null }) }, computer,
    { authorize: async () => { authorizations++; throw new ComputerFoundationError('WATCH_EXPIRED'); } }, { now: () => now });
  await assert.rejects(watch.capture('owner-a', 'watch-a'), /WATCH_EXPIRED/);
  assert.equal(authorizations, 1);
  assert.equal(captures, 0);
});

test('artifact export verifies provider evidence before private delivery and owner-scoped download', async () => {
  const computer: ComputerIdentity = { providerReference: 'private-ref', templateVersion: 'v1' };
  const bytes = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
  const provider = { readExport: async (_computer: ComputerIdentity, requested: string) => ({
    canonicalPath: requested, bytes, mimeType: 'image/svg+xml', symlinkFree: true,
  }) } as ComputerProvider;
  const order: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const store: PrivateArtifactStore = { put: async (key, value) => { order.push('put'); objects.set(key, value); }, get: async key => objects.get(key)! };
  let row: (ArtifactMetadata & { objectPath: string }) | null = null; let intentInput: Parameters<ArtifactRepository['reserve']>[0] | null = null;
  const repository: ArtifactRepository = {
    reserve: async input => { order.push('reserve'); intentInput = input; return { id: 'intent-a' }; },
    markUploaded: async () => { order.push('uploaded'); },
    finalize: async () => { order.push('finalized'); row = { ...intentInput!, id: 'artifact-a', createdAt: new Date() }; return row; },
    reject: async () => { order.push('rejected'); },
    findOwned: async (ownerId, artifactId) => row?.ownerId === ownerId && row.id === artifactId ? row : null,
  };
  const leaseRepository = new InMemoryResourceLeaseRepository();
  const leases = new ResourceLeaseManager(leaseRepository, { now: () => new Date('2026-09-06T12:00:00Z') });
  const lease = await leases.acquire({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1, holderId: 'holder-a', resourceKey: 'file:/workspace/exports/result.svg', ttlMs: 30_000 });
  const artifact = await exportArtifact({ ownerId: 'owner-a', runId: 'run-a', finalOutputKey: 'presentation', relativePath: 'result.svg', computer, provider, lease, leases, authorizer: noOpAuthorizer, policy, store, repository });
  assert.equal(artifact.sizeBytes, bytes.byteLength);
  assert.match(artifact.checksumSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(order, ['reserve', 'put', 'uploaded', 'finalized']);
  assert.equal((await downloadArtifact('owner-a', artifact.id, repository, store)).bytes.byteLength, bytes.byteLength);
  await assert.rejects(downloadArtifact('owner-b', artifact.id, repository, store), /ARTIFACT_NOT_FOUND/);
  const headers = attachmentHeaders({ name: artifact.name, mimeType: artifact.mimeType });
  assert.match(headers['Content-Disposition'], /^attachment;/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
});

test('an ambiguous artifact upload enters durable cleanup before any announcement', async () => {
  const now = new Date('2026-09-06T12:00:00Z'); const order: string[] = [];
  const leaseRepository = new InMemoryResourceLeaseRepository();
  const leases = new ResourceLeaseManager(leaseRepository, { now: () => now });
  const lease = await leases.acquire({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1, holderId: 'holder-a', resourceKey: 'file:/workspace/exports/result.txt', ttlMs: 30_000 });
  const repository: ArtifactRepository = {
    reserve: async () => { order.push('reserve'); return { id: 'intent-a' }; },
    markUploaded: async () => { order.push('uploaded'); },
    finalize: async () => { order.push('finalized'); throw new Error('must not finalize'); },
    reject: async (_id, uploaded) => { order.push(`rejected:${uploaded}`); },
    findOwned: async () => null,
  };
  const provider = { readExport: async (_computer: ComputerIdentity, requested: string) => ({ canonicalPath: requested,
    bytes: new TextEncoder().encode('result'), mimeType: 'text/plain', symlinkFree: true }) } as ComputerProvider;
  await assert.rejects(exportArtifact({ ownerId: 'owner-a', runId: 'run-a', finalOutputKey: 'result', relativePath: 'result.txt',
    computer: { providerReference: 'private-ref', templateVersion: 'v1' }, provider, lease, leases, authorizer: noOpAuthorizer,
    policy, store: { put: async () => { order.push('put'); throw new Error('storage unavailable'); }, get: async () => new Uint8Array() }, repository }), /storage unavailable/);
  assert.deepEqual(order, ['reserve', 'put', 'rejected:true']);
});
