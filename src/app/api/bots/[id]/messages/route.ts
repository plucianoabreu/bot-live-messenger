import { configure, tasks } from '@trigger.dev/sdk';
import type { chatTask } from '@/trigger/chat';
import { requireUser, sameOrigin } from '@/server/http';
import { messageInput, parseSequencePage } from '@/domain/runs';
import { z } from 'zod';
const noStore={'Cache-Control':'private, no-store, max-age=0'};
// Production credentials can be introduced without removing the preview/dev binding.
if(process.env.TRIGGER_PRODUCTION_SECRET_KEY)configure({secretKey:process.env.TRIGGER_PRODUCTION_SECRET_KEY});
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
 const auth=await requireUser();if(auth.response)return auth.response;
 const {id}=await params;if(!z.uuid().safeParse(id).success)return Response.json({error:'Contato inválido.'},{status:400});
 let page;try{page=parseSequencePage(new URL(request.url).searchParams);}catch{return Response.json({error:'Cursor de mensagens inválido.'},{status:400});}
 const owned=await auth.db.from('bots').select('id').eq('id',id).maybeSingle();
 if(owned.error)return Response.json({error:'Não foi possível carregar a conversa.'},{status:500});
 if(!owned.data)return Response.json({error:'Contato não encontrado.'},{status:404});
 const result=await auth.db.from('messages').select('id,sequence,role,content,created_at').eq('bot_id',id)
  .gt('sequence',page.after).order('sequence').limit(page.limit+1);
 if(result.error)return Response.json({error:'Não foi possível carregar a conversa.'},{status:500});
 const rows=result.data??[],hasMore=rows.length>page.limit,messages=rows.slice(0,page.limit).map(message=>({...message,sequence:String(message.sequence)}));
 return Response.json({messages,nextCursor:messages.at(-1)?.sequence??page.after,hasMore},{headers:noStore});
}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
 const admissionStartedAt=performance.now();
 if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
 const auth=await requireUser();if(auth.response)return auth.response;
 const {id}=await params;if(!z.uuid().safeParse(id).success)return Response.json({error:'Contato inválido.'},{status:400});
 if(process.env.RUNS_ENABLED!=='true')return Response.json({error:'As tarefas ainda não estão disponíveis.'},{status:503});
 // Bound input before parsing to avoid unbounded JSON bodies.
 const reader=request.body?.getReader();if(!reader)return Response.json({error:'Mensagem inválida.'},{status:400});
 let bytes=0;let raw='';const decoder=new TextDecoder();
 while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>40000){await reader.cancel();return Response.json({error:'Mensagem muito longa.'},{status:413});}raw+=decoder.decode(value,{stream:true});}
 raw+=decoder.decode();
 let body:unknown;try{body=JSON.parse(raw);}catch{return Response.json({error:'Mensagem inválida.'},{status:400});}
 const parsed=messageInput.safeParse(body);if(!parsed.success)return Response.json({error:'Escreva uma mensagem de até 8.000 caracteres.'},{status:400});
 if(parsed.data.kind!=='chat')return Response.json({error:'O computador ainda está sendo preparado.'},{status:503});
 const {data,error}=await auth.db.rpc('enqueue_message',{p_bot_id:id,p_content:parsed.data.content,p_idempotency_key:parsed.data.idempotencyKey,p_kind:parsed.data.kind});
 if(error){
  const errors:Record<string,[number,string]>={BOT_NOT_FOUND:[404,'Contato não encontrado.'],RUN_ALREADY_OPEN:[409,'Espere a tarefa atual terminar.'],USER_CONCURRENCY:[429,'Você já tem três tarefas em andamento.'],WELCOME_QUOTA:[429,'Você usou sua cota de boas-vindas para este recurso.'],PILOT_BUDGET_EXHAUSTED:[429,'As experiências gratuitas estão pausadas. Suas conversas continuam disponíveis.'],IDEMPOTENCY_CONFLICT:[409,'Este envio já foi usado para outra mensagem.'],RUNTIME_DISABLED:[503,'As tarefas ainda não estão disponíveis.']};
  const [status,message]=Object.entries(errors).find(([code])=>error.message.includes(code))?.[1]??[500,'Não foi possível enviar. Tente novamente.'];
  return Response.json({error:message},{status});
 }
 const recordAdmission=async(stage:'admission_enqueued'|'dispatch_completed')=>{
  if(process.env.LATENCY_DIAGNOSTICS!=='true')return;
  const elapsedMs=Math.max(0,Math.min(3600000,Math.round(performance.now()-admissionStartedAt)));
  try{await auth.db.rpc('record_chat_latency_client_measurement',{p_run_id:data,p_stage:stage,p_elapsed_ms:elapsedMs});}catch{/* Diagnostics never change admission. */}
 };
 await recordAdmission('admission_enqueued');
 // Committed runs remain in the outbox if dispatch fails. The reconciler can recover them.
 try { await tasks.trigger<typeof chatTask>('bot-messenger-chat',{runId:data},{idempotencyKey:data});await recordAdmission('dispatch_completed'); }
 catch { console.error('CHAT_DISPATCH_PENDING'); }
 const [runResult,messageResult]=await Promise.all([
  auth.db.from('runs').select('id,bot_id,kind,state,cancel_requested,error_code,created_at,finished_at').eq('id',data).single(),
  auth.db.from('messages').select('id').eq('run_id',data).eq('role','user').single(),
 ]);
 if(runResult.error||messageResult.error)return Response.json({error:'A tarefa foi salva, mas o estado ainda não pôde ser carregado. Tente atualizar.'},{status:500,headers:noStore});
 return Response.json({messageId:messageResult.data.id,runId:data,status:runResult.data.state,run:{...runResult.data,started_at:null}},{status:202,headers:noStore});
}
