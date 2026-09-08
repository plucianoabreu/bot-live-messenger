import { z } from 'zod';

/** One trusted, provisioned Hermes server per account. Never accept this binding from a browser. */
export type HermesWorkspace = {
  ownerId: string;
  baseUrl: string;
  apiKey: string;
  trafficAccessToken: string;
};
const uuid = z.uuid();
const remoteId = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const started = z.object({ run_id: remoteId, status: z.string() });
const status = z.object({
  run_id: remoteId, session_id: z.string().optional(), status: z.string(),
  output: z.string().max(32000).optional(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).optional(),
});

export function hermesSession(ownerId: string, botId: string) {
  return `blm_${uuid.parse(ownerId)}_${uuid.parse(botId)}`;
}

/** Transport only: admission, durable run mapping and budget enforcement belong to the coordinator. */
export class HermesClient {
  private readonly origin: string;
  constructor(private readonly workspace: HermesWorkspace, private readonly transport: typeof fetch = fetch) {
    uuid.parse(workspace.ownerId);
    const url = new URL(workspace.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('HERMES_ENDPOINT_INVALID');
    }
    if (!workspace.apiKey.trim() || /[\r\n]/.test(workspace.apiKey)) throw new Error('HERMES_CREDENTIAL_INVALID');
    if (!workspace.trafficAccessToken.trim() || /[\r\n]/.test(workspace.trafficAccessToken)) {
      throw new Error('HERMES_TRAFFIC_CREDENTIAL_INVALID');
    }
    this.origin = url.origin;
  }

  private async request(path: string, signal: AbortSignal, body?: unknown, headers?: Record<string, string>) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.transport(this.origin + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: {
          Authorization: `Bearer ${this.workspace.apiKey}`,
          'E2B-Traffic-Access-Token': this.workspace.trafficAccessToken,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error('HERMES_TRANSPORT_FAILED'); }
    if (!response.ok) throw new Error(`HERMES_HTTP_${response.status}`);
    // Bound remote data before parsing and never include provider bodies in errors.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('HERMES_RESPONSE_INVALID');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 131072) { await reader.cancel(); throw new Error('HERMES_RESPONSE_LIMIT'); }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch { throw new Error('HERMES_RESPONSE_INVALID'); }
    finally { reader.releaseLock(); }
  }

  async start(input: { ownerId: string; botId: string; runId: string; instructions: string; message: string; model: string }, signal: AbortSignal) {
    if (input.ownerId !== this.workspace.ownerId) throw new Error('HERMES_OWNER_MISMATCH');
    uuid.parse(input.runId);
    const session = hermesSession(input.ownerId, input.botId);
    if (!input.model.trim() || !input.message.trim() || !input.instructions.trim() ||
        Buffer.byteLength(input.message + input.instructions) > 48000) throw new Error('HERMES_INPUT_INVALID');
    const result = await this.request('/v1/runs', signal, {
      input: input.message, instructions: input.instructions, session_id: session,
      model: input.model, provider: 'openai-api', model_options: { reasoning_effort: 'none' },
    }, { 'Idempotency-Key': input.runId, 'X-Hermes-Session-Key': session });
    const parsed = started.safeParse(result);
    if (!parsed.success) throw new Error('HERMES_RESPONSE_INVALID');
    return { runId: parsed.data.run_id, sessionId: session };
  }

  async read(runId: string, signal: AbortSignal) {
    remoteId.parse(runId);
    const parsed = status.safeParse(await this.request(`/v1/runs/${runId}`, signal));
    if (!parsed.success || parsed.data.run_id !== runId) throw new Error('HERMES_RESPONSE_INVALID');
    return parsed.data;
  }

  async stop(runId: string, signal: AbortSignal) {
    remoteId.parse(runId);
    await this.request(`/v1/runs/${runId}/stop`, signal, {});
    // Acknowledgement is not termination. Retain the workspace lease until terminal status.
    return { state: 'stop_requested' as const };
  }
}
