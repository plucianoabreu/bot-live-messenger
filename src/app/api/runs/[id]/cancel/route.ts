import { requireUser, sameOrigin } from '@/server/http';
import { z } from 'zod';
const runFields='id,bot_id,kind,state,cancel_requested,error_code,created_at,finished_at';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
 if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
 const auth=await requireUser();if(auth.response)return auth.response;
 const {id}=await params;if(!z.uuid().safeParse(id).success)return Response.json({error:'Tarefa inválida.'},{status:400});
 const {error}=await auth.db.rpc('request_cancel',{p_run_id:id});
 if(error)return Response.json({error:'Não foi possível interromper esta tarefa.'},{status:error.message.includes('RUN_NOT_FOUND')?404:500});
 const result=await auth.db.from('runs').select(runFields).eq('id',id).maybeSingle();
 if(result.error)return Response.json({error:'A interrupção foi salva, mas o estado ainda não pôde ser carregado. Atualize a conversa.'},{status:500});
 if(!result.data)return Response.json({error:'Tarefa não encontrada.'},{status:404});
 return Response.json({accepted:true,run:result.data},{headers:{'Cache-Control':'private, no-store, max-age=0'}});
}
