import test from 'node:test';
import assert from 'node:assert/strict';
import {busyPresenceDelayMs,isLongRunningExecution,presence,presets} from '../src/domain/bots';
import {canTransition,limits,messageInput,withinBudget} from '../src/domain/runs';
test('presence follows work before idle computer state',()=>{
 assert.equal(presence('PAUSED','QUEUED'),'away');
 assert.equal(presence('READY','WAITING_FOR_USER'),'away');
 assert.equal(presence('NOT_CREATED'),'available');
 assert.equal(presence('FAILED'),'offline');
 assert.equal(presence('FAILED','RUNNING'),'offline');
 assert.equal(presence('READY','RUNNING',false),'offline');
});
test('Busy starts only after 120 seconds of persisted active execution',()=>{
 const start='2026-09-08T12:00:00.000Z';
 assert.equal(isLongRunningExecution({state:'RUNNING',started_at:start},Date.parse(start)+busyPresenceDelayMs-1),false);
 assert.equal(isLongRunningExecution({state:'RUNNING',started_at:start},Date.parse(start)+busyPresenceDelayMs),true);
 assert.equal(isLongRunningExecution({state:'RUNNING',started_at:'not-a-date'},Date.parse(start)+busyPresenceDelayMs),false);
 assert.equal(isLongRunningExecution({state:'RUNNING',started_at:start,heartbeat_at:'2026-09-08T12:03:00.000Z'},Date.parse(start)+busyPresenceDelayMs),true);
 assert.equal(presence('READY',{state:'RUNNING',started_at:start},true,Date.parse(start)+busyPresenceDelayMs-1),'available');
 assert.equal(presence('READY',{state:'RUNNING',started_at:start},true,Date.parse(start)+busyPresenceDelayMs),'busy');
 assert.equal(presence('READY',{state:'WAITING_FOR_USER',started_at:start},true,Date.parse(start)+busyPresenceDelayMs),'away');
 assert.equal(presence('READY',{state:'SUCCEEDED',started_at:start},true,Date.parse(start)+busyPresenceDelayMs),'available');
});
test('terminal runs cannot restart or claim success after cancellation',()=>{
 assert.equal(canTransition('CANCELLED','SUCCEEDED'),false);
 assert.equal(canTransition('SUCCEEDED','RUNNING'),false);
 assert.equal(canTransition('QUEUED','SUCCEEDED'),false);
 assert.equal(canTransition('RUNNING','CANCELLED'),true);
});
test('budget reserves before spending and rejects invalid accounting',()=>{
 assert.equal(withinBudget(200000,50000),true);
 assert.equal(withinBudget(200000,50001),false);
 assert.equal(withinBudget(-1,1),false);
 assert.equal(withinBudget(0,NaN),false);
 assert.equal(withinBudget(19000,1000,'chat'),true);
 assert.equal(withinBudget(19000,1001,'chat'),false);
});
test('pilot quota policy prioritizes eight lifetime chats within the fixed USD 50 envelope',()=>{
 assert.deepEqual(limits,{
  welcomeChatMessages:8,welcomeComputerRuns:1,maxSeconds:120,maxTurns:20,maxActions:60,
  maxCostMicros:250_000,chatCostMicros:20_000,chatPoolMicros:30_000_000,
  computerPoolMicros:10_000_000,reserveMicros:10_000_000,
 });
});
test('message boundary rejects empty, oversized and untrusted ownership fields',()=>{
 const idempotencyKey='11111111-1111-4111-8111-111111111111';
 assert.equal(messageInput.safeParse({content:'  ',idempotencyKey}).success,false);
 assert.equal(messageInput.safeParse({content:'x'.repeat(8001),idempotencyKey}).success,false);
 assert.equal(messageInput.safeParse({content:'Hello',idempotencyKey,userId:'other'}).success,false);
 assert.deepEqual(messageInput.parse({content:' Hello ',idempotencyKey}),{content:'Hello',idempotencyKey,kind:'chat'});
});
test('all V0 contacts follow the approved naming convention',()=>{
 assert.equal(presets.length,10);assert.equal(new Set(presets.map(p=>p.role)).size,10);for(const p of presets)assert.match(p.name,/^AI .+ \S+$/);
});
