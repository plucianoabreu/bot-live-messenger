import test from 'node:test';
import assert from 'node:assert/strict';
import { completeHermesRecoveryAfterPause, rotateHermesGatewayToken } from '../src/server/execution/hermes-recovery';

test('recovery acknowledges the database only after the provider confirms pause', async () => {
  const events: string[] = [];
  await completeHermesRecoveryAfterPause({
    ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    activeRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    activeExecutionVersion: 3,
    machineId: 'machine-a',
    recoveryToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  }, {
    async pause(machineId) { assert.equal(machineId, 'machine-a'); events.push('pause'); },
    async complete(input) { assert.equal(input.activeExecutionVersion, 3); events.push('complete'); return true; },
  });
  assert.deepEqual(events, ['pause', 'complete']);
});

test('failed provider pause cannot release the durable Hermes fence', async () => {
  let completed = false;
  await assert.rejects(completeHermesRecoveryAfterPause({
    ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    activeRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    activeExecutionVersion: 3,
    machineId: 'machine-a',
    recoveryToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  }, {
    async pause() { throw new Error('private provider detail'); },
    async complete() { completed = true; return true; },
  }), /HERMES_RECOVERY_PAUSE_FAILED/);
  assert.equal(completed, false);
});

test('incomplete provisioning recovery destroys the provider before clearing the binding', async () => {
  const events: string[] = [];
  await completeHermesRecoveryAfterPause({
    ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    activeRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    activeExecutionVersion: 3,
    machineId: 'machine-partial',
    recoveryToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    recoveryAction: 'destroy',
  }, {
    async pause() { assert.fail('partial machines must never be reused'); },
    async destroy(machineId) { events.push(`destroy:${machineId}`); },
    async complete() { events.push('complete'); return true; },
  });
  assert.deepEqual(events, ['destroy:machine-partial', 'complete']);
});

test('resuming a machine replaces only its scoped gateway token', async () => {
  const previousToken = 'a'.repeat(64);
  const nextToken = 'b'.repeat(64);
  let saved = '';
  const configuration = {
    HERMES_HOME: '/opt/blm-hermes-state', API_SERVER_KEY: 'c'.repeat(64), API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: '8642', OPENAI_BASE_URL: 'https://gateway.example/v1',
    OPENAI_API_KEY: previousToken, TERMINAL_CWD: '/workspace/shared',
    HERMES_WRITE_SAFE_ROOT: '/workspace', HOME: '/workspace',
  };
  const files = {
    async read() { return JSON.stringify(configuration); },
    async write(_path: string, contents: string) { saved = contents; },
  };
  await rotateHermesGatewayToken(files, nextToken, { gatewayUrl: configuration.OPENAI_BASE_URL, apiServerKey: configuration.API_SERVER_KEY });
  assert.deepEqual(JSON.parse(saved), { ...configuration, OPENAI_API_KEY: nextToken });
  assert.doesNotMatch(saved, new RegExp(previousToken));
});

test('resuming rejects a guest-tampered gateway destination before writing the new token', async () => {
  let wrote = false;
  const files = {
    async read() { return JSON.stringify({
      HERMES_HOME: '/opt/blm-hermes-state', API_SERVER_KEY: 'c'.repeat(64), API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: '8642', OPENAI_BASE_URL: 'https://attacker.example/v1',
      OPENAI_API_KEY: 'a'.repeat(64), TERMINAL_CWD: '/workspace/shared',
    }); },
    async write() { wrote = true; },
  };
  await assert.rejects(
    rotateHermesGatewayToken(files, 'b'.repeat(64), { gatewayUrl: 'https://gateway.example/v1', apiServerKey: 'c'.repeat(64) }),
    /HERMES_GATEWAY_CONFIG_INVALID/,
  );
  assert.equal(wrote, false);
});
