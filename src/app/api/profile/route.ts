import { requireUser,sameOrigin,boundedJson } from '@/server/http';
import { profileInput } from '@/domain/profiles';
export async function PATCH(request:Request){
 if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
 const auth=await requireUser();if(auth.response)return auth.response;
 let raw:unknown;try{raw=await boundedJson(request,2000);}catch{return Response.json({error:'Dados inválidos.'},{status:400});}
 const parsed=profileInput.safeParse(raw);if(!parsed.success)return Response.json({error:'Escolha uma imagem do catálogo.'},{status:400});
 const {error}=await auth.db.rpc('save_user_picture',{p_avatar_id:parsed.data.avatarId});
 if(error)return Response.json({error:'Não foi possível salvar sua imagem.'},{status:500});
 return Response.json({avatarId:parsed.data.avatarId},{headers:{'Cache-Control':'no-store'}});
}
