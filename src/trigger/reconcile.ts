import { task, tasks } from '@trigger.dev/sdk';
import { workerDatabase } from '../server/execution/database';
import type { chatTask } from './chat';
// Invoke periodically only after release gates pass; not scheduled automatically.
export const reconcileChats=task({id:'bot-messenger-reconcile',maxDuration:30,retry:{maxAttempts:1},run:async()=>{
 const db=workerDatabase();
 const {error}=await db.rpc('reconcile_chats');if(error)throw new Error('RECONCILE_FAILED');
 if(process.env.RUNS_ENABLED!=='true')return {dispatched:0};
 const {data,error:readError}=await db.from('runs').select('id').eq('state','QUEUED').eq('kind','chat').order('created_at').limit(20);
 if(readError)throw new Error('OUTBOX_READ_FAILED');
 for(const run of data??[])await tasks.trigger<typeof chatTask>('bot-messenger-chat',{runId:run.id},{idempotencyKey:run.id});
 return {dispatched:data?.length??0};
}});
