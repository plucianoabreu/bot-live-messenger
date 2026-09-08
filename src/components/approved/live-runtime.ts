export function draftAfterSuccessfulSend(current:string|undefined,submitted:string) {
 return current===submitted?'':current??'';
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

type TranscriptMessage = {id?:string;author:string;text:string};
export function acceptedMessagesAfterSend<T extends TranscriptMessage>(messages:readonly T[],accepted:{id:string;content:string}) {
 if(messages.some(message=>message.id===accepted.id))return [...messages];
 return [...messages,{id:accepted.id,author:'user' as const,text:accepted.content.trim()}];
}

type DeliveredArtifact = {id:string;name:string;size_bytes:number};
export function deliveredFilesForMessage(artifacts:readonly DeliveredArtifact[]|undefined) {
 return (artifacts??[]).map(artifact=>({
  name:artifact.name,
  size:artifact.size_bytes,
  href:`/api/artifacts/${encodeURIComponent(artifact.id)}`,
 }));
}

type V1ExcludedFeature = 'conversation-export' | 'watch' | 'groups' | 'delegation';
export function v1VisibleMenuItems<T extends {v1Feature?:V1ExcludedFeature}>(items:readonly T[]) {
 return items.filter(item=>!item.v1Feature);
}

export function liveEntryState(alreadyEntered:boolean,mainWindowHidden:boolean) {
 return {entered:true,mainWindowHidden:alreadyEntered?mainWindowHidden:false,showOnboarding:!alreadyEntered};
}
