import { z } from 'zod';
import { parseSequencePage } from '@/domain/runs';
import { requireUser } from '@/server/http';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
 const auth=await requireUser();if(auth.response)return auth.response;
 const {id}=await params;if(!z.uuid().safeParse(id).success)return Response.json({error:'Tarefa inválida.'},{status:400});
 let page;try{page=parseSequencePage(new URL(request.url).searchParams);}catch{return Response.json({error:'Cursor de eventos inválido.'},{status:400});}
 const run=await auth.db.from('runs').select('id,bot_id').eq('id',id).maybeSingle();
 if(run.error)return Response.json({error:'Não foi possível carregar os eventos.'},{status:500});
 if(!run.data)return Response.json({error:'Tarefa não encontrada.'},{status:404});
 const botId=run.data.bot_id;
 const result=await auth.db.from('run_events').select('id,schema_version,kind,summary,payload,created_at').eq('run_id',id)
  .gt('id',page.after).order('id').limit(page.limit+1);
 if(result.error)return Response.json({error:'Não foi possível carregar os eventos.'},{status:500});
 const rows=result.data??[],hasMore=rows.length>page.limit,events=rows.slice(0,page.limit).map(event=>({
  schemaVersion:event.schema_version,id:String(event.id),sequence:String(event.id),runId:id,botId,
  timestamp:event.created_at,type:event.kind,summary:event.summary,payload:event.payload,
 }));
 return Response.json({events,nextCursor:events.at(-1)?.sequence??page.after,hasMore},{headers:{'Cache-Control':'private, no-store, max-age=0'}});
}
