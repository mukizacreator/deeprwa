// DeepRWA — Full frontend logic

const state = {
  user: null,
  token: localStorage.getItem('deeprwa_token') || null,
  chats: [],
  activeChatId: null,
  messages: [],
  isGenerating: false,
  abortController: null,
  attachments: [],
  editingMessageId: null,
  editingValue: '',
  editingSelection: null,
  messageVersions: {},
  view: 'chats',
  config: {}
};

const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const formEl = $('composer');
const inputEl = $('input');
const sendBtn = $('sendBtn');
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
const renameModal = $('renameModal');
const renameModalClose = $('renameModalClose');
const renameInput = $('renameInput');
const renameSubmit = $('renameSubmit');
const confirmModal = $('confirmModal');
const confirmTitle = $('confirmTitle');
const confirmText = $('confirmText');
const confirmCancel = $('confirmCancel');
const confirmOk = $('confirmOk');

function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }
refreshIcons();

// ============= HELPERS =============
function escapeHtml(t) { return String(t || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeHtmlOutsideCode(text) {
  const lines = (text || '').split('\n'); let inCode = false;
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
function authHeaders() { return state.token ? { 'Authorization': `Bearer ${state.token}` } : {}; }
function isLocalId(id) { return typeof id === 'string' && id.startsWith('local_'); }
function makeLocalId() { return 'local_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function nowISO() { return new Date().toISOString(); }

// ============= INIT =============
async function init() {
  try {
    state.config = await fetch('/api/config').then(r => r.json());
  } catch {}
  if (state.token) {
    try {
      const res = await fetch('/api/auth/me', { headers: authHeaders() });
      if (res.ok) { const d = await res.json(); state.user = d.user; renderUser(); await loadConversations(); }
      else { state.token = null; localStorage.removeItem('deeprwa_token'); renderUser(); }
    } catch { renderUser(); }
  } else { renderUser(); }
  renderWelcome();
  updateSendButton();
  inputEl.focus();
}

function renderUser() {
  if (state.user) {
    loginBtn.innerHTML = `<i data-lucide="log-out"></i><span>Log out</span>`;
    loginBtn.onclick = () => {
      state.token = null; state.user = null;
      localStorage.removeItem('deeprwa_token');
      state.chats = []; state.activeChatId = null; state.messages = [];
      renderUser(); renderChatList(); renderWelcome();
    };
  } else {
    loginBtn.innerHTML = `<i data-lucide="log-in"></i><span>Log in</span>`;
    loginBtn.onclick = () => openAuthModal('login');
  }
  refreshIcons();
}

// ============= SIDEBAR =============
function openSidebar() { sidebar.classList.add('open'); sidebarBackdrop.classList.add('show'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('show'); }
menuBtn.addEventListener('click', openSidebar);
sidebarClose.addEventListener('click', closeSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);
sidebarCollapseBtn.addEventListener('click', () => {
  document.body.classList.add('sidebar-collapsed');
  expandBtn.classList.remove('hidden');
  try { localStorage.setItem('dr_sidebar', 'collapsed'); } catch {}
});
expandBtn.addEventListener('click', () => {
  document.body.classList.remove('sidebar-collapsed');
  expandBtn.classList.add('hidden');
  try { localStorage.setItem('dr_sidebar', 'expanded'); } catch {}
});
try { if (localStorage.getItem('dr_sidebar') === 'collapsed' && window.innerWidth > 820) { document.body.classList.add('sidebar-collapsed'); expandBtn.classList.remove('hidden'); } } catch {}

sidebarNav.addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item'); if (!item) return;
  sidebarNav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  item.classList.add('active');
  state.view = item.dataset.view;
  renderChatList();
});

// ============= CHAT LIST =============
function renderChatList() {
  if (state.view === 'images') {
    sidebarContent.innerHTML = `<div class="sidebar-empty"><p>No images yet</p><span>Images you send or generate will appear here</span></div>`;
    return;
  }
  if (!state.chats.length) {
    sidebarContent.innerHTML = `<div class="sidebar-empty"><p>No chats yet</p><span>Start a conversation with DeepRWA</span></div>`;
    return;
  }
  const pinned = state.chats.filter(c => c.pinned);
  const rest = state.chats.filter(c => !c.pinned);
  const renderOne = (c) => `
    <div class="chat-item ${c.id === state.activeChatId ? 'active' : ''}" data-id="${c.id}">
      <i data-lucide="${c.pinned ? 'pin' : 'message-square'}" class="chat-item-icon"></i>
      <span class="chat-item-title">${escapeHtml(c.title || 'New chat')}</span>
      <button class="chat-item-menu" data-menu="${c.id}" aria-label="Menu">
        <i data-lucide="more-horizontal"></i>
      </button>
    </div>`;
  let html = '';
  if (pinned.length) html += `<div class="sidebar-section">Pinned</div>` + pinned.map(renderOne).join('');
  if (rest.length) html += (pinned.length ? `<div class="sidebar-section">Chats</div>` : '') + rest.map(renderOne).join('');
  sidebarContent.innerHTML = html;
  refreshIcons();
}

sidebarContent.addEventListener('click', async (e) => {
  const menuBtn = e.target.closest('.chat-item-menu');
  if (menuBtn) {
    e.stopPropagation();
    const id = menuBtn.dataset.menu;
    const rect = menuBtn.getBoundingClientRect();
    openChatMenu(id, rect);
    return;
  }
  const item = e.target.closest('.chat-item');
  if (item) selectChat(item.dataset.id);
});

function openChatMenu(id, rect) {
  document.querySelectorAll('.chat-menu').forEach(m => m.remove());
  const chat = state.chats.find(c => c.id === id);
  if (!chat) return;
  const menu = document.createElement('div');
  menu.className = 'chat-menu';
  menu.style.left = rect.left - 140 + 'px';
  menu.style.top = rect.bottom + 4 + 'px';
  menu.innerHTML = `
    <button data-act="pin"><i data-lucide="pin"></i>${chat.pinned ? 'Unpin' : 'Pin'}</button>
    <button data-act="share"><i data-lucide="share-2"></i>Share</button>
    <button data-act="rename"><i data-lucide="pencil"></i>Rename</button>
    <button data-act="delete" class="danger"><i data-lucide="trash-2"></i>Delete</button>`;
  document.body.appendChild(menu);
  refreshIcons();
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    const act = btn.dataset.act;
    menu.remove();
    if (act === 'pin') await togglePin(id);
    else if (act === 'share') await shareChat(id);
    else if (act === 'rename') openRenameModal(id);
    else if (act === 'delete') confirmDelete(id);
  });
}

async function togglePin(id) {
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  chat.pinned = !chat.pinned;
  if (state.user && !isLocalId(id)) {
    await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: chat.pinned })
    });
  }
  renderChatList();
}

function openRenameModal(id) {
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  renameInput.value = chat.title || '';
  renameModal.classList.remove('hidden');
  renameInput.focus();
  renameModal.dataset.id = id;
}
renameModalClose.addEventListener('click', () => renameModal.classList.add('hidden'));
renameSubmit.addEventListener('click', async () => {
  const id = renameModal.dataset.id;
  const newTitle = renameInput.value.trim();
  if (!newTitle) return;
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  chat.title = newTitle;
  if (state.user && !isLocalId(id)) {
    await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle })
    });
  }
  renderChatList();
  renameModal.classList.add('hidden');
});

function confirmDelete(id) {
  confirmTitle.textContent = 'Delete this chat?';
  confirmText.textContent = 'This cannot be undone.';
  confirmModal.classList.remove('hidden');
  confirmModal.dataset.id = id;
}
confirmCancel.addEventListener('click', () => confirmModal.classList.add('hidden'));
confirmOk.addEventListener('click', async () => {
  const id = confirmModal.dataset.id;
  confirmModal.classList.add('hidden');
  const chat = state.chats.find(c => c.id === id);
  if (!chat) return;
  if (state.user && !isLocalId(id)) {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: authHeaders() });
  }
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.activeChatId === id) newChatSilent();
  renderChatList();
});

function newChatSilent() {
  state.activeChatId = null;
  state.messages = [];
  state.attachments = [];
  renderFilePreviews();
  renderWelcome();
  updateSendButton();
}

// ============= NEW CHAT BUTTON =============
newChatBtn.addEventListener('click', () => {
  if (state.isGenerating) return;
  if (state.activeChatId) {
    const chat = state.chats.find(c => c.id === state.activeChatId);
    if (chat && (!chat.messages || !chat.messages.length) && !state.messages.length) {
      inputEl.focus();
      closeSidebar();
      return;
    }
  }
  createNewChat();
});

function createNewChat() {
  const chat = {
    id: makeLocalId(),
    title: 'New chat',
    messages: [],
    pinned: false,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  state.messages = [];
  state.attachments = [];
  state.editingMessageId = null;
  renderFilePreviews();
  renderWelcome();
  renderChatList();
  updateSendButton();
  inputEl.focus();
  closeSidebar();
}

// ============= WELCOME =============
function renderWelcome() {
  chatEl.innerHTML = `
    <div class="welcome">
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

chatEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  inputEl.value = chip.dataset.q || '';
  autoGrow(); updateSendButton();
  formEl.requestSubmit();
});

// ============= SEND/STOP BUTTON =============
function updateSendButton() {
  const hasText = inputEl.value.trim().length > 0;
  const hasFiles = state.attachments.length > 0;
  const iconSend = sendBtn.querySelector('.icon-send');
  const iconStop = sendBtn.querySelector('.icon-stop');
  if (state.isGenerating) {
    iconSend.classList.add('hidden');
    iconStop.classList.remove('hidden');
    sendBtn.classList.add('generating');
    sendBtn.disabled = false;
  } else {
    iconSend.classList.remove('hidden');
    iconStop.classList.add('hidden');
    sendBtn.classList.remove('generating');
    sendBtn.disabled = !(hasText || hasFiles);
  }
}

sendBtn.addEventListener('click', () => {
  if (state.isGenerating) stopGeneration();
  else if (!sendBtn.disabled) formEl.requestSubmit();
});

function stopGeneration() {
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
  state.isGenerating = false;
  inputEl.disabled = false;
  updateSendButton();
}

// ============= COMPOSER =============
function autoGrow() {
  inputEl.style.height = '0px';
  const maxH = Math.min(window.innerHeight * 0.5, 400);
  const want = Math.min(inputEl.scrollHeight, maxH);
  inputEl.style.height = Math.max(want, 44) + 'px';
  inputEl.style.overflowY = inputEl.scrollHeight > maxH ? 'auto' : 'hidden';
}
inputEl.addEventListener('input', () => { autoGrow(); updateSendButton(); });
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!state.isGenerating && !sendBtn.disabled) formEl.requestSubmit();
  }
});

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  for (const f of e.target.files) {
    const id = Math.random().toString(36).slice(2);
    state.attachments.push({ id, file: f, url: URL.createObjectURL(f), name: f.name, type: f.type });
  }
  fileInput.value = '';
  renderFilePreviews();
  updateSendButton();
});

function renderFilePreviews() {
  if (!state.attachments.length) { filePreviews.hidden = true; filePreviews.innerHTML = ''; return; }
  filePreviews.hidden = false;
  filePreviews.innerHTML = state.attachments.map(f => {
    const isImg = f.type.startsWith('image/');
    return `<div class="file-chip" data-id="${f.id}">
      ${isImg ? `<img src="${f.url}" class="file-thumb" />` : `<div class="file-icon"><i data-lucide="file-text"></i></div>`}
      <button type="button" class="file-remove" data-remove="${f.id}"><i data-lucide="x"></i></button>
    </div>`;
  }).join('');
  refreshIcons();
}
filePreviews.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]'); if (!btn) return;
  const id = btn.dataset.remove;
  const i = state.attachments.findIndex(x => x.id === id);
  if (i >= 0) { URL.revokeObjectURL(state.attachments[i].url); state.attachments.splice(i, 1); }
  renderFilePreviews(); updateSendButton();
});

// ============= MESSAGES RENDER =============
function renderMessages() {
  if (!state.messages.length) { renderWelcome(); return; }
  chatEl.innerHTML = '';
  state.messages.forEach((m, i) => {
    if (m.role === 'user') chatEl.appendChild(buildUserMessage(m, i));
    else chatEl.appendChild(buildAssistantMessage(m, i));
  });
  scrollBottom();
  refreshIcons();
}

function buildUserMessage(m, i) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  wrap.dataset.index = i;
  wrap.dataset.id = m.id || '';

  if (state.editingMessageId === m.id) {
    wrap.classList.add('editing');
    wrap.innerHTML = `
      ${renderFilesInline(m.files)}
      <div class="edit-area">
        <textarea class="edit-textarea" id="editTextarea">${escapeHtml(state.editingValue)}</textarea>
        <div class="edit-actions">
          <button class="btn-secondary" id="editCancel"><i data-lucide="x"></i>Cancel</button>
          <button class="btn-primary" id="editSend"><i data-lucide="send"></i>Send</button>
        </div>
      </div>`;
    return wrap;
  }

  const versionData = state.messageVersions[m.id];
  const versionSwitcher = versionData && versionData.versions.length > 1
    ? `<div class="version-switcher">
        <button class="vs-btn" data-vs="prev" ${versionData.currentIndex === 0 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
        <span class="vs-label">${versionData.currentIndex + 1} / ${versionData.versions.length}</span>
        <button class="vs-btn" data-vs="next" ${versionData.currentIndex === versionData.versions.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
       </div>`
    : '';

  wrap.innerHTML = `
    ${renderFilesInline(m.files)}
    <div class="bubble">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
    <div class="msg-actions msg-actions-user">
      <button class="msg-action" data-action="copy" title="Copy"><i data-lucide="copy"></i></button>
      <button class="msg-action" data-action="edit" title="Edit"><i data-lucide="pencil"></i></button>
    </div>
    ${versionSwitcher}`;
  return wrap;
}

function renderFilesInline(files) {
  if (!files || !files.length) return '';
  return `<div class="msg-files">${files.map(f => {
    const isImg = (f.type || '').startsWith('image/');
    const url = f.url || f.public_url || '';
    return isImg
      ? `<img src="${url}" class="msg-file-thumb" />`
      : `<div class="msg-file-doc"><i data-lucide="file-text"></i><span>${escapeHtml(f.name || 'file')}</span></div>`;
  }).join('')}</div>`;
}

function buildAssistantMessage(m, i) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.dataset.index = i;
  wrap.dataset.id = m.id || '';
  const content = m.content || '';
  const showActions = !!content;
  wrap.innerHTML = `
    <div class="avatar"><img src="/av.png" alt="DeepRWA" /></div>
    <div class="assistant-body">
      <div class="assistant-name">DeepRWA</div>
      <div class="assistant-text">${content ? renderMarkdown(content) : ''}</div>
      ${renderFilesInline(m.files)}
      ${!content ? `<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-label">Initializing…</span></div>` : ''}
      <div class="msg-actions msg-actions-assistant ${showActions ? '' : 'hidden'}">
        <button class="msg-action" data-action="copy" title="Copy"><i data-lucide="copy"></i></button>
        <button class="msg-action" data-action="like" title="Like"><i data-lucide="thumbs-up"></i></button>
        <button class="msg-action" data-action="dislike" title="Dislike"><i data-lucide="thumbs-down"></i></button>
        <button class="msg-action" data-action="share" title="Share"><i data-lucide="share-2"></i></button>
      </div>
    </div>`;
  return wrap;
}

// ============= MESSAGE ACTIONS =============
chatEl.addEventListener('click', async (e) => {
  // Version switcher
  const vs = e.target.closest('[data-vs]');
  if (vs) {
    const wrap = vs.closest('.msg-user');
    const msgId = wrap.dataset.id;
    const dir = vs.dataset.vs;
    applyVersionChange(msgId, dir);
    return;
  }
  // Edit send/cancel
  if (e.target.closest('#editCancel')) {
    state.editingMessageId = null;
    state.editingValue = '';
    state.editingSelection = null;
    renderMessages();
    return;
  }
  if (e.target.closest('#editSend')) {
    const ta = document.getElementById('editTextarea');
    if (ta) await saveEditAndSend(ta.value);
    return;
  }
  // Message actions
  const action = e.target.closest('.msg-action');
  if (!action) return;
  const msgEl = action.closest('.msg');
  const idx = parseInt(msgEl.dataset.index);
  const act = action.dataset.action;
  if (act === 'copy') {
    const text = state.messages[idx]?.content || '';
    try { await navigator.clipboard.writeText(text); } catch {}
    action.classList.add('copied');
    setTimeout(() => action.classList.remove('copied'), 1500);
  } else if (act === 'like') {
    action.classList.toggle('active');
    action.closest('.msg-actions').querySelector('[data-action="dislike"]')?.classList.remove('active');
  } else if (act === 'dislike') {
    action.classList.toggle('active');
    action.closest('.msg-actions').querySelector('[data-action="like"]')?.classList.remove('active');
  } else if (act === 'edit') {
    const m = state.messages[idx];
    state.editingMessageId = m.id;
    state.editingValue = m.content;
    state.editingSelection = null;
    renderMessages();
    setTimeout(() => {
      const ta = document.getElementById('editTextarea');
      if (ta) { ta.focus(); ta.style.height = ta.scrollHeight + 'px'; }
    }, 0);
  } else if (act === 'share') {
    await shareSingleMessage(idx);
  }
});

// Track cursor in edit textarea
chatEl.addEventListener('input', (e) => {
  if (e.target.id === 'editTextarea') {
    state.editingValue = e.target.value;
    state.editingSelection = { start: e.target.selectionStart, end: e.target.selectionEnd };
    e.target.style.height = '0px';
    e.target.style.height = e.target.scrollHeight + 'px';
  }
});

// ============= SEND MESSAGE =============
formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.isGenerating) return;
  const text = inputEl.value.trim();
  if (!text && !state.attachments.length) return;

  // Ensure chat exists
  let chat = state.chats.find(c => c.id === state.activeChatId);
  let isNewChat = false;
  if (!chat) {
    chat = { id: makeLocalId(), title: 'New chat', messages: [], pinned: false, createdAt: nowISO(), updatedAt: nowISO() };
    state.chats.unshift(chat);
    state.activeChatId = chat.id;
    isNewChat = true;
    renderChatList();
  }

  const filesForMsg = state.attachments.map(f => ({ name: f.name, type: f.type, url: f.url }));
  const isFirstMessage = isNewChat || chat.title === 'New chat' || !chat.messages.length;

  inputEl.value = '';
  autoGrow();
  state.attachments = [];
  renderFilePreviews();

  chatEl.querySelector('.welcome')?.remove();

  const userMsg = { id: 'user_' + Date.now(), role: 'user', content: text, files: filesForMsg };
  state.messages.push(userMsg);
  chat.messages = state.messages;

  const assistantMsg = { id: 'asst_' + Date.now(), role: 'assistant', content: '', files: [] };
  state.messages.push(assistantMsg);

  renderMessages();

  // Title generation for first message
  if (isFirstMessage && text) {
    if (state.user && !isLocalId(chat.id)) {
      // Server generates on /api/chat below; refresh after
    } else {
      fetch('/api/chat/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      }).then(r => r.json()).then(d => {
        if (d.title) {
          const c = state.chats.find(x => x.id === chat.id);
          if (c) { c.title = d.title; renderChatList(); }
        }
      }).catch(() => {});
    }
  }

  state.isGenerating = true;
  inputEl.disabled = true;
  updateSendButton();
  state.abortController = new AbortController();

  let fullText = '';
  try {
    const endpoint = state.user ? '/api/chat' : '/api/chat/guest';
    const payload = { messages: state.messages.map(m => ({ role: m.role, content: m.content })) };
    if (state.user) payload.conversationId = isLocalId(chat.id) ? null : chat.id;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
      signal: state.abortController.signal
    });
    if (!res.ok || !res.body) throw new Error('Bad response');

    const serverConvId = res.headers.get('X-Conversation-Id');
    if (serverConvId && isLocalId(chat.id)) {
      // Upgrade local ID to server ID
      const oldId = chat.id;
      chat.id = serverConvId;
      state.activeChatId = serverConvId;
      renderChatList();
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let firstChunk = true;

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
            if (firstChunk) {
              firstChunk = false;
              const t = chatEl.querySelector('.msg-assistant:last-of-type .thinking');
              if (t) t.remove();
            }
            fullText += j.text;
            assistantMsg.content = fullText;
            const el = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .assistant-text`);
            if (el) el.innerHTML = renderMarkdown(fullText);
            scrollBottom();
          }
        } catch {}
      }
    }

    if (fullText) {
      assistantMsg.content = fullText;
      // Show assistant actions
      const actEl = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .msg-actions-assistant`);
      if (actEl) actEl.classList.remove('hidden');
      // Refresh conversation list from server if logged in
      if (state.user) await loadConversations();
    } else {
      assistantMsg.content = 'No response received.';
      renderMessages();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (fullText) {
        assistantMsg.content = fullText + '\n\n*[stopped]*';
      } else {
        assistantMsg.content = '*Stopped.*';
      }
      renderMessages();
    } else {
      console.error(err);
      assistantMsg.content = 'Something went wrong. Please try again.';
      renderMessages();
    }
  } finally {
    state.isGenerating = false;
    inputEl.disabled = false;
    state.abortController = null;
    updateSendButton();
    inputEl.focus();
  }
});

// ============= EDIT & VERSIONS =============
async function saveEditAndSend(newText) {
  const trimmed = newText.trim();
  if (!trimmed) return;
  const editId = state.editingMessageId;
  const editIdx = state.messages.findIndex(m => m.id === editId);
  if (editIdx < 0) return;

  const userMsg = state.messages[editIdx];
  const nextMsg = state.messages[editIdx + 1];
  const isAssistantNext = nextMsg && nextMsg.role === 'assistant';

  // Init or grab version record
  if (!state.messageVersions[editId]) {
    state.messageVersions[editId] = {
      versions: [userMsg.content],
      files: [userMsg.files || []],
      aiReplies: [isAssistantNext ? nextMsg.content : ''],
      aiFiles: [isAssistantNext ? (nextMsg.files || []) : []],
      currentIndex: 0
    };
  }
  const v = state.messageVersions[editId];

  // Push new version slot
  if (v.versions[v.versions.length - 1] !== trimmed) {
    v.versions.push(trimmed);
    v.files.push(userMsg.files || []);
    v.aiReplies.push('');
    v.aiFiles.push([]);
  }
  v.currentIndex = v.versions.length - 1;

  // Update user message locally
  userMsg.content = trimmed;
  userMsg.files = v.files[v.currentIndex];

  // Truncate history after the edit point
  state.messages = state.messages.slice(0, editIdx + 1);
  const chat = state.chats.find(c => c.id === state.activeChatId);
  if (chat) chat.messages = state.messages;

  // Reset edit state
  state.editingMessageId = null;
  state.editingValue = '';
  state.editingSelection = null;

  // Push placeholder assistant
  const assistantMsg = { id: 'asst_' + Date.now(), role: 'assistant', content: '', files: [] };
  state.messages.push(assistantMsg);

  renderMessages();

  // Stream the new AI reply
  state.isGenerating = true;
  inputEl.disabled = true;
  updateSendButton();
  state.abortController = new AbortController();

  let fullText = '';
  try {
    const endpoint = state.user ? '/api/chat' : '/api/chat/guest';
    const payload = {
      messages: state.messages.filter(m => m.role === 'user' || (m.role === 'assistant' && m.content)).map(m => ({ role: m.role, content: m.content }))
    };
    if (state.user && chat && !isLocalId(chat.id)) payload.conversationId = chat.id;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
      signal: state.abortController.signal
    });
    if (!res.ok || !res.body) throw new Error('Bad response');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let firstChunk = true;
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
            if (firstChunk) {
              firstChunk = false;
              const t = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .thinking`);
              if (t) t.remove();
            }
            fullText += j.text;
            assistantMsg.content = fullText;
            const el = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .assistant-text`);
            if (el) el.innerHTML = renderMarkdown(fullText);
            scrollBottom();
          }
        } catch {}
      }
    }

    v.aiReplies[v.currentIndex] = fullText;
    v.aiFiles[v.currentIndex] = [];

    // Sync to backend if logged in
    if (state.user && chat && !isLocalId(chat.id) && userMsg.id && !userMsg.id.startsWith('user_')) {
      try {
        await fetch(`/api/chat/messages/${userMsg.id}/sync-versions`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userMessageContent: userMsg.content,
            userMessageFiles: userMsg.files || [],
            versions: v.versions,
            versionFiles: v.files,
            aiReplies: v.aiReplies,
            aiFiles: v.aiFiles,
            currentVersionIndex: v.currentIndex,
            assistantContent: fullText,
            assistantFiles: []
          })
        });
        await loadConversations();
      } catch (e) { console.warn('sync failed', e); }
    }

    renderMessages();
  } catch (err) {
    if (err.name === 'AbortError') {
      v.aiReplies[v.currentIndex] = fullText || '*Stopped.*';
      renderMessages();
    } else {
      console.error(err);
      v.aiReplies[v.currentIndex] = 'Something went wrong.';
      renderMessages();
    }
  } finally {
    state.isGenerating = false;
    inputEl.disabled = false;
    state.abortController = null;
    updateSendButton();
  }
}

function applyVersionChange(msgId, dir) {
  const v = state.messageVersions[msgId];
  if (!v) return;
  const newIdx = dir === 'prev' ? Math.max(0, v.currentIndex - 1) : Math.min(v.versions.length - 1, v.currentIndex + 1);
  if (newIdx === v.currentIndex) return;
  v.currentIndex = newIdx;

  const msgIdx = state.messages.findIndex(m => m.id === msgId);
  if (msgIdx < 0) return;
  state.messages[msgIdx].content = v.versions[newIdx];
  state.messages[msgIdx].files = v.files[newIdx];

  const nextMsg = state.messages[msgIdx + 1];
  if (nextMsg && nextMsg.role === 'assistant') {
    nextMsg.content = v.aiReplies[newIdx] || '';
    nextMsg.files = v.aiFiles[newIdx] || [];
  }
  renderMessages();
}

// ============= LOAD CONVERSATIONS =============
async function loadConversations() {
  if (!state.user) return;
  try {
    const res = await fetch('/api/conversations', { headers: authHeaders() });
    const data = await res.json();
    const serverChats = (data.conversations || []).map(c => ({
      id: c.id, title: c.title, pinned: c.pinned,
      messages: [], createdAt: c.created_at, updatedAt: c.updated_at
    }));
    // Preserve local chats that aren't yet on server
    const locals = state.chats.filter(c => isLocalId(c.id));
    state.chats = [...locals, ...serverChats];
    renderChatList();
  } catch {}
}

async function selectChat(id) {
  if (state.isGenerating) return;
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  state.activeChatId = id;
  state.editingMessageId = null;
  state.editingValue = '';
  state.attachments = [];
  renderFilePreviews();

  if (state.user && !isLocalId(id)) {
    try {
      const res = await fetch(`/api/conversations/${id}/messages`, { headers: authHeaders() });
      const data = await res.json();
      state.messages = (data.messages || []).map(m => ({
        id: m.id, role: m.role, content: m.content, files: m.files || []
      }));
      // Rebuild version records
      (data.messages || []).forEach(m => {
        if (m.role === 'user' && m.versions && m.versions.length > 0) {
          state.messageVersions[m.id] = {
            versions: m.versions,
            files: m.version_files || [],
            aiReplies: m.ai_replies || [],
            aiFiles: m.ai_files || [],
            currentIndex: m.current_version_index || 0
          };
        }
      });
    } catch { state.messages = []; }
  } else {
    state.messages = chat.messages || [];
  }
  chat.messages = state.messages;
  if (state.messages.length) renderMessages(); else renderWelcome();
  renderChatList();
  closeSidebar();
}

// ============= AUTH MODAL =============
function openAuthModal(mode) { authModal.classList.remove('hidden'); mode === 'login' ? renderLoginModal() : renderSignupModal(); }
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
    if (!email || !password) return;
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
    <input type="password" id="authPassword" placeholder="Password (min 6)" class="modal-input" />
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
    // Sync active local chat if it had messages
    const active = state.chats.find(c => c.id === state.activeChatId);
    if (active && isLocalId(active.id) && state.messages.length) {
      // Will be re-created server-side on next send
    }
  };
}

// ============= SHARE =============
async function shareChat(chatId) {
  const chat = state.chats.find(c => c.id === chatId); if (!chat) return;
  let msgs = chat.messages || [];
  if ((!msgs || !msgs.length) && state.user && !isLocalId(chatId)) {
    try {
      const res = await fetch(`/api/conversations/${chatId}/messages`, { headers: authHeaders() });
      const d = await res.json();
      msgs = (d.messages || []).map(m => ({ role: m.role, content: m.content, files: m.files || [] }));
    } catch {}
  }
  if (!msgs.length) { alert('Nothing to share in this chat yet.'); return; }
  await postShare(msgs);
}

async function shareSingleMessage(idx) {
  const msg = state.messages[idx]; if (!msg) return;
  const msgs = [msg];
  // Include preceding user message for context
  const prev = state.messages[idx - 1];
  if (prev && prev.role === 'user') msgs.unshift(prev);
  await postShare(msgs);
}

async function postShare(msgs) {
  // Enrich with version data
  const enriched = msgs.map(m => {
    const out = { role: m.role, content: m.content, files: m.files || [] };
    if (m.id && state.messageVersions[m.id]) {
      const v = state.messageVersions[m.id];
      out.versions = v.versions;
      out.versionFiles = v.files;
      out.aiReplies = v.aiReplies;
      out.aiFiles = v.aiFiles;
      out.currentVersionIndex = v.currentIndex;
    }
    return out;
  }).filter(m => (m.content && m.content.trim()) || (m.files && m.files.length));

  try {
    const res = await fetch('/api/share/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: enriched })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showShareModal(data.url);
  } catch (e) { alert('Could not create share link: ' + e.message); }
}

function showShareModal(url) {
  shareLinkInput.value = url;
  shareModal.classList.remove('hidden');
}
shareModalClose.addEventListener('click', () => shareModal.classList.add('hidden'));
shareModal.addEventListener('click', (e) => { if (e.target === shareModal) shareModal.classList.add('hidden'); });
copyShareLink.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareLinkInput.value); } catch {}
  copyShareLink.textContent = 'Copied!';
  setTimeout(() => copyShareLink.textContent = 'Copy', 1500);
});

// ============= BOOT =============
init();
