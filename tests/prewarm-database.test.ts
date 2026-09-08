import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function databaseWithAllMigrations() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    insert into auth.users values('${OWNER}');
    select set_config('request.jwt.claim.sub','${OWNER}',false);`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const migration of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(migration, directory), 'utf8'));
  }
  return db;
}


async function enable(db:PGlite){await db.exec('select public.ensure_bots(); update public.runtime_config set runs_enabled=true,computer_enabled=true,prewarm_enabled=true;');}
async function claim(db:PGlite){return (await db.query<{v:{status:string;lease_token:string}}>('select public.claim_hermes_prewarm($1) v',[OWNER])).rows[0].v;}
async function ready(db:PGlite,id:string){await db.query('select public.bind_prewarm($1,$2)',[id,'machine']);await db.query('select public.complete_hermes_prewarm($1,$2,$3)',[OWNER,id,'machine']);}
async function run(db:PGlite){const r=(await db.query<{id:string}>("select public.enqueue_message((select id from public.bots limit 1),'hello',gen_random_uuid()) id")).rows[0].id;await db.query('select public.claim_chat($1)',[r]);return r;}

test('first account reserves before create; duplicates and depleted budgets cannot allocate twice',async()=>{
 const db=await databaseWithAllMigrations();try{
 await enable(db);const a=await claim(db);assert.equal(a.status,'preparing');
 await db.exec('update public.runtime_config set prewarm_enabled=false');
 assert.equal((await db.query<{v:boolean}>('select public.begin_prewarm_provider($1) v',[a.lease_token])).rows[0].v,false);
 await db.exec('update public.runtime_config set prewarm_enabled=true');
 assert.equal((await db.query<{v:boolean}>('select public.begin_prewarm_provider($1) v',[a.lease_token])).rows[0].v,true);
 assert.equal((await db.query<{v:boolean}>('select public.begin_prewarm_provider($1) v',[a.lease_token])).rows[0].v,false);
 assert.equal((await claim(db)).status,'busy');
 assert.equal((await db.query('select id from public.runs')).rows.length,0);
 assert.equal(Number((await db.query<{allocated_micros:number}>("select allocated_micros from public.pilot_budgets where kind='computer'")).rows[0].allocated_micros),250000);
 await db.exec("update public.prewarm_intents set state='DONE',settled_at=now(),created_at=now()-interval '1 day';update public.pilot_budgets set allocated_micros=limit_micros where kind='computer'");
 await assert.rejects(claim(db),/COMPUTER_BUDGET_EXHAUSTED/);
 assert.equal((await db.query('select id from public.prewarm_intents')).rows.length,1);
 }finally{await db.close();}
});

test('first send cannot steal preparation; ready handoff settles once and excludes stale cleanup',async()=>{
 const db=await databaseWithAllMigrations();try{
 await enable(db);const a=await claim(db),r=await run(db);
 await assert.rejects(db.query('select public.claim_hermes_workspace($1,1,$2)',[r,'a'.repeat(64)]),/PREWARM_PENDING/);
 await ready(db,a.lease_token);
 await db.query('select public.claim_hermes_workspace($1,1,$2)',[r,'a'.repeat(64)]);
 assert.equal((await db.query<{state:string}>('select state from public.prewarm_intents')).rows[0].state,'HANDED_OFF');
 assert.equal((await db.query<{v:unknown}>('select public.claim_prewarm_cleanup($1) v',[a.lease_token])).rows[0].v,null);
 assert.equal((await db.query('select run_id from public.account_pilot_reservations where reservation_kind=\'hermes\'')).rows.length,1);
 }finally{await db.close();}
});

test('expiry cleanup fences first send; failed pause retains intent; completion allows normal claim',async()=>{
 const db=await databaseWithAllMigrations();try{
 await enable(db);const a=await claim(db);await ready(db,a.lease_token);
 await db.exec("update public.prewarm_intents set expires_at=now()-interval '1 second'");
 const c=(await db.query<{v:{cleanup_token:string}}>('select public.claim_prewarm_cleanup($1) v',[a.lease_token])).rows[0].v;
 const r=await run(db);
 await assert.rejects(db.query('select public.claim_hermes_workspace($1,1,$2)',[r,'a'.repeat(64)]),/PREWARM_PENDING/);
 assert.equal((await claim(db)).status,'busy');
 assert.equal((await db.query<{v:boolean}>('select public.finish_prewarm_cleanup($1,$2) v',[a.lease_token,crypto.randomUUID()])).rows[0].v,false);
 assert.equal((await db.query<{v:boolean}>('select public.finish_prewarm_cleanup($1,$2) v',[a.lease_token,c.cleanup_token])).rows[0].v,true);
 await db.query('select public.claim_hermes_workspace($1,1,$2)',[r,'a'.repeat(64)]);
 }finally{await db.close();}
});

test('crash before ID persistence retains lookup intent and reservation beyond deadline',async()=>{
 const db=await databaseWithAllMigrations();try{
 await enable(db);const a=await claim(db);
 await db.exec("update public.prewarm_intents set deadline=now()-interval '1 second'");
 assert.equal((await claim(db)).status,'busy');
 assert.equal((await db.query<{v:boolean}>('select public.bind_prewarm($1,$2) v',[a.lease_token,'late'])).rows[0].v,false);
 assert.equal((await db.query<{v:unknown}>('select public.claim_prewarm_cleanup($1) v',[a.lease_token])).rows[0].v,null);
 await db.exec("update public.prewarm_intents set deadline=now()-interval '4 minutes'");
 const c=(await db.query<{v:{id:string;machine_id:null;cleanup_token:string}}>('select public.claim_prewarm_cleanup($1) v',[a.lease_token])).rows[0].v;
 assert.equal(c.id,a.lease_token);assert.equal(c.machine_id,null);
 await assert.rejects(db.query('delete from auth.users where id=$1',[OWNER]),/PREWARM_RECOVERY_PENDING/);
 await db.query('select public.finish_prewarm_cleanup($1,$2)',[c.id,c.cleanup_token]);
 const i=(await db.query<{outcome:string;compute_cost_micros:number}>('select outcome,compute_cost_micros from public.prewarm_intents')).rows[0];
 assert.equal(i.outcome,'reserved_upper_bound');assert.equal(Number(i.compute_cost_micros),250000);
 await db.query('delete from auth.users where id=$1',[OWNER]);
 }finally{await db.close();}
});

test('flags and client privileges fail closed',async()=>{
 const db=await databaseWithAllMigrations();try{
 assert.equal((await claim(db)).status,'disabled');await enable(db);
 await db.exec('set role authenticated');
 await assert.rejects(claim(db),/permission denied/);
 await assert.rejects(db.query('select * from public.prewarm_intents'),/permission denied/);
 }finally{await db.close();}
});
