import { ApprovedMessenger } from '@/components/approved/messenger';
import { supabase,authConfigured } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
export default async function ResetPassword(){
 if(!authConfigured())redirect('/');
 const db=await supabase();const {data,error}=await db.auth.getUser();if(error||!data.user)redirect('/?error=recovery');
 return <ApprovedMessenger authConfigured recovery/>;
}
