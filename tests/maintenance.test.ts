import test from 'node:test';
import assert from 'node:assert/strict';
import { runMaintenance } from '../src/trigger/maintenance';

test('maintenance executes each bounded cleanup operation once', async () => {
  const events: string[] = [];
  const result = await runMaintenance({
    async cleanupAccount() { events.push('account'); return { processed: false }; },
    async cleanupArtifact() { events.push('artifact'); return true; },
    async cleanupWatch() { events.push('watch'); return false; },
    async recoverHermes() { events.push('hermes'); return true; },
  });

  assert.deepEqual(events, ['account', 'artifact', 'watch', 'hermes']);
  assert.deepEqual(result, {
    account: { processed: false },
    artifact: true,
    watch: false,
    hermes: true,
  });
});

test('maintenance isolates cleanup classes and reports a bounded aggregate failure', async () => {
  const events: string[] = [];
  await assert.rejects(runMaintenance({
    cleanupAccount() { events.push('account'); throw new Error('private provider diagnostic'); },
    async cleanupArtifact() { events.push('artifact'); return true; },
    async cleanupWatch() { events.push('watch'); return true; },
    async recoverHermes() { events.push('hermes'); return true; },
  }), /MAINTENANCE_PARTIAL_FAILURE/);
  assert.deepEqual(events, ['account', 'artifact', 'watch', 'hermes']);
});
