import {memories} from '@/server/collaboration';

export async function GET(request:Request){return memories(request);}
export async function POST(request:Request){return memories(request);}
