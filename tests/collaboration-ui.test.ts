import test from 'node:test';
import assert from 'node:assert/strict';
import {
 activeMemoryVersion,collaborationStorageMode,createGenerationGate,groupFromApi,handoffLabel,handoffsForBot,
 reconcileMembershipChanges,sourceMessagesForHandoff,
} from '../src/components/approved/collaboration-ui';

test('group view keeps only active memberships without losing durable metadata',()=>{
 const group=groupFromApi({
  id:'group-1',name:'Research',created_at:'2026-09-06T10:00:00Z',updated_at:'2026-09-06T11:00:00Z',
  bot_group_memberships:[{bot_id:'active',removed_at:null},{bot_id:'removed',removed_at:'2026-09-06T10:30:00Z'}],
 });
 assert.deepEqual(group,{id:'group-1',name:'Research',ids:['active'],createdAt:'2026-09-06T10:00:00Z',updatedAt:'2026-09-06T11:00:00Z'});
});

test('memory view selects the canonical current version even when history is unordered',()=>{
 const current=activeMemoryVersion({current_version:2,memory_versions:[
  {version:3,content:'future',provenance:'test'},
  {version:1,content:'old',provenance:'test'},
  {version:2,content:'current',provenance:'User correction'},
 ]});
 assert.deepEqual(current,{version:2,content:'current',provenance:'User correction'});
});

test('handoff history scopes both directions, sorts newest first and preserves unknown states',()=>{
 const handoffs=[
  {id:'old',source_bot_id:'a',target_bot_id:'b',state:'AUTHORIZED'},
  {id:'other',source_bot_id:'c',target_bot_id:'d',state:'DELIVERED'},
  {id:'new',source_bot_id:'b',target_bot_id:'a',state:'COMPLETED'},
 ];
 assert.deepEqual(handoffsForBot(handoffs,'a').map(item=>item.id),['new','old']);
 assert.deepEqual(handoffs.map(item=>item.id),['old','other','new']);
 assert.equal(handoffLabel('AUTHORIZED'),'Autorizada');
 assert.equal(handoffLabel('FUTURE_STATE'),'FUTURE_STATE');
});

test('dialog generation gate rejects responses from an older dialog and invalidates closed dialogs',()=>{
 const gate=createGenerationGate();
 const first=gate.next();
 const second=gate.next();
 assert.equal(gate.isCurrent(first),false);
 assert.equal(gate.isCurrent(second),true);
 gate.invalidate();
 assert.equal(gate.isCurrent(second),false);
});

test('authenticated membership changes always reconcile from canonical state after a partial failure',async()=>{
 const changes=[
  {groupId:'one',groupName:'Research',active:true},
  {groupId:'two',groupName:'Design',active:false},
 ];
 const calls:string[]=[];let reloads=0;
 const canonical=[{id:'one',name:'Research',ids:['bot'],createdAt:'created',updatedAt:'updated'}];
 const result=await reconcileMembershipChanges(changes,async change=>{
  calls.push(change.groupId);if(change.groupId==='two')throw new Error('Membership conflict');
 },async()=>{reloads++;return canonical;});
 assert.deepEqual(calls,['one','two']);
 assert.equal(reloads,1);
 assert.equal(result.canonical,canonical);
 assert.deepEqual(result.failures,[{change:changes[1],message:'Membership conflict'}]);
});

test('collaboration persistence has an explicit authenticated and demo split',()=>{
 assert.equal(collaborationStorageMode(true),'authenticated');
 assert.equal(collaborationStorageMode(false),'demo');
});

test('handoff context includes only explicitly referenced loaded messages',()=>{
 const messages=[
  {id:'allowed',text:'bounded context'},
  {id:'private',text:'unrelated private conversation'},
  {id:'second',text:'second source'},
 ];
 const visible=sourceMessagesForHandoff({handoff_source_messages:[{message_id:'allowed'},{message_id:'missing'},{message_id:'second'}]},messages,2);
 assert.deepEqual(visible.map(message=>message.text),['bounded context','second source']);
});
