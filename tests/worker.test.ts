import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
test('worker fences duplicate calls, unauthorized writes and stale completion',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;insert into auth.users values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);`);
 for(const file of ['202609060001_initial','202609060002_pilot_quotas','202609060003_team_profiles','20260906193000_chat_worker','20260906210000_live_chat_updates'])await db.exec(await readFile(new URL('../supabase/migrations/'+file+'.sql',import.meta.url),'utf8'));
 await db.exec('select public.ensure_bots();update public.runtime_config set runs_enabled=true;');
 const {rows:[r]}=await db.query<{id:string}>(`select public.enqueue_message((select id from public.bots limit 1),'hello',gen_random_uuid()) as id`);
 const {rows:[claim]}=await db.query<{value:{version:number}}>('select public.claim_chat($1) as value',[r.id]);
 assert.equal(claim.value.version,1);
 assert.equal((await db.query<{value:null}>('select public.claim_chat($1) as value',[r.id])).rows[0].value,null);
 await assert.rejects(db.query('select public.authorize_chat_call($1,1,20001)',[r.id]),/BUDGET_EXCEEDED/);
 await db.query('select public.authorize_chat_call($1,1,1000)',[r.id]);
 await assert.rejects(db.query('select public.authorize_chat_call($1,1,1000)',[r.id]),/duplicate key/);
 await db.exec('set role authenticated;');
 await assert.rejects(db.query('select public.claim_chat($1)',[r.id]),/permission denied/);
 await db.exec('reset role;');
 assert.equal((await db.query<{ok:boolean}>("select public.finish_chat($1,2,'hi','resp',10,2) as ok",[r.id])).rows[0].ok,false);
 assert.equal((await db.query<{ok:boolean}>("select public.finish_chat($1,1,'hi','resp',10,2) as ok",[r.id])).rows[0].ok,true);
 assert.equal((await db.query<{ok:boolean}>("select public.finish_chat($1,1,'hi','resp',10,2) as ok",[r.id])).rows[0].ok,false);
 assert.equal((await db.query("select * from public.messages where role='assistant'")).rows.length,1);
 assert.deepEqual((await db.query<{kind:string}>('select kind from public.run_events where run_id=$1 order by id',[r.id])).rows.map(row=>row.kind),['run_queued','run_started','run_completed']);
 }finally{await db.close();}
});
