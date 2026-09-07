import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 createDesktopShortcutSelection,prepareV1Markup,prepareWelcomeMarkup,readWelcomePreference,welcomeDocumentState,welcomeMenuState,
 welcomePreferenceKey,writeWelcomePreference,
} from '../src/components/approved/runtime.js';
import {approvedMarkup} from '../src/components/approved/markup';

const runtime=readFileSync(new URL('../src/components/approved/runtime.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../src/app/globals.css',import.meta.url),'utf8');

function memoryStorage(){
 const values=new Map<string,string>();
 return {
  getItem(key:string){return values.get(key)??null;},
  setItem(key:string,value:string){values.set(key,value);},
 };
}

test('authenticated welcome visibility is stored per user while demo stays session-local',()=>{
 const storage=memoryStorage();
 const userA={live:true,userId:'user/a'};
 const userB={live:true,userId:'user/b'};
 assert.equal(readWelcomePreference(storage,userA),true);
 writeWelcomePreference(storage,userA,false);
 assert.equal(storage.getItem(welcomePreferenceKey('user/a')),'closed');
 assert.equal(readWelcomePreference(storage,userA),false);
 assert.equal(readWelcomePreference(storage,userB),true);
 writeWelcomePreference(storage,{live:false,userId:'demo'},false);
 assert.equal(readWelcomePreference(storage,{live:false,userId:'demo'}),true);
});

test('welcome preference safely falls back open when browser storage is unavailable',()=>{
 const storage={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
 assert.equal(readWelcomePreference(storage,{live:true,userId:'user-a'}),true);
 assert.doesNotThrow(()=>writeWelcomePreference(storage,{live:true,userId:'user-a'},false));
});

test('welcome markup contains one read-only document and disclosure before hydration',()=>{
 const prepared=prepareWelcomeMarkup(approvedMarkup);
 const preparedAgain=prepareWelcomeMarkup(prepared);
 assert.match(prepared,/<div id="welcome-mode-disclosure"[^>]*>[^<]+<\/div><textarea id="welcome-text" readonly/);
 assert.equal((preparedAgain.match(/id="welcome-mode-disclosure"/g)||[]).length,1);
 assert.equal((preparedAgain.match(/id="welcome-text"/g)||[]).length,1);
 assert.match(preparedAgain,/<textarea id="welcome-text" readonly/);
 assert.equal((preparedAgain.match(/id="welcome-notepad"/g)||[]).length,1);
 assert.match(runtime,/\$\('welcome-text'\)\.readOnly=true;/);
});

test('welcome guide and persistent disclosure match actual runtime availability',()=>{
 const demo=welcomeDocumentState();
 assert.equal(demo.mode,'demo');
 assert.match(demo.disclosure,/Demonstração local: conversas e tarefas são simuladas/);
 assert.doesNotMatch(demo.guide,/computador|Acompanhar|grupo|delega/i);

 const preparing=welcomeDocumentState({live:true,runsEnabled:false,watchAvailable:false});
 assert.equal(preparing.mode,'live');
 assert.match(preparing.disclosure,/tarefas ainda estão em preparação/);
 assert.doesNotMatch(preparing.guide,/Acompanhar|grupo|delega/i);

 const withoutWatch=welcomeDocumentState({live:true,runsEnabled:true,watchAvailable:false});
 assert.match(withoutWatch.disclosure,/conversas e tarefas estão disponíveis/);
 assert.doesNotMatch(withoutWatch.guide,/Acompanhar|grupo|delega/i);

 const withWatch=welcomeDocumentState({live:true,runsEnabled:true,watchAvailable:true});
 assert.equal(withWatch.disclosure,withoutWatch.disclosure);
 assert.equal(withWatch.guide,withoutWatch.guide);
});

test('V1 markup removes conversation export and excluded promises but keeps file downloads',()=>{
 const prepared=prepareV1Markup(approvedMarkup);
 assert.doesNotMatch(prepared,/data-command="history"/);
 assert.doesNotMatch(prepared,/Bots que colaboram|Acompanhe o trabalho/i);
 assert.match(prepared,/data-command="attach"/);
 assert.match(prepared,/id="dialog-download"/);
 assert.match(prepared,/id="welcome-download"/);
});

test('notepad menu state follows selection, wrapping, and font boundaries',()=>{
 assert.deepEqual(welcomeMenuState(),{canCopy:false,wrapChecked:true,canIncreaseFont:true,canDecreaseFont:true,defaultFont:true});
 assert.deepEqual(welcomeMenuState({selectionStart:2,selectionEnd:8,wrap:false,fontSize:22}),{canCopy:true,wrapChecked:false,canIncreaseFont:false,canDecreaseFont:true,defaultFont:false});
 assert.deepEqual(welcomeMenuState({selectionStart:8,selectionEnd:8,wrap:true,fontSize:11}),{canCopy:false,wrapChecked:true,canIncreaseFont:true,canDecreaseFont:false,defaultFont:false});
});

test('desktop shortcut selection persists independently from window focus',()=>{
 const selection=createDesktopShortcutSelection(['messenger','notepad']);
 assert.equal(selection.current(),null);
 assert.equal(selection.select('messenger'),'messenger');
 assert.equal(selection.isSelected('messenger'),true);
 // Focus transfer into the Messenger window does not mutate shortcut selection.
 assert.equal(selection.current(),'messenger');
 assert.equal(selection.select('unknown'),'messenger');
 assert.equal(selection.select('notepad'),'notepad');
 assert.equal(selection.isSelected('messenger'),false);
 assert.equal(selection.isSelected('notepad'),true);
});

test('notepad exposes historical menus and honest supported commands',()=>{
 assert.match(runtime,/\['Arquivo','Editar','Formatar','Exibir','Ajuda'\]/);
 assert.match(runtime,/\{label:'Novo',disabled:true\}/);
 assert.match(runtime,/\{label:'Recortar',disabled:true\}/);
 assert.match(runtime,/\{label:'Baixar como \.txt',action:downloadWelcome\}/);
 assert.match(runtime,/\{label:'Selecionar tudo',action:selectWelcomeAll\}/);
 assert.match(runtime,/\{label:'Quebra automática de linha',check:menuState\.wrapChecked/);
 assert.match(runtime,/\{label:'Aumentar fonte'.*setWelcomeFontSize/);
 assert.match(runtime,/id="minimize-welcome"/);
 assert.match(runtime,/button\.setAttribute\('aria-selected','false'\)/);
 assert.match(runtime,/button\.classList\.toggle\('selected',selected\);button\.setAttribute\('aria-selected',String\(selected\)\)/);
});

test('desktop windows are resizable within reachable viewport bounds',()=>{
 assert.match(css,/#main-window\{[^}]*max-width:calc\(100vw - 8px\)[^}]*resize:both/);
 assert.match(css,/\.welcome-notepad\{[^}]*max-width:calc\(100vw - 8px\)[^}]*max-height:calc\(100dvh - 8px\)[^}]*resize:both/);
 assert.match(runtime,/window\.addEventListener\('resize',[\s\S]*moveWindow/);
});
