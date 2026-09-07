import { handleHermesModel } from '@/server/execution/hermes-gateway';
import { workerDatabase } from '@/server/execution/database';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  if (process.env.HERMES_ENABLED !== 'true') return new Response(null, { status: 503 });
  if (!process.env.OPENAI_API_KEY?.trim()) return Response.json({ error: { code: 'OPENAI_KEY_MISSING', message: 'AI configuration unavailable' } }, { status: 503 });
  return handleHermesModel(request, {
    model: process.env.OPENAI_MODEL ?? '',
    inputRate: Number(process.env.OPENAI_INPUT_MICROS_PER_TOKEN),
    outputRate: Number(process.env.OPENAI_OUTPUT_MICROS_PER_TOKEN),
    async reserve(hash, cost) {
      const { error } = await workerDatabase().rpc('authorize_hermes_model', { p_proxy_hash: hash, p_cost: cost });
      if (error) {
        const reason = ['UNAUTHORIZED', 'LEASE_LOST', 'RUNTIME_DISABLED', 'BUDGET_EXCEEDED'].find(code => error.message === code);
        throw new Error(reason ? `HERMES_${reason}` : 'HERMES_DATABASE_ERROR');
      }
    },
    async complete(body, signal) {
      if (!process.env.OPENAI_API_KEY) throw new Error('MODEL_UNAVAILABLE');
      const result = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!result.ok) throw new Error('MODEL_FAILED');
      return result.json();
    },
  });
}
