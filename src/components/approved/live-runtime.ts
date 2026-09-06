export function draftAfterSuccessfulSend(current:string|undefined,submitted:string) {
 return current===submitted?'':current??'';
}

export function runAfterRequest<T>(runs:Record<string,T>|undefined,botId:string,run:T) {
 return {...runs,[botId]:run};
}

export function liveEntryState(alreadyEntered:boolean,mainWindowHidden:boolean) {
 return {entered:true,mainWindowHidden:alreadyEntered?mainWindowHidden:false,showOnboarding:!alreadyEntered};
}
