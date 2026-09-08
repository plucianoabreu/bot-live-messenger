import { createHash } from 'node:crypto';
import { z } from 'zod';

const input = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.null(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]).optional(),
    name: z.string().optional(), tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'),
      function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  })).min(1).max(160),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string().max(100) }).passthrough() })).max(64).optional(),
  stream: z.boolean().optional(),
}).passthrough();

export interface HermesGatewayDependencies {
  model: string;
  inputRate: number;
  outputRate: number;
  reserve(tokenHash: string, costMicros: number): Promise<void>;
  complete(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** Only this gateway holds the real model key. Reservations are never refunded on unknown outcomes. */
export async function handleHermesModel(request: Request, deps: HermesGatewayDependencies): Promise<Response> {
  let stage = 'validation';
  try {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 });
    if (!deps.model || !Number.isFinite(deps.inputRate) || deps.inputRate <= 0 || !Number.isFinite(deps.outputRate) || deps.outputRate <= 0) {
      throw new Error('PRICING_UNAVAILABLE');
    }
    const reader = request.body?.getReader();
    if (!reader) throw new Error('INVALID_REQUEST');
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 100_000) { await reader.cancel(); throw new Error('INPUT_LIMIT'); }
        parts.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const parsed = input.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
    // Streaming needs incremental accounting and cancellation; fail closed until supported.
    if (parsed.stream) return Response.json({ error: { message: 'Use stream=false' } }, { status: 400 });
    // Construct an allowlist; callers cannot choose a model, endpoint, token cap or paid hosted tools.
    // Luna's Chat Completions endpoint rejects function tools when reasoning is enabled.
    // Hermes depends on function tools, so enforce the supported combination here.
    const body = { model: deps.model, messages: parsed.messages, tools: parsed.tools,
      stream: false, max_completion_tokens: 1200, reasoning_effort: parsed.tools?.length ? 'none' : 'high' };
    const cost = Math.ceil((Buffer.byteLength(JSON.stringify(body)) + 4096) * deps.inputRate + 1200 * deps.outputRate);
    stage = 'reservation';
    await deps.reserve(createHash('sha256').update(token).digest('hex'), cost);
    stage = 'provider';
    const result = await deps.complete(body, AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]));
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const allowed = ['HERMES_UNAUTHORIZED', 'HERMES_LEASE_LOST', 'HERMES_RUNTIME_DISABLED', 'HERMES_COMPUTER_DISABLED', 'HERMES_BUDGET_EXCEEDED', 'HERMES_DATABASE_ERROR', 'WORKER_DATABASE_NOT_CONFIGURED'];
    const code = error instanceof Error && allowed.includes(error.message) ? error.message : `HERMES_${stage.toUpperCase()}_FAILED`;
    console.error('HERMES_GATEWAY_REJECTED', code);
    return Response.json({ error: { code, message: 'Execution unavailable or task limit reached' } }, { status: 403 });
  }
}
