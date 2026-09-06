import test from 'node:test';
import assert from 'node:assert/strict';
import { executeChat } from '../src/server/execution/chat';

function fixture() {
  let calls = 0;
  const controller = new AbortController();
  const options = { model: 'test-model', instructions: 'Help with research.',
    history: [{ role: 'user' as const, content: 'Olá' }], signal: controller.signal,
    authorize: async () => {}, provider: async () => {
      calls++;
      return { id: 'response-test', status: 'completed', output_text: 'Olá!', usage: { input_tokens: 20, output_tokens: 3 } };
    } };
  return { options, controller, calls: () => calls };
}
test('budget denial prevents a provider call', async () => {
  const f = fixture();
  f.options.authorize = async () => { throw new Error('BUDGET_EXCEEDED'); };
  await assert.rejects(executeChat(f.options), /BUDGET_EXCEEDED/);
  assert.equal(f.calls(), 0);
});
test('cancellation during authorization prevents a provider call', async () => {
  const f = fixture();
  f.options.authorize = async () => { f.controller.abort(); };
  await assert.rejects(executeChat(f.options));
  assert.equal(f.calls(), 0);
});
test('oversized history fails before spending', async () => {
  const f = fixture(); f.options.history[0].content = 'á'.repeat(48000);
  await assert.rejects(executeChat(f.options), /CONTEXT_LIMIT/);
  assert.equal(f.calls(), 0);
});
test('successful response retains usage and provider identity', async () => {
  const f = fixture(); const result = await executeChat(f.options);
  assert.equal(result.text, 'Olá!'); assert.equal(result.usage.output_tokens, 3);
  assert.equal(result.providerResponseId, 'response-test'); assert.equal(f.calls(), 1);
});
test('provider failure is not retried', async () => {
  const f = fixture(); let attempts = 0;
  f.options.provider = async () => { attempts++; throw new Error('network'); };
  await assert.rejects(executeChat(f.options), /network/); assert.equal(attempts, 1);
});
