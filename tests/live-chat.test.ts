import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isActiveRun, livePollInterval, parseSequencePage } from '../src/domain/runs';
import { attachDeliveredArtifacts, type DeliveredArtifact, type WorkspaceMessage } from '../src/domain/bots';
import {
 acceptedMessagesAfterSend,
 connectionControlState,
 deliveredFileMarkup,
 deliveredFilesForMessage,
 draftAfterSuccessfulSend,
 liveComposerState,
  liveEntryState,
  browserLatencyPayload,
 runAfterRequest,
 v1VisibleMenuItems,
} from '../src/components/approved/live-runtime';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const migrations=['202609060001_initial','202609060002_pilot_quotas','202609060003_team_profiles','20260906193000_chat_worker','20260906210000_live_chat_updates'];

test('sequence cursors and live polling reject ambiguous input and track active work',()=>{
 assert.deepEqual(parseSequencePage(new URLSearchParams('after=00042&limit=100')),{after:'42',limit:100});
 assert.throws(()=>parseSequencePage(new URLSearchParams('after=-1')),/INVALID_CURSOR/);
 assert.throws(()=>parseSequencePage(new URLSearchParams('after=99999999999999999999')),/INVALID_CURSOR/);
 assert.throws(()=>parseSequencePage(new URLSearchParams('limit=101')),/INVALID_LIMIT/);
 assert.equal(isActiveRun({state:'WAITING_FOR_USER'}),true);
 assert.equal(isActiveRun({state:'CANCELLED'}),false);
 assert.equal(livePollInterval({a:{state:'RUNNING'}}),2000);
 assert.equal(livePollInterval({a:{state:'SUCCEEDED'}}),10000);
});

test('browser latency payload is bounded and contains no conversation data',()=>{
 assert.deepEqual(browserLatencyPayload('browser_admission_received',100,112.4),{stage:'browser_admission_received',elapsedMs:12});
 assert.deepEqual(browserLatencyPayload('browser_answer_dom_ready',100,99),{stage:'browser_answer_dom_ready',elapsedMs:0});
 assert.deepEqual(browserLatencyPayload('browser_answer_dom_ready',0,3600001),{stage:'browser_answer_dom_ready',elapsedMs:3600000});
});

test('successful send clears only the exact submitted draft',()=>{
 assert.equal(draftAfterSuccessfulSend('submitted message','submitted message'),'');
 assert.equal(draftAfterSuccessfulSend('new draft typed during request','submitted message'),'new draft typed during request');
});
test('disabled live runtime gives the composer an explicit unavailable state',()=>{
 assert.deepEqual(liveComposerState({offline:false,pending:false,live:true,runsEnabled:false}),{
  inputDisabled:true,
  sendDisabled:true,
  runtimeUnavailable:true,
 });
 assert.equal(liveComposerState({offline:false,pending:false,live:true,runsEnabled:true}).runtimeUnavailable,false);
});
test('live mode omits unavailable bot connection controls while demo keeps them',()=>{
 assert.deepEqual(connectionControlState({live:true,offline:true}),{showToggle:false,showInlineConnect:false});
 assert.deepEqual(connectionControlState({live:true,offline:false}),{showToggle:false,showInlineConnect:false});
 assert.deepEqual(connectionControlState({live:false,offline:true}),{showToggle:true,showInlineConnect:true});
 assert.deepEqual(connectionControlState({live:false,offline:false}),{showToggle:true,showInlineConnect:false});
});
test('accepted send appears immediately in the local transcript',()=>{
 const current=[{id:'assistant-1',author:'agent',text:'Como posso ajudar?'}] as const;
 assert.deepEqual(acceptedMessagesAfterSend(current,{id:'message-1',content:'  Primeiro pedido  '}),[
  {id:'assistant-1',author:'agent',text:'Como posso ajudar?'},
  {id:'message-1',author:'user',text:'Primeiro pedido'},
 ]);
 assert.deepEqual(acceptedMessagesAfterSend([
  {id:'message-1',author:'user',text:'Primeiro pedido'},
 ],{id:'message-1',content:'Primeiro pedido'}),[
  {id:'message-1',author:'user',text:'Primeiro pedido'},
 ]);
 assert.deepEqual(current,[{id:'assistant-1',author:'agent',text:'Como posso ajudar?'}]);
});
test('delivered artifacts map to authenticated download links on refresh',async()=>{
 const artifactId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 assert.deepEqual(deliveredFilesForMessage([{id:artifactId,name:'report.pdf',size_bytes:2048}]),[
  {name:'report.pdf',size:2048,href:`/api/artifacts/${artifactId}`},
 ]);
 assert.deepEqual(deliveredFilesForMessage(undefined),[]);
 const page=await readFile(new URL('../src/app/messenger/page.tsx',import.meta.url),'utf8');
 assert.match(page,/from\('artifacts'\).*\.in\('run_id',runIds\).*not\('delivered_at','is',null\)/);
 assert.doesNotMatch(page,/from\('artifacts'\).*\.limit\(/);
 assert.doesNotMatch(page,/object_path/);
 assert.match(page,/if\(artifactResult\.error\)console\.error\('ARTIFACT_METADATA_UNAVAILABLE'\)/);
});
test('delivery mapping associates runs across bots and preserves orphan artifacts',()=>{
 const messages:WorkspaceMessage[]=[
  {id:'user-a',bot_id:'bot-a',run_id:'run-a',role:'user',content:'A',created_at:'2026-09-07T10:00:00Z'},
  {id:'assistant-a',bot_id:'bot-a',run_id:'run-a',role:'assistant',content:'Done',created_at:'2026-09-07T10:01:00Z'},
  {id:'user-b',bot_id:'bot-b',run_id:'run-b',role:'user',content:'B',created_at:'2026-09-07T10:02:00Z'},
 ];
 const artifacts:DeliveredArtifact[]=[
  {id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',run_id:'run-a',name:'a.txt',mime_type:'text/plain',size_bytes:1,delivered_at:'2026-09-07T10:01:00Z'},
  {id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',run_id:'run-b',name:'b.txt',mime_type:'text/plain',size_bytes:2,delivered_at:'2026-09-07T10:03:00Z'},
 ];
 const result=attachDeliveredArtifacts(messages,[{id:'run-a',bot_id:'bot-a'},{id:'run-b',bot_id:'bot-b'}],artifacts);
 assert.equal(result.find(message=>message.id==='user-a')?.artifacts,undefined);
 assert.deepEqual(result.find(message=>message.id==='assistant-a')?.artifacts,[artifacts[0]]);
 assert.deepEqual(result.at(-1),{id:'artifact-run-b',bot_id:'bot-b',run_id:'run-b',role:'assistant',content:'Arquivo entregue.',created_at:'2026-09-07T10:03:00Z',artifacts:[artifacts[1]]});
});
test('delivered file markup escapes names and href attributes',()=>{
 const markup=deliveredFileMarkup({name:'<report & "notes">.txt',size:2,href:'/api/artifacts/id?x="bad"'},'2 < KB');
 assert.doesNotMatch(markup,/<report|"bad"|2 < KB/);
 assert.match(markup,/&lt;report &amp; &quot;notes&quot;&gt;\.txt/);
 assert.match(markup,/href="\/api\/artifacts\/id\?x=&quot;bad&quot;"/);
});
test('V1 menus omit excluded features while keeping supported actions',()=>{
 const visible=v1VisibleMenuItems([
  {label:'Iniciar uma conversa'},
  {label:'Criar grupo',v1Feature:'groups' as const},
  {label:'Ver delegações',v1Feature:'delegation' as const},
  {label:'Memórias salvas'},
 ]);
 assert.deepEqual(visible.map(item=>item.label),['Iniciar uma conversa','Memórias salvas']);
});
test('cancel response updates the bot captured before the request',()=>{
 const runs=runAfterRequest({botB:{id:'run-b'}},'botA',{id:'run-a-cancelled'});
 assert.deepEqual(runs,{botB:{id:'run-b'},botA:{id:'run-a-cancelled'}});
});
test('poll reconciliation preserves a closed contact window after authenticated entry',()=>{
 assert.deepEqual(liveEntryState(false,true),{entered:true,mainWindowHidden:false,showOnboarding:true});
 assert.deepEqual(liveEntryState(true,true),{entered:true,mainWindowHidden:true,showOnboarding:false});
});

test('chat sequences, lifecycle events and cancellation remain owner scoped',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;insert into auth.users values('${A}'),('${B}');`);
  for(const file of migrations)await db.exec(await readFile(new URL('../supabase/migrations/'+file+'.sql',import.meta.url),'utf8'));
  const asUser=async(id:string)=>db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false);`);
  await asUser(A);await db.query('select public.ensure_bots()');
  await asUser(B);await db.query('select public.ensure_bots()');
  await db.exec('reset role;update public.runtime_config set runs_enabled=true;');
  await asUser(A);
  const bot=(await db.query<{id:string}>('select id from public.bots order by id limit 1')).rows[0].id;
  const run=(await db.query<{id:string}>("select public.enqueue_message($1,'hello',gen_random_uuid()) as id",[bot])).rows[0].id;
  const message=(await db.query<{sequence:string}>('select sequence from public.messages where run_id=$1',[run])).rows[0];
  assert.ok(BigInt(message.sequence)>0n);
  let events=await db.query<{kind:string;schema_version:number}>('select kind,schema_version from public.run_events where run_id=$1 order by id',[run]);
  assert.deepEqual(events.rows,[{kind:'run_queued',schema_version:1}]);

  await asUser(B);
  assert.equal((await db.query('select * from public.runs where id=$1',[run])).rows.length,0);
  assert.equal((await db.query('select * from public.messages where run_id=$1',[run])).rows.length,0);
  assert.equal((await db.query('select * from public.run_events where run_id=$1',[run])).rows.length,0);
  await assert.rejects(()=>db.query('select public.request_cancel($1)',[run]),/RUN_NOT_FOUND/);

  await asUser(A);await db.query('select public.request_cancel($1)',[run]);await db.query('select public.request_cancel($1)',[run]);
  events=await db.query('select kind,schema_version from public.run_events where run_id=$1 order by id',[run]);
  assert.deepEqual(events.rows,[{kind:'run_queued',schema_version:1},{kind:'run_cancelled',schema_version:1}]);
  assert.equal((await db.query<{state:string}>('select state from public.runs where id=$1',[run])).rows[0].state,'CANCELLED');

  const running=(await db.query<{id:string}>("select public.enqueue_message($1,'again',gen_random_uuid()) as id",[bot])).rows[0].id;
  await db.exec(`reset role;update public.runs set state='RUNNING' where id='${running}';`);await asUser(A);
  await db.query('select public.request_cancel($1)',[running]);await db.query('select public.request_cancel($1)',[running]);
  const runningEvents=await db.query<{kind:string}>('select kind from public.run_events where run_id=$1 order by id',[running]);
  assert.deepEqual(runningEvents.rows.map(row=>row.kind),['run_queued','run_started','run_cancel_requested']);
  assert.deepEqual((await db.query<{state:string;cancel_requested:boolean}>('select state,cancel_requested from public.runs where id=$1',[running])).rows[0],{state:'RUNNING',cancel_requested:true});
  await db.exec(`reset role;update public.runs set state='CANCELLED',finished_at=now() where id='${running}';`);
  await asUser(A);
  const failed=(await db.query<{id:string}>("select public.enqueue_message($1,'one more',gen_random_uuid()) as id",[bot])).rows[0].id;
  await db.exec(`reset role;update public.runs set state='RUNNING' where id='${failed}';update public.runs set state='FAILED',error_code='WORKER_EXPIRED',finished_at=now() where id='${failed}';`);
  await asUser(A);
  const failure=await db.query<{kind:string;payload:{reasonCode:string}}>('select kind,payload from public.run_events where run_id=$1 order by id desc limit 1',[failed]);
  assert.deepEqual(failure.rows[0],{kind:'run_failed',payload:{reasonCode:'WORKER_EXPIRED'}});
 }finally{await db.close();}
});
