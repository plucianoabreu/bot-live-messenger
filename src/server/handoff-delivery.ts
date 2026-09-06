import {workerDatabase} from './execution/database';
import {handoffCreateInput,type HandoffCreate} from '@/domain/collaboration';

export async function authorizeHandoffForWorker(input:HandoffCreate) {
  const parsed=handoffCreateInput.parse(input);
  const {data,error}=await workerDatabase().rpc('authorize_bot_handoff',{
    p_root_run_id:parsed.rootRunId,p_parent_handoff_id:parsed.parentHandoffId,p_source_bot_id:parsed.sourceBotId,
    p_target_bot_id:parsed.targetBotId,p_group_id:parsed.groupId,p_task:parsed.task,p_source_message_ids:parsed.sourceMessageIds,
    p_budget_micros:parsed.budgetMicros,p_idempotency_key:parsed.idempotencyKey,
  });
  if(error)throw new Error(error.message);
  return data as string;
}

// Worker-only durable transitions. They do not dispatch a provider or grant tools.
export async function deliverHandoff(handoffId:string,deliveryKey:string) {
  const {error}=await workerDatabase().rpc('deliver_bot_handoff',{p_handoff_id:handoffId,p_delivery_key:deliveryKey});
  if(error)throw new Error(error.message);
}

export async function finishHandoff(handoffId:string,resultKey:string,state:'COMPLETED'|'FAILED',result:string) {
  const {error}=await workerDatabase().rpc('finish_bot_handoff',{
    p_handoff_id:handoffId,p_result_key:resultKey,p_state:state,p_result:result,
  });
  if(error)throw new Error(error.message);
}
