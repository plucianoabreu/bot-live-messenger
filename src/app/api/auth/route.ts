import { z } from 'zod';
import { sameOrigin } from '@/server/http';
import { authConfigured, supabase } from '@/lib/supabase/server';
import { loginErrorResponse, signupErrorResponse } from '@/domain/auth-errors';
import { configuredAppOrigin } from '@/server/auth/callback';
const email=z.email().max(254);
const password=z.string().min(6).max(128);
const input=z.discriminatedUnion('action',[
 z.object({action:z.literal('login'),email,password,name:z.string().optional()}),
 z.object({action:z.literal('signup'),email,password,name:z.string().trim().min(1).max(48)}),
 z.object({action:z.literal('recover'),email}),
 z.object({action:z.literal('reset'),password}),
 z.object({action:z.literal('signout')}),
]);
export async function POST(request:Request){
 if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
 if(!authConfigured())return Response.json({error:'O acesso ainda está sendo preparado. Use a demonstração.'},{status:503});
 const reader=request.body?.getReader();if(!reader)return Response.json({error:'Dados inválidos.'},{status:400});
 let raw='',size=0;const decoder=new TextDecoder();
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();return Response.json({error:'Dados inválidos.'},{status:413});}raw+=decoder.decode(value,{stream:true});}
 raw+=decoder.decode();let json:unknown;try{json=JSON.parse(raw);}catch{return Response.json({error:'Dados inválidos.'},{status:400});}
 const parsed=input.safeParse(json);if(!parsed.success)return Response.json({error:'Confira os campos e tente novamente.'},{status:400});
 const body=parsed.data,db=await supabase();
 if(body.action==='signout'){
  const {error}=await db.auth.signOut();return Response.json(error?{error:'Não foi possível sair.'}:{ok:true},{status:error?500:200});
 }
 if(body.action==='login'){
  const {error}=await db.auth.signInWithPassword({email:body.email,password:body.password});
  if(error){const mapped=loginErrorResponse(error);return Response.json({error:mapped.message},{status:mapped.status});}
  return Response.json({ok:true},{status:200});
 }
 if(body.action==='reset'){
  const {data,error:authError}=await db.auth.getUser();if(authError||!data.user)return Response.json({error:'O link expirou. Solicite outro e-mail de recuperação.'},{status:401});
  const {error}=await db.auth.updateUser({password:body.password});
  return Response.json(error?{error:'Não foi possível alterar a senha. Tente outra senha.'}:{ok:true},{status:error?400:200});
 }
 const origin=configuredAppOrigin(process.env.APP_URL);if(!origin)return Response.json({error:'O acesso ainda está sendo preparado.'},{status:503});
 if(body.action==='recover'){
  const {error}=await db.auth.resetPasswordForEmail(body.email,{redirectTo:`${origin}/auth/callback?flow=recovery`});
  return Response.json(error?{error:'Não foi possível enviar agora. Tente novamente em instantes.'}:{ok:true},{status:error?429:200});
 }
 const {data,error}=await db.auth.signUp({email:body.email,password:body.password,options:{data:{full_name:body.name},emailRedirectTo:`${origin}/auth/callback`}});
 if(error){const mapped=signupErrorResponse(error);return Response.json({error:mapped.message},{status:mapped.status});}
 return Response.json({ok:true,confirmEmail:!data.session},{status:200});
}
