// Minimal client-side assistant: chat + todos + notes + reminders
(()=>{
  // Helpers for localStorage
  const storage = {
    get(key, fallback){ try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch(e){ return fallback } },
    set(key,val){ localStorage.setItem(key, JSON.stringify(val)) }
  }

  // Configuration: load WORKER_BASE from `public/worker-config.json` at runtime.
  // This allows the deployed Pages site to point to the Worker without rebuilding.
  let WORKER_BASE = '';
  (async function loadWorkerConfig(){
    try{
      const r = await fetch('/worker-config.json', { cache: 'no-store' });
      if (r.ok){
        const cfg = await r.json();
        if (cfg && cfg.workerBase) WORKER_BASE = cfg.workerBase;
      }
    }catch(e){ /* ignore */ }
  })();

  // DOM
  const views = document.querySelectorAll('.view');
  const sidebarBtns = document.querySelectorAll('.sidebar button');
  function showView(name){
    views.forEach(v=>v.classList.add('hidden'));
    document.getElementById('view-'+name).classList.remove('hidden');
    sidebarBtns.forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  }
  sidebarBtns.forEach(b=>b.addEventListener('click', ()=>showView(b.dataset.view)));

  // Chat
  const chatLog = document.getElementById('chat-log');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  function appendMessage(text, who='assistant'){
    const el = document.createElement('div');
    el.className = 'chat-bubble '+(who==='user'?'user':'assistant');
    el.textContent = text;
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // Assistant logic (simple heuristics)
  function assistantReply(message){
    message = message.trim();
    // Add todo: "add todo buy milk" or "add a todo: buy milk"
    let m = message.match(/(?:add|create) (?:a )?todo[: ]?\s*(.+)/i);
    if(m){
      addTodo(m[1]);
      return `Added to‑do: "${m[1]}"`;
    }

    m = message.match(/(?:remind me to)\s+(.+)\s+in\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)/i);
    if(m){
      const text = m[1];
      const num = parseInt(m[2],10);
      const unit = m[3];
      let ms = 0;
      if(unit.startsWith('second')) ms = num*1000;
      else if(unit.startsWith('minute')) ms = num*60*1000;
      else if(unit.startsWith('hour')) ms = num*60*60*1000;
      scheduleReminder(Date.now()+ms, text);
      return `Okay — I'll remind you to "${text}" in ${num} ${unit}.`;
    }

    if(/list todos|show todos|what are my todos/i.test(message)){
      const todos = storage.get('ca_todos',[]);
      if(!todos.length) return 'You have no to‑dos.';
      return 'To‑dos:\n' + todos.map((t,i)=>`${i+1}. ${t.text}${t.done? ' (done)':''}`).join('\n');
    }

    if(/note|remember/i.test(message) && message.includes(':')){
      let parts = message.split(':');
      const title = parts.shift().trim();
      const body = parts.join(':').trim();
      addNote(body);
      return `Saved a note: "${body.slice(0,60)}"`;
    }

    if(/help|commands|what can you do/i.test(message)){
      return 'I can manage simple to‑dos, notes, and reminders. Try: "add todo buy milk", "remind me to stretch in 10 minutes", "save note: buy milk".';
    }

    // Default friendly response
    return "I can help with to‑dos, notes and reminders — say 'help' for examples.";
  }

  chatForm.addEventListener('submit', (ev)=>{
    ev.preventDefault();
    const text = chatInput.value.trim();
    if(!text) return;
    appendMessage(text,'user');
    chatInput.value='';
    setTimeout(()=>{
      const reply = assistantReply(text);
      appendMessage(reply,'assistant');
    }, 250);
  });

  // To‑dos
  function getTodos(){ return storage.get('ca_todos',[]) }
  function saveTodos(todos){ storage.set('ca_todos',todos); renderTodos(); }
  function addTodo(text){ const todos = getTodos(); todos.push({text, done:false, id:Date.now()}); saveTodos(todos); }
  function toggleTodo(id){ const todos = getTodos().map(t=> t.id===id?({...t, done: !t.done}):t); saveTodos(todos); }
  function removeTodo(id){ const todos = getTodos().filter(t=>t.id!==id); saveTodos(todos); }

  const todoForm = document.getElementById('todo-form');
  const todoInput = document.getElementById('todo-input');
  const todoList = document.getElementById('todo-list');

  todoForm.addEventListener('submit', (e)=>{ e.preventDefault(); const v=todoInput.value.trim(); if(!v) return; addTodo(v); todoInput.value=''; appendMessage(`Added to‑do: ${v}`,'assistant'); });

  function renderTodos(){
    todoList.innerHTML='';
    getTodos().forEach(t=>{
      const li = document.createElement('li');
      const left = document.createElement('div');
      left.textContent = t.text + (t.done ? ' ✓' : '');
      li.appendChild(left);
      const btns = document.createElement('div');
      const toggle = document.createElement('button'); toggle.textContent = t.done? 'Undo':'Done'; toggle.addEventListener('click', ()=>toggleTodo(t.id));
      const del = document.createElement('button'); del.textContent='Delete'; del.addEventListener('click', ()=>removeTodo(t.id));
      btns.appendChild(toggle); btns.appendChild(del);
      li.appendChild(btns);
      todoList.appendChild(li);
    })
  }

  // Notes
  function getNotes(){ return storage.get('ca_notes',[]) }
  function saveNotes(notes){ storage.set('ca_notes',notes); renderNotes(); }
  function addNote(text){ const notes = getNotes(); notes.unshift({text, time:Date.now(), id:Date.now()}); saveNotes(notes); }

  const noteInput = document.getElementById('note-input');
  const saveNoteBtn = document.getElementById('save-note');
  const notesList = document.getElementById('notes-list');

  saveNoteBtn.addEventListener('click', ()=>{ const v=noteInput.value.trim(); if(!v) return; addNote(v); noteInput.value=''; appendMessage('Saved a note for you.','assistant'); });

  function renderNotes(){ notesList.innerHTML=''; getNotes().forEach(n=>{ const li=document.createElement('li'); li.textContent = new Date(n.time).toLocaleString() + ' — ' + n.text; notesList.appendChild(li); }) }

  // Reminders
  function getReminders(){ return storage.get('ca_reminders',[]) }
  function saveReminders(list){ storage.set('ca_reminders',list); renderReminders(); }
  function scheduleReminder(timestamp, text){ const rem = getReminders(); const id = Date.now(); rem.push({id,text,timestamp}); saveReminders(rem); scheduleTimeout({id,text,timestamp}); }

  const remForm = document.getElementById('reminder-form');
  const remText = document.getElementById('reminder-text');
  const remTime = document.getElementById('reminder-time');
  const remList = document.getElementById('reminders-list');

  remForm.addEventListener('submit', (e)=>{ e.preventDefault(); const text = remText.value.trim(); const when = remTime.value; if(!text || !when) return; const ts = new Date(when).getTime(); scheduleReminder(ts, text); remText.value = ''; remTime.value=''; appendMessage(`Scheduled reminder: ${text}`,'assistant'); });

  function renderReminders(){ remList.innerHTML=''; getReminders().forEach(r=>{ const li=document.createElement('li'); li.textContent = `${new Date(r.timestamp).toLocaleString()} — ${r.text}`; const del = document.createElement('button'); del.textContent='Remove'; del.addEventListener('click', ()=>{ saveReminders(getReminders().filter(x=>x.id!==r.id)); }); li.appendChild(del); remList.appendChild(li); }) }

  function scheduleTimeout(r){ const delay = r.timestamp - Date.now(); if(delay <= 0){ deliverReminder(r); return; } setTimeout(()=>deliverReminder(r), Math.min(delay, 2147483647)); }

  function deliverReminder(r){ // show browser notification + chat message
    appendMessage(`Reminder: ${r.text}`,'assistant');
    if(window.Notification && Notification.permission==='granted'){
      new Notification('CloudAssistant reminder', {body: r.text});
    }
    // remove delivered reminders
    saveReminders(getReminders().filter(x=>x.id!==r.id));
  }

  // Request notification permission on start
  if(window.Notification && Notification.permission!=='granted'){
    Notification.requestPermission().catch(()=>{});
  }

  // Initialize: render stored data and schedule pending reminders
  function init(){ renderTodos(); renderNotes(); renderReminders(); showView('chat');
    getReminders().forEach(r=>scheduleTimeout(r));
    appendMessage('Hello! I am your personal assistant. Type "help" for tips.','assistant');
  }

  init();
  // OAuth popup handling: listen for messages from the worker callback popup
  window.addEventListener('message', (ev)=>{
    try {
      const data = ev.data || {};
      if (data && data.type === 'cloudassistant:gauth' && data.email) {
        storage.set('ca_google_email', data.email);
        document.getElementById('signed-user').textContent = data.email;
        appendMessage(`Google account connected: ${data.email}`,'assistant');
      }
    } catch(e){ }
  });

  // Wire Sign-in button
  const signBtn = document.getElementById('btn-google-signin');
  signBtn.addEventListener('click', ()=>{
    const popup = window.open((WORKER_BASE||'') + '/auth/google/start', 'ca_gsignin', 'width=600,height=700');
    if (!popup) alert('Popup blocked — please allow popups for this site to sign in.');
  });

  // If we have an email stored, show it
  const storedEmail = storage.get('ca_google_email');
  if (storedEmail) document.getElementById('signed-user').textContent = storedEmail;

  // Add a quick Drive loader button to the sidebar under Reminders
  const remView = document.getElementById('view-reminders');
  const driveLoadBtn = document.createElement('button');
  driveLoadBtn.textContent = 'Load Drive files';
  driveLoadBtn.addEventListener('click', async ()=>{
    const email = storage.get('ca_google_email');
    if(!email){ appendMessage('No Google account connected. Click Sign in with Google.', 'assistant'); return; }
    appendMessage('Loading Drive files...', 'assistant');
    try{
      const res = await fetch((WORKER_BASE||'') + `/api/drive/list?email=${encodeURIComponent(email)}`);
      if(!res.ok) throw new Error(await res.text());
      const json = await res.json();
      const list = (json.files || []).map(f=>`${f.name} (${f.mimeType})`).join('\n');
      appendMessage('Drive files:\n' + (list || 'No files found'), 'assistant');
    }catch(e){ appendMessage('Drive load failed: ' + String(e), 'assistant'); }
  });
  remView.appendChild(driveLoadBtn);
})();
