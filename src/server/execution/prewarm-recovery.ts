import { Sandbox } from '@e2b/desktop';
import { workerDatabase } from './database';

export async function recoverPrewarmMachines(input:{id:string;user_id:string;machine_id:string|null;ready_at:string|null;existing_machine?:boolean},provider:{
 list(metadata:Record<string,string>):Promise<{items:Array<{sandboxId:string;metadata:Record<string,string>}>;hasNext:boolean}>;
 pause(id:string):Promise<void>;destroy(id:string):Promise<void>;
}){
 const metadata={application:'bot-live-messenger',owner:input.user_id,engine:'hermes',prewarmIntent:input.id};
 if((input.ready_at||input.existing_machine)&&input.machine_id){await provider.pause(input.machine_id);return;}
 const page=await provider.list(metadata);
 if(page.hasNext||page.items.length>10)throw new Error('PREWARM_SCAN_LIMIT');
 if(page.items.some(item=>Object.entries(metadata).some(([k,v])=>item.metadata[k]!==v)))throw new Error('PREWARM_SCAN_MISMATCH');
 const ids=new Set(page.items.map(item=>item.sandboxId));
 if(input.machine_id)ids.add(input.machine_id);
 for(const id of ids)await provider.destroy(id);
}

export async function cleanupPrewarm(env:NodeJS.ProcessEnv,intentId?:string){
 // Recovery remains enabled when admission is switched off.
 if(!env.E2B_API_KEY)return false;
 const db=workerDatabase(),key=env.E2B_API_KEY;
 const claimed=await db.rpc('claim_prewarm_cleanup',{p_id:intentId??null});
 if(claimed.error)throw new Error('PREWARM_CLEANUP_CLAIM_FAILED');
 if(!claimed.data)return false;
 const claim=claimed.data;
 await recoverPrewarmMachines(claim,{
  async list(metadata){const pages=Sandbox.list({apiKey:key,query:{metadata,state:['running','paused']},limit:10});return {items:await pages.nextItems(),hasNext:pages.hasNext};},
  async pause(id){await Sandbox.pause(id,{apiKey:key,keepMemory:false});},
  async destroy(id){await Sandbox.kill(id,{apiKey:key});},
 });
 const done=await db.rpc('finish_prewarm_cleanup',{p_id:claim.id,p_token:claim.cleanup_token});
 if(done.error||done.data!==true)throw new Error('PREWARM_CLEANUP_FENCE_CHANGED');
 return true;
}
