import {handoffs} from '@/server/collaboration';

export async function GET(request:Request){return handoffs(request);}
export async function POST(request:Request){return handoffs(request);}
