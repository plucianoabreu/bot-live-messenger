export type GroupMembership = {bot_id:string;removed_at:string|null};
export type ApiGroup = {
 id:string;
 name:string;
 created_at:string;
 updated_at:string;
 bot_group_memberships?:GroupMembership[];
};
export type UiGroup = {id:string;name:string;ids:string[];createdAt:string;updatedAt:string};

export type MemoryVersion = {version:number;content:string;provenance:string};
export type MemoryItem = {current_version:number;memory_versions?:MemoryVersion[]};

export type HandoffItem = {source_bot_id:string;target_bot_id:string;state:string};
export type HandoffSourceReference = {message_id:string};
export type MembershipChange = {groupId:string;groupName:string;active:boolean};
export type MembershipFailure = {change:MembershipChange;message:string};

const handoffLabels:Record<string,string> = {
 AUTHORIZED:'Autorizada',
 DELIVERED:'Entregue ao serviço',
 COMPLETED:'Concluída',
 FAILED:'Falhou',
 CANCELLED:'Interrompida',
};

export function groupFromApi(group:ApiGroup):UiGroup {
 return {
  id:group.id,
  name:group.name,
  ids:(group.bot_group_memberships??[]).filter(member=>!member.removed_at).map(member=>member.bot_id),
  createdAt:group.created_at,
  updatedAt:group.updated_at,
 };
}

export function activeMemoryVersion(memory:MemoryItem):MemoryVersion|undefined {
 return (memory.memory_versions??[]).find(version=>Number(version.version)===Number(memory.current_version));
}

export function handoffsForBot<T extends HandoffItem>(handoffs:T[],botId:string|null):T[] {
 const visible=botId?handoffs.filter(item=>item.source_bot_id===botId||item.target_bot_id===botId):handoffs;
 return [...visible].reverse();
}

export function handoffLabel(state:string):string {
 return handoffLabels[state]??state;
}

export function createGenerationGate() {
 let generation=0;
 return {
  next:()=>++generation,
  invalidate:()=>++generation,
  isCurrent:(candidate:number)=>candidate===generation,
 };
}

export function collaborationStorageMode(live:boolean):'authenticated'|'demo' {
 return live?'authenticated':'demo';
}

export function sourceMessagesForHandoff<T extends {id?:string}>(
 handoff:{handoff_source_messages?:HandoffSourceReference[]},
 messages:T[],
 limit=3,
):T[] {
 const allowed=new Set((handoff.handoff_source_messages??[]).map(reference=>reference.message_id));
 return messages.filter(message=>message.id&&allowed.has(message.id)).slice(0,limit);
}

export async function reconcileMembershipChanges(
 changes:MembershipChange[],
 mutate:(change:MembershipChange)=>Promise<unknown>,
 reload:()=>Promise<UiGroup[]>,
):Promise<{canonical:UiGroup[];failures:MembershipFailure[]}> {
 const settled=await Promise.allSettled(changes.map(change=>mutate(change)));
 const canonical=await reload();
 const failures=settled.flatMap((result,index)=>result.status==='rejected'?[{
  change:changes[index],
  message:result.reason instanceof Error?result.reason.message:'Não foi possível concluir esta alteração.',
 }]:[]);
 return {canonical,failures};
}
