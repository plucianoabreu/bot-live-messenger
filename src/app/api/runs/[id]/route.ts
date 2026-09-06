import { z } from 'zod';
import { requireUser } from '@/server/http';

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}) {
 const auth=await requireUser();if(auth.response)return auth.response;
 const {id}=await params;if(!z.uuid().safeParse(id).success)return Response.json({error:'Tarefa inválida.'},{status:400});
 const result=await auth.db.from('runs').select('id,bot_id,kind,state,cancel_requested,error_code,created_at,finished_at').eq('id',id).maybeSingle();
 if(result.error)return Response.json({error:'Não foi possível carregar a tarefa.'},{status:500});
 if(!result.data)return Response.json({error:'Tarefa não encontrada.'},{status:404});
 return Response.json({run:result.data},{headers:{'Cache-Control':'private, no-store, max-age=0'}});
}
