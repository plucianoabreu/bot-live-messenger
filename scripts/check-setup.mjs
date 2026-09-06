import { existsSync } from 'node:fs';
// Only report presence/validity. Never print credential values or make paid calls.
if(existsSync('.env.local'))process.loadEnvFile('.env.local');
const groups={
 identity:['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','APP_URL'],
 chat:['SUPABASE_SERVICE_ROLE_KEY','TRIGGER_SECRET_KEY','OPENAI_API_KEY','OPENAI_MODEL','OPENAI_INPUT_MICROS_PER_TOKEN','OPENAI_OUTPUT_MICROS_PER_TOKEN'],
 computer:['E2B_API_KEY','E2B_TEMPLATE_ID'],
};
let missing=false;
for(const [phase,keys] of Object.entries(groups)){
 const absent=keys.filter(key=>!process.env[key]?.trim());missing ||= absent.length>0;
 console.log(`${phase}: ${absent.length?'missing '+absent.join(', '):'configuration present; connectivity not verified'}`);
}
for(const key of ['NEXT_PUBLIC_SUPABASE_URL','APP_URL'])if(process.env[key]){
 try{const url=new URL(process.env[key]);if(!['http:','https:'].includes(url.protocol))throw new Error();}
 catch{missing=true;console.log(`${key}: invalid URL`);}
}
for(const key of ['OPENAI_INPUT_MICROS_PER_TOKEN','OPENAI_OUTPUT_MICROS_PER_TOKEN'])if(process.env[key]){
 const value=Number(process.env[key]);
 if(!Number.isFinite(value)||value<=0){missing=true;console.log(`${key}: must be a positive number`);}
}
console.log(`runtime admission: ${process.env.RUNS_ENABLED==='true'?'requested; hosted release gates must be verified separately':'disabled'}`);
console.log(`chat memory: ${process.env.MEMORY_ENABLED==='true'?'requested; collaboration migration and isolation must be verified separately':'disabled'}`);
console.log('Read-only check: no provider calls, external writes, projects, or migrations.');
process.exitCode=missing?1:0;
