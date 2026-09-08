import { configure, tasks } from '@trigger.dev/sdk';
import type { prewarmTask } from '@/trigger/prewarm';
import { requireUser, sameOrigin } from '@/server/http';

if (process.env.TRIGGER_PRODUCTION_SECRET_KEY) configure({ secretKey: process.env.TRIGGER_PRODUCTION_SECRET_KEY });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem inválida.' }, { status: 403 });
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (process.env.PREWARM_ENABLED !== 'true') return new Response(null, { status: 204 });
  try { await tasks.trigger<typeof prewarmTask>('bot-messenger-prewarm', { userId: auth.user.id }, { idempotencyKey: `prewarm:${auth.user.id}` }); }
  catch { /* This is deliberately non-blocking: chat admission is authoritative. */ }
  return new Response(null, { status: 202, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
}
