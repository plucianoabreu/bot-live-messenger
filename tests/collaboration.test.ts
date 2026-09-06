import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collaborationError,
  collaborationLimits,
  groupCreateInput,
  handoffCreateInput,
  memoryCreateInput,
  memoryUpdateInput,
} from '../src/domain/collaboration';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('collaboration API inputs reject ownership fields and enforce bounded context',()=>{
  const key='11111111-1111-4111-8111-111111111111';
  const bot='22222222-2222-4222-8222-222222222222';
  const run='33333333-3333-4333-8333-333333333333';
  assert.equal(memoryCreateInput.safeParse({kind:'preference',content:'Prefiro respostas curtas.',provenance:'Explicit user correction',idempotencyKey:key,userId:A}).success,false);
  assert.equal(memoryCreateInput.safeParse({botId:bot,kind:'working_context',content:'Context',provenance:'Conversation',sourceContext:{raw:['not allowed']},idempotencyKey:key}).success,false);
  assert.equal(memoryUpdateInput.safeParse({botId:bot,kind:'working_context',content:'Updated',provenance:'User correction',expectedVersion:0}).success,false);
  assert.equal(groupCreateInput.safeParse({name:' Research ',idempotencyKey:key}).success,true);
  assert.equal(handoffCreateInput.safeParse({rootRunId:run,sourceBotId:bot,targetBotId:key,task:'Compare',budgetMicros:1,idempotencyKey:key,sourceMessageIds:Array(collaborationLimits.maxSourceMessages+1).fill(run)}).success,false);
  assert.deepEqual(collaborationError('database HANDOFF_CYCLE'),{status:409,message:'Esta delegação criaria um ciclo.'});
  assert.equal(collaborationError('unexpected').status,500);
});

test('migration scopes versioned memory and groups to one owner',async()=>{
  const db=await collaborationDatabase();
  try{
    const asUser=actor(db);
    await asUser(A);await db.query('select public.ensure_bots()');
    const bots=(await db.query<{id:string}>('select id from public.bots order by preset')).rows;
    const memoryKey=crypto.randomUUID();
    const saveMemory=(content:string,key:string|null=memoryKey,expected:number|null=null)=>db.query<{id:string}>(
      `select public.save_memory(nullif($1,'')::uuid,nullif($2,'')::uuid,$3,$4,$5,$6::jsonb,nullif($7,'')::uuid,$8) as id`,
      ['',bots[0].id,'working_context',content,'Explicit user statement','{"message":"source"}',key??'',expected]
    );
    const memory=(await saveMemory('Use concise summaries.')).rows[0].id;
    assert.equal((await saveMemory('Use concise summaries.')).rows[0].id,memory);
    await assert.rejects(()=>saveMemory('Different content.'),/IDEMPOTENCY_CONFLICT/);
    await db.query(`select public.save_memory($1,$2,'working_context','Use concise summaries with sources.','User correction','{}'::jsonb,null,1)`,[memory,bots[0].id]);
    const versions=(await db.query<{version:number;superseded_at:string|null}>('select version,superseded_at from public.memory_versions order by version')).rows;
    assert.deepEqual(versions.map(row=>row.version),[1,2]);
    assert.ok(versions[0].superseded_at);assert.equal(versions[1].superseded_at,null);
    await db.exec('reset role;');
    await assert.rejects(()=>db.query(`insert into public.memory_versions(item_id,user_id,version,content,provenance)
      values($1,$2,3,'Conflicting active version','test')`,[memory,A]),/memory_versions_one_active/);
    await asUser(A);
    await assert.rejects(()=>db.query(`select public.save_memory($1,$2,'working_context','Stale','User correction','{}'::jsonb,null,1)`,[memory,bots[0].id]),/VERSION_CONFLICT/);

    const groupKey=crypto.randomUUID();
    const group=(await db.query<{id:string}>(`select public.save_bot_group(null,'Research', $1) as id`,[groupKey])).rows[0].id;
    assert.equal((await db.query<{id:string}>(`select public.save_bot_group(null,'Research', $1) as id`,[groupKey])).rows[0].id,group);
    await assert.rejects(()=>db.query(`select public.save_bot_group(null,'Other', $1)`,[groupKey]),/IDEMPOTENCY_CONFLICT/);
    await db.query('select public.set_bot_group_member($1,$2,true)',[group,bots[0].id]);
    await db.query('select public.set_bot_group_member($1,$2,true)',[group,bots[1].id]);
    assert.equal((await db.query('select * from public.bot_group_memberships where removed_at is null')).rows.length,2);

    await asUser(B);await db.query('select public.ensure_bots()');
    assert.equal((await db.query('select * from public.memory_items')).rows.length,0);
    assert.equal((await db.query('select * from public.bot_groups')).rows.length,0);
    await assert.rejects(()=>db.query('select public.delete_memory($1,2)',[memory]),/MEMORY_NOT_FOUND/);
    const botB=(await db.query<{id:string}>('select id from public.bots limit 1')).rows[0].id;
    await assert.rejects(()=>db.query('select public.set_bot_group_member($1,$2,true)',[group,botB]),/GROUP_NOT_FOUND/);
    await assert.rejects(()=>db.query("insert into public.bot_groups(user_id,name,creation_key) values($1,'Spoof',$2)",[A,crypto.randomUUID()]),/permission denied/);

    await asUser(A);await db.query('select public.set_bot_group_member($1,$2,false)',[group,bots[1].id]);
    assert.ok((await db.query<{removed_at:string}>('select removed_at from public.bot_group_memberships where group_id=$1 and bot_id=$2',[group,bots[1].id])).rows[0].removed_at);
    await db.query('select public.delete_memory($1,2)',[memory]);
    assert.equal((await db.query('select * from public.memory_items where id=$1',[memory])).rows.length,0);
    assert.equal((await db.query('select * from public.memory_versions where item_id=$1',[memory])).rows.length,0);
    await assert.rejects(()=>db.query('select public.delete_memory($1,2)',[memory]),/MEMORY_NOT_FOUND/);
    await assert.rejects(()=>saveMemory('Use concise summaries.'),/MEMORY_DELETED/);
    await db.exec('reset role;');
    const tombstone=(await db.query<{id:string;kind:string;current_version:number;deleted_at:string|null}>('select id,kind,current_version,deleted_at from public.memory_items where id=$1',[memory])).rows[0];
    assert.deepEqual({id:tombstone.id,kind:tombstone.kind,current_version:tombstone.current_version},{id:memory,kind:'working_context',current_version:2});
    assert.ok(tombstone.deleted_at);
    assert.equal((await db.query('select * from public.memory_versions where item_id=$1',[memory])).rows.length,0);
    await asService(db);
    const learned=(await db.query<{id:string}>(`select public.save_memory(null,$1,'working_context','Persisted by worker','run:owned','{}'::jsonb,$2,null) as id`,[bots[1].id,crypto.randomUUID()])).rows[0].id;
    await asUser(A);assert.equal((await db.query('select id from public.memory_items where id=$1',[learned])).rows.length,1);
  }finally{await db.close();}
});

test('one root ledger prevents model calls and child handoffs from double-spending the reservation',async()=>{
  const db=await collaborationDatabase();
  try{
    const asUser=actor(db);await asUser(A);await db.query('select public.ensure_bots()');
    const bots=(await db.query<{id:string}>('select id from public.bots order by preset')).rows;
    await db.exec('reset role;update public.runtime_config set runs_enabled=true;');await asUser(A);
    const enqueue=async(botId:string)=>(await db.query<{id:string}>("select public.enqueue_message($1,'Budget root',$2) as id",[botId,crypto.randomUUID()])).rows[0].id;
    const authorize=async(root:string,source:string,target:string,cost:number)=>(await db.query<{id:string}>(
      `select public.authorize_bot_handoff($1,null,$2,$3,null,'Bounded child','{}'::uuid[],$4,$5) as id`,
      [root,source,target,cost,crypto.randomUUID()]
    )).rows[0].id;

    const childFirst=await enqueue(bots[0].id);await asService(db);
    await authorize(childFirst,bots[0].id,bots[1].id,5000);
    const childFirstClaim=(await db.query<{value:{version:number}}>('select public.claim_chat($1) as value',[childFirst])).rows[0].value;
    await db.query('select public.authorize_chat_call($1,$2,15000)',[childFirst,childFirstClaim.version]);
    await asUser(A);
    assert.equal(Number((await db.query<{allocated_micros:string}>('select allocated_micros from public.root_task_budgets where root_run_id=$1',[childFirst])).rows[0].allocated_micros),20000);
    await asService(db);
    await assert.rejects(()=>authorize(childFirst,bots[0].id,bots[2].id,1),/HANDOFF_BUDGET/);

    await asUser(A);const rootFirst=await enqueue(bots[3].id);await asService(db);
    const rootFirstClaim=(await db.query<{value:{version:number}}>('select public.claim_chat($1) as value',[rootFirst])).rows[0].value;
    await db.query('select public.authorize_chat_call($1,$2,16000)',[rootFirst,rootFirstClaim.version]);
    await assert.rejects(()=>authorize(rootFirst,bots[3].id,bots[4].id,4001),/HANDOFF_BUDGET/);
    await authorize(rootFirst,bots[3].id,bots[4].id,4000);
    await asUser(A);
    assert.equal(Number((await db.query<{allocated_micros:string}>('select allocated_micros from public.root_task_budgets where root_run_id=$1',[rootFirst])).rows[0].allocated_micros),20000);

    const plainChat=await enqueue(bots[5].id);await asService(db);
    const plainClaim=(await db.query<{value:{version:number}}>('select public.claim_chat($1) as value',[plainChat])).rows[0].value;
    await db.query('select public.authorize_chat_call($1,$2,20000)',[plainChat,plainClaim.version]);
    await assert.rejects(()=>db.query('select public.authorize_chat_call($1,$2,20000)',[plainChat,plainClaim.version]),/duplicate key/);
    await asUser(A);
    assert.equal(Number((await db.query<{allocated_micros:string}>('select allocated_micros from public.root_task_budgets where root_run_id=$1',[plainChat])).rows[0].allocated_micros),20000);
  }finally{await db.close();}
});

test('handoffs persist attribution and stop duplicates, cycles, depth, budget and cancelled roots',async()=>{
  const db=await collaborationDatabase();
  try{
    const asUser=actor(db);
    await asUser(A);await db.query('select public.ensure_bots()');
    const bots=(await db.query<{id:string}>('select id from public.bots order by preset')).rows;
    const group=(await db.query<{id:string}>(`select public.save_bot_group(null,'Research',$1) as id`,[crypto.randomUUID()])).rows[0].id;
    for(const bot of bots.slice(0,5))await db.query('select public.set_bot_group_member($1,$2,true)',[group,bot.id]);
    await db.exec('reset role;update public.runtime_config set runs_enabled=true;');await asUser(A);
    const root=(await db.query<{id:string}>("select public.enqueue_message($1,'Root task',$2) as id",[bots[0].id,crypto.randomUUID()])).rows[0].id;
    const sourceMessage=(await db.query<{id:string}>('select id from public.messages where run_id=$1',[root])).rows[0].id;
    const authorize=async(args:{parent?:string;source:string;target:string;budget?:number;key?:string;groupId?:string|null;task?:string})=>(await db.query<{id:string}>(
      `select public.authorize_bot_handoff($1,nullif($2,'')::uuid,$3,$4,nullif($5,'')::uuid,$6,array[$7::uuid],$8,$9) as id`,
      [root,args.parent??'',args.source,args.target,args.groupId===undefined?group:(args.groupId??''),args.task??'Delegated research',sourceMessage,args.budget??5000,args.key??crypto.randomUUID()]
    )).rows[0].id;

    const firstKey=crypto.randomUUID();
    await asService(db);
    const first=await authorize({source:bots[0].id,target:bots[1].id,key:firstKey});
    await asUser(A);
    assert.equal(await authorize({source:bots[0].id,target:bots[1].id,key:firstKey}),first);
    await assert.rejects(()=>authorize({source:bots[0].id,target:bots[2].id,key:firstKey}),/IDEMPOTENCY_CONFLICT/);
    await assert.rejects(()=>authorize({source:bots[1].id,target:bots[2].id,parent:first}),/PARENT_NOT_DELIVERED/);
    await assert.rejects(()=>db.query('select public.deliver_bot_handoff($1,$2)',[first,crypto.randomUUID()]),/permission denied/);

    const delivery1=crypto.randomUUID();await asService(db);await db.query('select public.deliver_bot_handoff($1,$2)',[first,delivery1]);
    await db.query('select public.deliver_bot_handoff($1,$2)',[first,delivery1]);
    await assert.rejects(()=>db.query('select public.deliver_bot_handoff($1,$2)',[first,crypto.randomUUID()]),/IDEMPOTENCY_CONFLICT/);
    const resultKey=crypto.randomUUID();
    await db.query("select public.finish_bot_handoff($1,$2,'COMPLETED','Attributed result')",[first,resultKey]);
    await db.query("select public.finish_bot_handoff($1,$2,'COMPLETED','Attributed result')",[first,resultKey]);
    await assert.rejects(()=>db.query("select public.finish_bot_handoff($1,$2,'COMPLETED','Different result')",[first,resultKey]),/IDEMPOTENCY_CONFLICT/);
    await asUser(A);
    const stored=await db.query<{state:string;result:string;source_bot_id:string;target_bot_id:string}>('select state,result,source_bot_id,target_bot_id from public.bot_handoffs where id=$1',[first]);
    assert.deepEqual(stored.rows[0],{state:'COMPLETED',result:'Attributed result',source_bot_id:bots[0].id,target_bot_id:bots[1].id});
    const second=await authorize({parent:first,source:bots[1].id,target:bots[2].id});
    await asService(db);await db.query('select public.deliver_bot_handoff($1,$2)',[second,crypto.randomUUID()]);await asUser(A);
    await assert.rejects(()=>authorize({parent:second,source:bots[2].id,target:bots[0].id}),/HANDOFF_CYCLE/);
    const third=await authorize({parent:second,source:bots[2].id,target:bots[3].id});
    await asService(db);await db.query('select public.deliver_bot_handoff($1,$2)',[third,crypto.randomUUID()]);await asUser(A);
    await assert.rejects(()=>authorize({parent:third,source:bots[3].id,target:bots[4].id,budget:1}),/HANDOFF_DEPTH/);
    await assert.rejects(()=>authorize({source:bots[0].id,target:bots[4].id,budget:6000,groupId:null}),/HANDOFF_BUDGET/);

    const removed=await authorize({source:bots[0].id,target:bots[4].id,budget:1000});
    await db.query('select public.set_bot_group_member($1,$2,false)',[group,bots[4].id]);
    await asService(db);await assert.rejects(()=>db.query('select public.deliver_bot_handoff($1,$2)',[removed,crypto.randomUUID()]),/GROUP_MEMBER_REQUIRED/);
    await asUser(A);await db.query('select public.set_bot_group_member($1,$2,true)',[group,bots[4].id]);
    const deliveredBeforeRemoval=await authorize({source:bots[0].id,target:bots[4].id,budget:1000});
    await asService(db);await db.query('select public.deliver_bot_handoff($1,$2)',[deliveredBeforeRemoval,crypto.randomUUID()]);
    await asUser(A);await db.query('select public.set_bot_group_member($1,$2,false)',[group,bots[4].id]);
    await asService(db);await assert.rejects(()=>db.query("select public.finish_bot_handoff($1,$2,'COMPLETED','Late result')",[deliveredBeforeRemoval,crypto.randomUUID()]),/GROUP_MEMBER_REQUIRED/);
    await asUser(A);await db.query('select public.request_cancel($1)',[root]);
    const states=(await db.query<{state:string}>('select state from public.bot_handoffs order by depth,id')).rows.map(row=>row.state);
    assert.ok(states.includes('CANCELLED'));
    assert.equal((await db.query<{cancelled_at:string}>('select cancelled_at from public.root_task_budgets where root_run_id=$1',[root])).rows[0].cancelled_at!==null,true);
    // PGlite has one database session, so it cannot reproduce a two-session deadlock.
    // Exercising both serialized orders verifies terminal behavior; hosted Supabase
    // still needs a two-session cancel/deliver race test before enabling delegation.
    await asService(db);
    await assert.rejects(()=>db.query('select public.deliver_bot_handoff($1,$2)',[removed,crypto.randomUUID()]),/ROOT_CANCELLED/);
    await assert.rejects(()=>db.query("select public.finish_bot_handoff($1,$2,'COMPLETED','After cancel')",[third,crypto.randomUUID()]),/ROOT_CANCELLED/);
    await asUser(A);
    await assert.rejects(()=>authorize({source:bots[0].id,target:bots[1].id,budget:1}),/ROOT_CANCELLED/);

    await asUser(B);await db.query('select public.ensure_bots()');
    assert.equal((await db.query('select * from public.bot_handoffs')).rows.length,0);
    assert.equal((await db.query('select * from public.root_task_budgets')).rows.length,0);
  }finally{await db.close();}
});

async function collaborationDatabase(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;insert into auth.users values('${A}'),('${B}');`);
  const directory=new URL('../supabase/migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
  return db;
}

function actor(db:PGlite){return (id:string)=>db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false);`);}
async function asService(db:PGlite){await db.exec("reset role;set role service_role;select set_config('request.jwt.claim.sub','',false);");}
