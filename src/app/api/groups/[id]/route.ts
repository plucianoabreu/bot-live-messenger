import {group} from '@/server/collaboration';

type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context){return group(request,(await params).id);}
export async function PATCH(request:Request,{params}:Context){return group(request,(await params).id);}
export async function DELETE(request:Request,{params}:Context){return group(request,(await params).id);}
