import { redirect } from 'next/navigation';
import { supabase,authConfigured } from '@/lib/supabase/server';
import { ApprovedMessenger } from '@/components/approved/messenger';
import { attachDeliveredArtifacts, type Bot, type DeliveredArtifact, type Message, type WorkspaceMessage } from '@/domain/bots';
import type { RunSummary } from '@/domain/runs';
export const dynamic='force-dynamic';
export default async function MessengerPage(){
 if(!authConfigured())redirect('/?error=configuration');
 const db=await supabase();const {data:{user},error}=await db.auth.getUser();
 if(error||!user)redirect('/');
 const seeded=await db.rpc('ensure_bots');
 if(seeded.error)throw new Error('WORKSPACE_UNAVAILABLE');
 const [botResult,messageResult,runResult,profileResult,computerResult]=await Promise.all([
  db.from('bots').select('id,name,preset,description,role,instructions,instructions_version,avatar_id,enabled').order('created_at').order('id'),
  db.from('messages').select('id,sequence,run_id,bot_id,role,content,created_at').order('sequence',{ascending:false}).limit(300),
  db.from('runs').select('id,bot_id,kind,state,cancel_requested,error_code,created_at,heartbeat_at,finished_at').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(300),
  db.from('profiles').select('avatar_id').eq('user_id',user.id).single(),
  db.from('workspace_computers').select('state').eq('user_id',user.id).single(),
 ]);
 if(botResult.error||messageResult.error||runResult.error||profileResult.error||computerResult.error)throw new Error('WORKSPACE_UNAVAILABLE');
 const runIds=(runResult.data??[]).map(run=>run.id);
 let artifacts:DeliveredArtifact[]=[];
 if(runIds.length){
  const artifactResult=await db.from('artifacts').select('id,run_id,name,mime_type,size_bytes,delivered_at').in('run_id',runIds).not('delivered_at','is',null).order('delivered_at');
  if(artifactResult.error)console.error('ARTIFACT_METADATA_UNAVAILABLE');
  else artifacts=(artifactResult.data??[]) as DeliveredArtifact[];
 }
 const messages=(messageResult.data??[]).reverse().map(m=>({...m,sequence:String(m.sequence)})) as WorkspaceMessage[];
 const hydratedMessages=attachDeliveredArtifacts(messages,runResult.data??[],artifacts);
 const history:Record<string,Message[]>={};for(const message of hydratedMessages)(history[message.bot_id]??=[]).push(message);
 const latestRuns:Record<string,RunSummary>={};for(const run of runResult.data??[]){if(!latestRuns[run.bot_id])latestRuns[run.bot_id]=run as RunSummary;}
 const bots=(botResult.data??[]).map(b=>({...b,computer_state:computerResult.data.state,run_state:latestRuns[b.id]?.state})) as Bot[];
 return <ApprovedMessenger live bots={bots} messages={history} runs={latestRuns} userName={user.user_metadata?.full_name??'Você'} userId={user.id} userAvatarId={profileResult.data.avatar_id} runsEnabled={process.env.RUNS_ENABLED==='true'} watchEnabled={process.env.RUNS_ENABLED==='true'&&process.env.COMPUTER_ENABLED==='true'&&process.env.WATCH_ENABLED==='true'} latencyDiagnostics={process.env.LATENCY_DIAGNOSTICS==='true'}/>;
}
