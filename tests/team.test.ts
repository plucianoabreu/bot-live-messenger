import { PGlite } from '@electric-sql/pglite';
import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPicture,displayPictures,pictureUrl,botProfileInput } from '../src/domain/profiles';
import { presets } from '../src/domain/bots';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('catalog preserves all original bytes and includes static GIF previews',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../docs/display-pictures-manifest.json',import.meta.url),'utf8'));
 assert.equal(displayPictures.length,30);
 for(const asset of manifest.assets){
  assert.ok(displayPictures.includes(asset.file));
  const bytes=await readFile(new URL('../public/assets/display-pictures/'+asset.file,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
  if(asset.file.endsWith('.gif'))assert.ok((await readFile(new URL('../public'+pictureUrl(asset.file,true),import.meta.url))).length>0);
 }
 assert.equal(pictureUrl('../private'),pictureUrl(defaultPicture));
 assert.equal(botProfileInput.safeParse({name:'AI Test Engineer',role:'Engineer',description:'Test',instructions:'Test',avatarId:'https://tracker.test/image'}).success,false);
});

test('team profiles are durable, scoped and idempotent; one shared computer; root quotas span bots',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;insert into auth.users values('${A}'),('${B}');`);
 const directory=new URL('../supabase/migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
 const asUser=async(id:string)=>db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false);`);
 await asUser(A);await db.query('select public.ensure_bots()');
 const original=(await db.query<{id:string}>('select id from public.bots order by preset')).rows;
 assert.equal(original.length,10);
 const catalog=(await db.query<{preset:string;avatar_id:string}>('select preset,avatar_id from public.preset_catalog')).rows;
 for(const preset of presets)assert.equal(catalog.find(p=>p.preset===preset.preset)?.avatar_id,preset.avatarId);
 assert.equal((await db.query('select user_id,state from public.workspace_computers')).rows.length,1);
 await assert.rejects(()=>db.query('select provider_id from public.workspace_computers'),/permission denied/);
 await assert.rejects(()=>db.query("update public.preset_catalog set instructions='override'"),/permission denied/);
 const key=crypto.randomUUID();
 const values=[null,'AI Einstein Research','Research','Pesquisa personalizada','Original instructions',displayPictures[0],key];
 const save=(v:unknown[])=>db.query<{id:string}>('select public.save_bot_profile($1,$2,$3,$4,$5,$6,$7) as id',v);
 const id=(await save(values)).rows[0].id;assert.equal((await save(values)).rows[0].id,id);
 await assert.rejects(()=>save([null,'AI Other Research',...values.slice(2)]),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(()=>save([null,...values.slice(1,5),'missing.png',crypto.randomUUID()]),/INVALID_BOT_PROFILE/);
 await db.query('select public.save_user_picture($1)',[displayPictures[1]]);
 await db.query('select public.ensure_bots()');
 assert.equal((await db.query('select id from public.bots')).rows.length,11);
 assert.equal((await db.query<{avatar_id:string}>('select avatar_id from public.profiles')).rows[0].avatar_id,displayPictures[1]);
 await asUser(B);await db.query('select public.ensure_bots()');
 assert.equal((await db.query('select id from public.bots where id=$1',[id])).rows.length,0);
 await assert.rejects(()=>save([id,...values.slice(1)]),/BOT_NOT_FOUND/);
 assert.equal((await db.query<{avatar_id:string}>('select avatar_id from public.profiles')).rows[0].avatar_id,defaultPicture);
 assert.equal((await db.query<{user_id:string}>('select user_id,state from public.workspace_computers')).rows[0].user_id,B);
 await db.exec('reset role;update public.runtime_config set runs_enabled=true;');await asUser(A);
 const enqueue=(bot:string)=>db.query<{id:string}>("select public.enqueue_message($1,'Task',$2) as id",[bot,crypto.randomUUID()]);
 const root=(await enqueue(id)).rows[0].id;
 await save([id,values[1],values[2],values[3],'Revised instructions',displayPictures[2],null]);
 assert.equal((await db.query<{instructions_snapshot:string}>('select instructions_snapshot from public.runs where id=$1',[root])).rows[0].instructions_snapshot,'Original instructions');
 const snapshot=(await db.query<{bot_identity_snapshot:{name:string;role:string;description:string;instructions:string}}>('select bot_identity_snapshot from public.runs where id=$1',[root])).rows[0].bot_identity_snapshot;
 assert.deepEqual(snapshot,{name:'AI Einstein Research',role:'Research',description:'Pesquisa personalizada',instructions:'Original instructions'});
 assert.equal((await db.query<{instructions_version:number}>('select instructions_version from public.bots where id=$1',[id])).rows[0].instructions_version,2);
 const two=(await enqueue(original[0].id)).rows[0].id,three=(await enqueue(original[1].id)).rows[0].id;
 await assert.rejects(()=>enqueue(original[2].id),/USER_CONCURRENCY/);
 for(const run of [root,two,three])await db.query('select public.request_cancel($1)',[run]);
 for(let i=2;i<7;i++){const run=(await enqueue(original[i].id)).rows[0].id;await db.query('select public.request_cancel($1)',[run]);}
 await assert.rejects(()=>enqueue(original[7].id),/WELCOME_QUOTA/);
 await db.exec('reset role;');
 assert.equal(Number((await db.query<{allocated_micros:string}>("select allocated_micros from public.pilot_budgets where kind='chat'")).rows[0].allocated_micros),160000);
 assert.equal((await db.query('select * from public.workspace_computers')).rows.length,2);
 }finally{await db.close();}
});
