import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

test('client latency checkpoints are bounded and owner-scoped',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;insert into auth.users values('${A}'),('${B}');`);
  for(const file of ['202609060001_initial','202609060002_pilot_quotas','202609060003_team_profiles','20260906193000_chat_worker','20260906210000_live_chat_updates','20260908020000_chat_latency_observability'])await db.exec(await readFile(new URL(`../supabase/migrations/${file}.sql`,import.meta.url),'utf8'));
  await db.exec(`select set_config('request.jwt.claim.sub','${A}',false);select public.ensure_bots();update public.runtime_config set runs_enabled=true;`);
  const run=(await db.query<{id:string}>("select public.enqueue_message((select id from public.bots where user_id=$1 limit 1),'hello',gen_random_uuid()) as id",[A])).rows[0].id;
  await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${A}',false);`);
  assert.equal((await db.query<{ok:boolean}>('select public.record_chat_latency_client_measurement($1,\'browser_admission_received\',12) as ok',[run])).rows[0].ok,true);
  await db.exec(`select set_config('request.jwt.claim.sub','${B}',false);`);
  assert.equal((await db.query<{ok:boolean}>('select public.record_chat_latency_client_measurement($1,\'browser_answer_dom_ready\',20) as ok',[run])).rows[0].ok,false);
  await assert.rejects(()=>db.query('select * from public.chat_latency_client_measurements'),/permission denied/);
  await db.exec('reset role;set role service_role;');
  const row=(await db.query<{browser_admission_received_ms:number;browser_answer_dom_ready_ms:null}>('select browser_admission_received_ms,browser_answer_dom_ready_ms from public.chat_latency_client_measurements where run_id=$1',[run])).rows[0];
  assert.deepEqual(row,{browser_admission_received_ms:12,browser_answer_dom_ready_ms:null});
 }finally{await db.close();}
});
