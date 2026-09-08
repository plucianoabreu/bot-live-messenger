import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/server';
import { planAuthCallback } from '@/server/auth/callback';
export async function GET(request:Request) {
  const plan=planAuthCallback(request.url,process.env.APP_URL);
  if(plan.kind==='configuration_error') return new Response('Configuração indisponível',{status:503});
  if(plan.kind==='signin_error') return NextResponse.redirect(plan.redirectUrl);
  if(plan.kind==='exchange') {
    const client=await supabase();
    const {error}=await client.auth.exchangeCodeForSession(plan.code);
    if(!error) return NextResponse.redirect(plan.successRedirectUrl);
  }
  return NextResponse.redirect(plan.failureRedirectUrl);
}
