import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_DELETION_CONFIRMATION, accountCleanupReadiness, accountDeletionInput } from '../src/domain/account-deletion';
import { AccountDeletionError, processOneAccountDeletion, requestAccountDeletion, type AccountCleanupDependencies } from '../src/server/account-deletion';

test('deletion requires exact confirmation and cleanup configuration fails closed', () => {
  assert.equal(accountDeletionInput.safeParse({ password: 'secret1', confirmation: ACCOUNT_DELETION_CONFIRMATION }).success, true);
  assert.equal(accountDeletionInput.safeParse({ password: 'secret1', confirmation: 'delete' }).success, false);
  assert.equal(accountCleanupReadiness({ NODE_ENV: 'test' }).ready, false);
  assert.equal(accountCleanupReadiness({
    NODE_ENV: 'test',
    ACCOUNT_CLEANUP_ENABLED: 'true', ACCOUNT_CLEANUP_WORKER_CONFIGURED: 'true', ACCOUNT_CLEANUP_COMPUTER_DESTROYER_CONFIGURED: 'true',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only',
    ARTIFACT_BUCKET: 'artifacts', WATCH_FRAME_BUCKET: 'frames',
  }).ready, true);
});

test('deletion reauthenticates the same user, persists, then globally signs out', async () => {
  const calls: string[] = [];
  const db = {
    auth: {
      signInWithPassword: async () => { calls.push('reauth'); return { data: { user: { id: 'user-a' } }, error: null }; },
      signOut: async ({ scope }: { scope: 'global' }) => { calls.push(`signout:${scope}`); return { error: null }; },
    },
  };
  const result = await requestAccountDeletion({
    db, currentUser: { id: 'user-a', email: 'owner@example.com' }, password: 'secret1',
    persist: async () => { calls.push('request'); return { id: crypto.randomUUID(), state: 'PENDING', requested_at: new Date().toISOString() }; },
  });
  assert.equal(result.state, 'PENDING');
  assert.deepEqual(calls, ['reauth', 'request', 'signout:global']);
});

test('account mismatch fails before the durable request', async () => {
  let requested = false;
  const db = {
    auth: {
      signInWithPassword: async () => ({ data: { user: { id: 'user-b' } }, error: null }),
      signOut: async () => ({ error: null }),
    },
  };
  await assert.rejects(requestAccountDeletion({
    db, currentUser: { id: 'user-a', email: 'owner@example.com' }, password: 'secret1',
    persist: async () => { requested = true; return null; },
  }),
    (error: unknown) => error instanceof AccountDeletionError && error.code === 'ACCOUNT_MISMATCH');
  assert.equal(requested, false);
});

function cleanupDependencies(overrides: Partial<AccountCleanupDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: AccountCleanupDependencies = {
    claim: async () => ({ request_id: 'request-a', user_id: 'user-a', claim_token: 'claim-a', artifact_paths: ['user-a/run/report.txt'], watch_paths: ['user-a/watch/0'], computer_provider_ids: ['computer-a', 'hermes-a'], artifacts_deleted: false, watch_deleted: false, computer_destroyed: false, auth_deleted: false }),
    renew: async () => { calls.push('renew'); return true; },
    recordStage: async (_token, stage) => { calls.push(`stage:${stage}`); return true; },
    removeArtifacts: async () => { calls.push('artifacts'); },
    removeWatchFrames: async () => { calls.push('frames'); },
    destroyComputer: async () => { calls.push('computer'); },
    deleteAuthUser: async () => { calls.push('auth'); },
    finish: async () => { calls.push('finish'); return true; },
    fail: async (_token, code) => { calls.push(`fail:${code}`); },
    ...overrides,
  };
  return { calls, dependencies };
}

test('cleanup removes private resources and auth before recording completion', async () => {
  const { calls, dependencies } = cleanupDependencies();
  assert.deepEqual(await processOneAccountDeletion(dependencies), { processed: true, requestId: 'request-a', state: 'COMPLETED' });
  assert.deepEqual(calls, ['renew', 'artifacts', 'stage:ARTIFACTS_DELETED', 'renew', 'frames', 'stage:WATCH_DELETED', 'renew', 'computer', 'computer', 'stage:COMPUTER_DESTROYED', 'renew', 'auth', 'stage:AUTH_DELETED', 'renew', 'finish']);
});

test('cleanup records a bounded stage code and stops after provider failure', async () => {
  const { calls, dependencies } = cleanupDependencies({ destroyComputer: async () => { throw new Error('provider detail'); } });
  assert.deepEqual(await processOneAccountDeletion(dependencies), { processed: true, requestId: 'request-a', state: 'FAILED', errorCode: 'COMPUTER_CLEANUP_FAILED' });
  assert.deepEqual(calls, ['renew', 'artifacts', 'stage:ARTIFACTS_DELETED', 'renew', 'frames', 'stage:WATCH_DELETED', 'renew', 'fail:COMPUTER_CLEANUP_FAILED']);
});

test('cleanup rejects a private object path outside the owner prefix', async () => {
  const { calls, dependencies } = cleanupDependencies({
    claim: async () => ({ request_id: 'request-a', user_id: 'user-a', claim_token: 'claim-a', artifact_paths: ['user-b/file'], watch_paths: [], computer_provider_ids: [], artifacts_deleted: false, watch_deleted: false, computer_destroyed: false, auth_deleted: false }),
  });
  const result = await processOneAccountDeletion(dependencies);
  assert.equal(result.state, 'FAILED');
  assert.deepEqual(calls, ['fail:UNKNOWN_CLEANUP_FAILURE']);
});

test('durable stage receipts skip completed external effects on retry', async () => {
  const { calls, dependencies } = cleanupDependencies({
    claim: async () => ({ request_id: 'request-a', user_id: 'user-a', claim_token: 'claim-a', artifact_paths: ['user-a/run/report.txt'], watch_paths: ['user-a/watch/0'], computer_provider_ids: ['computer-a', 'computer-a'], artifacts_deleted: true, watch_deleted: true, computer_destroyed: false, auth_deleted: false }),
  });
  assert.equal((await processOneAccountDeletion(dependencies)).state, 'COMPLETED');
  assert.deepEqual(calls, ['renew', 'computer', 'stage:COMPUTER_DESTROYED', 'renew', 'auth', 'stage:AUTH_DELETED', 'renew', 'finish']);
});
