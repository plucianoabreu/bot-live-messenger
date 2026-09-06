import {groupMember} from '@/server/collaboration';

type Context={params:Promise<{id:string;botId:string}>};
export async function PUT(request:Request,{params}:Context){const p=await params;return groupMember(request,p.id,p.botId);}
export async function DELETE(request:Request,{params}:Context){const p=await params;return groupMember(request,p.id,p.botId);}
