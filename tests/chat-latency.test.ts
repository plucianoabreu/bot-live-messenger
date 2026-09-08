import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatLatencyTracker, persistChatLatencyMeasurement } from '../src/server/execution/chat-latency';

test('latency tracker records elapsed durations once without conversation content', () => {
  let now = 1_000;
  const tracker = createChatLatencyTracker(() => now);
  now = 1_120;
  tracker.mark('history_loaded');
  now = 1_240;
  tracker.mark('history_loaded');
  now = 1_500;
  tracker.mark('executor_started');
  now = 1_800;
  tracker.mark('direct_provider_started');
  now = 2_100;
  tracker.mark('direct_provider_completed');
  assert.deepEqual(tracker.snapshot(), {
    worker_claimed_ms: 0,
    history_loaded_ms: 120,
    memory_loaded_ms: null,
    executor_started_ms: 500,
    direct_provider_started_ms: 800,
    direct_provider_completed_ms: 1100,
    hermes_workspace_claimed_ms: null,
    hermes_provision_started_ms: null,
    hermes_resume_started_ms: null,
    hermes_sandbox_ready_ms: null,
    hermes_remote_started_ms: null,
    hermes_remote_completed_ms: null,
    executor_finished_ms: null,
    persistence_completed_ms: null,
  });
});

test('failed telemetry does not fail the conversation worker and reports only a sanitized code', async () => {
  const tracker = createChatLatencyTracker();
  const failures: string[] = [];
  const saved = await persistChatLatencyMeasurement(
    { rpc: async () => ({ data: false, error: null }) },
    'run-id',
    1,
    tracker.snapshot(),
    code => failures.push(code),
  );
  assert.equal(saved, false);
  assert.deepEqual(failures, ['rejected']);
});

test('successful telemetry persistence is silent', async () => {
  const failures: string[] = [];
  const saved = await persistChatLatencyMeasurement(
    { rpc: async () => ({ data: true, error: null }) },
    'run-id',
    1,
    createChatLatencyTracker().snapshot(),
    code => failures.push(code),
  );
  assert.equal(saved, true);
  assert.deepEqual(failures, []);
});
