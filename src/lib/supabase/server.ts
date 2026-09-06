import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
export function authConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
export async function supabase() {
  if (!authConfigured()) throw new Error('AUTH_NOT_CONFIGURED');
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {getAll: () => store.getAll(), setAll: values => {
      try { values.forEach(({name,value,options}) => store.set(name,value,options)); }
      catch { /* Server components cannot write cookies; proxy performs refresh. */ }
    }},
  });
}
