import { saveBot } from '@/server/bot-profile';
export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
 return saveBot(request,(await params).id);
}
