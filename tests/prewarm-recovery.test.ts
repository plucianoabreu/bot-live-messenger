import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverPrewarmMachines } from '../src/server/execution/prewarm-recovery';
import { HermesE2BFactory, type HermesE2BApi } from '../src/server/execution/hermes-e2b';
const intent={id:'attempt',user_id:'owner',machine_id:null,ready_at:null};
test('ambiguous create is found by exact attempt metadata, without creating again',async()=>{
 const killed:string[]=[];
 await recoverPrewarmMachines(intent,{
  async list(metadata){assert.equal(metadata.prewarmIntent,'attempt');return {items:[{sandboxId:'created-before-crash',metadata}],hasNext:false};},
  async destroy(id){killed.push(id);},async pause(){assert.fail('not ready');}
 });assert.deepEqual(killed,['created-before-crash']);
});
test('foreign metadata and truncated inventory preserve recovery fence',async()=>{
 for(const truncated of [true,false])await assert.rejects(recoverPrewarmMachines(intent,{
  async list(){return {items:[{sandboxId:'foreign',metadata:{}}],hasNext:truncated};},
  async destroy(){assert.fail('must not destroy foreign machine');},async pause(){assert.fail();}
 }),/PREWARM_SCAN_/);
});
test('existing workspace is paused on preparation failure and never destroyed',async()=>{
 const paused:string[]=[];await recoverPrewarmMachines({...intent,machine_id:'existing',existing_machine:true},{
  async list(){assert.fail('existing identity is durable');},async destroy(){assert.fail('preserve account files');},async pause(id){paused.push(id);}
 });assert.deepEqual(paused,['existing']);
});
test('failed pause propagates without permitting settlement',async()=>{
 await assert.rejects(recoverPrewarmMachines({...intent,machine_id:'ready',ready_at:'now'},{
 async list(){assert.fail();},async destroy(){assert.fail();},async pause(){throw new Error('provider timeout');}
 }),/provider timeout/);
});
test('provider create receives durable correlation metadata before a simulated lost response',async()=>{
 let metadata:unknown;
 const factory=new HermesE2BFactory('fake','template',180000,{version:'v1',allowedHosts:['gateway.example']},{cpuCount:2,memoryMib:2048},{
 async create(_template:string,options:Record<string,unknown>){metadata=options.metadata;throw new Error('response lost after creation');},
 } as unknown as HermesE2BApi,'durable-intent');
 await assert.rejects(factory.create('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),/response lost/);
 assert.deepEqual(metadata,{application:'bot-live-messenger',owner:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',engine:'hermes',networkPolicy:'v1',prewarmIntent:'durable-intent'});
});
