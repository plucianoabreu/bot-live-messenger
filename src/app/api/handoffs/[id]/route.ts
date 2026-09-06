import {handoff} from '@/server/collaboration';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){return handoff(request,(await params).id);}
