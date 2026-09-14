// DeepRWA — Phase 2 frontend
const SUPABASE_URL = 'YOUR_SUPABASE_URL'; // Injected via /api/config or hardcoded
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';

const state = {
  user: null,
  token: localStorage.getItem('deeprwa_token') || null,
  conversations: [],
  activeConversationId: null,
  messages: [],
  isGenerating: false,
  abortController: null,
  files: [],
  editingMessageId: null,
  messageVersions: {}, // msgId -> { versions, currentIndex }
  view: 'chats'
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const welcomeEl = $('welcome');
const formEl = $('composer');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const stopBtn = $('stopBtn');
const newChatBtn = $('newChatBtn');
const sidebar = $('sidebar');
const sidebarBackdrop = $('sidebarBackdrop');
const menuBtn = $('menuBtn');
const expandBtn = $('expandBtn');
const sidebarClose = $('sidebarClose');
const sidebarCollapseBtn = $('sidebarCollapseBtn');
const attachBtn = $('attachBtn');
const fileInput = $('fileInput');
const filePreviews = $('filePreviews');
const sidebarNav = $('sidebarNav');
const sidebarContent = $('sidebarContent');
const loginBtn = $('loginBtn');
const authModal = $('authModal');
const authModalBody = $('authModalBody');
const authModalClose = $('authModalClose');
const shareModal = $('shareModal');
const shareModalClose = $('shareModalClose');
const shareLinkInput = $('shareLinkInput');
const copyShareLink = $('copyShareLink');

function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }
refreshIcons();

// ---------- Init: fetch config, check session ----------
async function init() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    // In production, these would be provided by the server config endpoint
  } catch {}

  if (state.token) {
    try {
      const res = await fetch('/api/auth/me', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        state.user = data.user;
        renderUser();
        await loadConversations();
      } else {
        state.token = null;
        localStorage.removeItem('deeprwa_token');
      }
    } catch {}
  }
  updateSendState();
  inputEl.focus();
}

function authHeaders() {
  return state.token ? { 'Authorization': `Bearer ${state.token}` } : {};
}

function renderUser() {
  if (state.user) {
    loginBtn.innerHTML = `<i data-lucide="log-out"></i><span>Log out</span>`;
    loginBtn.onclick = () => { state.token = null; state.user = null; localStorage.removeItem('deeprwa_token'); renderUser(); newChat(); };
  } else {
    loginBtn.innerHTML = `<i data-lucide="log-in"></i><span>Log in</span>`;
    loginBtn.onclick = () => openAuthModal('login');
  }
  refreshIcons();
}

// ---------- Sidebar ----------
function openSidebar() { sidebar.classList.add('open'); sidebarBackdrop.classList.add('show'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('show'); }
menuBtn.addEventListener('click', openSidebar);
sidebarClose.addEventListener('click', closeSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);

// Collapse/expand
sidebarCollapseBtn.addEventListener('click', () => {
  document.body.classList.add('sidebar-collapsed');
  expandBtn.classList.remove('hidden');
  try { localStorage.setItem('deeprwa_sidebar_collapsed', 'true'); } catch {}
});
expandBtn.addEventListener('click', () => {
  document.body.classList.remove('sidebar-collapsed');
  expandBtn.classList.add('hidden');
  try { localStorage.setItem('deeprwa_sidebar_collapsed', 'false'); } catch {}
});
try {
  if (localStorage.getItem('deeprwa_sidebar_collapsed') === 'true' && window.innerWidth > 820) {
    document.body.classList.add('sidebar-collapsed');
    expandBtn.classList.remove('hidden');
  }
} catch {}

// ---------- Sidebar nav ----------
sidebarNav.addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  sidebarNav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  item.classList.add('active');
  state.view = item.dataset.view;
  if (state.view === 'images') renderImagesView();
  else renderChatsView();
});

function renderChatsView() {
  if (!state.user) {
    sidebarContent.innerHTML = `
      <div class="sidebar-empty">
        <p>Log in to save chats</p>
        <span>Your conversations will appear here</span>
      </div>`;
    return;
  }
  if (!state.conversations.length) {
    sidebarContent.innerHTML = `
      <div class="sidebar-empty">
        <p>No chats yet</p>
        <span>Start a conversation with DeepRWA</span>
      </div>`;
    return;
  }
  sidebarContent.innerHTML = state.conversations.map(c => `
    <div class="chat-item ${c.id === state.activeConversationId ? 'active' : ''}" data-id="${c.id}">
      <i data-lucide="message-square" class="chat-item-icon"></i>
      <span class="chat-item-title">${escapeHtml(c.title)}</span>
      <div class="chat-item-actions">
        <button class="chat-action" data-action="pin" title="Pin"><i data-lucide="pin"></i></button>
        <button class="chat-action" data-action="share" title="Share"><i data-lucide="share-2"></i></button>
        <button class="chat-action" data-action="rename" title="Rename"><i data-lucide="pencil"></i></button>
        <button class="chat-action" data-action="delete" title="Delete"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('');
  refreshIcons();
}

function renderImagesView() {
  sidebarContent.innerHTML = `
    <div class="sidebar-empty">
      <p>No images yet</p>
      <span>Images you send or generate will appear here</span>
    </div>`;
}

sidebarContent.addEventListener('click', async (e) => {
  const item = e.target.closest('.chat-item');
  const action = e.target.closest('.chat-action');
  if (action) {
    e.stopPropagation();
    const id = item.dataset.id;
    const act = action.dataset.action;
    if (act === 'delete') { await deleteConversation(id); }
    else if (act === 'rename') { openRenameModal(id); }
    else if (act === 'share') { await shareChat(id); }
    else if (act === 'pin') { await togglePin(id); }
    return;
  }
  if (item) loadConversation(item.dataset.id);
});

// ---------- Conversations ----------
async function loadConversations() {
  if (!state.user) return;
  try {
    const res = await fetch('/api/conversations', { headers: authHeaders() });
    const data = await res.json();
    state.conversations = data.conversations || [];
    renderChatsView();
  } catch {}
}

async function loadConversation(id) {
  state.activeConversationId = id;
  const res = await fetch(`/api/conversations/${id}/messages`, { headers: authHeaders() });
  const data = await res.json();
  state.messages = (data.messages || []).map(m => ({ role: m.role, content: m.content }));
  renderMessages();
  renderChatsView();
  closeSidebar();
}

async function deleteConversation(id) {
  await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: authHeaders() });
  state.conversations = state.conversations.filter(c => c.id !== id);
  if (state.activeConversationId === id) newChat();
  renderChatsView();
}

async function togglePin(id) {
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;
  await fetch(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: !conv.pinned })
  });
  await loadConversations();
}

function newChat() {
  if (state.isGenerating) return;
  state.messages = [];
  state.activeConversationId = null;
  state.files = [];
  renderFilePreviews();
  renderWelcome();
  renderChatsView();
  closeSidebar();
  updateSendState();
  inputEl.focus();
}

newChatBtn.addEventListener('click', newChat);

// ---------- Messages render ----------
function renderWelcome() {
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
}

function renderMessages() {
  chatEl.innerHTML = '';
  if (!state.messages.length) { renderWelcome(); return; }
  state.messages.forEach((m, i) => {
    if (m.role === 'user') appendUserMessage(m.content, i);
    else appendAssistantMessage(m.content, i);
  });
  scrollBottom();
}

function appendUserMessage(text, index) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  el.dataset.index = index;
  el.innerHTML = `
    <div class="bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
    <div class="msg-actions msg-actions-user">
      <button class="msg-action" data-action="copy" title="Copy"><i data-lucide="copy"></i></button>
      <button class="msg-action" data-action="edit" title="Edit"><i data-lucide="pencil"></i></button>
    </div>`;
  chatEl.appendChild(el);
  refreshIcons();
}

function appendAssistantMessage(text, index) {
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  el.dataset.index = index;
  el.innerHTML = `
    <div class="avatar"><img src="/av.png" alt="DeepRWA" /></div>
    <div class="assistant-body">
      <div class="assistant-name">DeepRWA</div>
      <div class="assistant-text">${renderMarkdown(text)}</div>
      <div class="msg-actions msg-actions-assistant">
        <button class="msg-action" data-action="copy" title="Copy"><i data-lucide="copy"></i></button>
        <button class="msg-action" data-action="like" title="Like"><i data-lucide="thumbs-up"></i></button>
        <button class="msg-action" data-action="dislike" title="Dislike"><i data-lucide="thumbs-down"></i></button>
        <button class="msg-action" data-action="share" title="Share"><i data-lucide="share-2"></i></button>
      </div>
    </div>`;
  chatEl.appendChild(el);
  refreshIcons();
}

// ---------- Message actions ----------
chatEl.addEventListener('click', async (e) => {
  const action = e.target.closest('.msg-action');
  if (!action) return;
  const msgEl = action.closest('.msg');
  const idx = parseInt(msgEl.dataset.index);
  const act = action.dataset.action;

  if (act === 'copy') {
    const text = state.messages[idx]?.content || '';
    await navigator.clipboard.writeText(text);
    action.classList.add('copied');
    setTimeout(() => action.classList.remove('copied'), 1500);
  }
  else if (act === 'like') {
    action.classList.toggle('active');
    action.closest('.msg-actions').querySelector('[data-action="dislike"]')?.classList.remove('active');
  }
  else if (act === 'dislike') {
    action.classList.toggle('active');
    action.closest('.msg-actions').querySelector('[data-action="like"]')?.classList.remove('active');
  }
  else if (act === 'edit') {
    startEditMessage(idx, msgEl);
  }
  else if (act === 'share') {
    await shareMessage(idx);
  }
});

function startEditMessage(idx, msgEl) {
  state.editingMessageId = idx;
  const text = state.messages[idx].content;
  const bubble = msgEl.querySelector('.bubble');
  const actions = msgEl.querySelector('.msg-actions-user');
  bubble.innerHTML = `<textarea class="edit-textarea">${escapeHtml(text)}</textarea>`;
  actions.innerHTML = `
    <button class="msg-action" data-action="cancel-edit" title="Cancel"><i data-lucide="x"></i></button>
    <button class="msg-action" data-action="save-edit" title="Save"><i data-lucide="send"></i></button>`;
  refreshIcons();
  const ta = bubble.querySelector('textarea');
  ta.focus();
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';

  actions.querySelector('[data-action="cancel-edit"]').onclick = () => renderMessages();
  actions.querySelector('[data-action="save-edit"]').onclick = async () => {
    const newText = ta.value.trim();
    if (!newText) return;
    state.messages = state.messages.slice(0, idx);
    state.messages.push({ role: 'user', content: newText });
    renderMessages();
    await sendMessage();
  };
}

// ---------- Markdown ----------
function escapeHtml(t) { return String(t || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
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

// ---------- Composer ----------
function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px'; }
function updateSendState() {
  const hasText = inputEl.value.trim().length > 0;
  const hasFiles = state.files.length > 0;
  sendBtn.disabled = !(hasText || hasFiles) || state.isGenerating;
}
inputEl.addEventListener('input', () => { autoGrow(); updateSendState(); });
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) formEl.requestSubmit(); }
});

// ---------- Files ----------
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  for (const f of e.target.files) {
    const id = Math.random().toString(36).slice(2);
    state.files.push({ id, file: f, url: URL.createObjectURL(f), name: f.name, type: f.type });
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
    return `<div class="file-chip" data-id="${f.id}">
      ${isImg ? `<img src="${f.url}" class="file-thumb" />` : `<div class="file-icon"><i data-lucide="file-text"></i></div>`}
      <button type="button" class="file-remove" data-remove="${f.id}"><i data-lucide="x"></i></button>
    </div>`;
  }).join('');
  refreshIcons();
}

filePreviews.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const id = btn.dataset.remove;
  const idx = state.files.findIndex(x => x.id === id);
  if (idx >= 0) { URL.revokeObjectURL(state.files[idx].url); state.files.splice(idx, 1); }
  renderFilePreviews();
  updateSendState();
});

// ---------- Send ----------
formEl.addEventListener('submit', async (e) => { e.preventDefault(); await sendMessage(); });

async function sendMessage() {
  if (state.isGenerating) return;
  const text = inputEl.value.trim();
  if (!text && !state.files.length) return;

  inputEl.value = '';
  autoGrow();
  chatEl.querySelector('.welcome')?.remove();

  state.messages.push({ role: 'user', content: text || '(file)' });
  appendUserMessage(text, state.messages.length - 1);

  state.files = [];
  renderFilePreviews();
  updateSendState();

  const assistantEl = appendAssistantStreaming();

  state.isGenerating = true;
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  state.abortController = new AbortController();

  let full = '';
  try {
    const endpoint = state.user ? '/api/chat' : '/api/chat/guest';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ messages: state.messages, conversationId: state.activeConversationId }),
      signal: state.abortController.signal
    });
    if (!res.ok || !res.body) throw new Error('Bad response');

    const convId = res.headers.get('X-Conversation-Id');
    if (convId && !state.activeConversationId) { state.activeConversationId = convId; await loadConversations(); }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = ''; let first = true;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (p === '[DONE]') break;
        try {
          const j = JSON.parse(p);
          if (j.text) {
            if (first) { assistantEl.querySelector('.thinking')?.classList.add('hidden'); first = false; }
            full += j.text;
            assistantEl.querySelector('.assistant-text').innerHTML = renderMarkdown(full);
            scrollBottom();
          }
        } catch {}
      }
    }
    if (full) {
      state.messages.push({ role: 'assistant', content: full });
      addAssistantActions(assistantEl, state.messages.length - 1);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (full) { state.messages.push({ role: 'assistant', content: full }); addAssistantActions(assistantEl, state.messages.length - 1); }
      else assistantEl.querySelector('.assistant-text').textContent = 'Stopped.';
    } else {
      assistantEl.querySelector('.assistant-text').textContent = 'Something went wrong. Please try again.';
    }
  } finally {
    state.isGenerating = false;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    state.abortController = null;
    assistantEl.querySelector('.thinking')?.classList.add('hidden');
    updateSendState();
    inputEl.focus();
  }
}

function appendAssistantStreaming() {
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  el.innerHTML = `
    <div class="avatar"><img src="/av.png" alt="DeepRWA" /></div>
    <div class="assistant-body">
      <div class="assistant-name">DeepRWA</div>
      <div class="assistant-text"></div>
      <div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-label">Initializing…</span></div>
      <div class="msg-actions msg-actions-assistant hidden"></div>
    </div>`;
  chatEl.appendChild(el);
  scrollBottom();
  return el;
}

function addAssistantActions(el, idx) {
  const actionsEl = el.querySelector('.msg-actions-assistant');
  actionsEl.classList.remove('hidden');
  actionsEl.innerHTML = `
    <button class="msg-action" data-action="copy" title="Copy"><i data-lucide="copy"></i></button>
    <button class="msg-action" data-action="like" title="Like"><i data-lucide="thumbs-up"></i></button>
    <button class="msg-action" data-action="dislike" title="Dislike"><i data-lucide="thumbs-down"></i></button>
    <button class="msg-action" data-action="share" title="Share"><i data-lucide="share-2"></i></button>`;
  el.dataset.index = idx;
  refreshIcons();
}

stopBtn.addEventListener('click', () => { if (state.abortController) state.abortController.abort(); });

// ---------- Chips ----------
chatEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  inputEl.value = chip.dataset.q || '';
  autoGrow(); updateSendState();
  formEl.requestSubmit();
});

// ---------- Auth Modal ----------
function openAuthModal(mode) {
  authModal.classList.remove('hidden');
  if (mode === 'login') renderLoginModal();
  else renderSignupModal();
  refreshIcons();
}
authModalClose.addEventListener('click', () => authModal.classList.add('hidden'));
authModal.addEventListener('click', (e) => { if (e.target === authModal) authModal.classList.add('hidden'); });

function renderLoginModal() {
  authModalBody.innerHTML = `
    <h3>Log in to DeepRWA</h3>
    <p class="modal-sub">Save your chats and access them anywhere.</p>
    <input type="email" id="authEmail" placeholder="Email" class="modal-input" />
    <input type="password" id="authPassword" placeholder="Password" class="modal-input" />
    <button class="btn-primary" id="authSubmit">Log in</button>
    <p class="modal-switch">Don't have an account? <a href="#" id="switchSignup">Sign up</a></p>`;
  refreshIcons();
  document.getElementById('switchSignup').onclick = (e) => { e.preventDefault(); renderSignupModal(); };
  document.getElementById('authSubmit').onclick = async () => {
    const email = document.getElementById('authEmail').value;
    const password = document.getElementById('authPassword').value;
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    renderVerifyCodeModal(data.pendingToken, 'login');
  };
}

function renderSignupModal() {
  authModalBody.innerHTML = `
    <h3>Create your DeepRWA account</h3>
    <p class="modal-sub">Save chats, access from any device.</p>
    <input type="email" id="authEmail" placeholder="Email" class="modal-input" />
    <input type="password" id="authPassword" placeholder="Password (min 6 chars)" class="modal-input" />
    <input type="password" id="authConfirm" placeholder="Confirm password" class="modal-input" />
    <button class="btn-primary" id="authSubmit">Create account</button>
    <p class="modal-switch">Already have an account? <a href="#" id="switchLogin">Log in</a></p>`;
  refreshIcons();
  document.getElementById('switchLogin').onclick = (e) => { e.preventDefault(); renderLoginModal(); };
  document.getElementById('authSubmit').onclick = async () => {
    const email = document.getElementById('authEmail').value;
    const password = document.getElementById('authPassword').value;
    const confirm = document.getElementById('authConfirm').value;
    if (password !== confirm) { alert('Passwords do not match'); return; }
    const res = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    renderVerifyCodeModal(data.pendingToken, 'signup');
  };
}

function renderVerifyCodeModal(pendingToken, type) {
  authModalBody.innerHTML = `
    <h3>Enter verification code</h3>
    <p class="modal-sub">We sent a 6-digit code to your email.</p>
    <input type="text" id="verifyCode" placeholder="000000" maxlength="6" class="modal-input code-input" />
    <button class="btn-primary" id="verifySubmit">Verify</button>`;
  refreshIcons();
  document.getElementById('verifySubmit').onclick = async () => {
    const code = document.getElementById('verifyCode').value;
    const endpoint = type === 'login' ? '/api/auth/verify-login' : '/api/auth/confirm-signup';
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingToken, code }) });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    state.token = data.accessToken;
    state.user = data.user;
    localStorage.setItem('deeprwa_token', data.accessToken);
    authModal.classList.add('hidden');
    renderUser();
    await loadConversations();
  };
}

// ---------- Share ----------
async function shareChat(id) {
  const res = await fetch('/api/share/chat', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: id }) });
  const data = await res.json();
  if (data.token) showShareModal(`https://deeprwa.agentdomains.co/share/${data.token}`);
}
async function shareMessage(idx) {
  const msg = state.messages[idx];
  if (!msg) return;
  showShareModal(`https://deeprwa.agentdomains.co/share/message/${encodeURIComponent(msg.content.slice(0, 200))}`);
}
function showShareModal(url) {
  shareLinkInput.value = url;
  shareModal.classList.remove('hidden');
}
shareModalClose.addEventListener('click', () => shareModal.classList.add('hidden'));
copyShareLink.addEventListener('click', async () => { await navigator.clipboard.writeText(shareLinkInput.value); copyShareLink.textContent = 'Copied!'; setTimeout(() => copyShareLink.textContent = 'Copy', 1500); });

// ---------- Init ----------
init();
