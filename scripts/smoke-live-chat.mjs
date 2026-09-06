import { createClient } from '@supabase/supabase-js';
import { tasks } from '@trigger.dev/sdk';

if (process.env.RUN_LIVE_SMOKE !== 'true') {
  throw new Error('Set RUN_LIVE_SMOKE=true to authorize this bounded test.');
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !publishableKey || !serviceKey || !process.env.TRIGGER_SECRET_KEY) {
  throw new Error('Live smoke configuration is incomplete.');
}

const admin = createClient(url, serviceKey, {auth:{persistSession:false,autoRefreshToken:false}});
const client = createClient(url, publishableKey, {auth:{persistSession:false,autoRefreshToken:false}});
const email = `smoke-${Date.now()}@bot-live-messenger.invalid`;
const password = `Smoke-${crypto.randomUUID()}!`;
let userId;
let runId;

try {
  const created = await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{full_name:'Smoke Test'}});
  if (created.error || !created.data.user) throw new Error('SMOKE_USER_CREATE_FAILED');
  userId = created.data.user.id;

  const signedIn = await client.auth.signInWithPassword({email,password});
  if (signedIn.error || !signedIn.data.session) throw new Error('SMOKE_SIGN_IN_FAILED');
  const seeded = await client.rpc('ensure_bots');
  if (seeded.error) throw new Error('SMOKE_SEED_FAILED');
  const bots = await client.from('bots').select('id').order('created_at').limit(1).single();
  if (bots.error || !bots.data) throw new Error('SMOKE_BOT_MISSING');

  const enabled = await admin.from('runtime_config').update({runs_enabled:true}).eq('singleton',true);
  if (enabled.error) throw new Error('SMOKE_ENABLE_FAILED');

  const queued = await client.rpc('enqueue_message',{
    p_bot_id:bots.data.id,
    p_content:'Reply with exactly: OK',
    p_idempotency_key:crypto.randomUUID(),
    p_kind:'chat',
  });
  if (queued.error || !queued.data) throw new Error(`SMOKE_QUEUE_FAILED:${queued.error?.message ?? 'missing run'}`);
  runId = queued.data;
  await tasks.trigger('bot-messenger-chat',{runId},{idempotencyKey:runId});

  const deadline = Date.now()+120_000;
  let state;
  while (Date.now()<deadline) {
    const current = await admin.from('runs').select('state').eq('id',runId).single();
    if (current.error) throw new Error('SMOKE_RUN_READ_FAILED');
    state=current.data.state;
    if (['SUCCEEDED','FAILED','CANCELLED'].includes(state)) break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const assistant = await admin.from('messages').select('content').eq('run_id',runId).eq('role','assistant').maybeSingle();
  if (state!=='SUCCEEDED' || assistant.error || !assistant.data?.content) throw new Error(`SMOKE_NOT_COMPLETED:${state ?? 'timeout'}`);
  console.log(JSON.stringify({ok:true,state,runIdPrefix:String(runId).slice(0,8),assistantLength:assistant.data.content.length}));
} finally {
  await admin.from('runtime_config').update({runs_enabled:false}).eq('singleton',true);
  if (userId) await admin.auth.admin.deleteUser(userId);
}
