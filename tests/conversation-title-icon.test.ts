import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('conversation title bar uses the dedicated chat icon with a narrow fallback',async()=>{
 const runtime=await readFile(new URL('../src/components/approved/runtime.js',import.meta.url),'utf8');
 assert.match(runtime,/conversationTitleIcon\.src='\/assets\/titlebar-chats\.svg'/);
 assert.match(runtime,/icon\.src='\/assets\/messenger\.svg'/);
 assert.match(runtime,/else icon\.hidden=true/);

 for(const asset of ['titlebar-chats.svg','messenger.svg']){
  const contents=await readFile(new URL(`../public/assets/${asset}`,import.meta.url),'utf8');
  assert.match(contents,/<svg\b/);
 }
});
