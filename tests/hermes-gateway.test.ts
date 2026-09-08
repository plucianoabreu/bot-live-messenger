import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHermesModel } from '../src/server/execution/hermes-gateway';

const token = 'a'.repeat(64);
const request = (body: unknown, key = token) => new Request('https://example.com/api/hermes/v1/chat/completions', {
  method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body),
});
const message = { messages: [{ role: 'user', content: 'hello' }] };

test('gateway reserves before completion and overrides caller model and output cap', async () => {
  const events: string[] = [];
  const response = await handleHermesModel(request({ ...message, model: 'expensive', max_completion_tokens: 99999 }), {
    model: 'configured-model', inputRate: 0.2, outputRate: 1.2,
    async reserve(hash, cost) { assert.notEqual(hash, token); assert.ok(cost > 1440); events.push('reserve'); },
    async complete(body) {
      assert.equal(body.model, 'configured-model'); assert.equal(body.max_completion_tokens, 1200);
      assert.equal(body.reasoning_effort, 'high');
      events.push('complete'); return { id: 'response' };
    },
  });
  assert.equal(response.status, 200); assert.deepEqual(events, ['reserve', 'complete']);
});

test('gateway disables reasoning when Hermes supplies function tools', async () => {
  const response = await handleHermesModel(request({
    ...message,
    tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object' } } }],
  }), {
    model: 'configured-model', inputRate: 0.2, outputRate: 1.2,
    async reserve() {},
    async complete(body) {
      assert.equal(body.reasoning_effort, 'none');
      return { id: 'response' };
    },
  });
  assert.equal(response.status, 200);
});

test('gateway never calls model after quota failure and sanitizes errors', async () => {
  const response = await handleHermesModel(request(message), {
    model: 'model', inputRate: 1, outputRate: 1,
    async reserve() { throw new Error('private provider data'); },
    async complete() { assert.fail('must not call provider'); },
  });
  assert.equal(response.status, 403); assert.ok(!(await response.text()).includes('private provider data'));
});

test('gateway preserves the bounded computer-disabled reason without calling the model', async () => {
  const response = await handleHermesModel(request(message), {
    model: 'model', inputRate: 1, outputRate: 1,
    async reserve() { throw new Error('HERMES_COMPUTER_DISABLED'); },
    async complete() { assert.fail('must not call provider'); },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'HERMES_COMPUTER_DISABLED');
});

test('gateway rejects remote images, invalid tokens and streaming before spending', async () => {
  const deps = { model: 'model', inputRate: 1, outputRate: 1,
    async reserve() { assert.fail('must not reserve'); }, async complete() { assert.fail('must not complete'); } };
  assert.equal((await handleHermesModel(request(message, 'invalid'), deps)).status, 401);
  assert.equal((await handleHermesModel(request({ ...message, stream: true }), deps)).status, 400);
  assert.equal((await handleHermesModel(request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/large.png' } }] }] }), deps)).status, 403);
});
