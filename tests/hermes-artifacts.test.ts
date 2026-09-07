import test from 'node:test';
import assert from 'node:assert/strict';
import { exportHermesArtifact, type HermesArtifactAuthorizer, type HermesArtifactReader } from '../src/server/computer/hermes-artifacts';
import { type ArtifactMetadata, type ArtifactRepository, type PrivateArtifactStore } from '../src/server/computer/artifacts';
import type { WorkspacePolicy } from '../src/server/computer/policy';

const policy: WorkspacePolicy = {
  workspaceRoot: '/workspace',
  exportRoot: '/workspace/exports',
  maxExportBytes: 1024,
  allowedHosts: new Set(),
  maxRedirects: 0,
};

function artifactHarness() {
  const calls: string[] = [];
  let row: (ArtifactMetadata & { objectPath: string }) | null = null;
  let reserved: Parameters<ArtifactRepository['reserve']>[0] | null = null;
  const objects = new Map<string, Uint8Array>();
  const repository: ArtifactRepository = {
    reserve: async input => { calls.push('reserve'); reserved = input; return { id: 'intent-a' }; },
    markUploaded: async () => { calls.push('uploaded'); },
    finalize: async () => {
      calls.push('finalized');
      row = { ...reserved!, id: 'artifact-a', createdAt: new Date('2026-09-07T12:00:00Z') };
      return row;
    },
    reject: async (_intent, uploaded) => { calls.push(`rejected:${uploaded}`); },
    findOwned: async () => row,
  };
  const store: PrivateArtifactStore = {
    put: async (key, bytes) => { calls.push('put'); objects.set(key, bytes); },
    get: async key => objects.get(key)!,
  };
  return { calls, repository, store, reserved: () => reserved };
}

test('Hermes export reauthorizes the exact path before durable private delivery', async () => {
  const harness = artifactHarness();
  const authorizationCalls: string[] = [];
  const authorizer: HermesArtifactAuthorizer = { authorize: async input => {
    authorizationCalls.push(`${input.ownerId}:${input.runId}:${input.executionVersion}:${input.exportPath}`);
    return { machineId: 'machine-a' };
  } };
  const readerCalls: unknown[] = [];
  const bytes = new TextEncoder().encode('durable result');
  const reader: HermesArtifactReader = { readExport: async input => {
    readerCalls.push(input);
    return { canonicalPath: input.path, bytes, mimeType: 'text/plain', symlinkFree: true };
  } };
  const artifact = await exportHermesArtifact({
    ownerId: 'owner-a', runId: 'run-a', executionVersion: 3, finalOutputKey: 'final-report', relativePath: 'reports/result.txt',
    policy, authorizer, reader, store: harness.store, repository: harness.repository,
  });
  assert.equal(authorizationCalls.length, 2);
  assert.deepEqual(readerCalls, [{ machineId: 'machine-a', path: '/workspace/exports/reports/result.txt', maxBytes: 1024, noFollow: true }]);
  assert.deepEqual(harness.calls, ['reserve', 'put', 'uploaded', 'finalized']);
  assert.equal(artifact.sizeBytes, bytes.byteLength);
  assert.match(artifact.checksumSha256, /^[0-9a-f]{64}$/);
  assert.equal(harness.reserved()?.resourceKey, 'file:/workspace/exports/reports/result.txt');
  assert.equal(harness.reserved()?.fencingToken, 0);
});

test('Hermes export rejects traversal and symlink evidence before Storage upload', async () => {
  const harness = artifactHarness();
  let authorizations = 0;
  const authorizer: HermesArtifactAuthorizer = { authorize: async () => { authorizations++; return { machineId: 'machine-a' }; } };
  const reader: HermesArtifactReader = { readExport: async input => ({
    canonicalPath: '/workspace/private/secret.txt', bytes: new Uint8Array([1]), mimeType: 'text/plain', symlinkFree: false,
  }) };
  await assert.rejects(exportHermesArtifact({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1,
    finalOutputKey: 'secret', relativePath: '../secret.txt', policy, authorizer, reader,
    store: harness.store, repository: harness.repository }), /INVALID_PATH/);
  assert.equal(authorizations, 0);
  await assert.rejects(exportHermesArtifact({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1,
    finalOutputKey: 'secret', relativePath: 'secret.txt', policy, authorizer, reader,
    store: harness.store, repository: harness.repository }), /UNSAFE_PATH/);
  assert.equal(authorizations, 2);
  assert.deepEqual(harness.calls, []);
});

test('Hermes export discards bytes when the workspace changes during the read', async () => {
  const harness = artifactHarness();
  let call = 0;
  const authorizer: HermesArtifactAuthorizer = { authorize: async () => ({ machineId: ++call === 1 ? 'machine-a' : 'machine-b' }) };
  const reader: HermesArtifactReader = { readExport: async input => ({
    canonicalPath: input.path, bytes: new Uint8Array([1]), mimeType: 'text/plain', symlinkFree: true,
  }) };
  await assert.rejects(exportHermesArtifact({ ownerId: 'owner-a', runId: 'run-a', executionVersion: 1,
    finalOutputKey: 'result', relativePath: 'result.txt', policy, authorizer, reader,
    store: harness.store, repository: harness.repository }), /LEASE_LOST/);
  assert.deepEqual(harness.calls, []);
});
