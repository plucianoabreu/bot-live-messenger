import { ApprovedMessenger } from '@/components/approved/messenger';
import { authConfigured } from '@/lib/supabase/server';
export const dynamic='force-dynamic';
export default async function Home({searchParams}:{searchParams:Promise<{error?:string}>}){const {error}=await searchParams;return <ApprovedMessenger authConfigured={authConfigured()} initialError={error?'Não foi possível entrar. Tente novamente ou solicite outro link.':undefined}/>;}
