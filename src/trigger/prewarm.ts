import { task, tasks } from '@trigger.dev/sdk';
import { Sandbox } from '@e2b/desktop';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { workerDatabase } from '../server/execution/database';
import { connectHermesE2B, HermesE2BFactory, hermesRuntimeNetworkPolicy } from '../server/execution/hermes-e2b';
import { assertHermesComputeReservation, hermesUsageConfiguration } from '../server/billing/hermes-usage';
import { provisionHermes } from '../server/execution/hermes-provision';
import { cleanupPrewarm } from '../server/execution/prewarm-recovery';

export const prewarmCleanupTask=task({id:'bot-messenger-prewarm-cleanup',maxDuration:60,retry:{maxAttempts:1},
 run:async(payload:{intentId:string})=>cleanupPrewarm(process.env,z.uuid().parse(payload.intentId))});

export const prewarmTask=task({id:'bot-messenger-prewarm',maxDuration:150,retry:{maxAttempts:1},
 run:async(payload:{userId:string})=>{
  if(process.env.PREWARM_ENABLED!=='true')return {skipped:true};
  const userId=z.uuid().parse(payload.userId),db=workerDatabase();
  const key=process.env.E2B_API_KEY,template=process.env.HERMES_TEMPLATE_ID,gateway=process.env.HERMES_MODEL_GATEWAY_URL;
  if(!key||!template||!gateway)return {skipped:true};
  const usage=hermesUsageConfiguration(process.env);
  assertHermesComputeReservation(usage,300_000,250_000);
  const policy=hermesRuntimeNetworkPolicy(gateway,process.env.E2B_NETWORK_POLICY_VERSION,process.env.E2B_ALLOWED_HOSTS);
  const {data:lease,error}=await db.rpc('claim_hermes_prewarm',{p_user_id:userId});
  if(error)throw new Error('PREWARM_ADMISSION_FAILED');
  if(lease?.status!=='preparing')return {skipped:true};
  const intentId=z.uuid().parse(lease.lease_token);
  // Persist watchdog dispatch before any provider call. Maintenance is fallback.
  await tasks.trigger('bot-messenger-prewarm-cleanup',{intentId},{delay:'5m',idempotencyKey:`prewarm-watchdog:${intentId}`});
  try{
   const began=await db.rpc('begin_prewarm_provider',{p_id:intentId});
   if(began.error||began.data!==true)return {recoveryPending:true};
   let machineId=lease.machine_id as string|null;
   const shape={cpuCount:usage.vcpuCount,memoryMib:usage.memoryMib};
   if(machineId)await connectHermesE2B(key,machineId,policy,shape);
   else{
    const factory=new HermesE2BFactory(key,template,180_000,policy,shape,undefined,intentId);
    const created=await provisionHermes({create:async owner=>{
     const machine=await factory.create(owner);
     const saved=await db.rpc('bind_prewarm',{p_id:intentId,p_machine:machine.id});
     if(saved.error||saved.data!==true)throw new Error('PREWARM_BINDING_FAILED');
     return machine;
    }},userId,{url:gateway,scopedToken:randomBytes(32).toString('hex')});
    machineId=created.machineId;
    const saved=await db.rpc('bind_prewarm',{p_id:intentId,p_machine:machineId,p_binding:{baseUrl:created.baseUrl,apiKey:created.apiKey,revision:created.revision}});
    if(saved.error||saved.data!==true)throw new Error('PREWARM_BINDING_FAILED');
    // Provision verifies a gateway with a deliberately unusable model token.
    // Drop that process using the existing lifecycle boundary, preserving disk,
    // then warm the VM again. The real run launches with its rotated token.
    await Sandbox.pause(machineId,{apiKey:key,keepMemory:false});
    await connectHermesE2B(key,machineId,policy,shape);
   }
   // Install provider backstop before READY permits handoff. A run's connect
   // renews its timeout only after atomic transfer of the account ownership.
   await Sandbox.setTimeout(machineId!,60_000,{apiKey:key});
   const ready=await db.rpc('complete_hermes_prewarm',{p_user_id:userId,p_lease_token:intentId,p_machine_id:machineId});
   if(ready.error||ready.data!==true)throw new Error('PREWARM_READY_FENCED');
   await tasks.trigger('bot-messenger-prewarm-cleanup',{intentId},{delay:'60s',idempotencyKey:`prewarm-idle:${intentId}`});
   return {ready:true};
  }catch{
   // Metadata + reserved intent survive even if create never returned an ID.
   return {recoveryPending:true};
  }
 }});
