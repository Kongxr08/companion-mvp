'use strict';
const $ = id => document.getElementById(id);
let state, initialized = false, sending = false, refreshing = false, lastMessageSignature = '', editingId = null;
let latestId = 0, notified = new Set(), pendingRequest = null, toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
async function api(path, data) {
  const options = data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)};
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本地服务暂时不可用');
  return result;
}
function el(tag, className, text) { const node = document.createElement(tag); if(className) node.className=className; if(text !== undefined) node.textContent=text; return node; }
function stamp(seconds) { return new Date(seconds * 1000).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function action(text, callback) { const button=el('button','text-button',text); button.type='button'; button.addEventListener('click', async () => {button.disabled=true;try{await callback();}catch(e){toast(e.message);}finally{button.disabled=false;}}); return button; }
function renderMessages(messages) {
  const signature=JSON.stringify(messages);
  if(signature===lastMessageSignature) return;
  const area=$('messages'), nearBottom=area.scrollHeight-area.scrollTop-area.clientHeight<100;
  if(messages.length) {
    area.replaceChildren();
    for(const message of messages) {
      const item=el('article',`message ${message.role} ${message.kind}`);
      const meta=el('div','message-meta');
      meta.append(el('span','',message.role==='user'?'你':state.settings.name));
      if(message.kind==='reminder'||message.kind==='proactive') meta.append(el('span','kind-badge',message.kind==='reminder'?'约定提醒':'主动消息'));
      meta.append(el('time','',stamp(message.created_at)));
      item.append(meta,el('div','bubble',message.content)); area.append(item);
      if(initialized && message.id>latestId && message.role==='assistant' && message.kind!=='chat' && !notified.has(message.id)) {
        notified.add(message.id);
        if('Notification' in window && Notification.permission==='granted' && document.hidden) {try{new Notification(state.settings.name,{body:message.content.slice(0,150),tag:`companion-${message.id}`});}catch{}}
      }
    }
  } else if(lastMessageSignature && !$('welcome')) {
    const welcome=el('div','welcome');welcome.id='welcome';welcome.append(el('span','welcome-icon','✺'),el('h2','','从一句话开始。'),el('p','','告诉我一个小偏好，或者今天发生的事。'));area.replaceChildren(welcome);
  }
  latestId=Math.max(latestId,...messages.map(m=>m.id),0);
  lastMessageSignature=signature;
  if(nearBottom || !initialized) area.scrollTop=area.scrollHeight;
}
function renderMemories(memories) {
  $('memory-count').textContent=memories.length;
  const list=$('memory-list'); list.replaceChildren();
  if(!memories.length) list.append(el('div','empty','还没有记忆。\n试着说：“我喜欢雨天。”'));
  const names={profile:'关于你',preference:'偏好',fact:'记住的事',episode:'共同经历'};
  for(const memory of memories) {
    const card=el('article','card'),top=el('div','card-top');top.append(el('span','tag',names[memory.category]||'记忆'),el('span','card-date',stamp(memory.updated_at)));
    card.append(top,el('p','card-content',memory.content));
    card.append(el('p','card-evidence',memory.origin==='manual'?'由你手动确认':`原始依据：${memory.evidence||'聊天来源已清理'}`));
    const actions=el('div','card-actions');
    actions.append(action('修改',async()=>{editingId=memory.id;$('edit-content').value=memory.content;$('edit-dialog').showModal();}),action('忘记',async()=>{await api('/api/memory/delete',{id:memory.id});await refresh();toast('已忘记，并重置短期上下文');}));
    card.append(actions);list.append(card);
  }
}
function renderTasks(tasks) {
  const list=$('task-list');list.replaceChildren();
  if(!tasks.length) list.append(el('div','empty','还没有约好的提醒。'));
  for(const task of tasks) {
    const card=el('article','card'),top=el('div','card-top');
    top.append(el('span','tag',{pending:'等待投递',delivered:'已送达',cancelled:'已取消'}[task.status]),el('span','card-date',stamp(task.due_at)));
    card.append(top,el('p','card-content',task.title));
    if(task.status==='pending')card.append(action('取消提醒',async()=>{await api('/api/tasks/cancel',{id:task.id});await refresh();toast('提醒已取消');}));
    list.append(card);
  }
}
function fillSettings(s) {
  $('setting-name').value=s.name;$('setting-persona').value=s.persona;
  $('setting-proactive').checked=s.proactive_enabled;$('setting-idle').checked=s.idle_enabled;
  $('setting-minutes').value=s.idle_minutes;$('setting-limit').value=s.daily_limit;
  $('quiet-start').value=s.quiet_start;$('quiet-end').value=s.quiet_end;$('setting-zone').value=s.timezone_offset;
}
async function refresh() {
  if(refreshing)return;refreshing=true;
  try {
    const next=await api('/api/state'),old=state;state=next;
    $('character-name').textContent=next.settings.name;
    document.title=`${next.settings.name} · 记得每一次相遇`;
    $('model-status').textContent=next.model;
    $('mode-banner').hidden=next.mode!=='demo';
    $('mood-label').textContent=next.mood.label;$('mood-reason').title=next.mood.reason;
    for(const key of ['valence','energy']) {$(key).value=next.mood[key];$(key+'-text').textContent=Math.round(next.mood[key]*100)+'%';}
    renderMessages(next.messages);
    if(!old || JSON.stringify(old.memories)!==JSON.stringify(next.memories))renderMemories(next.memories);
    if(!old || JSON.stringify(old.tasks)!==JSON.stringify(next.tasks))renderTasks(next.tasks);
    if(!initialized)fillSettings(next.settings);
    $('connection').textContent=next.scheduler_error?`● ${next.scheduler_error}`:`● 本地服务在线 · ${next.settings.proactive_enabled?'主动消息已允许':'主动消息已暂停'}`;
    initialized=true;
  } catch(e) {$('connection').textContent='● 连接中断，请检查后台程序';if(!initialized)showError(e.message);}
  finally {refreshing=false;}
}
for(const id of ['quiet-start','quiet-end'])for(let i=0;i<24;i++){const option=el('option','',String(i).padStart(2,'0')+':00');option.value=i;$(id).append(option);}
for(const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click',()=>{for(const tab of document.querySelectorAll('[data-tab]')){const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',active);$('panel-'+tab.dataset.tab).hidden=!active;}});
for(const button of document.querySelectorAll('[data-prompt]'))button.addEventListener('click',()=>{$('message').value=button.dataset.prompt;$('message').focus();});
$('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!sending)$('chat-form').requestSubmit();}});
$('chat-form').addEventListener('submit',async e=>{
  e.preventDefault();if(sending)return;const text=$('message').value.trim();if(!text)return;
  if(!pendingRequest || pendingRequest.text!==text)pendingRequest={text,id:crypto.randomUUID()};
  sending=true;$('send').disabled=true;$('message').readOnly=true;$('send').textContent='在听…';showError('');
  try{const result=await api('/api/chat',{message:text,request_id:pendingRequest.id});$('message').value='';pendingRequest=null;await refresh();$('messages').scrollTop=$('messages').scrollHeight;if(result.saved_memories)toast(`留下了 ${result.saved_memories} 条记忆`);}
  catch(err){showError(err.message+'。内容已保留，可直接重试。');}
  finally{sending=false;$('send').disabled=false;$('message').readOnly=false;$('send').textContent='发送 ↗';$('message').focus();}
});
$('memory-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/memory',{content:$('memory-content').value});$('memory-content').value='';await refresh();toast('记忆已保存');}catch(err){toast(err.message);}});
$('edit-cancel').addEventListener('click',()=>$('edit-dialog').close());
$('edit-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/memory',{id:editingId,content:$('edit-content').value});$('edit-dialog').close();await refresh();toast('记忆已更新');}catch(err){toast(err.message);}});
$('task-form').addEventListener('submit',async e=>{e.preventDefault();try{const due=new Date($('task-time').value).getTime()/1000;await api('/api/tasks',{title:$('task-title').value,due_at:due});$('task-title').value='';await refresh();toast('提醒已安排；免打扰期间会延后投递');}catch(err){toast(err.message);}});
$('quick-reminder').addEventListener('click',async()=>{try{await api('/api/tasks',{title:'休息一下，喝一杯水。',due_at:Date.now()/1000+20});await refresh();toast(state.settings.proactive_enabled?'20 秒后投递；免打扰期间会延后':'提醒已创建，请在设定中允许主动消息');}catch(err){toast(err.message);}});
$('settings-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/settings',{name:$('setting-name').value,persona:$('setting-persona').value,proactive_enabled:$('setting-proactive').checked,idle_enabled:$('setting-idle').checked,idle_minutes:Number($('setting-minutes').value),daily_limit:Number($('setting-limit').value),quiet_start:Number($('quiet-start').value),quiet_end:Number($('quiet-end').value),timezone_offset:Number($('setting-zone').value)});await refresh();toast('设定已保存');}catch(err){toast(err.message);}});
$('notify').addEventListener('click',async()=>{if(!('Notification'in window))return toast('此浏览器不支持系统通知，聊天收件箱仍可正常使用');try{const permission=await Notification.requestPermission();toast(permission==='granted'?'通知已开启：网页在后台打开时可收到通知':'未开启通知，消息仍会保存在聊天收件箱');}catch{toast('浏览器未提供通知权限，消息仍会保存在聊天收件箱');}});
$('clear-history').addEventListener('click',async()=>{if(!confirm('清空所有聊天记录？长期记忆、情绪和提醒会保留。'))return;try{await api('/api/history/clear',{});await refresh();toast('聊天记录已清空');}catch(err){toast(err.message);}});
refresh();setInterval(refresh,2500);
