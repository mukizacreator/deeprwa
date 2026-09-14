// DeepRWA — Phase 3 frontend

const state = {
  messages: [],
  isGenerating: false,
  abortController: null,
  files: [] // {id, file, url, name, type}
};

const chatEl = document.getElementById('chat');
const welcomeEl = document.getElementById('welcome');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const menuBtn = document.getElementById('menuBtn');
const sidebarClose = document.getElementById('sidebarClose');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const filePreviews = document.getElementById('filePreviews');
const sidebarNav = document.getElementById('sidebarNav');
const sidebarContent = document.getElementById('sidebarContent');

function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }
refreshIcons();

// ---------- Sidebar toggle ----------
function openSidebar() { sidebar.classList.add('open'); sidebarBackdrop.classList.add('show'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('show'); }
menuBtn.addEventListener('click', openSidebar);
sidebarClose.addEventListener('click', closeSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);

// Sidebar nav view switching
sidebarNav.addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  sidebarNav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  item.classList.add('active');
  const view = item.dataset.view;
  if (view === 'images') renderImagesView();
  else renderChatsView();
});

function renderChatsView() {
  sidebarContent.innerHTML = `
    <div class="sidebar-empty">
      <p>No chats yet</p>
      <span>Start a conversation with DeepRWA</span>
    </div>`;
}
function renderImagesView() {
  sidebarContent.innerHTML = `
    <div class="sidebar-empty">
      <p>No images yet</p>
      <span>Images you send or generate will appear here</span>
    </div>`;
}
renderChatsView();

// ---------- Auto-grow textarea + send button state ----------
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}
function updateSendState() {
  const hasText = inputEl.value.trim().length > 0;
  const hasFiles = state.files.length > 0;
  sendBtn.disabled = !(hasText || hasFiles);
}
inputEl.addEventListener('input', () => { autoGrow(); updateSendState(); });
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) formEl.requestSubmit();
  }
});

// ---------- File attach ----------
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  for (const f of e.target.files) {
    const id = Math.random().toString(36).slice(2);
    const url = URL.createObjectURL(f);
    state.files.push({ id, file: f, url, name: f.name, type: f.type });
  }
  fileInput.value = '';
  renderFilePreviews();
  updateSendState();
});

function renderFilePreviews() {
  if (!state.files.length) { filePreviews.hidden = true; filePreviews.innerHTML = ''; return; }
  filePreviews.hidden = false;
  filePreviews.innerHTML = state.files.map(f => {
    const isImg = f.type.startsWith('image/');
    return `
      <div class="file-chip" data-id="${f.id}">
        ${isImg
          ? `<img src="${f.url}" alt="${f.name}" class="file-thumb" />`
          : `<div class="file-icon"><i data-lucide="file-text"></i></div>`}
        <button type="button" class="file-remove" data-remove="${f.id}" aria-label="Remove">
          <i data-lucide="x"></i>
        </button>
      </div>`;
  }).join('');
  refreshIcons();
}

filePreviews.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const id = btn.dataset.remove;
  const idx = state.files.findIndex(x => x.id === id);
  if (idx >= 0) {
    URL.revokeObjectURL(state.files[idx].url);
    state.files.splice(idx, 1);
  }
  renderFilePreviews();
  updateSendState();
});

// ---------- Markdown helpers ----------
function escapeHtmlOutsideCode(text) {
  const lines = (text || '').split('\n');
  let inCode = false;
  return lines.map(line => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return line; }
    if (inCode) return line;
    return line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }).join('\n');
}
function renderMarkdown(text) {
  const safe = escapeHtmlOutsideCode(text || '');
  try { return window.marked.parse(safe, { breaks: true, gfm: true }); }
  catch { return safe.replace(/\n/g, '<br>'); }
}
function scrollBottom() { chatEl.scrollTop = chatEl.scrollHeight; }

// ---------- Messages ----------
function appendUser(text, files) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  let filesHtml = '';
  if (files && files.length) {
    filesHtml = `<div class="msg-files">${files.map(f => {
      const isImg = f.type.startsWith('image/');
      return isImg
        ? `<img src="${f.url}" alt="${f.name}" class="msg-file-thumb" />`
        : `<div class="msg-file-doc"><i data-lucide="file-text"></i><span>${f.name}</span></div>`;
    }).join('')}</div>`;
  }
  el.innerHTML = `${filesHtml}<div class="bubble">${escapeHtmlOutsideCode(text).replace(/\n/g, '<br>')}</div>`;
  chatEl.appendChild(el);
  scrollBottom();
}

function appendAssistant() {
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  el.innerHTML = `
    <div class="avatar"><img src="/av.png" alt="DeepRWA" /></div>
    <div class="assistant-body">
      <div class="assistant-name">DeepRWA</div>
      <div class="assistant-text"></div>
      <div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-label" id="statusLabel">Initializing…</span></div>
    </div>`;
  chatEl.appendChild(el);
  scrollBottom();
  return el;
}

function clearWelcome() {
  const w = chatEl.querySelector('.welcome');
  if (w) w.remove();
}

// ---------- Welcome chips ----------
chatEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  inputEl.value = chip.dataset.q || '';
  autoGrow();
  updateSendState();
  formEl.requestSubmit();
});

// ---------- New chat ----------
newChatBtn.addEventListener('click', () => {
  if (state.isGenerating) return;
  state.messages = [];
  state.files.forEach(f => URL.revokeObjectURL(f.url));
  state.files = [];
  renderFilePreviews();
  chatEl.innerHTML = `
    <div class="welcome" id="welcome">
      <img src="/av.png" alt="DeepRWA" class="welcome-logo" />
      <h1 class="brand-name brand-name-lg"><span class="b-deep">Deep</span><span class="b-r">R</span><span class="b-w">W</span><span class="b-a">A</span></h1>
      <p>Ask me anything about <strong>Rwanda</strong> — history, culture, tourism, people, news, and more. In any language.</p>
      <div class="chips">
        <button class="chip" data-q="Tell me about the history of Rwanda">History</button>
        <button class="chip" data-q="What are the top tourist attractions in Rwanda?">Tourism</button>
        <button class="chip" data-q="Who are some famous Rwandan people?">People</button>
        <button class="chip" data-q="Explain Umuganda and its importance">Culture</button>
      </div>
    </div>`;
  updateSendState();
  closeSidebar();
  inputEl.focus();
});

// ---------- Send ----------
formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.isGenerating) return;
  const text = inputEl.value.trim();
  if (!text && !state.files.length) return;

  const filesForMsg = [...state.files];

  inputEl.value = '';
  autoGrow();
  clearWelcome();

  appendUser(text, filesForMsg);
  state.messages.push({ role: 'user', content: text || '(file)' });

  // clear file previews
  state.files = [];
  renderFilePreviews();
  updateSendState();

  const assistantEl = appendAssistant();
  const textEl = assistantEl.querySelector('.assistant-text');
  const thinking = assistantEl.querySelector('.thinking');
  const statusLabel = assistantEl.querySelector('#statusLabel');
  statusLabel.textContent = 'Initializing…';

  state.isGenerating = true;
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  state.abortController = new AbortController();

  let full = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.messages }),
      signal: state.abortController.signal
    });
    if (!res.ok || !res.body) throw new Error('Bad response');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let first = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (p === '[DONE]') break;
        try {
          const j = JSON.parse(p);
          if (j.text) {
            if (first) { thinking.classList.add('hidden'); first = false; }
            full += j.text;
            textEl.innerHTML = renderMarkdown(full);
            scrollBottom();
          }
        } catch {}
      }
    }
    if (full) state.messages.push({ role: 'assistant', content: full });
    if (!full) { thinking.classList.add('hidden'); textEl.textContent = 'No response received.'; }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (full) {
        textEl.innerHTML = renderMarkdown(full + '\n\n*[stopped]*');
        state.messages.push({ role: 'assistant', content: full });
      } else {
        thinking.classList.add('hidden');
        textEl.textContent = 'Stopped.';
      }
    } else {
      thinking.classList.add('hidden');
      textEl.textContent = 'Something went wrong. Please try again.';
      console.error(err);
    }
  } finally {
    state.isGenerating = false;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    state.abortController = null;
    thinking.classList.add('hidden');
    updateSendState();
    inputEl.focus();
  }
});

stopBtn.addEventListener('click', () => {
  if (state.abortController) state.abortController.abort();
});

updateSendState();
inputEl.focus();
