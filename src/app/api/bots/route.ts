import { saveBot } from '@/server/bot-profile';
export async function POST(request:Request){return saveBot(request);}
