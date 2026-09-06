import { z } from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {
  collaborationError,
  groupCreateInput,
  groupUpdateInput,
  handoffCreateInput,
  memoryCreateInput,
  memoryUpdateInput,
} from '@/domain/collaboration';
import {boundedJson,requireUser,sameOrigin} from './http';

const idSchema = z.uuid();
const deleteMemoryInput = z.object({expectedVersion:z.number().int().positive()}).strict();

function noStore<T>(body: T, status = 200) {
  return Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
}

function errorResponse(message: string, fallback?: string) {
  const error=collaborationError(message,fallback);
  return Response.json({error:error.message},{status:error.status,headers:{'Cache-Control':'private, no-store'}});
}

async function body(request: Request, maxBytes = 24_000) {
  try{return {value:await boundedJson(request,maxBytes)} as const;}
  catch{return {response:Response.json({error:'Dados inválidos ou muito longos.'},{status:400})} as const;}
}

async function readMemory(db: SupabaseClient, id: string) {
  return db.from('memory_items').select('id,bot_id,kind,current_version,created_at,updated_at,memory_versions(version,content,provenance,source_context,created_at,superseded_at)').eq('id',id).is('deleted_at',null).maybeSingle();
}

export async function memories(request:Request) {
  const auth=await requireUser();if(auth.response)return auth.response;
  if(request.method==='GET'){
    const url=new URL(request.url);const botId=url.searchParams.get('botId');const scope=url.searchParams.get('scope');
    if(botId&&!idSchema.safeParse(botId).success)return Response.json({error:'Contato inválido.'},{status:400});
    if(scope&&scope!=='user')return Response.json({error:'Filtro inválido.'},{status:400});
    let query=auth.db.from('memory_items').select('id,bot_id,kind,current_version,created_at,updated_at,memory_versions(version,content,provenance,source_context,created_at,superseded_at)').is('deleted_at',null).order('updated_at',{ascending:false}).limit(100);
    if(botId)query=query.eq('bot_id',botId);else if(scope==='user')query=query.is('bot_id',null);
    const {data,error}=await query;
    if(error)return errorResponse(error.message,'Não foi possível carregar as memórias.');
    return noStore({memories:data});
  }
  if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'GET, POST'}});
  if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
  const parsedBody=await body(request);if(parsedBody.response)return parsedBody.response;
  const parsed=memoryCreateInput.safeParse(parsedBody.value);
  if(!parsed.success)return Response.json({error:'Confira os dados da memória.'},{status:400});
  const input=parsed.data;
  const {data,error}=await auth.db.rpc('save_memory',{
    p_id:null,p_bot_id:input.botId,p_kind:input.kind,p_content:input.content,p_provenance:input.provenance,
    p_source_context:input.sourceContext,p_idempotency_key:input.idempotencyKey,p_expected_version:null,
  });
  if(error)return errorResponse(error.message);
  const saved=await readMemory(auth.db,data);
  if(saved.error)return errorResponse(saved.error.message,'A memória foi salva, mas não pôde ser carregada.');
  if(!saved.data)return errorResponse('MEMORY_NOT_FOUND');
  return noStore({memory:saved.data},201);
}

export async function memory(request:Request,id:string) {
  if(!idSchema.safeParse(id).success)return Response.json({error:'Memória inválida.'},{status:400});
  const auth=await requireUser();if(auth.response)return auth.response;
  if(request.method==='GET'){
    const result=await readMemory(auth.db,id);
    if(result.error)return errorResponse(result.error.message,'Não foi possível carregar a memória.');
    if(!result.data)return errorResponse('MEMORY_NOT_FOUND');
    return noStore({memory:result.data});
  }
  if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
  if(request.method==='PATCH'){
    const parsedBody=await body(request);if(parsedBody.response)return parsedBody.response;
    const parsed=memoryUpdateInput.safeParse(parsedBody.value);
    if(!parsed.success)return Response.json({error:'Confira os dados da memória.'},{status:400});
    const input=parsed.data;
    const {error}=await auth.db.rpc('save_memory',{
      p_id:id,p_bot_id:input.botId,p_kind:input.kind,p_content:input.content,p_provenance:input.provenance,
      p_source_context:input.sourceContext,p_idempotency_key:null,p_expected_version:input.expectedVersion,
    });
    if(error)return errorResponse(error.message);
    const saved=await readMemory(auth.db,id);
    if(saved.error)return errorResponse(saved.error.message,'A memória foi atualizada, mas não pôde ser carregada.');
    if(!saved.data)return errorResponse('MEMORY_NOT_FOUND');
    return noStore({memory:saved.data});
  }
  if(request.method==='DELETE'){
    const parsedBody=await body(request,1000);if(parsedBody.response)return parsedBody.response;
    const parsed=deleteMemoryInput.safeParse(parsedBody.value);
    if(!parsed.success)return Response.json({error:'Versão da memória inválida.'},{status:400});
    const {error}=await auth.db.rpc('delete_memory',{p_id:id,p_expected_version:parsed.data.expectedVersion});
    if(error)return errorResponse(error.message);
    return new Response(null,{status:204,headers:{'Cache-Control':'private, no-store'}});
  }
  return new Response(null,{status:405,headers:{Allow:'GET, PATCH, DELETE'}});
}

const groupSelection='id,name,created_at,updated_at,bot_group_memberships(bot_id,added_at,removed_at)';

export async function groups(request:Request) {
  const auth=await requireUser();if(auth.response)return auth.response;
  if(request.method==='GET'){
    const {data,error}=await auth.db.from('bot_groups').select(groupSelection).is('archived_at',null).order('updated_at',{ascending:false}).limit(100);
    if(error)return errorResponse(error.message,'Não foi possível carregar os grupos.');
    return noStore({groups:data});
  }
  if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'GET, POST'}});
  if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
  const parsedBody=await body(request,4000);if(parsedBody.response)return parsedBody.response;
  const parsed=groupCreateInput.safeParse(parsedBody.value);
  if(!parsed.success)return Response.json({error:'Confira o nome do grupo.'},{status:400});
  const {data,error}=await auth.db.rpc('save_bot_group',{p_id:null,p_name:parsed.data.name,p_idempotency_key:parsed.data.idempotencyKey});
  if(error)return errorResponse(error.message);
  const saved=await auth.db.from('bot_groups').select(groupSelection).eq('id',data).single();
  if(saved.error)return errorResponse(saved.error.message,'O grupo foi salvo, mas não pôde ser carregado.');
  return noStore({group:saved.data},201);
}

export async function group(request:Request,id:string) {
  if(!idSchema.safeParse(id).success)return Response.json({error:'Grupo inválido.'},{status:400});
  const auth=await requireUser();if(auth.response)return auth.response;
  if(request.method==='GET'){
    const result=await auth.db.from('bot_groups').select(groupSelection).eq('id',id).is('archived_at',null).single();
    if(result.error)return errorResponse(result.error.message.includes('0 rows')?'GROUP_NOT_FOUND':result.error.message,'Não foi possível carregar o grupo.');
    return noStore({group:result.data});
  }
  if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
  if(request.method==='PATCH'){
    const parsedBody=await body(request,2000);if(parsedBody.response)return parsedBody.response;
    const parsed=groupUpdateInput.safeParse(parsedBody.value);
    if(!parsed.success)return Response.json({error:'Confira o nome do grupo.'},{status:400});
    const {error}=await auth.db.rpc('save_bot_group',{p_id:id,p_name:parsed.data.name,p_idempotency_key:null});
    if(error)return errorResponse(error.message);
    const saved=await auth.db.from('bot_groups').select(groupSelection).eq('id',id).single();
    if(saved.error)return errorResponse(saved.error.message,'O grupo foi atualizado, mas não pôde ser carregado.');
    return noStore({group:saved.data});
  }
  if(request.method==='DELETE'){
    const {error}=await auth.db.rpc('archive_bot_group',{p_group_id:id});
    if(error)return errorResponse(error.message);
    return new Response(null,{status:204,headers:{'Cache-Control':'private, no-store'}});
  }
  return new Response(null,{status:405,headers:{Allow:'GET, PATCH, DELETE'}});
}

export async function groupMember(request:Request,groupId:string,botId:string) {
  if(!idSchema.safeParse(groupId).success||!idSchema.safeParse(botId).success)return Response.json({error:'Grupo ou contato inválido.'},{status:400});
  if(request.method!=='PUT'&&request.method!=='DELETE')return new Response(null,{status:405,headers:{Allow:'PUT, DELETE'}});
  if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
  const auth=await requireUser();if(auth.response)return auth.response;
  const {error}=await auth.db.rpc('set_bot_group_member',{p_group_id:groupId,p_bot_id:botId,p_active:request.method==='PUT'});
  if(error)return errorResponse(error.message);
  return request.method==='PUT'?noStore({groupId,botId,active:true}):new Response(null,{status:204,headers:{'Cache-Control':'private, no-store'}});
}

const handoffSelection='id,root_run_id,parent_handoff_id,source_bot_id,target_bot_id,group_id,task,budget_micros,depth,state,result,created_at,delivered_at,finished_at,handoff_source_messages(message_id)';

export async function handoffs(request:Request) {
  const auth=await requireUser();if(auth.response)return auth.response;
  if(request.method==='GET'){
    const url=new URL(request.url);const rootRunId=url.searchParams.get('rootRunId');const groupId=url.searchParams.get('groupId');
    if(rootRunId&&!idSchema.safeParse(rootRunId).success||groupId&&!idSchema.safeParse(groupId).success)return Response.json({error:'Filtro inválido.'},{status:400});
    let query=auth.db.from('bot_handoffs').select(handoffSelection).order('created_at',{ascending:true}).limit(100);
    if(rootRunId)query=query.eq('root_run_id',rootRunId);if(groupId)query=query.eq('group_id',groupId);
    const {data,error}=await query;
    if(error)return errorResponse(error.message,'Não foi possível carregar as delegações.');
    return noStore({handoffs:data});
  }
  if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'GET, POST'}});
  if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
  const parsedBody=await body(request,16_000);if(parsedBody.response)return parsedBody.response;
  const parsed=handoffCreateInput.safeParse(parsedBody.value);
  if(!parsed.success)return Response.json({error:'Confira os dados da delegação.'},{status:400});
  const input=parsed.data;
  const {data,error}=await auth.db.rpc('authorize_bot_handoff',{
    p_root_run_id:input.rootRunId,p_parent_handoff_id:input.parentHandoffId,p_source_bot_id:input.sourceBotId,
    p_target_bot_id:input.targetBotId,p_group_id:input.groupId,p_task:input.task,p_source_message_ids:input.sourceMessageIds,
    p_budget_micros:input.budgetMicros,p_idempotency_key:input.idempotencyKey,
  });
  if(error)return errorResponse(error.message);
  const saved=await auth.db.from('bot_handoffs').select(handoffSelection).eq('id',data).single();
  if(saved.error)return errorResponse(saved.error.message,'A delegação foi autorizada, mas não pôde ser carregada.');
  return noStore({handoff:saved.data},201);
}

export async function handoff(request:Request,id:string) {
  if(request.method!=='GET')return new Response(null,{status:405,headers:{Allow:'GET'}});
  if(!idSchema.safeParse(id).success)return Response.json({error:'Delegação inválida.'},{status:400});
  const auth=await requireUser();if(auth.response)return auth.response;
  const result=await auth.db.from('bot_handoffs').select(handoffSelection).eq('id',id).single();
  if(result.error)return errorResponse(result.error.message.includes('0 rows')?'HANDOFF_NOT_FOUND':result.error.message,'Não foi possível carregar a delegação.');
  return noStore({handoff:result.data});
}
