import {memoryCreateInput,type MemoryCreate} from '@/domain/collaboration';
import {workerDatabase} from './execution/database';

// A worker can append bot-scoped context. User-wide preferences remain explicit user writes.
export async function storeBotMemory(input:MemoryCreate) {
  const parsed=memoryCreateInput.parse(input);
  if(!parsed.botId||parsed.kind==='preference')throw new Error('BOT_MEMORY_REQUIRED');
  const {data,error}=await workerDatabase().rpc('save_memory',{
    p_id:null,p_bot_id:parsed.botId,p_kind:parsed.kind,p_content:parsed.content,p_provenance:parsed.provenance,
    p_source_context:parsed.sourceContext,p_idempotency_key:parsed.idempotencyKey,p_expected_version:null,
  });
  if(error)throw new Error(error.message);
  return data as string;
}
