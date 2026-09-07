import { createClient } from '@supabase/supabase-js';
import { assertNodeWorker } from './node-boundary';

assertNodeWorker();
export function workerDatabase() {
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url || !key)throw new Error('WORKER_DATABASE_NOT_CONFIGURED');
 return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
}
