import { z } from 'zod';
import { boundedJson,requireUser,sameOrigin } from '@/server/http';

const payload=z.object({stage:z.enum(['browser_admission_received','browser_answer_dom_ready']),elapsedMs:z.number().int().min(0).max(3600000)}).strict();

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
 if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
 const auth=await requireUser();if(auth.response)return auth.response;
 const {id}=await params;if(!z.uuid().safeParse(id).success)return Response.json({error:'Tarefa inválida.'},{status:400});
 let body:unknown;try{body=await boundedJson(request,256);}catch{return Response.json({error:'Dados inválidos.'},{status:400});}
 const parsed=payload.safeParse(body);if(!parsed.success)return Response.json({error:'Dados inválidos.'},{status:400});
 const {error}=await auth.db.rpc('record_chat_latency_client_measurement',{p_run_id:id,p_stage:parsed.data.stage,p_elapsed_ms:parsed.data.elapsedMs});
 if(error)return Response.json({error:'Não foi possível registrar a medição.'},{status:500});
 return new Response(null,{status:204,headers:{'Cache-Control':'private, no-store, max-age=0'}});
}
