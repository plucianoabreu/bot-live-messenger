import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('migration enforces ownership, atomic admission, idempotency, cancellation and quota',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated; insert into auth.users values('${A}'),('${B}');`);
 await db.exec(await readFile(new URL('../supabase/migrations/202609060001_initial.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/202609060002_pilot_quotas.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/202609060003_team_profiles.sql',import.meta.url),'utf8'));
 const asUser=async(id:string)=>db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false);`);
 await asUser(A);await db.query('select public.ensure_bots()');await db.query('select public.ensure_bots()');
 let bots=await db.query<{id:string}>('select id from public.bots');assert.equal(bots.rows.length,10);const botA=bots.rows[0].id;
 await asUser(B);await db.query('select public.ensure_bots()');bots=await db.query<{id:string}>('select id from public.bots');assert.equal(bots.rows.length,10);const botB=bots.rows[0].id;
 assert.equal((await db.query('select * from public.bots where id=$1',[botA])).rows.length,0);
 await assert.rejects(()=>db.query('select * from public.computers'),/permission denied/);
 await assert.rejects(()=>db.query("select public.enqueue_message($1,'hello',$2)",[botA,crypto.randomUUID()]),/BOT_NOT_FOUND/);
 await asUser(A);const key=crypto.randomUUID();
 await assert.rejects(()=>db.query("select public.enqueue_message($1,'hello',$2)",[botA,key]),/RUNTIME_DISABLED/);
 assert.equal((await db.query('select * from public.messages')).rows.length,0);
 await db.exec('reset role; update public.runtime_config set runs_enabled=true;');await asUser(A);
 const enqueue=async(content:string,k:string)=>{const r=await db.query<{id:string}>('select public.enqueue_message($1,$2,$3) as id',[botA,content,k]);return r.rows[0].id;};
 const run=await enqueue('hello',key);assert.equal(await enqueue('hello',key),run);
 assert.equal((await db.query('select * from public.messages')).rows.length,1);
 await assert.rejects(()=>enqueue('different',key),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(()=>enqueue('new',crypto.randomUUID()),/RUN_ALREADY_OPEN/);
 await asUser(B);assert.equal((await db.query('select * from public.messages')).rows.length,0);
 await assert.rejects(()=>db.query('select public.request_cancel($1)',[run]),/RUN_NOT_FOUND/);
 await assert.rejects(()=>db.query("insert into public.messages(user_id,bot_id,run_id,role,content) values($1,$2,$3,'assistant','spoof')",[B,botB,run]),/permission denied/);
 await asUser(A);await db.query('select public.request_cancel($1)',[run]);
 assert.equal((await db.query<{state:string}>('select state from public.runs where id=$1',[run])).rows[0].state,'CANCELLED');
 for(let i=0;i<4;i++){const id=await enqueue('next',crypto.randomUUID());await db.query('select public.request_cancel($1)',[id]);}
 await assert.rejects(()=>enqueue('over quota',crypto.randomUUID()),/WELCOME_QUOTA/);
 assert.equal((await db.query('select * from public.messages')).rows.length,5);
 await assert.rejects(()=>db.query("select public.enqueue_message($1,'hello',$2,'computer')",[botA,key]),/IDEMPOTENCY_CONFLICT/);
 const computer=await db.query<{id:string}>("select public.enqueue_message($1,'computer task',$2,'computer') as id",[botA,crypto.randomUUID()]);
 await db.query('select public.request_cancel($1)',[computer.rows[0].id]);
 await assert.rejects(()=>db.query("select public.enqueue_message($1,'again',$2,'computer')",[botA,crypto.randomUUID()]),/WELCOME_QUOTA/);
 await assert.rejects(()=>db.query('select * from public.pilot_budgets'),/permission denied/);
 await db.exec('reset role;');
 assert.equal(Number((await db.query<{allocated_micros:string}>("select allocated_micros from public.pilot_budgets where kind='chat'")).rows[0].allocated_micros),100000);
 await db.exec("update public.pilot_budgets set allocated_micros=limit_micros where kind='chat';");
 await asUser(B);
 await assert.rejects(()=>db.query("select public.enqueue_message($1,'blocked',$2)",[botB,crypto.randomUUID()]),/PILOT_BUDGET_EXHAUSTED/);
 assert.equal((await db.query('select * from public.messages')).rows.length,0);
 }finally{await db.close();}
});
