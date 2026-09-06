import test from 'node:test';
import assert from 'node:assert/strict';
import {presence,presets} from '../src/domain/bots';
import {canTransition,messageInput,withinBudget} from '../src/domain/runs';
test('presence follows work before idle computer state',()=>{
 assert.equal(presence('PAUSED','QUEUED'),'busy');
 assert.equal(presence('READY','WAITING_FOR_USER'),'away');
 assert.equal(presence('NOT_CREATED'),'available');
 assert.equal(presence('FAILED'),'offline');
 assert.equal(presence('FAILED','RUNNING'),'offline');
 assert.equal(presence('READY','RUNNING',false),'offline');
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
