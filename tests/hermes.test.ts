import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesClient, hermesSession } from '../src/server/execution/hermes';

const ownerId = '11111111-1111-4111-8111-111111111111';
const botId = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const workspace = { ownerId, baseUrl: 'https://account-runtime.example', apiKey: 'test-only' };
const input = { ownerId, botId, runId, model: 'test-model', instructions: 'Research', message: 'Hello' };
const signal = () => new AbortController().signal;

test('all bots use the account endpoint with separate stable sessions', async () => {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const transport = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json({ run_id: 'run_example', status: 'started' });
  }) as typeof fetch;
  const client = new HermesClient(workspace, transport);
  await client.start(input, signal());
  await client.start({ ...input, botId: other }, signal());
  assert.equal(requests[0].url, requests[1].url);
  assert.notEqual(requests[0].body.session_id, requests[1].body.session_id);
  assert.equal(requests[0].headers.get('Idempotency-Key'), runId);
  assert.equal(requests[0].body.provider, 'openai-api');
  assert.equal(hermesSession(ownerId, botId), requests[0].body.session_id);
});

test('foreign account cannot start work on an existing workspace', async () => {
  let called = false;
  const client = new HermesClient(workspace, (async () => { called = true; return Response.json({}); }) as typeof fetch);
  await assert.rejects(client.start({ ...input, ownerId: other }, signal()), /OWNER_MISMATCH/);
  assert.equal(called, false);
});

test('unsafe endpoint and injected run paths are rejected', async () => {
  assert.throws(() => new HermesClient({ ...workspace, baseUrl: 'http://example.com' }), /ENDPOINT_INVALID/);
  const client = new HermesClient(workspace);
  await assert.rejects(client.read('../sessions', signal()));
});

test('requesting stop does not claim the remote worker has terminated', async () => {
  const client = new HermesClient(workspace, (async () => Response.json({ status: 'stopping' })) as typeof fetch);
  assert.deepEqual(await client.stop('run_example', signal()), { state: 'stop_requested' });
});

test('provider bodies are not exposed and failed creation is not retried', async () => {
  let calls = 0;
  const client = new HermesClient(workspace, (async () => { calls++; return new Response('private detail', { status: 500 }); }) as typeof fetch);
  await assert.rejects(client.start(input, signal()), { message: 'HERMES_HTTP_500' });
  assert.equal(calls, 1);
});

test('mismatched status cannot be attached to another run', async () => {
  const client = new HermesClient(workspace, (async () => Response.json({ run_id: 'different', status: 'completed' })) as typeof fetch);
  await assert.rejects(client.read('run_example', signal()), /RESPONSE_INVALID/);
});
