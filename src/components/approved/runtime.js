// DOM controller ported from the approved prototype, isolated to one React-owned host.
// Mock behavior is restricted to the explicit demonstration; live mode uses authorized APIs.
import { presence } from '../../domain/bots';
import { displayPictures, defaultPicture, pictureUrl, botProfileInput } from '../../domain/profiles';
import { isActiveRun } from '../../domain/runs';
import { acceptedMessagesAfterSend, deliveredFilesForMessage, draftAfterSuccessfulSend, liveComposerState, liveEntryState, runAfterRequest, v1VisibleMenuItems } from './live-runtime';
import {
 activeMemoryVersion,collaborationStorageMode,createGenerationGate,groupFromApi,handoffLabel,handoffsForBot,
 reconcileMembershipChanges,sourceMessagesForHandoff,
} from './collaboration-ui';

export const welcomePreferenceKey = userId => `bot-messenger.welcome.${encodeURIComponent(userId)}.open`;
export function readWelcomePreference(storage,{live,userId}) {
 if(!live||!userId)return true;
 try{return storage.getItem(welcomePreferenceKey(userId))!=='closed';}catch{return true;}
}
export function writeWelcomePreference(storage,{live,userId},open) {
 if(!live||!userId)return;
 try{storage.setItem(welcomePreferenceKey(userId),open?'open':'closed');}catch{/* Presentation preferences are optional when storage is unavailable. */}
}
export function welcomeDocumentState({live=false,runsEnabled=false}={}) {
 const tracking=live&&runsEnabled
  ? '4. Confira o andamento na conversa.'
  : live
   ? '4. As tarefas reais ainda estão em preparação.'
   : '4. Confira a resposta simulada na conversa.';
 const controls=live&&!runsEnabled
  ? '5. Quando as tarefas forem habilitadas, você poderá usar Parar.'
  : live
   ? '5. Use Parar quando quiser interromper uma tarefa.'
   : '5. Use Parar para interromper uma tarefa simulada.\n6. Confira a resposta simulada na conversa.';
 const context=live
  ? '6. Volte à conversa para continuar com o histórico salvo e baixar arquivos entregues.'
  : '7. Volte à conversa para continuar enquanto esta demonstração estiver aberta.';
 const disclosure=!live
  ? 'Demonstração local: conversas e tarefas são simuladas; nenhum trabalho é executado no computador.'
  : runsEnabled
   ? 'Conta conectada: conversas e tarefas estão disponíveis.'
   : 'Conta conectada: conversas salvas; tarefas ainda estão em preparação.';
 const availability=live&&!runsEnabled
  ? '\n\nMODO ATUAL\nAs tarefas reais ainda não estão disponíveis nesta conta. Para testar uma conversa agora, saia e escolha a demonstração local.'
  : live
   ? '\n\nLIMITES DO PILOTO\nSua conta pode iniciar até 5 tarefas de chat durante este piloto. O saldo restante ainda não aparece nesta tela.'
   : '';
 return {mode:live?'live':'demo',disclosure,guide:`COMO USAR O BOT MESSENGER
${availability}

1. Escolha um bot na lista e abra a conversa.
2. Diga o que você precisa e como quer receber o resultado.
3. Para criar um bot, clique em Adicionar bot e defina sua função.
${tracking}
${controls}
${context}

Fechou este guia? Clique em Bloco de Notas no desktop para reabrir.`};
}
export function welcomeMenuState({selectionStart=0,selectionEnd=0,wrap=true,fontSize=14}={}) {
 return {canCopy:selectionEnd>selectionStart,wrapChecked:wrap,canIncreaseFont:fontSize<22,canDecreaseFont:fontSize>11,defaultFont:fontSize===14};
}
export function createDesktopShortcutSelection(ids) {
 const allowed=new Set(ids);let selected=null;
 return {select(id){if(allowed.has(id))selected=id;return selected;},isSelected(id){return selected===id;},current(){return selected;}};
}
export function prepareWelcomeMarkup(markup,live=false) {
 const disclosure=welcomeDocumentState({live}).disclosure;
 let prepared=markup.replace(/<textarea id="welcome-text"(?![^>]*\breadonly\b)/,'<textarea id="welcome-text" readonly');
 if(!prepared.includes('id="welcome-mode-disclosure"'))prepared=prepared.replace('<textarea id="welcome-text"',
  `<div id="welcome-mode-disclosure" class="welcome-mode-disclosure" role="status" aria-live="polite">${disclosure}</div><textarea id="welcome-text"`);
 return prepared;
}
export function prepareV1Markup(markup) {
 return markup
  .replace(/<button\b[^>]*data-command="history"[^>]*>[\s\S]*?<\/button>/g,'')
  .replace('BOTS DE IA COM UM COMPUTADOR PARA TRABALHAR POR VOCÊ.','BOTS DE IA PARA CONVERSAR COM VOCÊ.')
  .replace('• Você pede. Sua equipe trabalha na tarefa.','• Você conversa diretamente com cada bot.')
  .replace('O QUE ESTAMOS CONSTRUINDO\n• Um computador na nuvem para seus bots.\n• Pesquisa em sites e trabalho com arquivos.\n• Relatórios, planilhas e apresentações.\n• Bots que colaboram e compartilham contexto.','O QUE VOCÊ PODE TESTAR\n• Conversas diretas com bots especialistas.\n• Bots personalizados com funções e instruções próprias.')
  .replace('• Quem quer delegar etapas do trabalho.\n','')
  .replace('3. Acompanhe o trabalho na conversa.','3. Confira a resposta na conversa.')
  .replace('• Hoje: interface, personalização e respostas simuladas.\n• Em construção: IA real e execução no computador.','• Conta conectada: a disponibilidade das tarefas aparece depois de entrar.\n• Demonstração local: respostas simuladas, sem execução externa.');
}
export function mountMessenger(host, initialOptions = {}) {
let options=initialOptions;
let liveEntered=false;
const abort=new AbortController();
const timers=new Set();
const setTimeout=(callback,delay)=>{const id=window.setTimeout(()=>{timers.delete(id);callback();},delay);timers.add(id);return id;};
const clearTimeout=id=>{window.clearTimeout(id);timers.delete(id);};
const livePending=new Set();
const requestKeys=new Map();
const previousScene=document.body.dataset.scene;
const collaborationMode=()=>collaborationStorageMode(Boolean(options.live));


// Contact catalog: edit names, initial presence, avatars and descriptions here.
const agents = [
 {id:'grok',name:'AI Sócrates Strategy',status:'available',avatar:'/assets/fox.svg',description:'Seu parceiro de IA para ideias maiores.'},
 {id:'code-assistant',avatar:'/assets/robot.svg',name:'AI Turing Engineer',status:'available',symbol:'{ }',color:'#4d98c0',description:'Uma boa ideia começa com uma boa conversa.'},
 {id:'reviewer',avatar:'/assets/monitor.svg',name:'AI Hopper Reviewer',status:'available',symbol:'✓',color:'#7587ab',description:'Um segundo olhar para cada detalhe.'},
 {id:'designer',avatar:'/assets/palette.svg',name:'AI Da Vinci Design',status:'away',symbol:'✿',color:'#cc91ac',description:'Dando forma às suas ideias.'},
 {id:'sql',avatar:'/assets/database.svg',name:'AI Codd Data',status:'available',symbol:'▤',color:'#69adb3',description:'Vamos encontrar a resposta nos dados.'},
 {id:'research',avatar:'/assets/search.svg',name:'AI Curie Research',status:'available',symbol:'⌕',color:'#a18db3',description:'Sempre tem algo novo para descobrir.'},
 {id:'memory',avatar:'/assets/memory.svg',name:'AI Buffett Finance',status:'away',symbol:'▣',color:'#c6a667',description:'Clareza para suas finanças e seus números.'},
 {id:'browser',avatar:'/assets/globe.svg',name:'AI Kotler Marketing',status:'available',symbol:'◎',color:'#5ba4cc',description:'Conectando sua marca às pessoas certas.'},
 {id:'devops',avatar:'/assets/gear.svg',name:'AI Hamilton Engineer',status:'available',symbol:'⚙',color:'#7d98ab',description:'Cuidando de tudo nos bastidores.'},
 {id:'cleaner',avatar:'/assets/database.svg',name:'AI Nightingale Analytics',status:'offline',symbol:'▦',color:'#8ea8b0',description:'Este bot está desconectado.'},
 {id:'support',avatar:'/assets/robot.svg',name:'AI Carnegie Support',status:'offline',symbol:'?',color:'#8ea8b0',description:'Este bot está desconectado.'},
 {id:'translation',avatar:'/assets/memory.svg',name:'AI Humboldt Translation',status:'offline',symbol:'文',color:'#8ea8b0',description:'Este bot está desconectado.'},
 {id:'vision',avatar:'/assets/search.svg',name:'AI Shannon Vision',status:'offline',symbol:'◉',color:'#8ea8b0',description:'Este bot está desconectado.'}
];

const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
const portraitUrl=id=>pictureUrl(id,reducedMotion.matches);
agents.forEach((bot,index)=>{bot.avatar_id=displayPictures[index];bot.avatar=portraitUrl(bot.avatar_id);});
const windows=new Map();let windowOrder=20;
const rootWindow=host.querySelector('#conversation-window');
const registeredListeners=[];
function listen(element,type,handler,options){element.addEventListener(type,handler,options);registeredListeners.push({element,type,handler,options});}
const $ = id => {
 const active=windows.get(state.active);
 if(active){if(id==='conversation-window')return active;const local=active.querySelector(`[data-part="${id}"],#${id}`);if(local)return local;}
 return host.querySelector(`#${id}`);
};
host.querySelector('.primary-toolbar [data-command="instructions"]')?.insertAdjacentHTML('afterend','<button data-command="memory"><img src="/assets/memory.svg" alt="">Memória</button>');
const statusLabels = {available:'Disponível',busy:'Ocupado',away:'Ausente',offline:'Offline'};
const defaultInstructions = {
  grok:'Ajude a transformar ideias em planos claros. Faça perguntas quando faltar contexto. Separe hipóteses de fatos e proponha um próximo passo concreto.',
  'code-assistant':'Ajude a construir software. Explique as mudanças propostas e prefira soluções simples e verificáveis.',
  reviewer:'Revise o código enviado. Priorize problemas reais, explique o impacto e sugira correções pequenas.',
  designer:'Avalie hierarquia, legibilidade e consistência visual. Transforme o feedback em mudanças específicas.',
  sql:'Ajude a explorar dados e escrever consultas SQL. Confirme tabelas e colunas antes de propor uma consulta.',
  memory:'Ajude a organizar receitas, custos e premissas financeiras. Explique os cálculos e explicite as informações que faltam.',
  browser:'Ajude a definir público, posicionamento e campanhas de marketing. Conecte cada proposta a um objetivo e uma forma de avaliar resultados.',
  research:'Pesquise a pergunta recebida. Distingua evidência, hipótese e lacunas. Inclua as fontes quando houver pesquisa real.'
};
const state = {
  tabs: [], active: null, favorites: new Set(['grok','code-assistant']),
  collapsed: new Set(), customGroups: [], filter:'all', compact:false, showOffline:true,
  userStatus:'available', userAvatar:portraitUrl(defaultPicture), userAvatarId:defaultPicture, scene:'blue', sound:false,
  personalMessage:'Ouvindo: thinking...', drafts:{}, attachments:{}, bold:{},
  jobs:new Map(), unread:new Set(), activity:[], instructions:{...defaultInstructions},
  messages:{grok:[
    {author:'agent',text:'Beleza. Me fala o que o bot precisa fazer.'},
    {author:'user',text:'quero um IDE no estilo MSN pra falar com bots'}
  ]}
};
const agentById = id => agents.find(agent => agent.id === id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const timeNow = () => new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
const isFavorite = id => state.favorites.has(id);
const prettySize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const formatDate = value => value ? new Date(value).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}) : 'Ainda não registrado';

function avatar(agent) {
  return `<span class="avatar-frame ${agent.status}"><img data-catalog-picture="${escapeHTML(agent.avatar_id||defaultPicture)}" src="${escapeHTML(portraitUrl(agent.avatar_id))}" alt="Imagem de ${escapeHTML(agent.name)}"></span>`;
}
function contactGroups() {
  return [
    {id:'favorites',name:'Favoritos',ids:agents.filter(a => isFavorite(a.id)).map(a => a.id)},
    {id:'agents',name:'Bots',ids:agents.filter(a => a.status !== 'offline').map(a => a.id)},
    ...(state.showOffline ? [{id:'offline',name:'Offline',ids:agents.filter(a => a.status === 'offline').map(a => a.id)}] : [])
  ];
}
function renderContacts() {
  const query = $('search').value.trim().toLocaleLowerCase('pt-BR');
  let matchCount = 0;
  $('contact-list').innerHTML = contactGroups().map(group => {
    const contacts = group.ids.map(agentById).filter(Boolean).filter(agent => {
      return (!query || `${agent.name} ${agent.description}`.toLocaleLowerCase('pt-BR').includes(query)) &&
        (state.showOffline || agent.status !== 'offline') &&
        (state.filter === 'all' || agent.status === state.filter);
    });
    if ((query || state.filter !== 'all') && !contacts.length) return '';
    matchCount += contacts.length;
    const collapsed = state.collapsed.has(group.id) && !query;
    const rows = contacts.map(agent => `<button class="contact-row ${state.active === agent.id && !$('conversation-window').hidden ? 'selected' : ''}" data-agent="${agent.id}" title="Conversar com ${escapeHTML(agent.name)} · Clique direito para opções">
      ${avatar(agent)}<span class="contact-info"><span class="contact-name"><span class="presence-indicator ${agent.status}"></span><span>${escapeHTML(agent.name)}</span>${state.unread.has(agent.id) ? '<span class="unread-dot">Nova mensagem</span>' : ''}</span>
      <span class="contact-subtitle">${statusLabels[agent.status]} <span>— ${escapeHTML(agent.description)}</span></span></span><span class="row-more" data-contact-menu="${agent.id}" aria-hidden="true">▾</span></button>`).join('');
    return `<section class="contact-group ${group.id === 'favorites' ? 'favorites' : ''}"><button class="group-heading" data-group="${group.id}" aria-expanded="${!collapsed}"><span class="group-arrow">${collapsed ? '▶' : '▼'}</span>${group.id === 'favorites' ? '<span class="star-icon">★</span>' : ''}${escapeHTML(group.name)} <span class="group-count">(${contacts.length})</span></button><div class="group-contacts" ${collapsed ? 'hidden' : ''}>${rows || '<span class="contact-subtitle">Nenhum contato neste grupo.</span>'}</div></section>`;
  }).join('');
  $('no-results').hidden = matchCount !== 0;
  $('connected-count').textContent = `${agents.filter(a => a.status !== 'offline').length} bots conectados`;
  $('main-window').classList.toggle('compact-contacts',state.compact);
}
function renderTabs() {
  $('conversation-title').textContent = state.active ? `${agentById(state.active).name} — Conversa` : 'Conversa';
  $('conversation-tabs').hidden=true;
}
function renderConversation(scrollToEnd = false) {
  if (!state.active) return;
  const agent = agentById(state.active);
  const messages = state.messages[agent.id] || [];
  const messagePane = $('messages');
  const wasAtBottom = messagePane.scrollHeight - messagePane.scrollTop - messagePane.clientHeight < 30;
  const oldScroll = messagePane.scrollTop;
  renderTabs();
  $('agent-portrait').innerHTML = avatar(agent);
  $('conversation-profile').innerHTML = `<div class="agent-title">${escapeHTML(agent.name)} <small>(${statusLabels[agent.status]})</small></div><div class="agent-description">${escapeHTML(agent.description)}</div>`;
  $('messages').innerHTML = messages.map(message => {
    if (message.author === 'system') return `<div class="message system"><span class="system-time">${message.time || ''}</span>${escapeHTML(message.text)}</div>`;
    return `<div class="message ${message.author}"><div class="message-author">${message.author === 'user' ? 'Você' : escapeHTML(agent.name)} diz:</div><div class="message-text ${message.bold ? 'bold' : ''}">${escapeHTML(message.text)}</div>${(message.files || []).map(file => file.href
      ? `<a class="message-file" href="${escapeHTML(file.href)}" download><img src="/assets/folder.svg" alt=""><span><strong>${escapeHTML(file.name)}</strong><small>${prettySize(file.size)} · Baixar arquivo entregue</small></span></a>`
      : `<span class="message-file"><img src="/assets/folder.svg" alt=""><span><strong>${escapeHTML(file.name)}</strong><small>${prettySize(file.size)} · Anexo local</small></span></span>`).join('')}</div>`;
  }).join('');
  if (scrollToEnd || wasAtBottom) messagePane.scrollTop = messagePane.scrollHeight;
  else messagePane.scrollTop = oldScroll;
  const runs=options.runs||options.activeRuns||{};
  const run=runs[agent.id];
  const pending = options.live ? isActiveRun(run) || livePending.has(agent.id) : state.jobs.has(agent.id);
  const offline = agent.status === 'offline';
  const composer=liveComposerState({offline,pending,live:Boolean(options.live),runsEnabled:Boolean(options.runsEnabled)});
  $('connection-notice').hidden = !offline&&!composer.runtimeUnavailable;
  $('connection-notice').innerHTML = offline
   ? `<span>ⓘ ${escapeHTML(agent.name)} está offline.</span><button data-command="connect">Conectar bot</button>`
   : composer.runtimeUnavailable
    ? '<span>ⓘ As tarefas reais ainda não estão disponíveis nesta conta. Para testar uma conversa agora, saia e escolha a demonstração local.</span>'
    : '';
  $('typing-status').textContent = pending ? `${agent.name} está trabalhando na sua solicitação...` : '';
  $('message-input').disabled = composer.inputDisabled;
  $('send').disabled = composer.sendDisabled;
  $('stop-task').disabled = !pending || (options.live && (!run || run.cancel_requested));
  $('nudge').disabled = offline;
  $('favorite-button').querySelector('span:last-child').textContent = isFavorite(agent.id) ? 'Favorito' : 'Favoritar';
  $('favorite-button').setAttribute('aria-pressed',String(isFavorite(agent.id)));
  $('font-toggle').setAttribute('aria-pressed',String(!!state.bold[agent.id]));
  $('message-input').style.fontWeight = state.bold[agent.id] ? 'bold' : 'normal';
  const lastMessage = messages.filter(message => message.author === 'agent').at(-1);
  $('last-message').textContent = lastMessage?.time ? `Última mensagem recebida às ${lastMessage.time} · Bot simulado` : 'Esta é uma conversa com um bot de IA.';
  if(options.live) {
    $('last-message').textContent=options.runsEnabled?'Conversa salva na sua conta.':'As tarefas ainda estão sendo preparadas.';
    const status={QUEUED:'Sua tarefa está na fila.',RUNNING:'O bot está trabalhando...',WAITING_FOR_USER:'O bot precisa da sua resposta.',SUCCEEDED:'Resposta concluída.',FAILED:'Não foi possível concluir a tarefa. Sua mensagem continua salva; tente novamente.',CANCELLED:'Tarefa interrompida.'};
    $('typing-status').textContent=run?.cancel_requested&&isActiveRun(run)?'Parando...':status[run?.state]||'';
  }
  renderAttachments();
}
function renderAttachments() {
  const files = state.attachments[state.active] || [];
  $('attachment-strip').hidden = !files.length;
  $('attachment-strip').innerHTML = files.map((file,index) => `<span>${escapeHTML(file.name)} (${prettySize(file.size)}) <button data-remove-file="${index}" aria-label="Remover ${escapeHTML(file.name)}">×</button></span>`).join('');
}
function saveDraft() {
  if (state.active) state.drafts[state.active] = $('message-input').value;
}
function openConversation(id) {
  saveDraft();
  ensureWindow(id);
  if (!state.tabs.includes(id)) state.tabs.push(id);
  state.active = id;
  state.unread.delete(id);
  $('conversation-window').hidden = false;
  const opened=$('conversation-window');
  if(!opened.classList.contains('maximized')){const rect=opened.getBoundingClientRect();moveWindow(opened,rect.left,rect.top);}
  bringToFront($('conversation-window'));
  $('message-input').value = state.drafts[id] || '';
  renderConversation(true);
  renderContacts();
  closeMenu();
  if (!$('message-input').disabled) $('message-input').focus();
}
function hideConversation(close = false) {
  saveDraft();
  $('conversation-window').hidden = true;
  if (close) { state.tabs = state.tabs.filter(id=>id!==state.active); state.active=null; }
  renderContacts();
  if (!close) notify('Conversa minimizada. Abra-a pelo menu Conversas, no topo.');
}
function closeTab(id) {
  saveDraft();
  state.tabs = state.tabs.filter(tab => tab !== id);
  if (!state.tabs.length) hideConversation(true);
  else if (state.active === id) { state.active = null; openConversation(state.tabs[0]); }
  else { renderTabs(); renderContacts(); }
}
// Single presence update path: contacts, tabs and the open conversation stay synchronized.
function setAgentStatus(id,status) {
  agentById(id).status = status;
  renderContacts();
  if (state.active === id) renderConversation();
  else if(windows.has(id)){const focused=state.active;state.active=id;renderConversation();state.active=focused;}
}
function addMessage(id,message) {
  (state.messages[id] ||= []).push({...message,time:timeNow()});
  if (state.active === id) renderConversation(true);
  else if(windows.has(id)){const focused=state.active;state.active=id;renderConversation(true);state.active=focused;}
}
function logActivity(id,text) {
  const entry = {id,text,time:timeNow()};
  state.activity.unshift(entry);
}
function mockReply(agent,text,files) {
  const input = text.length > 100 ? text.slice(0,100)+'…' : text;
  const replies = {
    grok:`Entendi. Vamos começar por “${input || 'esses arquivos'}”.\n\nMinha sugestão é definir o resultado esperado e dividir o trabalho em três passos: entender o contexto, montar uma primeira versão e revisar juntos. Por onde você quer começar?`,
    'code-assistant':'Posso te ajudar com isso. Me envie o trecho de código ou descreva o comportamento esperado. Vou propor uma mudança pequena e explicar como verificá-la.',
    reviewer:'Vou organizar a revisão em três pontos: comportamento esperado, possíveis falhas e uma correção sugerida. Envie o código ou o diff para continuarmos.',
    designer:'Vou olhar primeiro para hierarquia, espaçamento e legibilidade. Depois, transformamos cada observação em um ajuste concreto na interface.',
    sql:'Vamos começar pela pergunta que os dados precisam responder. Quais tabelas e colunas temos disponíveis?',
    research:'Vou estruturar a investigação em pergunta principal, fontes a consultar e pontos que precisam de confirmação. Qual é o recorte mais importante para você?',
    memory:'Vamos organizar receitas, custos e premissas para entender o cenário. Qual análise você quer preparar?',
    browser:'Vamos definir público, posicionamento e objetivo da campanha. Qual produto ou mensagem você quer trabalhar?',
    devops:'Vamos definir o ambiente e o resultado esperado antes de preparar a execução. Qual sistema você quer analisar?'
  };
  return (files.length ? `Você anexou ${files.length} arquivo(s) a esta conversa.\n\n` : '') + (replies[agent.id] || `Entendi. Vamos trabalhar em “${input || 'essa tarefa'}”. Me conte qual resultado você espera.`);
}
function sendMessage(event) {
  if(options.live) return liveSend(event);
  event.preventDefault();
  const id = state.active;
  const agent = agentById(id);
  if (!agent || agent.status === 'offline' || state.jobs.has(id)) return;
  const text = $('message-input').value.trim();
  const files = [...(state.attachments[id] || [])];
  if (!text && !files.length) return;
  addMessage(id,{author:'user',text,bold:state.bold[id],files});
  $('message-input').value = '';
  state.drafts[id] = '';
  state.attachments[id] = [];
  const timer = setTimeout(() => {
    state.jobs.delete(id);
    addMessage(id,{author:'agent',text:mockReply(agent,text,files)});
    setAgentStatus(id,'available');
    logActivity(id,`${agent.name} respondeu à sua solicitação.`);
    if ($('conversation-window').hidden || state.active !== id) {
      state.unread.add(id);
      renderContacts(); renderTabs();
      notify(`${agent.name} enviou uma mensagem.`);
    }
    playChime();
  },800);
  state.jobs.set(id,timer);
  setAgentStatus(id,'busy');
  logActivity(id,`${agent.name} começou a trabalhar.`);
}
function stopTask() {
  if(options.live) return liveStop();
  const id = state.active;
  if (!state.jobs.has(id)) return;
  clearTimeout(state.jobs.get(id));
  state.jobs.delete(id);
  addMessage(id,{author:'system',text:'Você interrompeu a tarefa. O bot está disponível novamente.'});
  setAgentStatus(id,'available');
  logActivity(id,`${agentById(id).name}: tarefa interrompida.`);
}
function nudge() {
  if(options.live) {notify('Você chamou a atenção do bot. A tarefa atual continua.');return;}
  const agent = agentById(state.active);
  if (!agent || agent.status === 'offline') return;
  addMessage(agent.id,{author:'system',text:`Você chamou a atenção de ${agent.name}.${state.jobs.has(agent.id) ? ' A tarefa continua em andamento.' : ''}`});
  if (agent.status === 'away') setAgentStatus(agent.id,'available');
  $('conversation-window').classList.remove('nudging');
  void $('conversation-window').offsetWidth;
  $('conversation-window').classList.add('nudging');
  logActivity(agent.id,`Você chamou a atenção de ${agent.name}.`);
  playChime();
}
let audioContext;
function playChime() {
  if (!state.sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume();
    [660,880,740].forEach((frequency,index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + index * .12;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0,start);
      gain.gain.linearRampToValueAtTime(.06,start+.015);
      gain.gain.exponentialRampToValueAtTime(.001,start+.16);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start+.18);
    });
  } catch { /* Sound is optional when audio APIs are unavailable. */ }
}
let toastTimer;
function notify(text) {
  $('toast-text').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').hidden = true,3600);
}

// Classic popup menus use one shared surface and keyboard navigation.
let menuActions = [];
let menuAnchor;
function closeMenu() {
  $('popup-menu').hidden = true;
  menuAnchor?.setAttribute('aria-expanded','false');
}
function showMenu(anchor,items,point) {
  closeMenu(); menuAnchor = anchor; menuActions = [];
  $('popup-menu').innerHTML = v1VisibleMenuItems(items).map(item => {
    if (item.separator) return '<div class="menu-separator" role="separator"></div>';
    if (item.caption) return `<div class="menu-caption">${escapeHTML(item.caption)}</div>`;
    const index = menuActions.push(item.action) - 1;
    return `<button role="menuitem" data-menu-item="${index}" ${item.disabled ? 'disabled' : ''}><span class="menu-check">${item.check ? '✓' : item.icon || ''}</span><span>${escapeHTML(item.label)}</span></button>`;
  }).join('');
  $('popup-menu').hidden = false;
  anchor.setAttribute('aria-expanded','true');
  const rect = anchor.getBoundingClientRect();
  const x = point?.x ?? rect.left;
  const y = point?.y ?? rect.bottom + 2;
  $('popup-menu').style.left = Math.max(6,Math.min(x,innerWidth - $('popup-menu').offsetWidth - 7))+'px';
  $('popup-menu').style.top = Math.max(6,Math.min(y,innerHeight - $('popup-menu').offsetHeight - 7))+'px';
  $('popup-menu').querySelector('button:not(:disabled)')?.focus();
}
function viewMenu(anchor) {
  showMenu(anchor,[
    {caption:'Lista de contatos'},
    {label:'Imagens de exibição',check:!state.compact,action:() => {state.compact=false;renderContacts();}},
    {label:'Lista compacta',check:state.compact,action:() => {state.compact=true;renderContacts();}},
    {separator:true},
    {label:'Mostrar contatos offline',check:state.showOffline,action:() => {state.showOffline=!state.showOffline;renderContacts();}},
    {label:'Todos os bots',check:state.filter==='all',action:() => {state.filter='all';renderContacts();}},
    {label:'Somente disponíveis',check:state.filter==='available',action:() => {state.filter='available';renderContacts();}},
    {separator:true},
    {label:'Expandir todos os grupos',action:() => {state.collapsed.clear();renderContacts();}},
    {label:'Recolher todos os grupos',action:() => {state.collapsed=new Set(contactGroups().map(g=>g.id));renderContacts();}}
  ]);
}
function contactMenu(id,anchor,point) {
  const agent = agentById(id);
  showMenu(anchor,[
    {caption:agent.name},
    {label:'Enviar uma mensagem',action:() => openConversation(id)},
    {label:isFavorite(id)?'Remover dos favoritos':'Adicionar aos favoritos',icon:'★',action:() => toggleFavorite(id)},
    {label:'Editar instruções...',action:() => openInstructions(id)},
    {label:'Ver perfil...',action:() => openAgentDetails(id)},
    {label:'Ver memória...',action:() => openMemoryDialog(id)},
    {label:'Ver atividade...',action:() => openActivity(id)},
    {separator:true},
    {label:agent.status==='offline'?'Conectar bot':'Desconectar bot',disabled:state.jobs.has(id),action:() => toggleConnection(id)},
    {label:'Mover para um grupo...',v1Feature:'groups',action:() => openGroupAssignment(id)}
  ],point);
}
function toggleFavorite(id) {
  isFavorite(id) ? state.favorites.delete(id) : state.favorites.add(id);
  renderContacts(); renderConversation();
}
function toggleConnection(id) {
  if(options.live) return unavailable();
  if (state.jobs.has(id)) return;
  const agent = agentById(id);
  const status = agent.status === 'offline' ? 'available' : 'offline';
  setAgentStatus(id,status);
  logActivity(id,`${agent.name} ${status === 'available' ? 'ficou online' : 'foi desconectado'}.`);
}
function presenceMenu(anchor) {
  showMenu(anchor,Object.entries(statusLabels).map(([status,label]) => ({label,check:state.userStatus===status,action:() => {
    state.userStatus=status;
    $('user-presence').textContent=`(${label})`;
    renderUserPictures();
  }})));
}
// Modal dialogs preserve the approved Messenger surface. Live mutations use owner-scoped APIs.
let dialogSubmit;
let historyDownloadURL;
let dialogReturnFocus;
const dialogGate=createGenerationGate();
function openDialog(title,content,onSubmit,saveLabel='Salvar') {
  const generation=dialogGate.next();
  closeMenu();
  dialogReturnFocus = document.activeElement;
  $('dialog-download').hidden = true;
  $('dialog-title').textContent = title;
  $('dialog-content').innerHTML = content;
  $('dialog-content').onclick = null;
  dialogSubmit = onSubmit;
  $('dialog-save').textContent = saveLabel;
  $('dialog-save').hidden = !onSubmit;
  $('dialog-cancel').textContent = onSubmit ? 'Cancelar' : 'Fechar';
  if (!$('classic-dialog').open) $('classic-dialog').showModal();
  $('dialog-content').querySelector('input,textarea,select,button')?.focus();
  return generation;
}
function closeDialog() {
  dialogGate.invalidate();
  $('classic-dialog').close();
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
}
function isCurrentDialog(generation){return dialogGate.isCurrent(generation)&&$('classic-dialog').open;}
function picturePicker(selected) {
 return `<div class="catalog-pictures" role="group" aria-label="Imagem de exibição">${displayPictures.map((id,index)=>`<label class="catalog-picture"><input type="radio" name="catalog-picture" value="${id}" ${id===selected?'checked':''} aria-label="Imagem clássica ${index+1}"><img data-catalog-picture="${id}" src="${portraitUrl(id)}" alt="Imagem clássica ${index+1}"></label>`).join('')}</div>`;
}
async function saveProfile(id,values,key) {
 if(!options.live){
  let bot=id?agentById(id):null;
  if(!bot){bot={id:'bot-'+crypto.randomUUID(),status:'available'};agents.push(bot);}
  Object.assign(bot,values,{avatar_id:values.avatarId,avatar:portraitUrl(values.avatarId)});
  state.instructions[bot.id]=values.instructions;return bot;
 }
 const result=await profileRequest(id?`/api/bots/${id}`:'/api/bots',id?'PATCH':'POST',{...values,...(!id?{idempotencyKey:key}:{})});
 const bot={...result.bot,avatar:portraitUrl(result.bot.avatar_id),status:agentById(result.bot.id)?.status||'available'};
 const index=agents.findIndex(b=>b.id===bot.id);if(index<0)agents.push(bot);else agents[index]=bot;
 state.instructions[bot.id]=bot.instructions;
 options.bots=agents.map(b=>({...b}));options.refresh?.();return bot;
}
async function profileRequest(url,method,body){
 const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:abort.signal});
 const result=await response.json();if(!response.ok)throw new Error(result.error||'Não foi possível salvar.');return result;
}
async function collaborationRequest(url,method='GET',body){
 const response=await fetch(url,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:abort.signal});
 const result=response.status===204?null:await response.json().catch(()=>null);
 if(!response.ok)throw new Error(result?.error||'Não foi possível concluir esta operação.');
 return result;
}
let groupsRequest;
async function loadGroups(force=false){
 if(collaborationMode()==='demo')return state.customGroups;
 if(groupsRequest)return groupsRequest;
 if(!force&&state.groupsLoaded)return state.customGroups;
 groupsRequest=collaborationRequest('/api/groups').then(result=>{
  state.customGroups=(result.groups||[]).map(groupFromApi);state.groupsLoaded=true;renderContacts();return state.customGroups;
 }).finally(()=>{groupsRequest=null;});
 return groupsRequest;
}
function openInstructions(id) {openBotProfile(id);}
function openAgentDetails(id) {openBotProfile(id);}
function openAddAgent() {openBotProfile();}
function openBotProfile(id) {
 const bot=id?agentById(id):null;if(id&&!bot)return;
 const key=crypto.randomUUID();
 openDialog(bot?`Perfil — ${bot.name}`:'Adicionar bot',`<h2>${bot?'Edite o perfil do bot.':'Quem você quer na sua equipe?'}</h2>
 <label class="field">Nome<input id="bot-profile-name" required maxlength="80" value="${escapeHTML(bot?.name||'')}" placeholder="AI Einstein Research"></label>
 <label class="field">Função<input id="bot-profile-role" required maxlength="120" value="${escapeHTML(bot?.role||'')}" placeholder="Ex.: Pesquisa de mercado"></label>
 <label class="field">Mensagem pessoal<input id="bot-profile-description" required maxlength="140" value="${escapeHTML(bot?.description||'')}" placeholder="Como este bot pode ajudar?"></label>
 <label class="field">Instruções<textarea id="bot-profile-instructions" required maxlength="4000">${escapeHTML(bot?(bot.instructions||state.instructions[id]||'Ajude o usuário com clareza.'):'Ajude o usuário com clareza. Peça contexto quando necessário.')}</textarea></label>
 <p>As alterações nas instruções valem para as próximas tarefas.</p>
 <p>Imagem de exibição</p>${picturePicker(bot?.avatar_id||defaultPicture)}
 <p>${options.live?'O perfil ficará salvo na sua conta.':'Demonstração: alterações nesta sessão; respostas simuladas.'}</p>`,async()=>{
  const values={name:$('bot-profile-name').value,role:$('bot-profile-role').value,description:$('bot-profile-description').value,instructions:$('bot-profile-instructions').value,avatarId:$('dialog-content').querySelector('input[name="catalog-picture"]:checked').value};
  const parsed=botProfileInput.safeParse(values);if(!parsed.success)throw new Error('Use um nome como AI Einstein Research e preencha todos os campos.');
  await saveProfile(id,parsed.data,key);
  closeDialog();renderContacts();renderConversation();notify('Perfil salvo.');
 },bot?'Salvar':'Adicionar');
}
function openCreateGroup() {
  const key=crypto.randomUUID();
  openDialog('Criar grupo',`<h2>Organize seus bots.</h2><label class="field">Nome do grupo<input id="new-group-name" required maxlength="80" placeholder="Ex.: Pesquisa de mercado"></label><p>${options.live?'O grupo e seus participantes ficarão salvos na sua conta.':'Demonstração: o grupo existe somente nesta sessão.'}</p>`,async() => {
    const name=$('new-group-name').value.trim();if(!name)return;
    if(collaborationMode()==='authenticated'){await loadGroups();const result=await collaborationRequest('/api/groups','POST',{name,idempotencyKey:key});state.customGroups=[groupFromApi(result.group),...state.customGroups.filter(group=>group.id!==result.group.id)];}
    else state.customGroups.push({id:'group-'+Date.now(),name,ids:[]});
    closeDialog();renderContacts();notify('Grupo criado. Use o menu de um contato para adicioná-lo.');
  },'Criar');
}
async function openManageGroups(){
 const generation=openDialog('Gerenciar grupos','<h2>Seus grupos</h2><p>Carregando grupos...</p>',null);
 try{await loadGroups(true);}catch(error){if(isCurrentDialog(generation))$('dialog-content').innerHTML=`<h2>Seus grupos</h2><p>${escapeHTML(error.message)}</p>`;return;}
 if(!isCurrentDialog(generation))return;
 $('dialog-content').innerHTML=`<h2>Seus grupos</h2><p>Renomeie grupos ou remova os que não usa mais. Para alterar participantes, abra o menu de um bot.</p>${state.customGroups.length?state.customGroups.map(group=>`<div class="activity-entry"><time>${group.ids.length} bot${group.ids.length===1?'':'s'}</time><strong>${escapeHTML(group.name)}</strong><p>${escapeHTML(group.ids.map(id=>agentById(id)?.name).filter(Boolean).join(', ')||'Nenhum bot neste grupo.')}</p><button type="button" class="glossy-button" data-edit-group="${group.id}">Renomear</button> <button type="button" class="glossy-button" data-delete-group="${group.id}">Remover</button></div>`).join(''):'<p>Nenhum grupo criado.</p>'}<button type="button" class="glossy-button" data-create-group>Criar grupo</button>`;
 $('dialog-content').onclick=event=>{
  const create=event.target.closest('[data-create-group]');if(create){openCreateGroup();return;}
  const edit=event.target.closest('[data-edit-group]');if(edit){openEditGroup(edit.dataset.editGroup);return;}
  const remove=event.target.closest('[data-delete-group]');if(remove)openDeleteGroup(remove.dataset.deleteGroup);
 };
}
function openEditGroup(id){
 const group=state.customGroups.find(item=>item.id===id);if(!group)return;
 openDialog(`Renomear — ${group.name}`,`<h2>Renomear grupo</h2><label class="field">Nome do grupo<input id="edit-group-name" required maxlength="80" value="${escapeHTML(group.name)}"></label>`,async()=>{
  const name=$('edit-group-name').value.trim();if(!name)return;
  if(collaborationMode()==='authenticated'){const result=await collaborationRequest(`/api/groups/${id}`,'PATCH',{name});Object.assign(group,groupFromApi(result.group));}
  else group.name=name;
  closeDialog();renderContacts();notify('Grupo atualizado.');
 });
}
function openDeleteGroup(id){
 const group=state.customGroups.find(item=>item.id===id);if(!group)return;
 openDialog(`Remover — ${group.name}`,`<h2>Remover este grupo?</h2><p>O grupo <b>${escapeHTML(group.name)}</b> deixará de aparecer. As conversas diretas com os bots continuam disponíveis.</p>`,async()=>{
  if(collaborationMode()==='authenticated')await collaborationRequest(`/api/groups/${id}`,'DELETE');
  state.customGroups=state.customGroups.filter(item=>item.id!==id);state.collapsed.delete(id);
  closeDialog();renderContacts();notify('Grupo removido.');
 },'Remover');
}
async function openGroupAssignment(id,failures=[],canonicalReady=false) {
  if(collaborationMode()==='authenticated'&&!canonicalReady){
   const generation=openDialog('Grupos do contato','<h2>Carregando grupos...</h2>',null);
   try{await loadGroups(true);}catch(error){if(isCurrentDialog(generation))$('dialog-content').innerHTML=`<h2>Não foi possível carregar os grupos</h2><p>${escapeHTML(error.message)}</p>`;return;}
   if(!isCurrentDialog(generation))return;
  }
  if(!state.customGroups.length){openCreateGroup();return;}
  const failureDetails=failures.length?`<div role="alert"><p><b>Algumas alterações não foram aplicadas.</b> A lista abaixo já reflete o estado confirmado pelo servidor.</p><ul>${failures.map(failure=>`<li>${failure.change.active?'Adicionar a':'Remover de'} <b>${escapeHTML(failure.change.groupName)}</b>: ${escapeHTML(failure.message)}</li>`).join('')}</ul></div>`:'';
  openDialog('Grupos do contato',`<h2>${escapeHTML(agentById(id).name)}</h2><p>Escolha em quais grupos este bot aparece.</p>${failureDetails}${state.customGroups.map(group=>`<label class="check-label"><input type="checkbox" name="agent-group" value="${group.id}" ${group.ids.includes(id)?'checked':''}>${escapeHTML(group.name)}</label>`).join('')}`,async() => {
    const selected=new Set([...$('dialog-content').querySelectorAll('input:checked')].map(input=>input.value));
    if(collaborationMode()==='authenticated'){
     const changes=state.customGroups.filter(group=>selected.has(group.id)!==group.ids.includes(id)).map(group=>({groupId:group.id,groupName:group.name,active:selected.has(group.id)}));
     const reconciled=await reconcileMembershipChanges(changes,change=>collaborationRequest(`/api/groups/${change.groupId}/members/${id}`,change.active?'PUT':'DELETE'),()=>loadGroups(true));
     state.customGroups=reconciled.canonical;
     if(reconciled.failures.length){notify('Algumas alterações de grupo falharam. Revise os detalhes.');await openGroupAssignment(id,reconciled.failures,true);return;}
    } else state.customGroups.forEach(group=>{group.ids=group.ids.filter(item=>item!==id);if(selected.has(group.id))group.ids.push(id);});
    closeDialog();renderContacts();
  });
}
async function openMemoryDialog(botId=null){
 if(collaborationMode()==='demo'){openDialog('Memória salva','<h2>Nenhuma memória durável na demonstração.</h2><p>As instruções e conversas desta demonstração ficam apenas nesta sessão. Entre em uma conta para inspecionar, corrigir ou excluir memórias salvas.</p>',null);return;}
 const generation=openDialog('Memória salva','<h2>Carregando memórias...</h2>',null);
 try{
  const result=await collaborationRequest('/api/memories');
  if(!isCurrentDialog(generation))return;
  const memories=(result.memories||[]).filter(memory=>!botId||memory.bot_id===null||memory.bot_id===botId);
  const rows=memories.map(memory=>({memory,version:activeMemoryVersion(memory)})).filter(row=>row.version);
  $('dialog-content').innerHTML=`<h2>${botId?`Memórias de ${escapeHTML(agentById(botId)?.name||'bot')} e preferências gerais`:'Todas as memórias salvas'}</h2><p>Você pode corrigir um fato salvo ou removê-lo. A origem e as versões anteriores permanecem registradas conforme a política do serviço.</p>${rows.length?rows.map(({memory,version})=>`<div class="activity-entry"><time>${memory.bot_id?escapeHTML(agentById(memory.bot_id)?.name||'Bot removido'):'Preferência geral'} · v${memory.current_version} · ${escapeHTML(formatDate(memory.updated_at))}</time><strong>${escapeHTML(version.content)}</strong><p>${escapeHTML(version.provenance||'Origem não informada')}</p><button type="button" class="glossy-button" data-correct-memory="${memory.id}">Corrigir</button> <button type="button" class="glossy-button" data-delete-memory="${memory.id}">Excluir</button></div>`).join(''):'<p>Nenhuma memória salva neste escopo.</p>'}`;
  $('dialog-content').onclick=event=>{
   const correct=event.target.closest('[data-correct-memory]');if(correct){const row=rows.find(item=>item.memory.id===correct.dataset.correctMemory);if(row)openMemoryCorrection(row.memory,row.version,botId);return;}
   const remove=event.target.closest('[data-delete-memory]');if(remove){const row=rows.find(item=>item.memory.id===remove.dataset.deleteMemory);if(row)openMemoryDelete(row.memory,row.version,botId);}
  };
 }catch(error){if(!abort.signal.aborted&&isCurrentDialog(generation))$('dialog-content').innerHTML=`<h2>Não foi possível carregar as memórias</h2><p>${escapeHTML(error.message)}</p>`;}
}
function openMemoryCorrection(memory,version,filterBotId){
 openDialog('Corrigir memória',`<h2>Corrija o que o bot deve lembrar.</h2><label class="field">Conteúdo<textarea id="memory-content" required maxlength="4000">${escapeHTML(version.content)}</textarea></label><p>Origem atual: ${escapeHTML(version.provenance||'não informada')} · versão ${memory.current_version}</p>`,async()=>{
  const content=$('memory-content').value.trim();if(!content)return;
  await collaborationRequest(`/api/memories/${memory.id}`,'PATCH',{botId:memory.bot_id,kind:memory.kind,content,provenance:'User correction',sourceContext:{correctedFromVersion:Number(memory.current_version),via:'memory-dialog'},expectedVersion:Number(memory.current_version)});
  notify('Memória corrigida.');await openMemoryDialog(filterBotId);
 });
}
function openMemoryDelete(memory,version,filterBotId){
 openDialog('Excluir memória',`<h2>Excluir esta memória?</h2><p>${escapeHTML(version.content)}</p><p>Ela deixará de ser usada nas próximas tarefas.</p>`,async()=>{
  await collaborationRequest(`/api/memories/${memory.id}`,'DELETE',{expectedVersion:Number(memory.current_version)});
  notify('Memória excluída.');await openMemoryDialog(filterBotId);
 },'Excluir');
}
async function openHandoffs(botId=null){
 const generation=openDialog('Delegações','<h2>Carregando histórico...</h2>',null);
 try{
  const result=await collaborationRequest('/api/handoffs');
  if(!isCurrentDialog(generation))return;
  const handoffs=handoffsForBot(result.handoffs||[],botId);
  const loadedMessages=Object.values(state.messages).flat();
  $('dialog-content').innerHTML=`<h2>Delegações registradas</h2><p>Este histórico mostra autorização, entrega e resultado persistidos. Uma autorização, sozinha, não significa que outro bot executou a tarefa.</p>${handoffs.length?handoffs.map(item=>{
   const references=item.handoff_source_messages||[];const sourceMessages=sourceMessagesForHandoff(item,loadedMessages);
   const sourceContext=references.length?(sourceMessages.length?`<p><b>Contexto de origem:</b></p><ul>${sourceMessages.map(message=>`<li>${message.author==='user'?'Você':message.author==='agent'?'Bot':'Sistema'}: ${escapeHTML(message.text.length>240?message.text.slice(0,240)+'…':message.text)}</li>`).join('')}</ul>${references.length>sourceMessages.length?`<small>${references.length-sourceMessages.length} mensagem(ns) referenciada(s) não exibida(s) neste resumo.</small>`:''}`:`<p><b>Contexto de origem:</b> ${references.length} mensagem(ns) referenciada(s), com conteúdo fora do histórico carregado.</p>`):'';
   return `<div class="activity-entry"><time>${escapeHTML(formatDate(item.created_at))} · ${escapeHTML(handoffLabel(item.state))}</time><strong>${escapeHTML(agentById(item.source_bot_id)?.name||'Bot de origem')} → ${escapeHTML(agentById(item.target_bot_id)?.name||'Bot de destino')}</strong><p>${escapeHTML(item.task)}</p>${sourceContext}${item.result?`<p><b>Resultado atribuído:</b> ${escapeHTML(item.result)}</p>`:''}<small>Profundidade ${Number(item.depth)+1}${item.group_id?` · ${escapeHTML(state.customGroups.find(group=>group.id===item.group_id)?.name||'Grupo removido')}`:''}</small></div>`;
  }).join(''):'<p>Nenhuma delegação registrada neste escopo.</p>'}<button type="button" class="glossy-button" data-refresh-handoffs>Atualizar</button>`;
  $('dialog-content').onclick=event=>{if(event.target.closest('[data-refresh-handoffs]'))openHandoffs(botId);};
 }catch(error){if(!abort.signal.aborted&&isCurrentDialog(generation))$('dialog-content').innerHTML=`<h2>Não foi possível carregar as delegações</h2><p>${escapeHTML(error.message)}</p>`;}
}
function openContactPicker() {
  openDialog('Iniciar uma conversa',`<h2>Com quem você quer conversar?</h2><label class="field">Contato<select id="pick-contact">${agents.map(agent=>`<option value="${agent.id}">${escapeHTML(agent.name)} (${statusLabels[agent.status]})</option>`).join('')}</select></label>`,() => {const id=$('pick-contact').value;closeDialog();openConversation(id);},'Conversar');
}
function openActivity(id) {
  const entries=id?state.activity.filter(entry=>entry.id===id):state.activity;
  openDialog(id?`Atividade — ${agentById(id).name}`:'Atividades dos bots',`<h2>O que aconteceu por aqui</h2>${entries.length?entries.map(entry=>`<div class="activity-entry"><time>${entry.time}</time>${escapeHTML(entry.text)}</div>`).join(''):'<p>Nenhuma atividade ainda. Envie uma mensagem para começar.</p>'}`,null);
}
function openHistory() {
  const agent=agentById(state.active);
  const text=(state.messages[agent.id]||[]).map(message=>`${message.time||''} ${message.author==='user'?'Você':message.author==='agent'?agent.name:'Sistema'}: ${message.text}${(message.files||[]).map(file=>'\n[Arquivo: '+file.name+']').join('')}`).join('\n\n');
  openDialog(`Histórico — ${agent.name}`,`<p>Histórico desta sessão. Exporte para guardar a conversa.</p><pre class="history-text">${escapeHTML(text||'Nenhuma mensagem nesta conversa.')}</pre>`,null);
  if(historyDownloadURL)URL.revokeObjectURL(historyDownloadURL);
  historyDownloadURL=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  $('dialog-download').href=historyDownloadURL;
  $('dialog-download').download=`conversa-${agent.id}.txt`;
  $('dialog-download').hidden=false;
}
function renderUserPictures() {
  state.userAvatar=portraitUrl(state.userAvatarId);
  host.querySelectorAll('.user-avatar').forEach(frame=>{frame.className=`avatar-frame ${state.userStatus} user-avatar`;const img=frame.querySelector('img');img.src=state.userAvatar;img.dataset.catalogPicture=state.userAvatarId;});
}
function openAppearance() {
 let scene=state.scene;
 openDialog('Personalizar o Bot Live Messenger',`<h2>Deixe o Bot Live Messenger com a sua cara.</h2><p>Cenário</p><div class="scene-choices">${[['blue','Azul clássico'],['green','Jardim'],['violet','Entardecer']].map(([theme,label])=>`<button type="button" class="scene-choice ${theme===scene?'selected':''}" data-theme="${theme}"><span class="scene-swatch"></span>${label}</button>`).join('')}</div><p>Imagem de exibição</p>${picturePicker(state.userAvatarId)}`,async()=>{
  const avatarId=$('dialog-content').querySelector('input[name="catalog-picture"]:checked').value;
  if(options.live){await profileRequest('/api/profile','PATCH',{avatarId});options.userAvatarId=avatarId;options.refresh?.();}
  else {try{localStorage.setItem('bot-messenger.demo-picture',avatarId);}catch{}}
  state.scene=scene;state.userAvatarId=avatarId;document.body.dataset.scene=scene;renderUserPictures();closeDialog();
 },'Aplicar');
 $('dialog-content').onclick=event=>{const theme=event.target.closest('[data-theme]');if(theme){scene=theme.dataset.theme;$('dialog-content').querySelectorAll('.scene-choice').forEach(button=>button.classList.toggle('selected',button===theme));}};
}
function openSettings() {
  openDialog('Opções — Bot Live Messenger',`<h2>Lista de contatos e notificações</h2><label class="check-label"><input id="setting-offline" type="checkbox" ${state.showOffline?'checked':''}>Mostrar contatos offline</label><label class="check-label"><input id="setting-compact" type="checkbox" ${state.compact?'checked':''}>Usar lista compacta</label><label class="check-label"><input id="setting-sound" type="checkbox" ${state.sound?'checked':''}>Reproduzir um som ao receber mensagens</label><p>O som é uma composição original para este protótipo.</p>`,() => {
    state.showOffline=$('setting-offline').checked;state.compact=$('setting-compact').checked;state.sound=$('setting-sound').checked;
    closeDialog();renderContacts();if(state.sound)playChime();
  });
}
function showEmoticons(anchor) {
  showMenu(anchor,[]);
  const faces=['☺','☻','♡',':)',':D',';)','8)',':P',':o','(^_^)'];
  $('popup-menu').innerHTML=`<div class="menu-caption">Emoticons</div><div class="emoticon-grid">${faces.map(face=>`<button data-face="${escapeHTML(face)}" title="${escapeHTML(face)}">${escapeHTML(face)}</button>`).join('')}</div>`;
  $('popup-menu').style.top=Math.max(6,anchor.getBoundingClientRect().top-$('popup-menu').offsetHeight-4)+'px';
}
const commands={
  'advertise':()=>openDialog('Anuncie no Bot Live Messenger','<h2>Sua marca nesta conversa.</h2><p>Este espaço está reservado para publicidade e parcerias.</p><p>Prévia do posicionamento. Nenhum anúncio de terceiros está sendo carregado.</p>',null),
  'settings':openSettings,'add-agent':openAddAgent,'create-group':openCreateGroup,'manage-groups':openManageGroups,
  'appearance':openAppearance,'activity':()=>openActivity(),
  'agent-activity':()=>openActivity(state.active),'history':openHistory,
  'memory':()=>openMemoryDialog(state.active),'saved-memories':()=>openMemoryDialog(),
  'instructions':()=>openInstructions(state.active),'agent-details':()=>openAgentDetails(state.active),
  'favorite':()=>toggleFavorite(state.active),'connect':()=>toggleConnection(state.active),
  'attach':()=>{if(agentById(state.active)?.status==='offline'){notify('Conecte o bot antes de anexar arquivos.');return;}$('file-input').click();},
  'personal-message':()=>openDialog('Mensagem pessoal',`<label class="field">O que você está pensando?<input id="new-personal-message" maxlength="140" value="${escapeHTML(state.personalMessage)}"></label>`,()=>{state.personalMessage=$('new-personal-message').value.trim();$('personal-message').textContent=state.personalMessage||'Compartilhe uma mensagem pessoal...';closeDialog();}),
  'about':()=>openDialog('Sobre o Bot Live Messenger','<h2>Bot Live Messenger</h2><p>Seus bots, na sua lista de contatos.</p><p>Converse, compartilhe referências e acompanhe o trabalho pela presença: disponível, ocupado, ausente ou offline.</p><p>Protótipo local inspirado no Messenger de 2009. Respostas e conexões são simuladas. Nada é enviado a um serviço de IA; mensagens, arquivos e configurações desta sessão são reiniciados ao recarregar.</p>',null)
};

// Event wiring. User-entered text is escaped before rendering into the transcript.
host.addEventListener('click',event=>{
  const notepadMenu=event.target.closest('[data-notepad-menu]');
  if(notepadMenu){welcomeMenu(notepadMenu,notepadMenu.dataset.notepadMenu);return;}
  const command=event.target.closest('[data-command]');
  if(command){commands[command.dataset.command]?.();return;}
  const menu=event.target.closest('[data-menu]');
  if(menu){
    if(menu.dataset.menu==='view')viewMenu(menu);
    if(menu.dataset.menu==='contacts')showMenu(menu,[{label:'Adicionar um bot...',icon:'+',action:openAddAgent},{label:'Criar grupo...',v1Feature:'groups',action:openCreateGroup},{label:'Gerenciar grupos...',v1Feature:'groups',action:openManageGroups},{label:'Memórias salvas...',action:()=>openMemoryDialog()},{separator:true},{label:'Iniciar uma conversa...',action:openContactPicker}]);
    if(menu.dataset.menu==='agent')contactMenu(state.active,menu);
    return;
  }
  if(!event.target.closest('#popup-menu')&&!event.target.closest('#conversations-button,#presence-button,#emoticon,[data-contact-menu]'))closeMenu();
});
listen($('contact-list'),'click',event=>{
  const group=event.target.closest('[data-group]');
  if(group){const id=group.dataset.group;state.collapsed.has(id)?state.collapsed.delete(id):state.collapsed.add(id);renderContacts();return;}
  const more=event.target.closest('[data-contact-menu]');
  if(more){event.stopPropagation();contactMenu(more.dataset.contactMenu,more);return;}
  const row=event.target.closest('[data-agent]');if(row)openConversation(row.dataset.agent);
});
listen($('contact-list'),'contextmenu',event=>{const row=event.target.closest('[data-agent]');if(row){event.preventDefault();contactMenu(row.dataset.agent,row,{x:event.clientX,y:event.clientY});}});
listen($('contact-list'),'keydown',event=>{const row=event.target.closest('[data-agent]');if(row&&event.shiftKey&&event.key==='F10'){event.preventDefault();contactMenu(row.dataset.agent,row);}});
listen($('search'),'input',renderContacts);
$('presence-button').onclick=event=>presenceMenu(event.currentTarget);
$('user-picture').onclick=openAppearance;
$('conversation-tabs').onclick=event=>{const close=event.target.closest('[data-close-tab]');if(close){closeTab(close.dataset.closeTab);return;}const tab=event.target.closest('[data-tab]');if(tab)openConversation(tab.dataset.tab);};
listen($('conversation-tabs'),'keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=state.tabs.indexOf(state.active);const next=event.key==='Home'?0:event.key==='End'?state.tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+state.tabs.length)%state.tabs.length;openConversation(state.tabs[next]);$('conversation-tabs').querySelector(`[data-tab="${state.active}"]`).focus();});
$('message-form').onsubmit=sendMessage;
listen($('message-input'),'keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('message-form').requestSubmit();}});
listen($('message-input'),'input',saveDraft);
$('font-toggle').onclick=()=>{state.bold[state.active]=!state.bold[state.active];renderConversation();$('message-input').focus();};
$('stop-task').onclick=stopTask;
$('nudge').onclick=nudge;
$('emoticon').onclick=event=>showEmoticons(event.currentTarget);
$('file-input').onchange=()=>{
  const id=state.active;if(!id)return;
  const files=[...$('file-input').files].map(file=>({name:file.name,size:file.size,type:file.type}));
  state.attachments[id]=[...(state.attachments[id]||[]),...files];
  $('file-input').value='';renderAttachments();$('message-input').focus();
};
$('attachment-strip').onclick=event=>{const remove=event.target.closest('[data-remove-file]');if(remove){state.attachments[state.active].splice(Number(remove.dataset.removeFile),1);renderAttachments();}};
$('popup-menu').onclick=event=>{
  const face=event.target.closest('[data-face]');if(face){const input=$('message-input');if(!input.disabled){input.value+=(input.value?' ':'')+face.dataset.face;saveDraft();}closeMenu();input.focus();return;}
  const item=event.target.closest('[data-menu-item]');if(item){const action=menuActions[Number(item.dataset.menuItem)];closeMenu();action?.();}
};
listen($('popup-menu'),'keydown',event=>{
  if(event.key==='Escape'){closeMenu();menuAnchor?.focus();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();const buttons=[...$('popup-menu').querySelectorAll('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();
});
let savingDialog=false;
$('dialog-form').onsubmit=async event=>{
 event.preventDefault();if(savingDialog)return;savingDialog=true;
 const buttons=[$('dialog-save'),$('dialog-close'),$('dialog-cancel')];buttons.forEach(b=>b.disabled=true);
 try{await dialogSubmit?.();}catch(error){if(!abort.signal.aborted)notify(error.message||'Não foi possível salvar.');}
 finally{savingDialog=false;buttons.forEach(b=>b.disabled=false);}
};
listen($('classic-dialog'),'cancel',event=>{if(savingDialog)event.preventDefault();});
$('dialog-close').onclick=closeDialog;$('dialog-cancel').onclick=closeDialog;
listen($('classic-dialog'),'close',()=>{$('dialog-content').onclick=null;});
listen($('dialog-content'),'input',event=>{if(event.target instanceof HTMLInputElement)event.target.setCustomValidity('');});
$('toast-close').onclick=()=>$('toast').hidden=true;
$('minimize-chat').onclick=()=>hideConversation();
$('close-chat').onclick=()=>hideConversation(true);
function toggleMaximize(){const maximized=$('conversation-window').classList.toggle('maximized');$('maximize-chat').setAttribute('aria-label',maximized?'Restaurar tamanho da conversa':'Maximizar conversa');}
$('maximize-chat').onclick=toggleMaximize;

function desktopWindows(){return [$('main-window'),$('login-screen'),$('welcome-notepad'),...windows.values()];}
function bringToFront(win){
 // Keep all application windows below the menu/notification layers.
 if(windowOrder>=900){
  const ordered=desktopWindows().sort((a,b)=>(Number(a.style.zIndex)||0)-(Number(b.style.zIndex)||0));
  windowOrder=20;ordered.forEach(item=>item.style.zIndex=String(++windowOrder));
 }
 win.style.zIndex=String(++windowOrder);
}
function moveWindow(win,x,y){
 win.style.left=Math.max(0,Math.min(Math.max(0,innerWidth-win.offsetWidth),x))+'px';
 win.style.top=Math.max(0,Math.min(Math.max(0,innerHeight-win.offsetHeight),y))+'px';
}
function wireDrag(win,handle=win.querySelector('[data-part="conversation-drag"],#conversation-drag')){
 let drag;
 handle.tabIndex=0;
 handle.setAttribute('aria-label',win.id==='main-window'?'Mover lista de contatos':win.id==='login-screen'?'Mover janela de login':win.id==='welcome-notepad'?'Mover Bloco de Notas':'Mover janela de conversa');
 handle.title='Arraste para mover · Alt + setas move pelo teclado';
 handle.addEventListener('pointerdown',event=>{
  if(event.target.closest('button,a,input,select')||win.classList.contains('maximized')||event.button!==0)return;
  event.preventDefault();
  const rect=win.getBoundingClientRect();drag={x:event.clientX-rect.left,y:event.clientY-rect.top};
  handle.setPointerCapture(event.pointerId);win.classList.add('is-dragging');closeMenu();
 });
 handle.addEventListener('pointermove',event=>{if(drag)moveWindow(win,event.clientX-drag.x,event.clientY-drag.y);});
 const endDrag=()=>{drag=null;win.classList.remove('is-dragging');};
 handle.addEventListener('pointerup',endDrag);handle.addEventListener('pointercancel',endDrag);handle.addEventListener('lostpointercapture',endDrag);
 handle.addEventListener('keydown',event=>{
  if(event.target!==handle||!event.altKey||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)||win.classList.contains('maximized'))return;
  event.preventDefault();const rect=win.getBoundingClientRect(),step=event.shiftKey?1:10;
  moveWindow(win,rect.left+(event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0),rect.top+(event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0));
 });
 if(win.matches('.aero-window'))handle.addEventListener('dblclick',event=>{if(!event.target.closest('button'))toggleMaximize();});
}
const welcomeWindow=$('welcome-notepad');
const welcomeTitle=welcomeWindow.querySelector('.aero-titlebar > span:not(.notepad-icon)');
welcomeTitle.textContent='Como usar o Bot Live Messenger.txt - Bloco de Notas';
welcomeWindow.querySelector('.window-controls').insertAdjacentHTML('afterbegin','<button id="minimize-welcome" aria-label="Minimizar Bloco de Notas" title="Minimizar">−</button>');
welcomeWindow.querySelector('.notepad-menubar').innerHTML=['Arquivo','Editar','Formatar','Exibir','Ajuda'].map(menu=>`<button data-notepad-menu="${menu.toLocaleLowerCase('pt-BR')}" aria-haspopup="menu" aria-expanded="false">${menu}</button>`).join('');
$('reopen-welcome').querySelector('span').classList.add('notepad-icon');
$('reopen-welcome').lastChild.textContent='Bloco de Notas';
welcomeWindow.querySelector('.notepad-status').innerHTML='<span>Como usar o Bot Live Messenger.txt</span><span id="welcome-font-status">100%</span><span>UTF-8</span>';
const shortcutSelection=createDesktopShortcutSelection(['messenger','notepad']);
const shortcutButtons={messenger:$('open-messenger'),notepad:$('reopen-welcome')};
for(const button of Object.values(shortcutButtons))button.setAttribute('aria-selected','false');
function selectDesktopShortcut(id){
 shortcutSelection.select(id);
 for(const [shortcutId,button] of Object.entries(shortcutButtons)){
  const selected=shortcutSelection.isSelected(shortcutId);button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected));
 }
}

wireDrag($('main-window'),$('main-window').querySelector('.app-titlebar'));
wireDrag($('login-screen'),$('login-screen').querySelector('.app-titlebar'));
wireDrag(welcomeWindow,welcomeWindow.querySelector('.aero-titlebar'));
for(const win of [$('login-screen'),$('welcome-notepad')]){
 win.addEventListener('pointerdown',()=>bringToFront(win),{signal:abort.signal});
 win.addEventListener('focusin',()=>bringToFront(win),{signal:abort.signal});
}
const landingNote=$('welcome-text').value;
$('welcome-text').readOnly=true;
let onboardingShown=false;
let welcomeFontSize=14;
function renderWelcomeDocument(){
 const documentState=welcomeDocumentState({live:Boolean(options.live),runsEnabled:Boolean(options.runsEnabled)});
 $('welcome-text').value=documentState.guide;
 let disclosure=$('welcome-mode-disclosure');
 if(!disclosure){
  disclosure=document.createElement('div');disclosure.id='welcome-mode-disclosure';disclosure.className='welcome-mode-disclosure';disclosure.setAttribute('role','status');disclosure.setAttribute('aria-live','polite');
  welcomeWindow.querySelector('.notepad-menubar').after(disclosure);
 }
 disclosure.textContent=documentState.disclosure;disclosure.dataset.mode=documentState.mode;
}
function setWelcomeOpen(open,{focusShortcut=false}={}) {
 welcomeWindow.hidden=!open;
 writeWelcomePreference(localStorage,options,open);
 if(open){bringToFront(welcomeWindow);$('welcome-text').focus();}
 else if(focusShortcut){selectDesktopShortcut('notepad');$('reopen-welcome').focus();}
}
function setWelcomeFontSize(next) {
 welcomeFontSize=Math.max(11,Math.min(22,next));
 $('welcome-text').style.fontSize=`${welcomeFontSize}px`;
 $('welcome-font-status').textContent=`${Math.round(welcomeFontSize/14*100)}%`;
}
function selectWelcomeAll(){const text=$('welcome-text');text.focus();text.select();}
function copyWelcomeSelection(){
 const text=$('welcome-text');
 if(text.selectionStart===text.selectionEnd){notify('Selecione um trecho do guia para copiar.');return;}
 text.focus();
 if(!document.execCommand?.('copy'))notify('Use Ctrl+C ou Command+C para copiar o trecho selecionado.');
}
function downloadWelcome(){
 const url=URL.createObjectURL(new Blob([$('welcome-text').value],{type:'text/plain;charset=utf-8'}));
 const link=document.createElement('a');link.href=url;link.download='Como usar o Bot Live Messenger.txt';link.click();
 window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function welcomeMenu(anchor,name){
 const text=$('welcome-text');
 const wrap=text.wrap!=='off';
 const menuState=welcomeMenuState({selectionStart:text.selectionStart,selectionEnd:text.selectionEnd,wrap,fontSize:welcomeFontSize});
 const menus={
  arquivo:[
   {label:'Novo',disabled:true},{label:'Abrir...',disabled:true},{label:'Salvar',disabled:true},{separator:true},
   {label:'Baixar como .txt',action:downloadWelcome},{separator:true},{label:'Fechar',action:()=>setWelcomeOpen(false,{focusShortcut:true})}
  ],
  editar:[
   {label:'Desfazer',disabled:true},{separator:true},{label:'Recortar',disabled:true},
   {label:'Copiar',disabled:!menuState.canCopy,action:copyWelcomeSelection},
   {label:'Colar',disabled:true},{label:'Excluir',disabled:true},{separator:true},
   {label:'Selecionar tudo',action:selectWelcomeAll}
  ],
  formatar:[
   {label:'Quebra automática de linha',check:menuState.wrapChecked,action:()=>{text.wrap=wrap?'off':'soft';}},
   {label:'Fonte...',disabled:true},{separator:true},
   {label:'Aumentar fonte',disabled:!menuState.canIncreaseFont,action:()=>setWelcomeFontSize(welcomeFontSize+1)},
   {label:'Diminuir fonte',disabled:!menuState.canDecreaseFont,action:()=>setWelcomeFontSize(welcomeFontSize-1)},
   {label:'Tamanho padrão',check:menuState.defaultFont,action:()=>setWelcomeFontSize(14)}
  ],
  exibir:[{label:'Barra de status',check:true,disabled:true}],
  ajuda:[{label:'Exibir Ajuda',disabled:true},{separator:true},{label:'Sobre este guia',action:()=>openDialog('Sobre o guia','<h2>Como usar o Bot Live Messenger</h2><p>Este documento apresenta os controles disponíveis no Bot Live Messenger.</p>',null)}]
 };
 showMenu(anchor,menus[name]||[]);
}
function showOnboarding(){
 renderWelcomeDocument();
 if(onboardingShown)return;
 onboardingShown=true;
 $('welcome-text').scrollTop=0;
 welcomeWindow.classList.remove('maximized');
 welcomeWindow.style.left='';welcomeWindow.style.top='';
 welcomeWindow.hidden=!readWelcomePreference(localStorage,options);
 if(!welcomeWindow.hidden)bringToFront(welcomeWindow);
}
$('close-welcome').onclick=$('minimize-welcome').onclick=()=>setWelcomeOpen(false,{focusShortcut:true});
$('minimize-main').onclick=$('close-main').onclick=()=>{closeMenu();$('main-window').hidden=true;selectDesktopShortcut('messenger');$('open-messenger').focus();};
$('maximize-main').onclick=()=>{const full=$('main-window').classList.toggle('maximized');$('maximize-main').setAttribute('aria-label',full?'Restaurar Bot Live Messenger':'Maximizar Bot Live Messenger');};

$('open-messenger').onclick=()=>{selectDesktopShortcut('messenger');const signedIn=$('login-screen').hidden;const win=signedIn?$('main-window'):$('login-screen');win.hidden=false;bringToFront(win);(signedIn?$('search'):$('auth-email')).focus();};
$('reopen-welcome').onclick=()=>{selectDesktopShortcut('notepad');setWelcomeOpen(true);};
$('maximize-welcome').onclick=()=>{const full=welcomeWindow.classList.toggle('maximized');$('maximize-welcome').setAttribute('aria-label',full?'Restaurar Bloco de Notas':'Maximizar Bloco de Notas');};


function ensureWindow(id){
 if(windows.has(id))return;
 let win;
 if(!rootWindow.dataset.botId){win=rootWindow;wireDrag(win);}
 else {
  win=rootWindow.cloneNode(true);win.hidden=true;win.classList.remove('maximized');
  const sources=[rootWindow,...rootWindow.querySelectorAll('[id]')];
  const targets=[win,...win.querySelectorAll('[id]')];
  sources.forEach((source,index)=>{
   const target=targets[index];
   if(source.id){target.dataset.part=source.id;target.removeAttribute('id');}
   for(const property of ['onclick','onsubmit','onchange'])if(source[property])target[property]=source[property];
   registeredListeners.filter(item=>item.element===source).forEach(item=>target.addEventListener(item.type,item.handler,item.options));
  });
  host.append(win);wireDrag(win);
 }
 win.dataset.botId=id;windows.set(id,win);win.hidden=false;
 const offset=(windows.size-1)%5*24;
 const contactBounds=$('main-window').getBoundingClientRect();
 moveWindow(win,contactBounds.right+32+offset,115+offset);
 bringToFront(win);
}
function focusWindow(win){
 if(win===$('main-window')){bringToFront(win);return;}
 const id=win.dataset.botId;if(!id)return;
 if(state.active!==id){saveDraft();state.active=id;$('message-input').value=state.drafts[id]||'';renderConversation();renderContacts();}
 bringToFront(win);
}
host.addEventListener('pointerdown',event=>{const win=event.target.closest('.aero-window,#main-window');if(win)focusWindow(win);},true);
host.addEventListener('focusin',event=>{const win=event.target.closest('.aero-window,#main-window');if(win)focusWindow(win);});
window.addEventListener('resize',()=>{closeMenu();for(const win of desktopWindows()){if(!win.hidden&&!win.classList.contains('maximized')){const rect=win.getBoundingClientRect();moveWindow(win,rect.left,rect.top);}}},{signal:abort.signal});

renderContacts();



// Explicit demo authentication is local; configured account forms use /api/auth.
// Demo account records are never an access-control boundary.
// Account records and password fingerprints are held in memory and reset on reload.
(() => {
  const accounts = new Map();
  const initialAgents = agents.map(agent=>({...agent}));
  const initialWorkspace = structuredClone(state);
  const demo = {email:'bot@messenger.test',name:'Você',password:'messenger'};
  const rememberedEmailKey = 'agent-messenger.remembered-email';
  let mode = 'login';
  let attempt = 0;
  let connecting = false;
  let demoAttempt = false;
  let loginTimer;

  // Deterministic one-way fingerprint for fictitious credentials, not production security.
  // Avoids keeping entered passwords in the account records and works with file:// too.
  function fingerprint(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash,16777619);
    }
    return (hash >>> 0).toString(16);
  }
  accounts.set(demo.email,{name:demo.name,fingerprint:fingerprint(demo.password)});

  function error(message,field) {
    $('auth-error').textContent = message;
    $('auth-error').hidden = false;
    if(field) {
      field.setAttribute('aria-invalid','true');
      field.focus();
    }
  }
  function clearError() {
    $('auth-error').hidden = true;
    $('auth-error').textContent = '';
    $('auth-form').querySelectorAll('[aria-invalid]').forEach(field=>field.removeAttribute('aria-invalid'));
  }
  function setMode(nextMode) {
    if(connecting)return;
    mode=nextMode;
    const signup=mode==='signup';
    clearError();
    $('login-screen').classList.toggle('signup-mode',signup);
    $('signup-name-field').hidden=!signup;
    $('signup-confirm-field').hidden=!signup;
    $('auth-name').required=signup;
    $('auth-confirm').required=signup;
    $('auth-heading').textContent=signup?'Criar uma conta':'Entrar';
    $('auth-subheading').textContent=signup?'Seu nome, seus bots, suas conversas.':'Seus bots estão esperando por você.';
    $('auth-submit').textContent=signup?'Criar conta':'Entrar';
    $('auth-password').autocomplete=signup?'new-password':'current-password';
    $('auth-password').value='';$('auth-confirm').value='';
    $('forgot-password').hidden=signup;
    $('auth-switch-copy').firstChild.textContent=signup?'Já tem uma conta? ':'Ainda não tem uma conta? ';
    $('auth-switch').textContent=signup?'Entrar':'Criar uma conta';
    (signup?$('auth-name'):$('auth-email')).focus();
  }
  function setConnecting(value) {
    connecting=value;
    $('auth-fields').disabled=value;
    $('auth-submit').disabled=value;
    $('auth-switch').disabled=value;
    $('auth-demo-button').disabled=value;
    $('forgot-password').disabled=value;
    $('auth-progress').hidden=!value;
    $('auth-cancel').hidden=!value;
    $('auth-form').setAttribute('aria-busy',String(value));
    $('login-avatar').className=`avatar-frame ${value?'available':'offline'}`;
    if(value)$('auth-cancel').focus();
  }
  function cancelConnection() {
    attempt++;
    clearTimeout(loginTimer);
    setConnecting(false);
    $('auth-password').value='';$('auth-confirm').value='';
    $('auth-email').focus();
  }
  function rememberEmail(email) {
    try {
      if($('auth-remember').checked)localStorage.setItem(rememberedEmailKey,email);
      else localStorage.removeItem(rememberedEmailKey);
    } catch { /* Remembering an email is optional in restricted file:// contexts. */ }
  }
  function enterMessenger(account,email) {
    rememberEmail(email);
    state.userStatus=$('auth-presence').value;
    $('user-display-name').textContent=account.name;
    $('user-presence').textContent=`(${state.userStatus==='offline'?'Invisível':statusLabels[state.userStatus]})`;
    renderUserPictures();
    $('auth-password').value='';$('auth-confirm').value='';
    setConnecting(false);
    $('login-screen').hidden=true;
    $('main-window').hidden=false;
    showOnboarding();
    document.title='Bot Live Messenger';
    renderContacts();
    $('search').focus();
  }
  listen($('auth-form'),'submit',async event=>{
    event.preventDefault();
    if(connecting)return;
    clearError();
    const email=$('auth-email').value.trim().toLowerCase();
    $('auth-email').value=email;
    const password=$('auth-password').value;
    const name=$('auth-name').value.trim();
    if(mode==='signup'&&!name)return error('Digite o nome que aparecerá nas suas conversas.',$('auth-name'));
    if(!email||!$('auth-email').validity.valid)return error('Digite um endereço de e-mail válido.',$('auth-email'));
    if(password.length<6)return error(options.authConfigured?'Use uma senha com pelo menos 6 caracteres.':'Use uma senha fictícia com pelo menos 6 caracteres.',$('auth-password'));
    if(mode==='signup'&&password!==$('auth-confirm').value)return error('As senhas não são iguais. Digite novamente.',$('auth-confirm'));
    if(options.authConfigured && !demoAttempt) {
      const currentAttempt=++attempt;
      setConnecting(true);
      try {
        const response=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:mode,email,password,name}),signal:abort.signal});
        const result=await response.json();
        if(currentAttempt!==attempt)return;
        if(!response.ok)throw new Error(result.error);
        rememberEmail(email);
        if(result.confirmEmail) {setConnecting(false);setMode('login');notify('Confira seu e-mail para confirmar a conta.');}
        else window.location.assign('/messenger');
      } catch(e) {if(abort.signal.aborted || currentAttempt!==attempt)return;setConnecting(false);error(e.message || 'Não foi possível entrar. Tente novamente.');}
      return;
    }
    demoAttempt=false;
    if(mode==='signup'&&accounts.has(email))return error('Este e-mail já tem uma conta nesta sessão. Escolha Entrar.',$('auth-email'));
    const submittedMode=mode;
    const passwordFingerprint=fingerprint(password);
    const currentAttempt=++attempt;
    $('auth-progress-text').textContent=submittedMode==='signup'?'Criando sua conta de demonstração...':'Conectando...';
    setConnecting(true);
    loginTimer=setTimeout(()=>{
      if(currentAttempt!==attempt)return;
      if(submittedMode==='signup') {
        const account={name,fingerprint:passwordFingerprint};
        accounts.set(email,account);
        enterMessenger(account,email);
      } else {
        const account=accounts.get(email);
        if(!account||account.fingerprint!==passwordFingerprint) {
          setConnecting(false);
          $('auth-password').value='';
          return error('O e-mail ou a senha não conferem. Use a conta de demonstração ou crie uma conta nesta sessão.',$('auth-password'));
        }
        enterMessenger(account,email);
      }
    },750);
  });
  $('auth-switch').onclick=()=>setMode(mode==='login'?'signup':'login');
  $('auth-cancel').onclick=cancelConnection;
  listen($('auth-form'),'input',clearError);
  $('auth-presence').onchange=()=>$('auth-presence-dot').className=`presence-indicator ${$('auth-presence').value}`;
  $('auth-demo-button').onclick=()=>{
    setMode('login');
    demoAttempt=true;
    $('auth-email').value=demo.email;
    $('auth-password').value=demo.password;
    $('auth-form').requestSubmit();
  };
  $('forgot-password').onclick=()=>openDialog('Não consegue entrar?',
    '<h2>Vamos voltar às suas conversas.</h2><p>Este protótipo não envia e-mails de recuperação. As contas criadas existem apenas até a página ser recarregada.</p><p>Para experimentar, use <b>bot@messenger.test</b> com a senha fictícia <b>messenger</b>, ou crie uma nova conta.</p>',
    ()=>{closeDialog();$('auth-demo-button').click();},'Usar demonstração');
  document.querySelectorAll('[data-auth-info]').forEach(button=>button.onclick=()=>{
    const privacy=button.dataset.authInfo==='privacy';
    openDialog(privacy?'Privacidade — Demonstração':'Bem-vindo ao Bot Live Messenger',privacy?
      '<h2>Uma demonstração no seu navegador.</h2><p>Nenhum dado é enviado a um servidor. As contas e conversas ficam na memória desta página e são reiniciadas ao recarregar.</p><p>Se você marcar “Lembrar meu e-mail”, somente o endereço será guardado neste navegador. Desmarque a opção e entre novamente para removê-lo. Senhas não são gravadas no armazenamento do navegador.</p><p>Use dados fictícios. Este formulário não oferece autenticação real.</p>':
      '<h2>Entre. Seus bots estão por aqui.</h2><p>Crie uma conta fictícia para escolher seu nome de exibição, ou use a conta de demonstração para explorar.</p><p>Depois de entrar, escolha um bot na lista para conversar. O status mostra quando ele está disponível, trabalhando ou desconectado.</p>',null);
  });
  $('sign-out').onclick=()=>{
    if(options.live){void liveSignOut();return;}
    saveDraft();closeMenu();
    if($('classic-dialog').open)closeDialog();
    // End pending work on sign-out so no reply notification leaks onto the login screen.
    state.jobs.forEach((timer,id)=>{clearTimeout(timer);agentById(id).status='available';});
    agents.splice(0,agents.length,...initialAgents.map(agent=>({...agent})));
    Object.assign(state,structuredClone(initialWorkspace));
    document.body.dataset.scene=state.scene;
    renderUserPictures();
    $('message-input').value='';
    for(const win of windows.values())win.hidden=true;
    $('conversation-window').hidden=true;$('toast').hidden=true;
    $('main-window').hidden=true;$('login-screen').hidden=false;onboardingShown=false;$('welcome-text').value=landingNote;$('welcome-text').scrollTop=0;
    $('auth-password').value='';$('auth-confirm').value='';
    setMode(options.recovery?'login':'signup');
  document.title='Criar uma conta — Bot Live Messenger';
    setMode('login');
  };
  try {
    const remembered=localStorage.getItem(rememberedEmailKey);
    // Migrate the previous public demo address without changing user-created accounts.
    if(remembered){$('auth-email').value=remembered.replace(/^agente@messenger\.test$/,demo.email);$('auth-remember').checked=true;}
  } catch { /* Login remains usable without storage. */ }
  document.title='Entrar — Bot Live Messenger';
})();


function unavailable(){openDialog('Bot Live Messenger','<h2>Esta função está sendo preparada.</h2><p>Ela está disponível na demonstração. A integração com sua conta ainda não foi habilitada.</p>',null);}
async function liveSend(event){
 event.preventDefault();const id=state.active;
 const runs=options.runs||options.activeRuns||{};
 if(!id || !options.runsEnabled || livePending.has(id) || isActiveRun(runs[id]))return;
 const submittedDraft=$('message-input').value;
 const content=submittedDraft.trim();if(!content)return;
 if(requestKeys.get(id)?.content!==content)requestKeys.set(id,{content,key:crypto.randomUUID()});
 livePending.add(id);renderConversation();
 try{
  const response=await fetch(`/api/bots/${id}/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,idempotencyKey:requestKeys.get(id).key}),signal:abort.signal});
  const result=await response.json();if(!response.ok)throw new Error(result.error);
  if(abort.signal.aborted)return;
  requestKeys.delete(id);state.drafts[id]=draftAfterSuccessfulSend(state.drafts[id],submittedDraft);
  if(state.active===id){const input=$('message-input');input.value=draftAfterSuccessfulSend(input.value,submittedDraft);state.drafts[id]=input.value;}
  state.messages[id]=acceptedMessagesAfterSend(state.messages[id]||[],{id:result.messageId,content});
  options.runs=runAfterRequest(options.runs,id,result.run||{id:result.runId,bot_id:id,kind:'chat',state:result.status||'QUEUED',cancel_requested:false,error_code:null,created_at:new Date().toISOString(),finished_at:null});
  if(state.active===id)renderConversation(true);
  options.refresh?.();
 }catch(e){if(!abort.signal.aborted)notify(e.message || 'Não foi possível enviar.');}
 finally{livePending.delete(id);if(!abort.signal.aborted)renderConversation();}
}
async function liveStop(){
 const id=state.active;const runs=options.runs||options.activeRuns||{};const run=runs[id];if(!id||!run||!isActiveRun(run))return;
 try{
  const response=await fetch(`/api/runs/${run.id}/cancel`,{method:'POST',signal:abort.signal});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Não foi possível interromper.');
  if(abort.signal.aborted)return;
  options.runs=runAfterRequest(options.runs,id,result.run);renderConversation();options.refresh?.();
 }catch(e){if(!abort.signal.aborted)notify(e.message);}
}
async function liveSignOut(){
 try{
  const response=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'signout'}),signal:abort.signal});
  if(!response.ok)throw new Error('Não foi possível sair. Tente novamente.');
  window.location.assign('/');
 }catch(e){if(!abort.signal.aborted)notify(e.message);}
}
function syncLive(){
 if(!options.live)return;
 agents.splice(0,agents.length,...(options.bots||[]).map(bot=>({...bot,avatar:portraitUrl(bot.avatar_id),status:presence(bot.computer_state,bot.run_state,bot.enabled)})));
 state.messages=Object.fromEntries(Object.entries(options.messages||{}).map(([id,list])=>[id,list.map(m=>({id:m.id,author:m.role==='assistant'?'agent':m.role,text:m.content,time:new Date(m.created_at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),files:deliveredFilesForMessage(m.artifacts)}))]));
 state.userAvatarId=options.userAvatarId||defaultPicture;renderUserPictures();
 state.instructions=Object.fromEntries(agents.map(b=>[b.id,b.instructions]));
 state.jobs.clear();Object.entries(options.runs||options.activeRuns||{}).filter(([,run])=>isActiveRun(run)).forEach(([id,run])=>state.jobs.set(id,run.id));
 if(!state.favorites.size || state.favorites.has('grok'))state.favorites=new Set(agents.slice(0,2).map(b=>b.id));
 state.tabs=state.tabs.filter(id=>agents.some(b=>b.id===id));
 if(state.active&&!agents.some(b=>b.id===state.active))hideConversation(true);
 const entry=liveEntryState(liveEntered,$('main-window').hidden);liveEntered=entry.entered;
 if(entry.showOnboarding){$('login-screen').hidden=true;$('main-window').hidden=entry.mainWindowHidden;showOnboarding();}
 else renderWelcomeDocument();
 $('user-display-name').textContent=options.userName||'Você';
 $('main-window').querySelector('.statusbar-right').lastChild.textContent=options.runsEnabled?'Conectado':'Tarefas em preparação';
 commands.attach=unavailable;
 commands.about=()=>openDialog('Sobre o Bot Live Messenger','<h2>Bot Live Messenger</h2><p>Seus bots, na sua lista de contatos.</p><p>Suas conversas ficam salvas na sua conta. As tarefas reais são habilitadas após a configuração dos serviços.</p>',null);
 renderContacts();
 const focused=state.active;for(const id of windows.keys()){if(agents.some(b=>b.id===id)){state.active=id;renderConversation();}}state.active=focused;
 document.title='Bot Live Messenger';
}
if(options.authConfigured){
 $('auth-demo-button').nextElementSibling.textContent='Demonstração local. Use dados fictícios somente na demonstração.';
 $('forgot-password').onclick=()=>openDialog('Recuperar acesso','<h2>Recuperar sua conta</h2><p>Para redefinir a senha, informe o e-mail da sua conta.</p><label class="field">E-mail<input id="recovery-email" type="email" required></label>',async()=>{
  const email=$('recovery-email').value;
  try{const response=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'recover',email}),signal:abort.signal});const result=await response.json();if(!response.ok)throw new Error(result.error);closeDialog();notify('Se houver uma conta, você receberá as instruções por e-mail.');}catch(e){if(!abort.signal.aborted)notify(e.message);}
 },'Enviar');
 host.querySelectorAll('[data-auth-info]').forEach(button=>button.onclick=()=>openDialog('Bot Live Messenger',button.dataset.authInfo==='privacy'?'<h2>Sua conta e suas conversas.</h2><p>O acesso usa autenticação segura. Conversas da sua conta ficam salvas para você continuar depois. A demonstração funciona localmente e usa dados fictícios.</p>':'<h2>Entre. Seus bots estão por aqui.</h2><p>Entre com seu e-mail e senha, crie uma conta ou experimente a demonstração local.</p>',null));
}
host.addEventListener('error',event=>{const img=event.target;if(img instanceof HTMLImageElement&&img.dataset.catalogPicture&&!img.dataset.fallback){img.dataset.fallback='true';img.src=portraitUrl(defaultPicture);}},{capture:true,signal:abort.signal});
reducedMotion.addEventListener('change',()=>{host.querySelectorAll('img[data-catalog-picture]').forEach(img=>{img.src=portraitUrl(img.dataset.catalogPicture);});},{signal:abort.signal});
if(!options.live){try{const saved=localStorage.getItem('bot-messenger.demo-picture');if(displayPictures.includes(saved))state.userAvatarId=saved;}catch{}}
renderUserPictures();
const loginPicture=$('login-avatar').querySelector('img');loginPicture.src=portraitUrl(defaultPicture);loginPicture.dataset.catalogPicture=defaultPicture;
if(options.preview){$('login-screen').hidden=true;$('main-window').hidden=false;showOnboarding();document.title='Bot Live Messenger';}
syncLive();
if(options.initialError){$('auth-error').hidden=false;$('auth-error').textContent=options.initialError;}
if(options.recovery){
 $('auth-heading').textContent='Nova senha';$('auth-subheading').textContent='Escolha uma nova senha para sua conta.';
 $('auth-email').closest('label').hidden=true;$('auth-email').required=false;
 $('signup-confirm-field').hidden=false;$('auth-confirm').required=true;
 $('auth-submit').textContent='Salvar senha';$('auth-password').autocomplete='new-password';
 host.querySelector('.auth-links').hidden=true;host.querySelector('.auth-demo').hidden=true;
 host.querySelector('.signin-presence').hidden=true;host.querySelector('.auth-remember').hidden=true;
 listen($('auth-form'),'submit',async event=>{
  event.preventDefault();event.stopImmediatePropagation();
  const password=$('auth-password').value;
  if(password.length<6||password!==$('auth-confirm').value){$('auth-error').hidden=false;$('auth-error').textContent='Use pelo menos 6 caracteres e confirme a mesma senha.';return;}
  $('auth-submit').disabled=true;
  try{const response=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reset',password}),signal:abort.signal});const result=await response.json();if(!response.ok)throw new Error(result.error);window.location.assign('/messenger');}
  catch(e){if(!abort.signal.aborted){$('auth-error').hidden=false;$('auth-error').textContent=e.message;$('auth-submit').disabled=false;}}
 },{capture:true});
}
return {
 update(next){options=next;syncLive();},
 destroy(){abort.abort();timers.forEach(id=>window.clearTimeout(id));timers.clear();audioContext?.close();if($('classic-dialog')?.open)$('classic-dialog').close();document.body.dataset.scene=previousScene;host.replaceChildren();}
};
}
