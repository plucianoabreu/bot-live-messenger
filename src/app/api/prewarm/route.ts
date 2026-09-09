import { configure, tasks } from '@trigger.dev/sdk';
import type { prewarmTask } from '@/trigger/prewarm';
import { boundedJson, requireUser, sameOrigin } from '@/server/http';
import { isHermesTestUserAllowed } from '@/server/execution/hermes-test-scope';
import { z } from 'zod';

if (process.env.TRIGGER_PRODUCTION_SECRET_KEY) configure({ secretKey: process.env.TRIGGER_PRODUCTION_SECRET_KEY });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem inválida.' }, { status: 403 });
  const auth = await requireUser();
  if (auth.response) return auth.response;
  if (!isHermesTestUserAllowed(process.env, auth.user.id)) return new Response(null, { status: 204 });
  if (process.env.PREWARM_ENABLED !== 'true') return new Response(null, { status: 204 });
  let botId:string;try{botId=z.object({botId:z.uuid()}).parse(await boundedJson(request,512)).botId;}catch{return new Response(null,{status:400});}
  const owned=await auth.db.from('bots').select('id').eq('id',botId).eq('user_id',auth.user.id).eq('enabled',true).maybeSingle();
  if(owned.error||!owned.data)return new Response(null,{status:404});
  try { await tasks.trigger<typeof prewarmTask>('bot-messenger-prewarm', { userId: auth.user.id }, { idempotencyKey: `prewarm:${auth.user.id}:${Math.floor(Date.now()/600000)}` }); }
  catch { /* This is deliberately non-blocking: chat admission is authoritative. */ }
  return new Response(null, { status: 202, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
}
