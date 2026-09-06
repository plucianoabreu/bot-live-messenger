import { redirect } from 'next/navigation';
import { supabase,authConfigured } from '@/lib/supabase/server';
import { ApprovedMessenger } from '@/components/approved/messenger';
import type { Bot, Message } from '@/domain/bots';
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
  db.from('messages').select('id,sequence,bot_id,role,content,created_at').order('sequence',{ascending:false}).limit(300),
  db.from('runs').select('id,bot_id,kind,state,cancel_requested,error_code,created_at,finished_at').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(300),
  db.from('profiles').select('avatar_id').eq('user_id',user.id).single(),
  db.from('workspace_computers').select('state').eq('user_id',user.id).single(),
 ]);
 if(botResult.error||messageResult.error||runResult.error||profileResult.error||computerResult.error)throw new Error('WORKSPACE_UNAVAILABLE');
 const history:Record<string,Message[]>={};for(const m of (messageResult.data??[]).reverse()){(history[m.bot_id]??=[]).push({...m,sequence:String(m.sequence)} as Message);}
 const latestRuns:Record<string,RunSummary>={};for(const run of runResult.data??[]){if(!latestRuns[run.bot_id])latestRuns[run.bot_id]=run as RunSummary;}
 const bots=(botResult.data??[]).map(b=>({...b,computer_state:computerResult.data.state,run_state:latestRuns[b.id]?.state})) as Bot[];
 return <ApprovedMessenger live bots={bots} messages={history} runs={latestRuns} userName={user.user_metadata?.full_name??'Você'} userId={user.id} userAvatarId={profileResult.data.avatar_id} runsEnabled={process.env.RUNS_ENABLED==='true'} watchEnabled={process.env.RUNS_ENABLED==='true'&&process.env.COMPUTER_ENABLED==='true'&&process.env.WATCH_ENABLED==='true'}/>;
}
