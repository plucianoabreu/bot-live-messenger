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
  assert.deepEqual(tracker.snapshot(), {
    worker_claimed_ms: 0,
    history_loaded_ms: 120,
    memory_loaded_ms: null,
    executor_started_ms: 500,
    hermes_workspace_claimed_ms: null,
    hermes_sandbox_ready_ms: null,
    hermes_remote_started_ms: null,
    hermes_remote_completed_ms: null,
    executor_finished_ms: null,
  });
});

test('failed telemetry does not fail the conversation worker', async () => {
  const tracker = createChatLatencyTracker();
  const saved = await persistChatLatencyMeasurement({ rpc: async () => ({ error: new Error('offline') }) }, 'run-id', 1, tracker.snapshot());
  assert.equal(saved, false);
});
