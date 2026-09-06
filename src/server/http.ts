import { supabase, authConfigured } from '@/lib/supabase/server';
export async function requireUser() {
 if(!authConfigured()) return {response:Response.json({error:'O acesso ainda está sendo preparado.'},{status:503})} as const;
 const db=await supabase(); const {data,error}=await db.auth.getUser();
 if(error || !data.user) return {response:Response.json({error:'Entre para continuar.'},{status:401})} as const;
 return {db,user:data.user} as const;
}
export function sameOrigin(request: Request) {
 const origin=request.headers.get('origin');
 return origin===new URL(request.url).origin || Boolean(process.env.APP_URL && origin===new URL(process.env.APP_URL).origin);
}

export async function boundedJson(request:Request, maxBytes=24000):Promise<unknown> {
 const reader=request.body?.getReader();if(!reader)throw new Error('INVALID_BODY');
 let size=0,body='';const decoder=new TextDecoder();
 try {
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
   if(size>maxBytes){await reader.cancel();throw new Error('BODY_TOO_LARGE');}
   body+=decoder.decode(value,{stream:true});
  }
  return JSON.parse(body+decoder.decode());
 }finally{reader.releaseLock();}
}
