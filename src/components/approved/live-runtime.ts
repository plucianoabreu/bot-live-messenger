import type { RunSummary } from '../../domain/runs';

export function draftAfterSuccessfulSend(current:string|undefined,submitted:string) {
 return current===submitted?'':current??'';
}

export function draftAfterFailedSend(current:string|undefined,submitted:string) {
 return !current||current===submitted?submitted:current;
}

export function runAfterRequest<T>(runs:Record<string,T>|undefined,botId:string,run:T) {
 return {...runs,[botId]:run};
}

export function liveComposerState({offline,pending,live,runsEnabled}:{offline:boolean;pending:boolean;live:boolean;runsEnabled:boolean}) {
 const runtimeUnavailable=live&&!runsEnabled;
 return {
  inputDisabled:offline||runtimeUnavailable,
  sendDisabled:offline||pending||runtimeUnavailable,
  runtimeUnavailable,
 };
}

export function connectionControlState({live,offline}:{live:boolean;offline:boolean}) {
 return {showToggle:!live,showInlineConnect:offline&&!live};
}

type ActivityRun = {state?: RunSummary['state'];cancel_requested?: boolean};
/** RUNNING is aggregate execution state, not a reliable stream-composition signal. */
export function thinkingIndicatorText({live,name,pending,run}:{live:boolean;name:string;pending:boolean;run?:ActivityRun}) {
 const thinking=live ? run?.state==='RUNNING'&&!run.cancel_requested : pending;
 return thinking?`${name} está pensando...`:'';
}

/** A failed run remains actionable without turning normal lifecycle polling into toast noise. */
export function runFailureFeedbackText(run?:ActivityRun) {
 if(run?.state==='FAILED')return 'Não foi possível concluir a tarefa. Sua mensagem continua salva; tente novamente.';
 return '';
}

export type TranscriptMessage = {id?:string;author:string;text:string;clientId?:string;delivery?:'sending'|'failed'};
export function acceptedMessagesAfterSend<T extends TranscriptMessage>(messages:readonly T[],accepted:{id:string;content:string}) {
 if(messages.some(message=>message.id===accepted.id))return [...messages];
 return [...messages,{id:accepted.id,author:'user' as const,text:accepted.content.trim()}];
}

export function optimisticMessageId(idempotencyKey:string) {return `optimistic:${idempotencyKey}`;}

export function optimisticMessagesAfterSend(messages:readonly TranscriptMessage[],pending:{idempotencyKey:string;content:string}):TranscriptMessage[] {
 const clientId=optimisticMessageId(pending.idempotencyKey);
 const existing=messages.find(message=>message.clientId===clientId||message.id===clientId);
 if(existing)return messages.map(message=>(message.clientId===clientId||message.id===clientId)?{...message,delivery:'sending' as const}:message);
 return [...messages,{id:clientId,clientId,author:'user' as const,text:pending.content.trim(),delivery:'sending' as const}];
}

export function reconcileOptimisticMessage(messages:readonly TranscriptMessage[],accepted:{id:string;idempotencyKey:string;content:string}):TranscriptMessage[] {
 const clientId=optimisticMessageId(accepted.idempotencyKey);
 const confirmed={id:accepted.id,author:'user' as const,text:accepted.content.trim()};
 let replaced=false;
 const reconciled:TranscriptMessage[]=[];
 for(const message of messages){
  if(message.id===accepted.id||message.clientId===clientId||message.id===clientId){if(!replaced){replaced=true;reconciled.push(confirmed);}continue;}
  reconciled.push(message);
 }
 return replaced?reconciled:[...reconciled,confirmed];
}

export function failOptimisticMessage(messages:readonly TranscriptMessage[],idempotencyKey:string):TranscriptMessage[] {
 const clientId=optimisticMessageId(idempotencyKey);
 return messages.map(message=>(message.clientId===clientId||message.id===clientId)?{...message,delivery:'failed' as const}:message);
}

export function mergeLiveTranscript<T extends TranscriptMessage>(authoritative:readonly T[],local:readonly TranscriptMessage[]):TranscriptMessage[] {
 const authoritativeIds=new Set(authoritative.map(message=>message.id).filter(Boolean));
 return [...authoritative,...local.filter(message=>message.delivery&&!authoritativeIds.has(message.id))];
}

type DeliveredArtifact = {id:string;name:string;size_bytes:number};
export function deliveredFilesForMessage(artifacts:readonly DeliveredArtifact[]|undefined) {
 return (artifacts??[]).map(artifact=>({
  name:artifact.name,
  size:artifact.size_bytes,
  href:`/api/artifacts/${encodeURIComponent(artifact.id)}`,
 }));
}

export function deliveredFileMarkup(file:{name:string;size:number;href:string},formattedSize:string) {
 const escape=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
 return `<a class="message-file" href="${escape(file.href)}" download><img src="/assets/folder.svg" alt=""><span><strong>${escape(file.name)}</strong><small>${escape(formattedSize)} · Baixar arquivo entregue</small></span></a>`;
}

type V1ExcludedFeature = 'conversation-export' | 'watch' | 'groups' | 'delegation';
export function v1VisibleMenuItems<T extends {v1Feature?:V1ExcludedFeature}>(items:readonly T[]) {
 return items.filter(item=>!item.v1Feature);
}

export function liveEntryState(alreadyEntered:boolean,mainWindowHidden:boolean) {
 return {entered:true,mainWindowHidden:alreadyEntered?mainWindowHidden:false,showOnboarding:!alreadyEntered};
}

export type BrowserLatencyStage='browser_admission_received'|'browser_answer_dom_ready';
export function browserLatencyPayload(stage:BrowserLatencyStage,startedAt:number,now:number) {
 return {stage,elapsedMs:Math.max(0,Math.min(3600000,Math.round(now-startedAt)))};
}

type RunMessage = {author:string;runId?:string};
export function hasRenderedAssistantForRun(messages:readonly RunMessage[],runId:string) {
 return messages.some(message=>message.author==='agent'&&message.runId===runId);
}
