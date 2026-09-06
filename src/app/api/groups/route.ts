import {groups} from '@/server/collaboration';

export async function GET(request:Request){return groups(request);}
export async function POST(request:Request){return groups(request);}
