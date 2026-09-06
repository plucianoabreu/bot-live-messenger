import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/server';
export async function GET(request:Request) {
  const code=new URL(request.url).searchParams.get('code');
  const origin=process.env.APP_URL;
  if(!origin) return new Response('Configuração indisponível',{status:503});
  if(code) {
    const client=await supabase();
    const {error}=await client.auth.exchangeCodeForSession(code);
    if(!error) return NextResponse.redirect(`${origin}/${new URL(request.url).searchParams.get('flow')==='recovery'?'reset-password':'messenger'}`);
  }
  return NextResponse.redirect(`${origin}/?error=signin`);
}
