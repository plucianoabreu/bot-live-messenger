import { z } from 'zod';
import { botProfileInput,createBotInput } from '@/domain/profiles';
import { requireUser,sameOrigin,boundedJson } from './http';

export async function saveBot(request:Request,id?:string) {
 if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
 const auth=await requireUser();if(auth.response)return auth.response;
 if(id&&!z.uuid().safeParse(id).success)return Response.json({error:'Contato inválido.'},{status:400});
 let raw:unknown;try{raw=await boundedJson(request);}catch{return Response.json({error:'Dados inválidos ou muito longos.'},{status:400});}
 const parsed=(id?botProfileInput:createBotInput).safeParse(raw);
 if(!parsed.success)return Response.json({error:'Confira nome, função, instruções e imagem do bot.'},{status:400});
 const p=parsed.data;
 const {data,error}=await auth.db.rpc('save_bot_profile',{
  p_id:id??null,p_name:p.name,p_role:p.role,p_description:p.description,p_instructions:p.instructions,
  p_avatar_id:p.avatarId,p_creation_key:'idempotencyKey' in p?p.idempotencyKey:null,
 });
 if(error){
  const code=error.message;
  if(code.includes('BOT_NOT_FOUND'))return Response.json({error:'Contato não encontrado.'},{status:404});
  if(code.includes('BOT_LIMIT'))return Response.json({error:'Você atingiu o limite de 20 bots personalizados.'},{status:429});
  if(code.includes('IDEMPOTENCY_CONFLICT'))return Response.json({error:'Este envio já foi usado. Feche e abra o formulário para criar outro bot.'},{status:409});
  if(code.includes('INVALID_'))return Response.json({error:'Confira os dados do bot.'},{status:400});
  return Response.json({error:'Não foi possível salvar o bot.'},{status:500});
 }
 const result=await auth.db.from('bots').select('id,name,preset,role,description,instructions,instructions_version,avatar_id,enabled,computer_state').eq('id',data).single();
 if(result.error)return Response.json({error:'O perfil foi salvo. Atualize a lista para carregá-lo.'},{status:500});
 return Response.json({bot:result.data},{status:id?200:201,headers:{'Cache-Control':'no-store'}});
}
