import { task, tasks } from '@trigger.dev/sdk';
import { z } from 'zod';
import { workerDatabase } from '../server/execution/database';
import { executeChat, type ChatMessage } from '../server/execution/chat';
import { createOpenAIProvider } from '../server/execution/openai';
import { loadChatMemoryContextWhenEnabled } from '../server/execution/memory-context';
import { chatRuntimeEnabled, executeHermes, hermesExecutionMayContinue } from '../server/execution/hermes-executor';
import { buildBotIdentityInstruction, parseBotIdentitySnapshot, renderUntrustedContent } from '../server/execution/identity-instructions';
import { createChatLatencyTracker, persistChatLatencyMeasurement } from '../server/execution/chat-latency';

export const chatTask=task({
 id:'bot-messenger-chat',maxDuration:120,retry:{maxAttempts:1},
 queue:{name:'bot-messenger-chat',concurrencyLimit:3},
 run:async(payload:{runId:string})=>{
  const runId=z.uuid().parse(payload.runId);
  const model=process.env.OPENAI_MODEL;
  const inputRate=Number(process.env.OPENAI_INPUT_MICROS_PER_TOKEN);
  const outputRate=Number(process.env.OPENAI_OUTPUT_MICROS_PER_TOKEN);
  if(!model || !Number.isFinite(inputRate) || inputRate<=0 || !Number.isFinite(outputRate) || outputRate<=0)throw new Error('MODEL_PRICING_NOT_CONFIGURED');
  const db=workerDatabase();
  const hermesEnabled=process.env.HERMES_ENABLED==='true';
  if(hermesEnabled){
   const run=await db.from('runs').select('user_id,state,cancel_requested').eq('id',runId).single();
   if(run.data?.state==='QUEUED'&&!run.data.cancel_requested){
    const pending=await db.from('prewarm_intents').select('id').eq('user_id',run.data.user_id).is('settled_at',null).neq('state','READY').maybeSingle();
    // Old schemas are compatible only while admission remains disabled.
    if(pending.error&&!(pending.error.code==='42P01'&&process.env.PREWARM_ENABLED!=='true'))throw new Error('PREWARM_STATE_UNAVAILABLE');
    if(pending.data){await tasks.trigger('bot-messenger-chat',{runId},{delay:'10s'});return {deferred:true};}
   }
  }
  const {data:r,error}=await db.rpc('claim_chat',{p_run_id:runId});
  if(error)throw new Error('CLAIM_FAILED');
  if(!r)return {skipped:true};
  const latencyDiagnosticsEnabled=process.env.LATENCY_DIAGNOSTICS==='true';
  const latency=createChatLatencyTracker();
  latency.mark('worker_claimed');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),100000);
  const interval=setInterval(async()=>{
   try{
    const [runState,runtimeState]=await Promise.all([
     db.from('runs').select('state,cancel_requested,execution_version').eq('id',runId).single(),
     db.from('runtime_config').select('runs_enabled,computer_enabled').eq('singleton',true).single(),
    ]);
    if(runState.error || runtimeState.error ||
      !hermesExecutionMayContinue(runState.data,chatRuntimeEnabled(runtimeState.data,hermesEnabled),r.version))controller.abort();
   }catch{controller.abort();}
  },2000);
  try{
   const {data:messages,error:historyError}=await db.from('messages').select('role,content,run_id,created_at,id')
    .eq('user_id',r.user_id).eq('bot_id',r.bot_id).lte('created_at',r.created_at)
    .in('role',['user','assistant']).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(30);
   if(historyError)throw new Error('HISTORY_FAILED');
   const {data:current,error:currentError}=await db.from('messages').select('role,content').eq('run_id',runId).eq('user_id',r.user_id).eq('role','user').single();
   if(currentError || !current)throw new Error('MESSAGE_MISSING');
   const history=[...(messages??[]).reverse().filter(m=>m.run_id!==runId),current] as ChatMessage[];
   latency.mark('history_loaded');
   // Default off: hosted chat may be deployed before the collaboration migration.
   // Once enabled, memory query or scope failures remain fail-closed.
   const memoryContext=await loadChatMemoryContextWhenEnabled(db,r.user_id,r.bot_id,process.env.MEMORY_ENABLED==='true',controller.signal);
   latency.mark('memory_loaded');
   const identity=parseBotIdentitySnapshot(r.identity);
   const trustedInstructions=buildBotIdentityInstruction(identity);
   const untrustedMemory=memoryContext?renderUntrustedContent('MEMORY',memoryContext):'';
   const untrustedMessage=renderUntrustedContent('USER MESSAGE',current.content);
   latency.mark('executor_started');
   const result=hermesEnabled
    ? await executeHermes({runId,version:r.version,ownerId:r.user_id,botId:r.bot_id,
      instructions:[trustedInstructions,untrustedMemory].filter(Boolean).join('\n\n'),message:untrustedMessage,model,signal:controller.signal,
      onTimingMark:latency.mark})
    : await executeChat({model,identity,memoryContext,history,signal:controller.signal,provider:createOpenAIProvider(),onTimingMark:latency.mark,
    authorize:async(bytes,output)=>{
     // Conservative byte-based bound plus framing allowance; prices must be verified for this model.
     const cost=Math.ceil((bytes+4096)*inputRate+output*outputRate);
     const {error}=await db.rpc('authorize_chat_call',{p_run_id:runId,p_version:r.version,p_cost:cost});
     if(error)throw new Error('CALL_NOT_AUTHORIZED');
    }});
   latency.mark('executor_finished');
   const {data:saved,error:saveError}=await db.rpc('finish_chat',{p_run_id:runId,p_version:r.version,p_text:result.text,
    p_response_id:result.providerResponseId,p_input:result.usage.input_tokens,p_output:result.usage.output_tokens});
   if(saveError)throw new Error('SAVE_FAILED');
   if(saved&&latencyDiagnosticsEnabled){latency.mark('persistence_completed');await persistChatLatencyMeasurement(db,runId,r.version,latency.snapshot());}
   return {saved:Boolean(saved)};
  }catch{
   await db.rpc('fail_chat',{p_run_id:runId,p_version:r.version});
   // Never put prompt, provider errors, credentials or responses into Trigger logs.
   throw new Error('CHAT_EXECUTION_FAILED');
  }finally{clearTimeout(timeout);clearInterval(interval);}
 }
});
