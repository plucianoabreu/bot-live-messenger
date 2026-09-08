import catalog from './presets.json';
import { pictureUrl } from './profiles';
export const presets = catalog.map(preset=>({...preset,avatar:pictureUrl(preset.avatarId)}));
export type ComputerState = 'NOT_CREATED' | 'CREATING' | 'READY' | 'PAUSED' | 'RESUMING' | 'FAILED';
export type RunState = 'QUEUED' | 'RUNNING' | 'WAITING_FOR_USER' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type Presence = 'available' | 'busy' | 'away' | 'offline';
export type PresenceRun = {state:RunState;started_at?:string|null;heartbeat_at?:string|null};
export const busyPresenceDelayMs=120_000;
export function isLongRunningExecution(run:PresenceRun|undefined,now=Date.now()) {
 if(run?.state!=='RUNNING'||!run.started_at)return false;
 const startedAt=Date.parse(run.started_at);
 // Invalid or future timestamps must not turn a bot Busy; admission remains
 // server-authoritative regardless of this visual-only state.
 return Number.isFinite(startedAt)&&startedAt<=now&&now-startedAt>=busyPresenceDelayMs;
}
export function presence(computer: ComputerState, run?: RunState|PresenceRun, enabled = true, now=Date.now()): Presence {
  if (!enabled || computer === 'FAILED') return 'offline';
  const state=typeof run==='string'?run:run?.state;
  if (state === 'WAITING_FOR_USER') return 'away';
  if (state === 'RUNNING'&&isLongRunningExecution(typeof run==='string'?undefined:run,now)) return 'busy';
  if (computer === 'PAUSED') return 'away';
  return 'available'; // No computer yet is still ready to accept work.
}
export const presenceLabels = {available: 'Disponível', busy: 'Ocupado', away: 'Ausente', offline: 'Offline'};
export type Bot = {id: string; name: string; preset: string|null; description: string; role: string; instructions: string; instructions_version:number; avatar_id:string; computer_state: ComputerState; enabled: boolean; run_state?: RunState};
export type DeliveredArtifact = {id:string;run_id:string;name:string;mime_type:string;size_bytes:number;delivered_at:string};
export type Message = {id: string; sequence?: string; run_id?:string|null; role: 'user' | 'assistant' | 'system'; content: string; created_at: string; artifacts?:DeliveredArtifact[]};
export type WorkspaceMessage = Message & {bot_id:string};

export function attachDeliveredArtifacts(
  messages:readonly WorkspaceMessage[],
  runs:readonly {id:string;bot_id:string}[],
  artifacts:readonly DeliveredArtifact[],
) {
  const artifactsByRun=new Map<string,DeliveredArtifact[]>();
  for(const artifact of artifacts){const list=artifactsByRun.get(artifact.run_id)??[];list.push(artifact);artifactsByRun.set(artifact.run_id,list);}
  const assistantIndexByRun=new Map<string,number>();
  messages.forEach((message,index)=>{if(message.role==='assistant'&&message.run_id)assistantIndexByRun.set(message.run_id,index);});
  const hydrated=messages.map((message,index)=>{
    const delivered=message.run_id&&assistantIndexByRun.get(message.run_id)===index?artifactsByRun.get(message.run_id):undefined;
    return delivered?.length?{...message,artifacts:delivered}:message;
  });
  const runsById=new Map(runs.map(run=>[run.id,run]));
  for(const [runId,delivered] of artifactsByRun){
    if(assistantIndexByRun.has(runId))continue;
    const run=runsById.get(runId);if(!run)continue;
    hydrated.push({id:`artifact-${runId}`,bot_id:run.bot_id,run_id:runId,role:'assistant',content:'Arquivo entregue.',created_at:delivered.at(-1)?.delivered_at??'',artifacts:delivered});
  }
  return hydrated;
}
