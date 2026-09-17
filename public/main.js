// DeepRWA — Complete frontend logic (rev.3.3.6)

// ============ CLIENT ID ============
function getOrCreateClientId() {
  const key = 'deeprwa_client_id';
  let id = localStorage.getItem(key);
  if (!id || !/^c_[a-f0-9]{32}$/.test(id)) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = 'c_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(key, id);
  }
  return id;
}
const CLIENT_ID = getOrCreateClientId();

// ============ AUTH MODAL STATE PERSISTENCE ============
const AUTH_MODAL_KEY = 'deeprwa_auth_modal_v1';
function saveAuthModalState(payload) {
  try { if (!payload) sessionStorage.removeItem(AUTH_MODAL_KEY); else sessionStorage.setItem(AUTH_MODAL_KEY, JSON.stringify(payload)); } catch {}
}
function loadAuthModalState() {
  try { const raw = sessionStorage.getItem(AUTH_MODAL_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function clearAuthModalState() { try { sessionStorage.removeItem(AUTH_MODAL_KEY); } catch {} }

// ============ VISUAL VIEWPORT ============
function setupVisualViewport() {
  if (!window.visualViewport) return;
  const apply = () => {
    const vv = window.visualViewport;
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
  };
  window.visualViewport.addEventListener('resize', apply);
  window.visualViewport.addEventListener('scroll', apply);
  apply();
}

// ============ STATE ============
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
  messageVersions: {},
  view: 'chats',
  authModal: { mode: 'login', pendingToken: null, forgot: { email: null, pendingToken: null, grantedToken: null } },
  sessionCheckInterval: null,
  lastSessionCheck: 0,
  _pendingAction: null,
  _pendingPw: null,
  _loginAt: 0,
  _filesCache: [],
  _selectedFiles: new Set(),
  _multiSelectMode: false,
  _chatMultiSelectMode: false,
  _selectedChats: new Set()
};

// ============ DOM ============
const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const formEl = $('composer');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const micBtn = $('micBtn');
const newChatBtn = $('newChatBtn');
const sidebar = $('sidebar');
const sidebarBackdrop = $('sidebarBackdrop');
const menuBtn = $('menuBtn');
const expandBtn = $('expandBtn');
const sidebarCollapseBtn = $('sidebarCollapseBtn');
const attachBtn = $('attachBtn');
const fileInput = $('fileInput');
const filePreviews = $('filePreviews');
const sidebarNav = $('sidebarNav');
const sidebarContent = $('sidebarContent');
const sidebarFooter = $('sidebarFooter');
const filesMultiBar = $('filesMultiBar');
const filesSelectAllBtn = $('filesSelectAllBtn');
const filesDeleteSelectedBtn = $('filesDeleteSelectedBtn');
const filesDeleteCountLabel = $('filesDeleteCountLabel');
const filesCancelSelectBtn = $('filesCancelSelectBtn');
const chatsMultiBar = $('chatsMultiBar');
const chatsSelectAllBtn = $('chatsSelectAllBtn');
const chatsPinSelectedBtn = $('chatsPinSelectedBtn');
const chatsDeleteSelectedBtn = $('chatsDeleteSelectedBtn');
const chatsDeleteCountLabel = $('chatsDeleteCountLabel');
const chatsCancelSelectBtn = $('chatsCancelSelectBtn');
const authModal = $('authModal');
const authModalBody = $('authModalBody');
const authModalClose = $('authModalClose');
const profileModal = $('profileModal');
const profileModalClose = $('profileModalClose');
const profileModalBody = $('profileModalBody');
const settingsModal = $('settingsModal');
const settingsModalClose = $('settingsModalClose');
const settingsSidebar = $('settingsSidebar');
const settingsContent = $('settingsContent');
const accountDropdown = $('accountDropdown');
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
const fileViewModal = $('fileViewModal');
const fileViewModalClose = $('fileViewModalClose');
const fileViewBody = $('fileViewBody');
const toastContainer = $('toastContainer');

// ============ UTILS ============
function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }
function escapeHtml(t) { return String(t || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function escapeHtmlOutsideCode(text) {
  const lines = (text || '').split('\n');
  let inCode = false;
  return lines.map(line => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return line; }
    if (inCode) return line;
    let cleaned = line
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<hr\s*\/?>/gi, '\n')
      .replace(/<a\s+[^>]*?href\s*=\s*["']([^"']*)["'][^>]*?>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<\/?(p|div|span|strong|em|b|i|u|ul|ol|li|blockquote|table|thead|tbody|tr|td|th|h[1-6]|section|article|header|footer|nav|aside|main|pre|code|sup|sub|small|mark|del|ins|figure|figcaption|picture|source|video|audio|canvas|iframe|form|input|button|select|textarea|label|fieldset|legend|details|summary|body|html|head|title|meta|link|script|style)[^>]*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    return cleaned.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }).join('\n');
}

function renderMarkdown(text) {
  const safe = escapeHtmlOutsideCode(text || '');
  let html;
  try { html = window.marked.parse(safe, { breaks: true, gfm: true }); }
  catch { return safe.replace(/\n/g, '<br>'); }
  html = html.replace(/<hr\s*\/?>/gi, '');
  html = html.replace(/<a\s+([^>]*?)>/gi, (_match, attrs) => {
    const cleanedAttrs = attrs
      .replace(/\btarget\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\brel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .trim();
    return `<a ${cleanedAttrs ? cleanedAttrs + ' ' : ''}target="_blank" rel="noopener noreferrer">`;
  });
  return html;
}

function scrollBottom() { chatEl.scrollTop = chatEl.scrollHeight; }
function authHeaders() {
  const h = { 'X-Client-Id': CLIENT_ID };
  if (state.token) h['Authorization'] = `Bearer ${state.token}`;
  return h;
}
function isLocalId(id) { return typeof id === 'string' && id.startsWith('local_'); }
function makeLocalId() { return 'local_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function nowISO() { return new Date().toISOString(); }
function formatDate(iso) { if (!iso) return ''; try { return new Date(iso).toLocaleString(); } catch { return ''; } }
function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ============ TOASTS ============
function toast(message, type = 'info', duration = 3500) {
  const icons = { success: 'check-circle', error: 'alert-circle', info: 'info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i data-lucide="${icons[type]}"></i><span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(el);
  refreshIcons();
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.25s'; }, duration - 300);
  setTimeout(() => el.remove(), duration);
}

// ============ PASSWORD TOGGLE ============
function passwordFieldHTML(id, placeholder, autocomplete = 'current-password') {
  return `
    <div class="input-wrap">
      <input type="password" id="${id}" placeholder="${placeholder}" class="modal-input" autocomplete="${autocomplete}" />
      <button type="button" class="input-toggle" data-toggle="${id}" aria-label="Show password"><i data-lucide="eye"></i></button>
    </div>`;
}
function attachPasswordToggles(root = document) {
  root.querySelectorAll('[data-toggle]').forEach(btn => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.toggle);
      if (!inp) return;
      const isPw = inp.type === 'password';
      inp.type = isPw ? 'text' : 'password';
      btn.innerHTML = `<i data-lucide="${isPw ? 'eye-off' : 'eye'}"></i>`;
      refreshIcons();
    });
  });
}

// ============ BUTTON HELPERS ============
function setBtnLoading(btn, text) {
  if (!btn) return;
  if (!btn._originalHTML) btn._originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span><span>${escapeHtml(text)}</span>`;
}
function resetBtn(btn) {
  if (!btn || !btn._originalHTML) return;
  btn.disabled = false;
  btn.innerHTML = btn._originalHTML;
  refreshIcons();
}
function attachCountdown(btn, seconds = 60) {
  if (!btn) return;
  if (btn._cdInterval) clearInterval(btn._cdInterval);
  const original = btn.dataset.originalText || btn.textContent.trim();
  btn.dataset.originalText = original;
  let remaining = seconds;
  btn.disabled = true;
  btn.textContent = `Resend in ${remaining}s`;
  btn._cdInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) { clearInterval(btn._cdInterval); btn._cdInterval = null; btn.disabled = false; btn.textContent = original; }
    else btn.textContent = `Resend in ${remaining}s`;
  }, 1000);
}

// ============ IMAGE COMPRESSION ============
async function compressImage(file, maxDimension = 1600, quality = 0.85) {
  if (!file.type.startsWith('image/')) return file;
  if (file.type === 'image/gif') return file;
  if (file.size < 200 * 1024) return file;
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > maxDimension || h > maxDimension) {
        if (w >= h) { h = Math.round((h * maxDimension) / w); w = maxDimension; }
        else { w = Math.round((w * maxDimension) / h); h = maxDimension; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { resolve(file); return; }
        const baseName = (file.name || 'image').replace(/\.[^.]+$/, '');
        const newFile = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
        resolve(newFile);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ============ VOICE INPUT ============
let _voiceRecognition = null;
let _voiceListening = false;
let _voiceBaseText = '';

function setupVoiceInput() {
  if (!micBtn) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micBtn.style.display = 'none';
    return;
  }
  _voiceRecognition = new SR();
  _voiceRecognition.continuous = false;
  _voiceRecognition.interimResults = true;
  _voiceRecognition.lang = navigator.language || 'en-US';

  _voiceRecognition.onstart = () => {
    _voiceListening = true;
    _voiceBaseText = inputEl.value || '';
    micBtn.classList.add('listening');
  };
  _voiceRecognition.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t; else interim += t;
    }
    const piece = final || interim;
    if (!piece) return;
    const sep = _voiceBaseText && !/\s$/.test(_voiceBaseText) ? ' ' : '';
    inputEl.value = _voiceBaseText + sep + piece;
    autoGrow(); updateSendButton();
  };
  _voiceRecognition.onerror = (e) => {
    _voiceListening = false;
    micBtn.classList.remove('listening');
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone access denied', 'error');
    else if (e.error === 'no-speech') toast('No speech detected — tap mic to try again', 'info', 2500);
    else if (e.error !== 'aborted') toast('Voice input error: ' + e.error, 'error');
  };
  _voiceRecognition.onend = () => {
    _voiceListening = false;
    micBtn.classList.remove('listening');
  };

  micBtn.addEventListener('click', () => {
    if (_voiceListening) { try { _voiceRecognition.stop(); } catch {} return; }
    try { _voiceRecognition.start(); } catch (e) { console.warn('voice start failed', e); }
  });
}

function stopVoiceInput() {
  if (_voiceListening && _voiceRecognition) { try { _voiceRecognition.stop(); } catch {} }
}

// ============ VOICE OUTPUT ============
let _currentSpeakBtn = null;

function stripMarkdownForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stopSpeaking() {
  if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch {} }
  if (_currentSpeakBtn) { _currentSpeakBtn.classList.remove('speaking'); _currentSpeakBtn = null; }
}

function speakMessage(text, btn) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    toast('Voice output is not supported on this browser', 'error');
    return;
  }
  if (_currentSpeakBtn === btn && window.speechSynthesis.speaking) { stopSpeaking(); return; }
  stopSpeaking();
  const clean = stripMarkdownForSpeech(text);
  if (!clean) { toast('Nothing to read', 'info'); return; }
  const utter = new SpeechSynthesisUtterance(clean);
  utter.lang = navigator.language || 'en-US';
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.onend = () => {
    if (_currentSpeakBtn === btn) _currentSpeakBtn = null;
    btn.classList.remove('speaking');
  };
  utter.onerror = () => {
    if (_currentSpeakBtn === btn) _currentSpeakBtn = null;
    btn.classList.remove('speaking');
  };
  _currentSpeakBtn = btn;
  btn.classList.add('speaking');
  window.speechSynthesis.speak(utter);
}

window.addEventListener('beforeunload', () => stopSpeaking());

// ============ SERVICE WORKER (PWA) ============
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('/sw.js').catch((e) => {
    console.warn('[sw] registration failed:', e.message);
  });
}

// ============ INIT ============
async function init() {
  setupVisualViewport();
  setupVoiceInput();
  registerServiceWorker();
  renderUser(); renderChatList(); renderWelcome(); updateSendButton();
  inputEl.focus();
  if (state.token) {
    try {
      const res = await fetch('/api/auth/me', { headers: authHeaders() });
      if (res.ok) {
        const d = await res.json();
        state.user = d.user;
        state._loginAt = Date.now();
        renderUser();
        await loadConversations();
      } else {
        let revoked = false;
        try { const d = await res.json(); if (d && d.code === 'SESSION_REVOKED') revoked = true; } catch {}
        state.token = null;
        localStorage.removeItem('deeprwa_token');
        renderUser();
        if (revoked) toast('Signed out from another device', 'info');
      }
    } catch { renderUser(); }
  }
  restoreAuthModalState();
  startSessionCheck();
}

// ============ SESSION CHECK ============
function startSessionCheck() {
  if (state.sessionCheckInterval) clearInterval(state.sessionCheckInterval);
  const doCheck = () => {
    if (!state.token) return;
    const now = Date.now();
    if (now - state.lastSessionCheck < 15000) return;
    state.lastSessionCheck = now;
    fetch('/api/auth/session-check', { headers: authHeaders() })
      .then(async (r) => {
        if (r.ok) {
          try { const d = await r.json(); if (d && d.valid === false) forceSignOut('Signed out from another device'); } catch {}
        } else if (r.status === 401) {
          forceSignOut('Signed out from another device');
        }
      })
      .catch(() => {});
  };
  setTimeout(doCheck, 5000);
  state.sessionCheckInterval = setInterval(doCheck, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) doCheck(); });
}

async function forceSignOut(reason) {
  state.token = null; state.user = null; state.chats = []; state.activeChatId = null; state.messages = [];
  state._selectedFiles.clear(); state._multiSelectMode = false;
  state._selectedChats.clear(); state._chatMultiSelectMode = false;
  localStorage.removeItem('deeprwa_token');
  clearAuthModalState();
  renderUser(); renderChatList(); renderWelcome(); closeAllModals();
  toast(reason || 'Signed out', 'info');
}

// ============ USER ============
function renderUser() {
  if (state.user) {
    const initial = (state.user.email || 'U')[0].toUpperCase();
    sidebarFooter.innerHTML = `
      <button class="auth-btn account" id="accountBtn">
        <div class="account-info">
          <div class="account-avatar">${escapeHtml(initial)}</div>
          <span class="account-email">${escapeHtml(state.user.email || 'Account')}</span>
        </div>
        <i data-lucide="chevron-up"></i>
      </button>`;
    refreshIcons();
    $('accountBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleAccountDropdown(e.currentTarget); });
  } else {
    sidebarFooter.innerHTML = `
      <button class="auth-btn" id="authBtn"><i data-lucide="log-in"></i><span>Log in</span></button>`;
    refreshIcons();
    $('authBtn').addEventListener('click', () => openAuthModal('login'));
  }
}

function toggleAccountDropdown(anchor) {
  if (!accountDropdown.classList.contains('hidden')) { accountDropdown.classList.add('hidden'); return; }
  const rect = anchor.getBoundingClientRect();
  accountDropdown.style.left = Math.max(8, rect.left) + 'px';
  accountDropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  accountDropdown.classList.remove('hidden');
  refreshIcons();
  const close = (ev) => {
    if (!accountDropdown.contains(ev.target) && ev.target !== anchor) {
      accountDropdown.classList.add('hidden');
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

accountDropdown.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const act = btn.dataset.action;
  accountDropdown.classList.add('hidden');
  if (act === 'profile') openProfileModal();
  else if (act === 'settings') openSettingsModal('account');
  else if (act === 'logout') confirmLogout();
});

// ============ SIDEBAR ============
function openSidebar() { sidebar.classList.add('open'); sidebarBackdrop.classList.add('show'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('show'); }
menuBtn.addEventListener('click', openSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);
sidebarCollapseBtn.addEventListener('click', () => {
  document.body.classList.add('sidebar-collapsed'); expandBtn.classList.remove('hidden');
  try { localStorage.setItem('dr_sidebar', 'collapsed'); } catch {}
});
expandBtn.addEventListener('click', () => {
  document.body.classList.remove('sidebar-collapsed'); expandBtn.classList.add('hidden');
  try { localStorage.setItem('dr_sidebar', 'expanded'); } catch {}
});
try { if (localStorage.getItem('dr_sidebar') === 'collapsed' && window.innerWidth > 820) { document.body.classList.add('sidebar-collapsed'); expandBtn.classList.remove('hidden'); } } catch {}

sidebarNav.addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item'); if (!item) return;
  sidebarNav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  item.classList.add('active');
  state.view = item.dataset.view;
  state._selectedFiles.clear();
  state._multiSelectMode = false;
  state._selectedChats.clear();
  state._chatMultiSelectMode = false;
  renderChatList();
});

// ============ CHAT LIST ============
function updateChatsMultiBar() {
  if (!state._chatMultiSelectMode || !state.chats.length) {
    chatsMultiBar.classList.add('hidden');
    return;
  }
  chatsMultiBar.classList.remove('hidden');
  const n = state._selectedChats.size;
  chatsDeleteCountLabel.textContent = n > 0 ? `Delete (${n})` : 'Delete';
  chatsDeleteSelectedBtn.disabled = n === 0;
  chatsPinSelectedBtn.disabled = n === 0;
  const selectedIds = Array.from(state._selectedChats);
  const allSelectedArePinned = selectedIds.length > 0 && selectedIds.every(id => {
    const c = state.chats.find(x => x.id === id);
    return c && c.pinned;
  });
  chatsPinSelectedBtn.innerHTML = allSelectedArePinned ? '<i data-lucide="pin-off"></i>' : '<i data-lucide="pin"></i>';
  chatsPinSelectedBtn.title = allSelectedArePinned ? 'Unpin selected' : 'Pin selected';
  chatsPinSelectedBtn.setAttribute('aria-label', allSelectedArePinned ? 'Unpin selected' : 'Pin selected');
  const allSelected = state.chats.length > 0 && state.chats.every(c => state._selectedChats.has(c.id));
  chatsSelectAllBtn.innerHTML = allSelected
    ? '<i data-lucide="check-square"></i><span>Deselect all</span>'
    : '<i data-lucide="square"></i><span>Select all</span>';
  refreshIcons();
}

function renderChatList() {
  if (state.view === 'files') {
    chatsMultiBar.classList.add('hidden');
    updateMultiBar();
    renderFilesList();
    return;
  }
  filesMultiBar.classList.add('hidden');
  updateChatsMultiBar();

  if (!state.chats.length) {
    sidebarContent.innerHTML = `<div class="sidebar-empty"><p>No chats yet</p><span>Start a conversation with DeepRWA</span></div>`;
    return;
  }

  const inMulti = state._chatMultiSelectMode;

  const renderOne = (c) => {
    if (inMulti) {
      const checked = state._selectedChats.has(c.id);
      return `<div class="chat-item ${checked ? 'selected' : ''}" data-id="${c.id}">
        <label class="file-checkbox" title="Select">
          <input type="checkbox" data-chat-check="${c.id}" ${checked ? 'checked' : ''} />
          <span class="file-checkbox-mark"></span>
        </label>
        <span class="chat-item-title" title="${escapeHtml(c.title || 'New chat')}">${escapeHtml(c.title || 'New chat')}</span>
      </div>`;
    }
    return `<div class="chat-item ${c.id === state.activeChatId ? 'active' : ''}" data-id="${c.id}">
      <i data-lucide="${c.pinned ? 'pin' : 'message-square'}" class="chat-item-icon"></i>
      <span class="chat-item-title" title="${escapeHtml(c.title || 'New chat')}">${escapeHtml(c.title || 'New chat')}</span>
      <button class="chat-item-menu" data-menu="${c.id}" aria-label="Menu"><i data-lucide="more-horizontal"></i></button>
    </div>`;
  };

  if (inMulti) {
    sidebarContent.innerHTML = state.chats.map(renderOne).join('');
  } else {
    const pinned = state.chats.filter(c => c.pinned);
    const rest = state.chats.filter(c => !c.pinned);
    let html = '';
    if (pinned.length) html += `<div class="sidebar-section">Pinned</div>` + pinned.map(renderOne).join('');
    if (rest.length) html += (pinned.length ? `<div class="sidebar-section">Chats</div>` : '') + rest.map(renderOne).join('');
    sidebarContent.innerHTML = html;
  }
  refreshIcons();
}

// ============ CHATS MULTI-SELECT BAR ============
chatsSelectAllBtn.addEventListener('click', () => {
  const allSelected = state.chats.length > 0 && state.chats.every(c => state._selectedChats.has(c.id));
  if (allSelected) state._selectedChats.clear();
  else state.chats.forEach(c => state._selectedChats.add(c.id));
  renderChatList();
});

chatsCancelSelectBtn.addEventListener('click', () => {
  state._chatMultiSelectMode = false;
  state._selectedChats.clear();
  renderChatList();
});

chatsPinSelectedBtn.addEventListener('click', async () => {
  const ids = Array.from(state._selectedChats);
  if (!ids.length) return;
  const allPinned = ids.every(id => { const c = state.chats.find(x => x.id === id); return c && c.pinned; });
  const targetPinned = !allPinned;
  for (const id of ids) {
    const c = state.chats.find(x => x.id === id);
    if (!c) continue;
    c.pinned = targetPinned;
    if (state.user && !isLocalId(id)) {
      try {
        await fetch(`/api/conversations/${id}`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: c.pinned })
        });
      } catch {}
    }
  }
  state._chatMultiSelectMode = false;
  state._selectedChats.clear();
  renderChatList();
  toast(`${ids.length} chat(s) ${targetPinned ? 'pinned' : 'unpinned'}`, 'success');
});

chatsDeleteSelectedBtn.addEventListener('click', () => {
  const count = state._selectedChats.size;
  if (!count) return;
  confirmAction({
    title: `Delete ${count} chat(s)?`,
    text: 'They will be removed from your chat list.',
    confirmLabel: 'Delete',
    onConfirm: async () => {
      const ids = Array.from(state._selectedChats);
      for (const id of ids) {
        if (state.user && !isLocalId(id)) {
          try { await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: authHeaders() }); } catch {}
        }
        state.chats = state.chats.filter(c => c.id !== id);
        if (state.activeChatId === id) newChatSilent();
      }
      state._selectedChats.clear();
      state._chatMultiSelectMode = false;
      renderChatList();
      toast(`${ids.length} chat(s) deleted`, 'success');
    }
  });
});

// ============ FILES LIST ============
async function renderFilesList() {
  if (state.user) {
    sidebarContent.innerHTML = `<div class="sidebar-empty"><p>Loading files…</p></div>`;
    try {
      const res = await fetch('/api/files-with-ids', { headers: authHeaders() });
      const d = await res.json();
      state._filesCache = (d.files || []).filter(f => !f.generated);
      renderFilesArray(state._filesCache, false);
    } catch {
      sidebarContent.innerHTML = `<div class="sidebar-empty"><p>Could not load files</p></div>`;
      state._filesCache = [];
    }
    updateMultiBar();
    return;
  }
  const files = [];
  for (const chat of state.chats) {
    for (const m of chat.messages || []) {
      if (Array.isArray(m.files)) {
        m.files.forEach((f, i) => {
          if (f && !f.generated && (f.dataUrl || f.url)) files.push({ ...f, _guestRef: { chatId: chat.id, msgId: m.id, index: i }, created_at: m._createdAt || nowISO() });
        });
      }
    }
  }
  state._filesCache = files;
  renderFilesArray(files, true);
  updateMultiBar();
}

function fileKey(f, idx) {
  if (f.messageId !== undefined) return `${f.messageId}:${f.index}`;
  if (f._guestRef) return `g:${f._guestRef.chatId}:${f._guestRef.msgId}:${f._guestRef.index}`;
  return `i:${idx}`;
}

function updateMultiBar() {
  if (state._multiSelectMode && state._filesCache.length > 0) {
    filesMultiBar.classList.remove('hidden');
    const n = state._selectedFiles.size;
    filesDeleteCountLabel.textContent = n > 0 ? `Delete (${n})` : 'Delete';
    filesDeleteSelectedBtn.disabled = n === 0;
    const allSelected = state._filesCache.length > 0 && state._filesCache.every((f, idx) => state._selectedFiles.has(fileKey(f, idx)));
    filesSelectAllBtn.innerHTML = allSelected
      ? '<i data-lucide="check-square"></i><span>Deselect all</span>'
      : '<i data-lucide="square"></i><span>Select all</span>';
    refreshIcons();
  } else {
    filesMultiBar.classList.add('hidden');
  }
}

function renderFilesArray(files, isGuest = false) {
  if (!files.length) {
    sidebarContent.innerHTML = isGuest
      ? `<div class="sidebar-empty"><p>No files in this session</p><span>Guest files are cleared when you reload.</span></div>`
      : `<div class="sidebar-empty"><p>No files yet</p><span>Files you send or receive will appear here</span></div>`;
    return;
  }
  const inMulti = state._multiSelectMode;
  sidebarContent.innerHTML = files.map((f, idx) => {
    const isImg = (f.type || '').startsWith('image/');
    const url = f.url || f.dataUrl || f.public_url || '';
    const key = fileKey(f, idx);
    const checked = state._selectedFiles.has(key);
    return `<div class="file-item-wrap" data-file-idx="${idx}">
      ${inMulti ? `<label class="file-checkbox" title="Select">
        <input type="checkbox" data-file-check="${idx}" ${checked ? 'checked' : ''} />
        <span class="file-checkbox-mark"></span>
      </label>` : ''}
      <button class="file-item" data-file-view='${escapeHtml(JSON.stringify({url, name: f.name, type: f.type}))}'>
        ${isImg && url
          ? `<img src="${url}" class="file-thumb-sm" loading="lazy" alt="file" />`
          : `<div class="file-thumb-sm"><i data-lucide="file-text"></i></div>`}
        <div class="file-item-info">
          <div class="file-item-name" title="${escapeHtml(f.name || 'file')}">${escapeHtml(f.name || 'file')}</div>
          <div class="file-item-meta">${timeAgo(f.created_at)}</div>
        </div>
      </button>
      ${!inMulti ? `<button class="file-item-menu" data-file-menu="${idx}" aria-label="File menu"><i data-lucide="more-vertical"></i></button>` : ''}
    </div>`;
  }).join('');
  refreshIcons();
}

// ============ SIDEBAR INTERACTION ============
sidebarContent.addEventListener('click', (e) => {
  const fileMenuBtn = e.target.closest('[data-file-menu]');
  if (fileMenuBtn) {
    e.stopPropagation();
    openFileMenu(parseInt(fileMenuBtn.dataset.fileMenu), fileMenuBtn.getBoundingClientRect());
    return;
  }
  const fileBtn = e.target.closest('[data-file-view]');
  if (fileBtn && !e.target.closest('.file-checkbox')) {
    try { const d = JSON.parse(fileBtn.dataset.fileView); showFileView(d.url, d.name, d.type); } catch {}
    return;
  }
  const chatMenuBtn = e.target.closest('.chat-item-menu');
  if (chatMenuBtn) {
    e.stopPropagation();
    openChatMenu(chatMenuBtn.dataset.menu, chatMenuBtn.getBoundingClientRect());
    return;
  }
  const chatItem = e.target.closest('.chat-item');
  if (chatItem) {
    if (state._chatMultiSelectMode) {
      if (e.target.closest('.file-checkbox')) return;
      const id = chatItem.dataset.id;
      const chk = chatItem.querySelector('[data-chat-check]');
      if (chk) {
        chk.checked = !chk.checked;
        if (chk.checked) state._selectedChats.add(id);
        else state._selectedChats.delete(id);
        chatItem.classList.toggle('selected', chk.checked);
        updateChatsMultiBar();
      }
      return;
    }
    selectChat(chatItem.dataset.id);
    return;
  }
});

sidebarContent.addEventListener('change', (e) => {
  const chatChk = e.target.closest('[data-chat-check]');
  if (chatChk) {
    const id = chatChk.dataset.chatCheck;
    if (chatChk.checked) state._selectedChats.add(id);
    else state._selectedChats.delete(id);
    const item = chatChk.closest('.chat-item');
    if (item) item.classList.toggle('selected', chatChk.checked);
    updateChatsMultiBar();
    return;
  }
  const fileChk = e.target.closest('[data-file-check]');
  if (fileChk) {
    const idx = parseInt(fileChk.dataset.fileCheck);
    const f = state._filesCache[idx];
    if (!f) return;
    const key = fileKey(f, idx);
    if (fileChk.checked) state._selectedFiles.add(key);
    else state._selectedFiles.delete(key);
    updateMultiBar();
  }
});

// ============ FILE MENU ============
function openFileMenu(idx, rect) {
  document.querySelectorAll('.file-menu').forEach(m => m.remove());
  const f = state._filesCache[idx];
  if (!f) return;
  const menu = document.createElement('div');
  menu.className = 'file-menu';
  menu.style.left = Math.max(8, Math.min(rect.left - 160, window.innerWidth - 200)) + 'px';
  menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 120) + 'px';
  menu.innerHTML = `
    <button data-act="multi"><i data-lucide="check-square"></i>Multi-select</button>
    <button data-act="delete" class="danger"><i data-lucide="trash-2"></i>Delete</button>`;
  document.body.appendChild(menu);
  refreshIcons();
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    const act = btn.dataset.act;
    menu.remove();
    if (act === 'multi') {
      state._multiSelectMode = true;
      state._selectedFiles.clear();
      state._selectedFiles.add(fileKey(f, idx));
      await renderFilesList();
    } else if (act === 'delete') {
      confirmAction({
        title: 'Delete this file?',
        text: `"${f.name || 'File'}" will be removed from your Files list.`,
        confirmLabel: 'Delete',
        onConfirm: async () => { await deleteFiles([f]); toast('File deleted', 'success'); }
      });
    }
  });
}

// ============ FILES MULTI-SELECT BAR ============
filesSelectAllBtn.addEventListener('click', () => {
  const allSelected = state._filesCache.length > 0 && state._filesCache.every((f, idx) => state._selectedFiles.has(fileKey(f, idx)));
  if (allSelected) state._selectedFiles.clear();
  else state._filesCache.forEach((f, idx) => state._selectedFiles.add(fileKey(f, idx)));
  renderFilesArray(state._filesCache, !state.user);
  updateMultiBar();
});

filesCancelSelectBtn.addEventListener('click', () => {
  state._multiSelectMode = false;
  state._selectedFiles.clear();
  renderFilesArray(state._filesCache, !state.user);
  updateMultiBar();
});

filesDeleteSelectedBtn.addEventListener('click', () => {
  const count = state._selectedFiles.size;
  if (!count) return;
  confirmAction({
    title: `Delete ${count} file(s)?`,
    text: 'They will be removed from your Files list.',
    confirmLabel: 'Delete',
    onConfirm: async () => {
      const toDelete = state._filesCache.filter((f, idx) => state._selectedFiles.has(fileKey(f, idx)));
      await deleteFiles(toDelete);
      state._selectedFiles.clear();
      state._multiSelectMode = false;
      toast(`${toDelete.length} file(s) deleted`, 'success');
    }
  });
});

async function deleteFiles(files) {
  if (!files.length) return;
  if (state.user) {
    const byMessage = {};
    for (const f of files) {
      if (f.messageId === undefined) continue;
      if (!byMessage[f.messageId]) byMessage[f.messageId] = [];
      byMessage[f.messageId].push(f.index);
    }
    for (const [messageId, indices] of Object.entries(byMessage)) {
      indices.sort((a, b) => b - a);
      for (const index of indices) {
        try { await fetch(`/api/files/${messageId}/${index}`, { method: 'DELETE', headers: authHeaders() }); } catch {}
      }
    }
    await renderFilesList();
  } else {
    const byMsg = {};
    for (const f of files) {
      if (!f._guestRef) continue;
      const k = `${f._guestRef.chatId}::${f._guestRef.msgId}`;
      if (!byMsg[k]) byMsg[k] = { chatId: f._guestRef.chatId, msgId: f._guestRef.msgId, indices: [] };
      byMsg[k].indices.push(f._guestRef.index);
    }
    for (const entry of Object.values(byMsg)) {
      entry.indices.sort((a, b) => b - a);
      const chat = state.chats.find(c => c.id === entry.chatId);
      if (!chat) continue;
      const msg = (chat.messages || []).find(m => m.id === entry.msgId);
      if (!msg || !Array.isArray(msg.files)) continue;
      for (const idx of entry.indices) msg.files.splice(idx, 1);
    }
    renderFilesList();
    renderMessages();
  }
}

// ============ CHAT MENU ============
function openChatMenu(id, rect) {
  document.querySelectorAll('.chat-menu').forEach(m => m.remove());
  const chat = state.chats.find(c => c.id === id);
  if (!chat) return;
  const menu = document.createElement('div');
  menu.className = 'chat-menu';
  menu.style.left = Math.max(8, Math.min(rect.left - 140, window.innerWidth - 200)) + 'px';
  menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 220) + 'px';
  menu.innerHTML = `
    <button data-act="pin"><i data-lucide="${chat.pinned ? 'pin-off' : 'pin'}"></i>${chat.pinned ? 'Unpin' : 'Pin'}</button>
    <button data-act="multi"><i data-lucide="check-square"></i>Multi-select</button>
    <button data-act="share"><i data-lucide="share-2"></i>Share</button>
    <button data-act="rename"><i data-lucide="pencil"></i>Rename</button>
    <button data-act="delete" class="danger"><i data-lucide="trash-2"></i>Delete</button>`;
  document.body.appendChild(menu);
  refreshIcons();
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    const act = btn.dataset.act; menu.remove();
    if (act === 'pin') await togglePin(id);
    else if (act === 'multi') {
      state._chatMultiSelectMode = true;
      state._selectedChats.clear();
      state._selectedChats.add(id);
      renderChatList();
    }
    else if (act === 'share') await shareChat(id);
    else if (act === 'rename') openRenameModal(id);
    else if (act === 'delete') askDelete(id);
  });
}

async function togglePin(id) {
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  chat.pinned = !chat.pinned;
  if (state.user && !isLocalId(id)) {
    try { await fetch(`/api/conversations/${id}`, { method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: chat.pinned }) }); } catch {}
  }
  renderChatList();
}

function askDelete(id) {
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  confirmAction({
    title: 'Delete this chat?', text: `"${chat.title || 'New chat'}" will be removed.`, confirmLabel: 'Delete',
    onConfirm: async () => {
      if (state.user && !isLocalId(id)) {
        try { await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: authHeaders() }); } catch {}
      }
      state.chats = state.chats.filter(c => c.id !== id);
      if (state.activeChatId === id) newChatSilent();
      renderChatList(); toast('Chat deleted', 'success');
    }
  });
}

function confirmAction({ title, text, confirmLabel = 'Confirm', danger = true, onConfirm }) {
  confirmTitle.textContent = title; confirmText.textContent = text;
  confirmOk.textContent = confirmLabel;
  confirmOk.className = danger ? 'btn-danger' : 'btn-primary';
  confirmModal.classList.remove('hidden');
  const cleanup = () => { confirmOk.onclick = null; confirmCancel.onclick = null; };
  confirmOk.onclick = async () => { confirmModal.classList.add('hidden'); cleanup(); await onConfirm(); };
  confirmCancel.onclick = () => { confirmModal.classList.add('hidden'); cleanup(); };
}

function openRenameModal(id) {
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  renameInput.value = chat.title || '';
  renameModal.classList.remove('hidden'); renameModal.dataset.id = id;
  renameInput.focus(); renameInput.select();
}
renameModalClose.addEventListener('click', () => renameModal.classList.add('hidden'));
renameSubmit.addEventListener('click', async () => {
  const id = renameModal.dataset.id;
  const newTitle = renameInput.value.trim();
  if (!newTitle) return;
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  chat.title = newTitle;
  if (state.user && !isLocalId(id)) {
    try { await fetch(`/api/conversations/${id}`, { method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle }) }); } catch {}
  }
  renderChatList(); renameModal.classList.add('hidden'); toast('Chat renamed', 'success');
});

function newChatSilent() {
  state.activeChatId = null; state.messages = []; state.attachments = [];
  renderFilePreviews(); renderWelcome(); updateSendButton();
}

// ============ NEW CHAT ============
newChatBtn.addEventListener('click', () => {
  if (state.isGenerating) return;
  if (state.activeChatId) {
    const chat = state.chats.find(c => c.id === state.activeChatId);
    if (chat && (!chat.messages || !chat.messages.length) && !state.messages.length) {
      inputEl.focus(); closeSidebar(); return;
    }
  }
  createNewChat();
});

function createNewChat() {
  const chat = { id: makeLocalId(), title: 'New chat', messages: [], pinned: false, createdAt: nowISO(), updatedAt: nowISO() };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  state.messages = []; state.attachments = []; state.editingMessageId = null;
  state._chatMultiSelectMode = false;
  state._selectedChats.clear();
  renderFilePreviews(); renderWelcome(); renderChatList(); updateSendButton();
  inputEl.focus(); closeSidebar();
}

// ============ WELCOME ============
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
  autoGrow(); updateSendButton(); formEl.requestSubmit();
});

// ============ SEND/STOP ============
function updateSendButton() {
  const hasText = inputEl.value.trim().length > 0;
  const hasFiles = state.attachments.length > 0;
  const iconSend = sendBtn.querySelector('.icon-send');
  const iconStop = sendBtn.querySelector('.icon-stop');
  if (state.isGenerating) {
    iconSend.classList.add('hidden'); iconStop.classList.remove('hidden');
    sendBtn.classList.add('generating'); sendBtn.disabled = false;
  } else {
    iconSend.classList.remove('hidden'); iconStop.classList.add('hidden');
    sendBtn.classList.remove('generating'); sendBtn.disabled = !(hasText || hasFiles);
  }
}
sendBtn.addEventListener('click', () => {
  if (state.isGenerating) stopGeneration();
  else if (!sendBtn.disabled) formEl.requestSubmit();
});
function stopGeneration() {
  if (state.abortController) { state.abortController.abort(); state.abortController = null; }
  state.isGenerating = false; inputEl.disabled = false; updateSendButton();
}

// ============ COMPOSER ============
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

inputEl.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const named = new File([file], file.name || `pasted-${Date.now()}.${ext}`, { type: file.type });
        addAttachment(named).then(ok => { if (ok) { toast('Image pasted', 'success', 2000); renderFilePreviews(); updateSendButton(); } });
      }
    }
  }
});

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  for (const f of e.target.files) await addAttachment(f);
  fileInput.value = '';
  renderFilePreviews(); updateSendButton();
});

async function addAttachment(file) {
  for (const existing of state.attachments) {
    if (existing.originalName === file.name && existing.originalSize === file.size && existing.originalLastModified === file.lastModified) {
      toast(`"${file.name}" is already attached`, 'info', 2000);
      return false;
    }
  }
  let processedFile = file;
  if (file.type.startsWith('image/') && file.size > 200 * 1024) {
    try { processedFile = await compressImage(file); } catch { processedFile = file; }
  }
  const id = Math.random().toString(36).slice(2);
  state.attachments.push({
    id, file: processedFile,
    url: URL.createObjectURL(processedFile),
    name: processedFile.name, type: processedFile.type,
    originalName: file.name, originalSize: file.size, originalLastModified: file.lastModified
  });
  return true;
}

function renderFilePreviews() {
  if (!state.attachments.length) { filePreviews.hidden = true; filePreviews.innerHTML = ''; return; }
  filePreviews.hidden = false;
  filePreviews.innerHTML = state.attachments.map(f => {
    const isImg = f.type.startsWith('image/');
    return `<div class="file-chip" data-id="${f.id}" title="${escapeHtml(f.name)}">
      ${isImg ? `<img src="${f.url}" class="file-thumb" data-preview-id="${f.id}" />` : `<div class="file-icon" data-preview-id="${f.id}"><i data-lucide="file-text"></i></div>`}
      <button type="button" class="file-remove" data-remove="${f.id}" aria-label="Remove"><i data-lucide="x"></i></button>
    </div>`;
  }).join('');
  refreshIcons();
}
filePreviews.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) {
    e.stopPropagation();
    const id = removeBtn.dataset.remove;
    const i = state.attachments.findIndex(x => x.id === id);
    if (i >= 0) { URL.revokeObjectURL(state.attachments[i].url); state.attachments.splice(i, 1); }
    renderFilePreviews(); updateSendButton();
    return;
  }
  const previewEl = e.target.closest('[data-preview-id]');
  if (previewEl) {
    const att = state.attachments.find(x => x.id === previewEl.dataset.previewId);
    if (att) showFileView(att.url, att.name, att.type);
  }
});

// ============ FILE VIEW MODAL ============
function showFileView(url, name, type) {
  if (!url) return;
  const isImg = (type || '').startsWith('image/');
  const isPdf = type === 'application/pdf';
  fileViewBody.innerHTML = `
    <div class="file-view-header">
      <span class="file-view-name">${escapeHtml(name || 'file')}</span>
      <a href="${url}" target="_blank" rel="noopener noreferrer" class="btn-secondary" style="padding:0.4rem 0.8rem;font-size:0.8rem;">Open in new tab <i data-lucide="external-link"></i></a>
    </div>
    <div class="file-view-content">
      ${isImg ? `<img src="${url}" alt="${escapeHtml(name)}" class="file-view-img" />`
        : isPdf ? `<iframe src="${url}" class="file-view-pdf" title="${escapeHtml(name)}"></iframe>`
        : `<div class="file-view-other"><i data-lucide="file-text"></i><p>Preview not available for this file type.</p><a href="${url}" target="_blank" rel="noopener noreferrer" class="btn-primary" style="width:auto;padding:0.6rem 1.2rem;">Open file</a></div>`}
    </div>`;
  fileViewModal.classList.remove('hidden');
  refreshIcons();
}
fileViewModalClose.addEventListener('click', () => fileViewModal.classList.add('hidden'));
fileViewModal.addEventListener('click', (e) => { if (e.target === fileViewModal) fileViewModal.classList.add('hidden'); });

// ============ MESSAGES ============
function renderMessages() {
  if (!state.messages.length) { renderWelcome(); return; }
  chatEl.innerHTML = '';
  state.messages.forEach((m, i) => {
    if (m.role === 'user') chatEl.appendChild(buildUserMessage(m, i));
    else chatEl.appendChild(buildAssistantMessage(m, i));
  });
  scrollBottom(); refreshIcons();
}

function renderFilesInline(files) {
  if (!files || !files.length) return '';
  const normal = files.filter(f => !f.generated);
  const generated = files.filter(f => f.generated);
  let html = '';
  if (normal.length) {
    html += `<div class="msg-files">${normal.map(f => {
      const isImg = (f.type || '').startsWith('image/');
      const url = f.url || f.dataUrl || f.public_url || '';
      if (!url) return '';
      const inner = isImg
        ? `<img src="${url}" class="msg-file-thumb" loading="lazy" alt="attachment" />`
        : `<div class="msg-file-doc"><i data-lucide="file-text"></i></div>`;
      return `<button class="msg-file-btn" data-msg-file='${escapeHtml(JSON.stringify({url, name: f.name, type: f.type}))}'>${inner}</button>`;
    }).join('')}</div>`;
  }
  if (generated.length) {
    html += generated.map(f => {
      const caption = (f.name || '').replace(/\.jpg$/i, '').replace(/_/g, ' ');
      return `<div class="generated-image-wrap" style="margin-top:0.75rem;max-width:min(100%,560px);">
        <img src="${f.url}" loading="lazy" alt="${escapeHtml(caption || 'Generated image')}"
          style="width:100%;height:auto;border-radius:12px;border:1px solid var(--border);background:var(--surface-2);display:block;" />
        <div style="text-align:center;font-size:0.78rem;color:var(--text-dim);padding:8px 0;line-height:1.4;">${escapeHtml(caption)}</div>
      </div>`;
    }).join('');
  }
  return html;
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
          <button class="btn-primary" id="editSend" style="width:auto;padding:0.55rem 1rem;margin:0;"><i data-lucide="send"></i>Send</button>
        </div>
      </div>`;
    return wrap;
  }
  const v = state.messageVersions[m.id];
  const switcher = v && v.versions.length > 1 ? `
    <div class="version-switcher">
      <button class="vs-btn" data-vs="prev" ${v.currentIndex === 0 ? 'disabled' : ''} aria-label="Previous"><i data-lucide="chevron-left"></i></button>
      <span class="vs-label">${v.currentIndex + 1} / ${v.versions.length}</span>
      <button class="vs-btn" data-vs="next" ${v.currentIndex === v.versions.length - 1 ? 'disabled' : ''} aria-label="Next"><i data-lucide="chevron-right"></i></button>
    </div>` : '';
  wrap.innerHTML = `
    ${renderFilesInline(m.files)}
    <div class="bubble">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
    <div class="msg-actions msg-actions-user">
      <button class="msg-action" data-action="copy" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
      <button class="msg-action" data-action="edit" title="Edit" aria-label="Edit"><i data-lucide="pencil"></i></button>
    </div>
    ${switcher}`;
  return wrap;
}

function buildAssistantMessage(m, i) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.dataset.index = i;
  wrap.dataset.id = m.id || '';
  const content = m.content || '';
  wrap.innerHTML = `
    <div class="avatar"><img src="/av.png" alt="DeepRWA" /></div>
    <div class="assistant-body">
      <div class="assistant-name">DeepRWA</div>
      <div class="assistant-text">${content ? renderMarkdown(content) : ''}</div>
      ${renderFilesInline(m.files)}
      ${!content ? `<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-label">Initializing…</span></div>` : ''}
      <div class="msg-actions msg-actions-assistant ${content ? '' : 'hidden'}">
        <button class="msg-action" data-action="copy" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
        <button class="msg-action" data-action="like" title="Like" aria-label="Like"><i data-lucide="thumbs-up"></i></button>
        <button class="msg-action" data-action="dislike" title="Dislike" aria-label="Dislike"><i data-lucide="thumbs-down"></i></button>
        <button class="msg-action" data-action="share" title="Share" aria-label="Share"><i data-lucide="share-2"></i></button>
        <button class="msg-action" data-action="speak" title="Read aloud" aria-label="Read aloud"><i data-lucide="volume-2"></i></button>
      </div>
    </div>`;
  return wrap;
}

// ============ MESSAGE ACTIONS ============
chatEl.addEventListener('click', async (e) => {
  const fileBtn = e.target.closest('[data-msg-file]');
  if (fileBtn) {
    try { const d = JSON.parse(fileBtn.dataset.msgFile); showFileView(d.url, d.name, d.type); } catch {}
    return;
  }
  const vs = e.target.closest('[data-vs]');
  if (vs) { const wrap = vs.closest('.msg-user'); applyVersionChange(wrap.dataset.id, vs.dataset.vs); return; }
  if (e.target.closest('#editCancel')) { state.editingMessageId = null; state.editingValue = ''; renderMessages(); return; }
  if (e.target.closest('#editSend')) { const ta = document.getElementById('editTextarea'); if (ta) await saveEditAndSend(ta.value); return; }
  const action = e.target.closest('.msg-action'); if (!action) return;
  const msgEl = action.closest('.msg');
  const idx = parseInt(msgEl.dataset.index);
  const act = action.dataset.action;
  if (act === 'copy') {
    const text = state.messages[idx]?.content || '';
    try { await navigator.clipboard.writeText(text); } catch {}
    action.classList.add('copied'); toast('Copied to clipboard', 'success', 2000);
    setTimeout(() => action.classList.remove('copied'), 1500);
  } else if (act === 'like') {
    action.classList.toggle('active');
    action.closest('.msg-actions').querySelector('[data-action="dislike"]')?.classList.remove('active');
  } else if (act === 'dislike') {
    action.classList.toggle('active');
    action.closest('.msg-actions').querySelector('[data-action="like"]')?.classList.remove('active');
  } else if (act === 'edit') {
    if (state.isGenerating) { toast('Please wait for the current response to finish, or stop it first', 'info'); return; }
    const m = state.messages[idx];
    state.editingMessageId = m.id; state.editingValue = m.content; renderMessages();
    setTimeout(() => { const ta = document.getElementById('editTextarea'); if (ta) { ta.focus(); ta.style.height = ta.scrollHeight + 'px'; } }, 0);
  } else if (act === 'share') {
    await shareSingleMessage(idx);
  } else if (act === 'speak') {
    const m = state.messages[idx];
    if (m && m.content) speakMessage(m.content, action);
  }
});
chatEl.addEventListener('input', (e) => {
  if (e.target.id === 'editTextarea') {
    state.editingValue = e.target.value;
    e.target.style.height = '0px';
    e.target.style.height = e.target.scrollHeight + 'px';
  }
});

// ============ HELPERS ============
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function uploadAttachmentsSnapshot(attachments) {
  if (!state.user || !attachments.length) return null;
  const uploaded = [];
  for (const att of attachments) {
    try {
      if (att.file.size > 10 * 1024 * 1024) { toast(`${att.name} is over 10 MB — kept locally`, 'error'); uploaded.push({ name: att.name, type: att.type, url: att.url }); continue; }
      const base64 = await fileToBase64(att.file);
      const res = await fetch('/api/upload', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: att.name, type: att.type, data: base64 }) });
      if (res.ok) { const d = await res.json(); uploaded.push({ name: d.name, type: d.type, url: d.url }); }
      else { uploaded.push({ name: att.name, type: att.type, url: att.url }); }
    } catch { uploaded.push({ name: att.name, type: att.type, url: att.url }); }
  }
  return uploaded;
}
async function attachmentsToDataUrlsSnapshot(attachments) {
  const out = [];
  for (const att of attachments) {
    try {
      if (att.file.size > 5 * 1024 * 1024) { out.push({ name: att.name, type: att.type, dataUrl: att.url }); continue; }
      const dataUrl = await fileToDataURL(att.file);
      out.push({ name: att.name, type: att.type, dataUrl });
    } catch {}
  }
  return out;
}
async function collectAttachmentsForAISnapshot(attachments) {
  const out = [];
  for (const a of attachments) {
    try {
      if (a.type.startsWith('image/') && a.file.size < 4 * 1024 * 1024) out.push({ name: a.name, mime: a.type, data: await fileToBase64(a.file) });
      else if (a.type === 'application/pdf' && a.file.size < 6 * 1024 * 1024) out.push({ name: a.name, mime: 'application/pdf', data: await fileToBase64(a.file) });
      else if (a.type === 'text/plain' || a.type === 'text/markdown' || a.type === 'text/csv' || a.type === 'application/json') {
        const text = await a.file.text();
        out.push({ name: a.name, mime: 'text/plain', data: btoa(unescape(encodeURIComponent(text.slice(0, 30000)))) });
      }
    } catch {}
  }
  return out;
}
async function requestTitle(text) {
  try {
    const res = await fetch('/api/chat/title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
    if (!res.ok) return null;
    return (await res.json()).title || null;
  } catch { return null; }
}

// ============ SEND MESSAGE ============
formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.isGenerating) return;
  const text = inputEl.value.trim();
  if (!text && !state.attachments.length) return;

  stopVoiceInput();
  state.isGenerating = true;
  inputEl.disabled = true;
  updateSendButton();

  try {
    let chat = state.chats.find(c => c.id === state.activeChatId);
    let isNewChat = false;
    if (!chat) {
      chat = { id: makeLocalId(), title: 'New chat', messages: [], pinned: false, createdAt: nowISO(), updatedAt: nowISO() };
      state.chats.unshift(chat); state.activeChatId = chat.id; isNewChat = true; renderChatList();
    }
    const isFirstMessage = isNewChat || chat.title === 'New chat' || !chat.messages.length;

    const attachmentsSnapshot = [...state.attachments];
    const localFiles = attachmentsSnapshot.map(f => ({ name: f.name, type: f.type, url: f.url }));

    inputEl.value = ''; autoGrow();
    state.attachments = []; renderFilePreviews();
    chatEl.querySelector('.welcome')?.remove();

    const userMsg = { id: 'user_' + Date.now(), role: 'user', content: text, files: localFiles, _createdAt: nowISO() };
    state.messages.push(userMsg); chat.messages = state.messages;

    const assistantMsg = { id: 'asst_' + Date.now(), role: 'assistant', content: '', files: [], _createdAt: nowISO() };
    state.messages.push(assistantMsg);
    renderMessages();

    if (isFirstMessage && text) {
      requestTitle(text).then(title => {
        if (!title) return;
        const c = state.chats.find(x => x.id === chat.id) || chat;
        c.title = title;
        renderChatList();
      }).catch(() => {});
    }

    const attachmentsForAI = await collectAttachmentsForAISnapshot(attachmentsSnapshot);
    let filesForMsg;
    if (state.user) filesForMsg = await uploadAttachmentsSnapshot(attachmentsSnapshot) || [];
    else filesForMsg = await attachmentsToDataUrlsSnapshot(attachmentsSnapshot);

    userMsg.files = filesForMsg;
    renderMessages();

    state.abortController = new AbortController();

    const endpoint = state.user ? '/api/chat' : '/api/chat/guest';
    const payload = {
      messages: state.messages.map(m => {
        const out = { role: m.role, content: m.content };
        if (m.role === 'user' && Array.isArray(m.files) && m.files.length) out.files = m.files;
        return out;
      }),
      attachments: attachmentsForAI
    };
    if (state.user) payload.conversationId = isLocalId(chat.id) ? null : chat.id;

    let res;
    try { res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload), signal: state.abortController.signal }); }
    catch (fetchErr) { throw new Error('NETWORK: ' + fetchErr.message); }
    if (!res.ok || !res.body) throw new Error('Bad response: ' + res.status);

    const serverConvId = res.headers.get('X-Conversation-Id');
    if (serverConvId && isLocalId(chat.id)) { chat.id = serverConvId; state.activeChatId = serverConvId; renderChatList(); }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', firstChunk = true, fullText = '';
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
            if (firstChunk) { firstChunk = false; chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .thinking`)?.remove(); }
            fullText += j.text; assistantMsg.content = fullText;
            const el = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .assistant-text`);
            if (el) el.innerHTML = renderMarkdown(fullText);
            scrollBottom();
          }
          if (j.image) {
            if (!assistantMsg.files) assistantMsg.files = [];
            assistantMsg.files.push({ url: j.image, type: 'image/jpeg', name: (j.prompt || 'image') + '.jpg', generated: true });
            const body = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .assistant-body`);
            if (body && !body.querySelector('.generated-image-wrap')) {
              const wrap = document.createElement('div');
              wrap.className = 'generated-image-wrap';
              wrap.style.cssText = 'margin-top:0.75rem;max-width:min(100%,560px);';
              wrap.innerHTML = `<img src="${j.image}" loading="lazy" alt="${escapeHtml(j.prompt || 'Generated image')}" style="width:100%;height:auto;border-radius:12px;border:1px solid var(--border);background:var(--surface-2);min-height:220px;display:block;" /><div class="gen-cap" style="text-align:center;font-size:0.78rem;color:var(--text-dim);padding:8px 0;line-height:1.4;">Generating image…</div>`;
              const img = wrap.querySelector('img');
              const cap = wrap.querySelector('.gen-cap');
              img.onload = () => { cap.textContent = j.prompt || ''; scrollBottom(); };
              img.onerror = () => { cap.textContent = 'Image could not be generated. Please try again.'; };
              body.appendChild(wrap);
              scrollBottom();
            }
          }
        } catch {}
      }
    }

    if (fullText || (assistantMsg.files && assistantMsg.files.length)) {
      if (fullText) assistantMsg.content = fullText;
      const actEl = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .msg-actions-assistant`);
      if (actEl) actEl.classList.remove('hidden');
      if (state.user) await loadConversations();
      if (state.view === 'files') renderFilesList();
      setTimeout(() => { if (state.view === 'files') renderFilesList(); }, 800);
    } else { assistantMsg.content = 'No response received.'; renderMessages(); }
  } catch (err) {
    if (err.name === 'AbortError') {
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant') { last.content = last.content ? last.content + '\n\n*[stopped]*' : '*Stopped.*'; }
      renderMessages();
    } else {
      console.error(err);
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant') last.content = err.message.startsWith('NETWORK:') ? 'Could not reach the server. Please check your connection and try again.' : 'Something went wrong. Please try again.';
      renderMessages();
    }
  } finally {
    state.isGenerating = false; inputEl.disabled = false; state.abortController = null; updateSendButton(); inputEl.focus();
  }
});

// ============ EDIT & VERSIONS ============
async function saveEditAndSend(newText) {
  const trimmed = newText.trim();
  if (!trimmed) return;
  if (state.isGenerating) {
    if (state.abortController) { try { state.abortController.abort(); } catch {} }
    state.abortController = null; state.isGenerating = false;
  }
  const editId = state.editingMessageId;
  const editIdx = state.messages.findIndex(m => m.id === editId);
  if (editIdx < 0) return;
  const userMsg = state.messages[editIdx];
  const nextMsg = state.messages[editIdx + 1];
  const isAsst = nextMsg && nextMsg.role === 'assistant';
  if (!state.messageVersions[editId]) {
    state.messageVersions[editId] = { versions: [userMsg.content], files: [userMsg.files || []], aiReplies: [isAsst ? nextMsg.content : ''], aiFiles: [isAsst ? (nextMsg.files || []) : []], currentIndex: 0 };
  }
  const v = state.messageVersions[editId];
  if (v.versions[v.versions.length - 1] !== trimmed) {
    v.versions.push(trimmed); v.files.push(userMsg.files || []); v.aiReplies.push(''); v.aiFiles.push([]);
  }
  v.currentIndex = v.versions.length - 1;
  userMsg.content = trimmed; userMsg.files = v.files[v.currentIndex];
  state.messages = state.messages.slice(0, editIdx + 1);
  const chat = state.chats.find(c => c.id === state.activeChatId);
  if (chat) chat.messages = state.messages;
  state.editingMessageId = null; state.editingValue = '';
  const assistantMsg = { id: 'asst_' + Date.now(), role: 'assistant', content: '', files: [], _createdAt: nowISO() };
  state.messages.push(assistantMsg);
  renderMessages();
  state.isGenerating = true; inputEl.disabled = true; updateSendButton();
  state.abortController = new AbortController();
  let fullText = '';
  try {
    const endpoint = state.user ? '/api/chat' : '/api/chat/guest';
    const payload = {
      messages: state.messages
        .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
        .map(m => {
          const out = { role: m.role, content: m.content };
          if (m.role === 'user' && Array.isArray(m.files) && m.files.length) out.files = m.files;
          return out;
        })
    };
    if (state.user && chat && !isLocalId(chat.id)) payload.conversationId = chat.id;
    let res;
    try { res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload), signal: state.abortController.signal }); }
    catch (fetchErr) { throw new Error('NETWORK: ' + fetchErr.message); }
    if (!res.ok || !res.body) throw new Error('Bad response');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', firstChunk = true;
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
            if (firstChunk) { firstChunk = false; chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .thinking`)?.remove(); }
            fullText += j.text; assistantMsg.content = fullText;
            const el = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .assistant-text`);
            if (el) el.innerHTML = renderMarkdown(fullText);
            scrollBottom();
          }
          if (j.image) {
            if (!assistantMsg.files) assistantMsg.files = [];
            assistantMsg.files.push({ url: j.image, type: 'image/jpeg', name: (j.prompt || 'image') + '.jpg', generated: true });
            const body = chatEl.querySelector(`.msg-assistant[data-id="${assistantMsg.id}"] .assistant-body`);
            if (body && !body.querySelector('.generated-image-wrap')) {
              const wrap = document.createElement('div');
              wrap.className = 'generated-image-wrap';
              wrap.style.cssText = 'margin-top:0.75rem;max-width:min(100%,560px);';
              wrap.innerHTML = `<img src="${j.image}" loading="lazy" alt="${escapeHtml(j.prompt || 'Generated image')}" style="width:100%;height:auto;border-radius:12px;border:1px solid var(--border);background:var(--surface-2);min-height:220px;display:block;" /><div class="gen-cap" style="text-align:center;font-size:0.78rem;color:var(--text-dim);padding:8px 0;line-height:1.4;">Generating image…</div>`;
              const img = wrap.querySelector('img');
              const cap = wrap.querySelector('.gen-cap');
              img.onload = () => { cap.textContent = j.prompt || ''; scrollBottom(); };
              img.onerror = () => { cap.textContent = 'Image could not be generated. Please try again.'; };
              body.appendChild(wrap);
              scrollBottom();
            }
          }
        } catch {}
      }
    }
    v.aiReplies[v.currentIndex] = fullText;
    v.aiFiles[v.currentIndex] = assistantMsg.files || [];
    renderMessages();
    if (state.user && chat && !isLocalId(chat.id) && userMsg.id && !userMsg.id.startsWith('user_')) {
      try {
        await fetch(`/api/chat/messages/${userMsg.id}/sync-versions`, {
          method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ userMessageContent: userMsg.content, userMessageFiles: userMsg.files || [], versions: v.versions, versionFiles: v.files, aiReplies: v.aiReplies, aiFiles: v.aiFiles, currentVersionIndex: v.currentIndex, assistantContent: fullText, assistantFiles: assistantMsg.files || [] })
        });
      } catch (e) { console.warn('sync versions failed', e); }
    }
  } catch (err) {
    if (err.name === 'AbortError') v.aiReplies[v.currentIndex] = fullText || '*Stopped.*';
    else { console.error(err); v.aiReplies[v.currentIndex] = err.message.startsWith('NETWORK:') ? 'Could not reach the server. Please check your connection.' : 'Something went wrong.'; }
    renderMessages();
  } finally {
    state.isGenerating = false; inputEl.disabled = false; state.abortController = null; updateSendButton();
  }
}

function applyVersionChange(msgId, dir) {
  const v = state.messageVersions[msgId]; if (!v) return;
  const newIdx = dir === 'prev' ? Math.max(0, v.currentIndex - 1) : Math.min(v.versions.length - 1, v.currentIndex + 1);
  if (newIdx === v.currentIndex) return;
  v.currentIndex = newIdx;
  const msgIdx = state.messages.findIndex(m => m.id === msgId);
  if (msgIdx < 0) return;
  state.messages[msgIdx].content = v.versions[newIdx];
  state.messages[msgIdx].files = v.files[newIdx];
  const next = state.messages[msgIdx + 1];
  if (next && next.role === 'assistant') { next.content = v.aiReplies[newIdx] || ''; next.files = v.aiFiles[newIdx] || []; }
  renderMessages();
}

// ============ LOAD CONVERSATIONS ============
async function loadConversations() {
  if (!state.user) return;
  try {
    const res = await fetch('/api/conversations', { headers: authHeaders() });
    const data = await res.json();
    const serverChats = (data.conversations || []).map(c => ({ id: c.id, title: c.title, pinned: c.pinned, messages: [], createdAt: c.created_at, updatedAt: c.updated_at }));
    state.chats = serverChats;
    renderChatList();
  } catch {}
}

async function selectChat(id) {
  if (state.isGenerating) return;
  const chat = state.chats.find(c => c.id === id); if (!chat) return;
  stopSpeaking();
  state.activeChatId = id; state.editingMessageId = null; state.editingValue = '';
  state.attachments = []; renderFilePreviews();
  if (state.user && !isLocalId(id)) {
    try {
      const res = await fetch(`/api/conversations/${id}/messages`, { headers: authHeaders() });
      const data = await res.json();
      state.messages = (data.messages || []).map(m => ({ id: m.id, role: m.role, content: m.content, files: m.files || [], _createdAt: m.created_at }));
      state.messageVersions = {};
      (data.messages || []).forEach(m => {
        if (m.role === 'user' && m.versions && m.versions.length > 0) {
          state.messageVersions[m.id] = { versions: m.versions, files: m.version_files || [], aiReplies: m.ai_replies || [], aiFiles: m.ai_files || [], currentIndex: m.current_version_index || 0 };
        }
      });
    } catch { state.messages = []; }
  } else {
    state.messages = chat.messages || [];
  }
  chat.messages = state.messages;
  if (state.messages.length) renderMessages(); else renderWelcome();
  renderChatList(); closeSidebar();
}

// ============ AUTH MODAL ============
function openAuthModal(mode) {
  authModal.classList.remove('hidden');
  authModal.dataset.mode = mode;
  if (mode === 'login') renderLoginForm();
  else if (mode === 'signup') renderSignupForm();
}

authModalClose.addEventListener('click', () => {
  authModal.classList.add('hidden');
  clearAuthModalState();
});
authModal.addEventListener('click', (e) => {
  if (e.target === authModal) {
    authModal.classList.add('hidden');
    clearAuthModalState();
  }
});

function renderLoginForm() {
  saveAuthModalState({ form: 'login' });
  authModalBody.innerHTML = `
    <h3>Log in to DeepRWA</h3>
    <p class="modal-sub">Save your chats and access them anywhere.</p>
    <input type="email" id="authEmail" placeholder="Email" class="modal-input" autocomplete="email" />
    ${passwordFieldHTML('authPassword', 'Password')}
    <button class="btn-primary" id="authSubmit">Log in</button>
    <button class="link-btn" id="forgotLink">Forgot password?</button>
    <p class="modal-switch">Don't have an account? <a id="switchSignup">Sign up</a></p>`;
  refreshIcons(); attachPasswordToggles(authModalBody);
  $('switchSignup').onclick = (e) => { e.preventDefault(); renderSignupForm(); };
  $('forgotLink').onclick = (e) => { e.preventDefault(); renderForgotStep1(); };
  $('authSubmit').onclick = async () => {
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!email || !password) { toast('Enter email and password', 'error'); return; }
    const btn = $('authSubmit'); setBtnLoading(btn, 'Logging in…');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: JSON.stringify({ email, password }) });
      const data = await res.json();
      if (!res.ok) { resetBtn(btn); toast(data.error || 'Login failed', 'error'); return; }
      state.authModal.pendingToken = data.pendingToken;
      renderVerifyCodeForm('login');
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

function renderSignupForm() {
  saveAuthModalState({ form: 'signup' });
  authModalBody.innerHTML = `
    <h3>Create your DeepRWA account</h3>
    <p class="modal-sub">Save chats, access from any device.</p>
    <input type="email" id="authEmail" placeholder="Email" class="modal-input" autocomplete="email" />
    <input type="text" id="authName" placeholder="Full name (optional)" class="modal-input" autocomplete="name" />
    ${passwordFieldHTML('authPassword', 'Password (min 8, letters + numbers)', 'new-password')}
    ${passwordFieldHTML('authConfirm', 'Confirm password', 'new-password')}
    <button class="btn-primary" id="authSubmit">Create account</button>
    <p class="modal-switch">Already have an account? <a id="switchLogin">Log in</a></p>`;
  refreshIcons(); attachPasswordToggles(authModalBody);
  $('switchLogin').onclick = (e) => { e.preventDefault(); renderLoginForm(); };
  $('authSubmit').onclick = async () => {
    const email = $('authEmail').value.trim();
    const fullName = $('authName').value.trim();
    const password = $('authPassword').value;
    const confirm = $('authConfirm').value;
    if (!email || !password) { toast('Fill all required fields', 'error'); return; }
    if (password !== confirm) { toast('Passwords do not match', 'error'); return; }
    if (password.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }
    const btn = $('authSubmit'); setBtnLoading(btn, 'Sending code…');
    try {
      const res = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: JSON.stringify({ email, password, fullName }) });
      const data = await res.json();
      if (!res.ok) { resetBtn(btn); toast(data.error || 'Signup failed', 'error'); return; }
      state.authModal.pendingToken = data.pendingToken;
      renderVerifyCodeForm('signup');
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

function renderVerifyCodeForm(type) {
  saveAuthModalState({ form: 'verify', type, pendingToken: state.authModal.pendingToken });
  authModalBody.innerHTML = `
    <h3>${type === 'signup' ? 'Verify your email' : 'Enter login code'}</h3>
    <p class="modal-sub">We sent a 6-digit code to your email.</p>
    <input type="text" id="verifyCode" placeholder="000000" maxlength="6" class="modal-input code-input" inputmode="numeric" autocomplete="one-time-code" />
    <button class="btn-primary" id="verifySubmit">Verify</button>
    <button class="link-btn" id="resendBtn">Resend code</button>`;
  refreshIcons();
  const codeInput = $('verifyCode'); codeInput.focus();
  const resendBtn = $('resendBtn'); attachCountdown(resendBtn, 60);
  resendBtn.onclick = async () => {
    if (resendBtn.disabled) return;
    const endpoint = type === 'signup' ? '/api/auth/resend-verification' : '/api/auth/resend-login-code';
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: JSON.stringify({ pendingToken: state.authModal.pendingToken }) });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Could not resend', 'error'); return; }
      state.authModal.pendingToken = data.pendingToken;
      saveAuthModalState({ form: 'verify', type, pendingToken: state.authModal.pendingToken });
      attachCountdown(resendBtn, 60); toast('Code resent', 'success');
    } catch { toast('Network error', 'error'); }
  };
  $('verifySubmit').onclick = async () => {
    const code = codeInput.value.trim();
    if (code.length !== 6) { toast('Enter the 6-digit code', 'error'); return; }
    const btn = $('verifySubmit'); setBtnLoading(btn, 'Verifying…');
    const endpoint = type === 'signup' ? '/api/auth/confirm-signup' : '/api/auth/verify-login';
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: JSON.stringify({ pendingToken: state.authModal.pendingToken, code }) });
      const data = await res.json();
      if (!res.ok) { resetBtn(btn); toast(data.error || 'Invalid code', 'error'); return; }
      if (data.requires2fa) { render2FALoginForm(data.twofaToken); return; }
      await handleLoginSuccess(data);
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

async function handleLoginSuccess(data) {
  state.chats = []; state.activeChatId = null; state.messages = []; state.attachments = [];
  state._selectedFiles.clear(); state._multiSelectMode = false;
  state._selectedChats.clear(); state._chatMultiSelectMode = false;
  state.messageVersions = {};
  state.token = data.accessToken;
  state.user = data.user;
  state._loginAt = Date.now();
  localStorage.setItem('deeprwa_token', data.accessToken);
  clearAuthModalState();
  authModal.classList.add('hidden');
  renderFilePreviews(); renderWelcome(); renderUser();
  await loadConversations();
  toast('Logged in', 'success');
}

function render2FALoginForm(twofaToken) {
  saveAuthModalState({ form: '2fa', twofaToken });
  authModalBody.innerHTML = `
    <h3>Two-factor authentication</h3>
    <p class="modal-sub">Enter the 6-digit code from your authenticator app.</p>
    <input type="text" id="faCode" placeholder="000000" maxlength="6" class="modal-input code-input" inputmode="numeric" autocomplete="one-time-code" />
    <button class="btn-primary" id="faSubmit">Verify</button>`;
  refreshIcons(); $('faCode').focus();
  $('faSubmit').onclick = async () => {
    const code = $('faCode').value.trim();
    const btn = $('faSubmit'); setBtnLoading(btn, 'Verifying…');
    try {
      const res = await fetch('/api/auth/verify-2fa', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: JSON.stringify({ twofaToken, code }) });
      const data = await res.json();
      if (!res.ok) { resetBtn(btn); toast(data.error || 'Invalid code', 'error'); return; }
      await handleLoginSuccess(data);
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

// ============ FORGOT PASSWORD ============
function renderForgotStep1() {
  saveAuthModalState({ form: 'forgot-step1' });
  authModalBody.innerHTML = `
    <h3>Reset your password</h3>
    <p class="modal-sub">Enter the email registered to your account.</p>
    <input type="email" id="fpEmail" placeholder="Email" class="modal-input" autocomplete="email" />
    <button class="btn-primary" id="fpSubmit">Send code</button>
    <button class="link-btn" id="fpBack">Back to login</button>`;
  refreshIcons();
  $('fpBack').onclick = (e) => { e.preventDefault(); renderLoginForm(); };
  $('fpSubmit').onclick = async () => {
    const email = $('fpEmail').value.trim();
    if (!email) { toast('Enter your email', 'error'); return; }
    const btn = $('fpSubmit'); setBtnLoading(btn, 'Sending code…');
    try {
      const res = await fetch('/api/auth/forgot-password-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const data = await res.json();
      if (!res.ok) { resetBtn(btn); toast(data.error || 'Failed', 'error'); return; }
      state.authModal.forgot.email = email; state.authModal.forgot.pendingToken = data.pendingToken;
      renderForgotStep2();
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

function renderForgotStep2() {
  saveAuthModalState({ form: 'forgot-step2', email: state.authModal.forgot.email, pendingToken: state.authModal.forgot.pendingToken });
  authModalBody.innerHTML = `
    <h3>Enter verification code</h3>
    <p class="modal-sub">We sent a 6-digit code to ${escapeHtml(state.authModal.forgot.email)}</p>
    <input type="text" id="fpCode" placeholder="000000" maxlength="6" class="modal-input code-input" inputmode="numeric" autocomplete="one-time-code" />
    <button class="btn-primary" id="fpVerify">Verify code</button>
    <button class="link-btn" id="fpResend">Resend code</button>`;
  refreshIcons(); $('fpCode').focus();
  const resendBtn = $('fpResend'); attachCountdown(resendBtn, 60);
  resendBtn.onclick = async () => {
    if (resendBtn.disabled) return;
    try {
      const res = await fetch('/api/auth/resend-forgot-password-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingToken: state.authModal.forgot.pendingToken }) });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Failed', 'error'); return; }
      state.authModal.forgot.pendingToken = data.pendingToken;
      saveAuthModalState({ form: 'forgot-step2', email: state.authModal.forgot.email, pendingToken: state.authModal.forgot.pendingToken });
      attachCountdown(resendBtn, 60); toast('Code resent', 'success');
    } catch { toast('Network error', 'error'); }
  };
  $('fpVerify').onclick = async () => {
    const code = $('fpCode').value.trim();
    if (code.length !== 6) { toast('Enter the 6-digit code', 'error'); return; }
    const btn = $('fpVerify'); setBtnLoading(btn, 'Verifying code…');
    try {
      const res = await fetch('/api/auth/forgot-password-verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingToken: state.authModal.forgot.pendingToken, code }) });
      const data = await res.json();
      if (!res.ok) { resetBtn(btn); toast(data.error || 'Invalid code', 'error'); return; }
      state.authModal.forgot.grantedToken = data.grantedToken;
      renderForgotStep3();
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

function renderForgotStep3() {
  saveAuthModalState({ form: 'forgot-step3', grantedToken: state.authModal.forgot.grantedToken });
  authModalBody.innerHTML = `
    <h3>Set new password</h3>
    <p class="modal-sub">Choose a new password different from your current one.</p>
    ${passwordFieldHTML('fpNew', 'New password (min 8, letters + numbers)', 'new-password')}
    ${passwordFieldHTML('fpConfirm', 'Confirm new password', 'new-password')}
    <button class="btn-primary" id="fpReset">Reset password</button>`;
  refreshIcons(); attachPasswordToggles(authModalBody);
  $('fpReset').onclick = async () => {
    const newPassword = $('fpNew').value;
    const confirm = $('fpConfirm').value;
    if (newPassword.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }
    if (newPassword !== confirm) { toast('Passwords do not match', 'error'); return; }
    const btn = $('fpReset'); setBtnLoading(btn, 'Resetting password…');
    try {
      const res = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grantedToken: state.authModal.forgot.grantedToken, newPassword }) });
      const data = await res.json();
      if (!res.ok) { resetBtn(btn); toast(data.error || 'Failed', 'error'); return; }
      toast('Password reset. Log in with your new password.', 'success');
      renderLoginForm();
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

// ============ RESTORE AUTH MODAL STATE ============
function restoreAuthModalState() {
  const saved = loadAuthModalState();
  if (!saved || !saved.form) return;
  try {
    if (saved.form === 'login') { authModal.classList.remove('hidden'); authModal.dataset.mode = 'login'; renderLoginForm(); }
    else if (saved.form === 'signup') { authModal.classList.remove('hidden'); authModal.dataset.mode = 'signup'; renderSignupForm(); }
    else if (saved.form === 'verify') { state.authModal.pendingToken = saved.pendingToken; authModal.classList.remove('hidden'); authModal.dataset.mode = saved.type; renderVerifyCodeForm(saved.type); }
    else if (saved.form === '2fa') { authModal.classList.remove('hidden'); render2FALoginForm(saved.twofaToken); }
    else if (saved.form === 'forgot-step1') { authModal.classList.remove('hidden'); renderForgotStep1(); }
    else if (saved.form === 'forgot-step2') { state.authModal.forgot.email = saved.email; state.authModal.forgot.pendingToken = saved.pendingToken; authModal.classList.remove('hidden'); renderForgotStep2(); }
    else if (saved.form === 'forgot-step3') { state.authModal.forgot.grantedToken = saved.grantedToken; authModal.classList.remove('hidden'); renderForgotStep3(); }
    else if (saved.form === 'action-verify') {
      if (!state.user) { clearAuthModalState(); return; }
      state._pendingAction = saved.pendingAction;
      settingsModal.classList.remove('hidden');
      settingsSidebar.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'account'));
      renderActionVerify(saved.action, saved.targetEmail);
    } else clearAuthModalState();
  } catch (e) { console.warn('restoreAuthModalState failed:', e); clearAuthModalState(); }
}

// ============ PROFILE MODAL ============
function openProfileModal() {
  if (!state.user) return;
  const u = state.user;
  const initial = (u.email || 'U')[0].toUpperCase();
  profileModalBody.innerHTML = `
    <div class="profile-header">
      <div class="profile-avatar">${escapeHtml(initial)}</div>
      <h3>${escapeHtml(u.display_name || u.email || 'Your profile')}</h3>
      <p class="modal-sub">${escapeHtml(u.email || '')}</p>
    </div>
    <div class="settings-section"><h4>Member since</h4><p>${formatDate(u.created_at) || 'Recently'}</p></div>
    <div class="settings-divider"></div>
    <div class="settings-section"><h4>Two-factor authentication</h4>
      <p><span class="status-badge ${u.totp_enabled ? 'on' : 'off'}">${u.totp_enabled ? 'Enabled' : 'Disabled'}</span></p>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-section"><h4>Account ID</h4>
      <p style="font-family: ui-monospace, monospace; font-size: 0.75rem; word-break: break-all;">${escapeHtml(u.id || '')}</p>
    </div>`;
  profileModal.classList.remove('hidden');
  refreshIcons();
}
profileModalClose.addEventListener('click', () => profileModal.classList.add('hidden'));
profileModal.addEventListener('click', (e) => { if (e.target === profileModal) profileModal.classList.add('hidden'); });

// ============ SETTINGS MODAL ============
function openSettingsModal(tab = 'account') {
  if (!state.user) return;
  settingsModal.classList.remove('hidden');
  settingsSidebar.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  renderSettingsTab(tab);
}
settingsModalClose.addEventListener('click', () => { settingsModal.classList.add('hidden'); clearAuthModalState(); });
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) { settingsModal.classList.add('hidden'); clearAuthModalState(); } });
settingsSidebar.addEventListener('click', (e) => {
  const tab = e.target.closest('.settings-tab'); if (!tab) return;
  settingsSidebar.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  renderSettingsTab(tab.dataset.tab);
});
function renderSettingsTab(tab) {
  clearAuthModalState();
  if (tab === 'account') renderAccountTab();
  else if (tab === 'security') renderSecurityTab();
  else if (tab === 'sessions') renderSessionsTab();
  refreshIcons();
}

// ============ ACCOUNT TAB ============
function renderAccountTab() {
  settingsContent.innerHTML = `
    <h3>Account</h3>
    <p class="modal-sub">Manage your email, password, and account.</p>
    <div class="settings-section">
      <h4>Change email</h4>
      <p>Current: <strong>${escapeHtml(state.user.email || '')}</strong></p>
      <button class="btn-secondary" id="changeEmailBtn">Change email</button>
      <div id="changeEmailArea" class="hidden" style="margin-top:1rem;">
        <input type="email" id="newEmailInput" class="modal-input" placeholder="New email address" autocomplete="email" />
        <button class="btn-primary" id="sendEmailCodeBtn" style="width:auto;padding:0.55rem 1rem;">Send code</button>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-section">
      <h4>Change password</h4>
      <p>Update your account password.</p>
      <button class="btn-secondary" id="changePwBtn">Change password</button>
      <div id="changePwArea" class="hidden" style="margin-top:1rem;">
        ${passwordFieldHTML('currentPw', 'Current password')}
        ${passwordFieldHTML('newPw', 'New password (min 8, letters + numbers)', 'new-password')}
        ${passwordFieldHTML('confirmPw', 'Confirm new password', 'new-password')}
        <button class="btn-primary" id="sendPwCodeBtn" style="width:auto;padding:0.55rem 1rem;">Send code</button>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-section danger-zone">
      <h4>Danger zone</h4>
      <p>Permanently delete your account and all associated data. This action cannot be undone.</p>
      <button class="btn-danger" id="deleteAccBtn">Delete account</button>
    </div>`;
  refreshIcons(); attachPasswordToggles(settingsContent);

  $('changeEmailBtn').onclick = () => { $('changeEmailArea').classList.toggle('hidden'); if (!$('changeEmailArea').classList.contains('hidden')) $('newEmailInput').focus(); };

  $('sendEmailCodeBtn').onclick = async () => {
    const newEmail = $('newEmailInput')?.value.trim();
    const btn = $('sendEmailCodeBtn');
    if (!newEmail) { toast('Enter new email', 'error'); return; }
    setBtnLoading(btn, 'Verifying email…');
    await new Promise(r => setTimeout(r, 250));
    const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!EMAIL_RE.test(newEmail)) { resetBtn(btn); toast('Invalid email format', 'error'); return; }
    if (newEmail.toLowerCase() === (state.user.email || '').toLowerCase()) { resetBtn(btn); toast('New email must be different from your current one', 'error'); return; }
    setBtnLoading(btn, 'Sending code…');
    sendActionCode('change-email', { newEmail });
  };

  $('changePwBtn').onclick = () => { $('changePwArea').classList.toggle('hidden'); if (!$('changePwArea').classList.contains('hidden')) $('currentPw').focus(); };

  $('sendPwCodeBtn').onclick = async () => {
    const current = $('currentPw').value, newPw = $('newPw').value, confirm = $('confirmPw').value;
    const btn = $('sendPwCodeBtn');
    setBtnLoading(btn, 'Checking fields…');
    await new Promise(r => setTimeout(r, 200));
    if (!current || !newPw || !confirm) { resetBtn(btn); toast('Fill all password fields', 'error'); return; }
    if (newPw.length < 8) { resetBtn(btn); toast('Password must be at least 8 characters', 'error'); return; }
    if (newPw !== confirm) { resetBtn(btn); toast('Passwords do not match', 'error'); return; }
    if (current === newPw) { resetBtn(btn); toast('New password must be different', 'error'); return; }
    setBtnLoading(btn, 'Verifying current password…');
    try {
      const res = await fetch('/api/auth/verify-current-password', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ password: current }) });
      if (!res.ok) { resetBtn(btn); toast('Current password is incorrect', 'error'); return; }
      state._pendingPw = { current, newPw };
      setBtnLoading(btn, 'Sending code…');
      sendActionCode('change-password');
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };

  $('deleteAccBtn').onclick = () => confirmAction({
    title: 'Delete your account?',
    text: 'This will permanently delete your account, chats, and files.',
    confirmLabel: 'Delete account',
    onConfirm: () => {
      const btn = $('deleteAccBtn');
      if (btn) setBtnLoading(btn, 'Sending code…');
      sendActionCode('delete-account');
    }
  });
}

async function sendActionCode(action, extra = {}) {
  try {
    const res = await fetch('/api/auth/send-action-code', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Failed', 'error'); return; }
    state._pendingAction = { action, token: data.pendingToken, targetEmail: data.targetEmail };
    renderActionVerify(action, data.targetEmail);
  } catch { toast('Network error', 'error'); }
}

function renderActionVerify(action, targetEmail) {
  saveAuthModalState({ form: 'action-verify', action, targetEmail, pendingAction: state._pendingAction });
  const headline = action === 'change-email' ? 'Verify new email' : action === 'change-password' ? 'Verify password change' : 'Verify account deletion';
  const verifyLabel = action === 'change-email' ? 'Verify & change email' : action === 'change-password' ? 'Verify & change password' : 'Verify & delete';
  const workingLabel = action === 'change-email' ? 'Changing email…' : action === 'change-password' ? 'Changing password…' : 'Deleting account…';

  settingsContent.innerHTML = `
    <h3>${headline}</h3>
    <p class="modal-sub">We sent a 6-digit code to <strong>${escapeHtml(targetEmail || '')}</strong></p>
    <input type="text" id="actCode" placeholder="000000" maxlength="6" class="modal-input code-input" inputmode="numeric" autocomplete="one-time-code" />
    <button class="btn-primary" id="actVerify">${verifyLabel}</button>
    <button class="link-btn" id="actResend">Resend code</button>
    <button class="link-btn" id="actBack">Back</button>`;
  refreshIcons(); $('actCode').focus();

  const resendBtn = $('actResend'); attachCountdown(resendBtn, 60);
  resendBtn.onclick = async () => {
    if (resendBtn.disabled) return;
    try {
      const res = await fetch('/api/auth/resend-action-code', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingToken: state._pendingAction.token }) });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Failed', 'error'); return; }
      state._pendingAction.token = data.pendingToken;
      saveAuthModalState({ form: 'action-verify', action, targetEmail, pendingAction: state._pendingAction });
      attachCountdown(resendBtn, 60); toast('Code resent', 'success');
    } catch { toast('Network error', 'error'); }
  };

  $('actBack').onclick = () => renderSettingsTab('account');

  $('actVerify').onclick = async () => {
    const code = $('actCode').value.trim();
    if (code.length !== 6) { toast('Enter 6-digit code', 'error'); return; }
    const btn = $('actVerify');
    setBtnLoading(btn, 'Verifying code…');
    try {
      const vres = await fetch('/api/auth/verify-action-code', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingToken: state._pendingAction.token, code, action }) });
      const vdata = await vres.json();
      if (!vres.ok) { resetBtn(btn); toast(vdata.error || 'Invalid code', 'error'); return; }
      setBtnLoading(btn, workingLabel);
      if (action === 'change-email') {
        const r = await fetch('/api/auth/change-email', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ grantedToken: vdata.grantedToken }) });
        const d = await r.json();
        if (!r.ok) { resetBtn(btn); toast(d.error || 'Failed', 'error'); return; }
        state.user.email = d.newEmail;
        toast('Email changed to ' + d.newEmail, 'success');
        clearAuthModalState();
        renderUser(); renderAccountTab();
      } else if (action === 'change-password') {
        const pw = state._pendingPw || {};
        const r = await fetch('/api/auth/change-password', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ grantedToken: vdata.grantedToken, currentPassword: pw.current, newPassword: pw.newPw }) });
        const d = await r.json();
        if (!r.ok) { resetBtn(btn); toast(d.error || 'Failed', 'error'); return; }
        state._pendingPw = null;
        toast('Password changed', 'success');
        clearAuthModalState();
        renderAccountTab();
      } else if (action === 'delete-account') {
        const r = await fetch('/api/auth/account', { method: 'DELETE', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ grantedToken: vdata.grantedToken }) });
        const d = await r.json();
        if (!r.ok) { resetBtn(btn); toast(d.error || 'Failed', 'error'); return; }
        settingsModal.classList.add('hidden');
        await forceSignOut('Account deleted');
      }
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

// ============ SECURITY TAB ============
function renderSecurityTab() {
  const enabled = state.user.totp_enabled;
  settingsContent.innerHTML = `
    <h3>Security</h3>
    <p class="modal-sub">Two-factor authentication adds an extra layer of security.</p>
    <div class="settings-section">
      <h4>Authenticator app</h4>
      <p>Status: <span class="status-badge ${enabled ? 'on' : 'off'}">${enabled ? 'Enabled' : 'Disabled'}</span></p>
      ${enabled ? `<button class="btn-danger" id="disable2faBtn">Disable 2FA</button>` : `<button class="btn-primary" id="enable2faBtn" style="width:auto;padding:0.55rem 1rem;">Enable 2FA</button>`}
    </div>`;
  refreshIcons();
  if (enabled) $('disable2faBtn').onclick = () => disable2FA();
  else $('enable2faBtn').onclick = () => setup2FA();
}

async function setup2FA() {
  settingsContent.innerHTML = `<h3>Setting up 2FA…</h3><p class="modal-sub">Generating secure key.</p>`;
  try {
    const res = await fetch('/api/auth/2fa/setup', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Failed', 'error'); renderSecurityTab(); return; }
    settingsContent.innerHTML = `
      <h3>Enable 2FA</h3>
      <p class="modal-sub">Scan this QR code with your authenticator app.</p>
      <div class="qr-wrap"><img src="${data.qrDataUrl}" alt="QR code" /></div>
      <p style="font-size:0.83rem;color:var(--text-muted);margin-bottom:0.5rem;">Or enter this key manually:</p>
      <div class="secret-box"><code>${escapeHtml(data.secret)}</code><button class="btn-secondary" id="copySecret" style="padding:0.4rem 0.7rem;font-size:0.8rem;">Copy</button></div>
      <div style="margin-top:1rem;">
        <input type="text" id="faSetupCode" placeholder="Enter 6-digit code from app" maxlength="6" class="modal-input code-input" inputmode="numeric" autocomplete="one-time-code" />
        <button class="btn-primary" id="confirm2faBtn">Verify & enable</button>
      </div>
      <button class="link-btn" id="cancel2fa">Cancel</button>`;
    refreshIcons();
    $('copySecret').onclick = async () => { try { await navigator.clipboard.writeText(data.secret); toast('Secret copied', 'success', 2000); } catch {} };
    $('cancel2fa').onclick = () => renderSecurityTab();

    $('confirm2faBtn').onclick = async () => {
      const code = $('faSetupCode').value.trim();
      if (code.length !== 6) { toast('Enter the 6-digit code', 'error'); return; }
      const btn = $('confirm2faBtn');
      setBtnLoading(btn, 'Verifying code…');
      await new Promise(r => setTimeout(r, 200));
      setBtnLoading(btn, 'Enabling 2FA…');
      try {
        const r = await fetch('/api/auth/2fa/enable', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
        const d = await r.json();
        if (!r.ok) { resetBtn(btn); toast(d.error || 'Invalid code', 'error'); return; }
        state.user.totp_enabled = true;
        toast('2FA enabled', 'success');
        renderSecurityTab();
      } catch { resetBtn(btn); toast('Network error', 'error'); }
    };
  } catch { toast('Network error', 'error'); renderSecurityTab(); }
}

async function disable2FA() {
  settingsContent.innerHTML = `
    <h3>Disable 2FA</h3>
    <p class="modal-sub">Enter the 6-digit code from your authenticator app to confirm.</p>
    <input type="text" id="faDisableCode" placeholder="000000" maxlength="6" class="modal-input code-input" inputmode="numeric" autocomplete="one-time-code" />
    <button class="btn-danger" id="confirmDisableBtn">Disable 2FA</button>
    <button class="link-btn" id="cancelDisable">Cancel</button>`;
  refreshIcons();
  $('cancelDisable').onclick = () => renderSecurityTab();
  $('confirmDisableBtn').onclick = async () => {
    const code = $('faDisableCode').value.trim();
    if (code.length !== 6) { toast('Enter the 6-digit code', 'error'); return; }
    const btn = $('confirmDisableBtn');
    setBtnLoading(btn, 'Verifying code…');
    await new Promise(r => setTimeout(r, 200));
    setBtnLoading(btn, 'Disabling 2FA…');
    try {
      const r = await fetch('/api/auth/2fa/disable', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const d = await r.json();
      if (!r.ok) { resetBtn(btn); toast(d.error || 'Invalid code', 'error'); return; }
      state.user.totp_enabled = false;
      toast('2FA disabled', 'success');
      renderSecurityTab();
    } catch { resetBtn(btn); toast('Network error', 'error'); }
  };
}

// ============ SESSIONS TAB ============
async function renderSessionsTab() {
  settingsContent.innerHTML = `<h3>Sessions</h3><p class="modal-sub">Loading…</p>`;
  try {
    const res = await fetch('/api/auth/sessions', { headers: authHeaders() });
    const data = await res.json();
    const sessions = data.sessions || [];
    const current = sessions.find(s => s.current);
    const others = sessions.filter(s => !s.current);
    settingsContent.innerHTML = `
      <h3>Sessions</h3>
      <p class="modal-sub">Devices currently signed in to your account.</p>
      ${current ? `<div class="settings-section"><h4>This device (current)</h4>
        <div class="session-item session-current"><div class="session-info">
          <div class="session-device">${escapeHtml(current.device || 'Current device')}</div>
          <div class="session-meta">${escapeHtml(current.ip || '')} · Active ${timeAgo(current.last_active)}</div>
        </div></div></div>` : ''}
      <div class="settings-divider"></div>
      <div class="settings-section">
        <h4>Other sessions (${others.length})</h4>
        ${others.length === 0 ? `<p>No other active sessions.</p>`
          : others.map(s => `<div class="session-item"><div class="session-info">
              <div class="session-device">${escapeHtml(s.device || 'Unknown device')}</div>
              <div class="session-meta">${escapeHtml(s.ip || '')} · Active ${timeAgo(s.last_active)}</div>
            </div><button class="btn-secondary" data-logout-session="${s.id}" style="padding:0.4rem 0.7rem;font-size:0.8rem;">Log out</button></div>`).join('')}
        ${others.length > 0 ? `<button class="btn-danger" id="logoutAllBtn" style="width:auto;padding:0.55rem 1rem;margin-top:0.5rem;">Log out all other sessions</button>` : ''}
      </div>`;
    refreshIcons();
    settingsContent.querySelectorAll('[data-logout-session]').forEach(btn => {
      btn.onclick = () => confirmAction({
        title: 'Log out this session?', text: 'That device will need to log in again.', confirmLabel: 'Log out',
        onConfirm: async () => {
          const orig = btn.textContent;
          btn.disabled = true; btn.textContent = 'Logging out…';
          try {
            await fetch(`/api/auth/sessions/${btn.dataset.logoutSession}`, { method: 'DELETE', headers: authHeaders() });
            toast('Session logged out', 'success');
            renderSessionsTab();
          } catch { btn.disabled = false; btn.textContent = orig; toast('Failed', 'error'); }
        }
      });
    });
    const allBtn = $('logoutAllBtn');
    if (allBtn) allBtn.onclick = () => confirmAction({
      title: 'Log out all other sessions?', text: 'All devices except this one will be signed out.', confirmLabel: 'Log out all',
      onConfirm: async () => {
        const orig = allBtn.textContent;
        allBtn.disabled = true; allBtn.textContent = 'Logging out all…';
        try {
          await fetch('/api/auth/sessions-all-others', { method: 'DELETE', headers: authHeaders() });
          toast('All other sessions logged out', 'success');
          renderSessionsTab();
        } catch { allBtn.disabled = false; allBtn.textContent = orig; toast('Failed', 'error'); }
      }
    });
  } catch { settingsContent.innerHTML = `<h3>Sessions</h3><p class="modal-sub">Could not load sessions.</p>`; }
}

// ============ LOGOUT ============
function confirmLogout() {
  confirmAction({
    title: 'Log out?',
    text: 'You will need to log in again to access your chats.',
    confirmLabel: 'Log out',
    danger: true,
    onConfirm: async () => {
      try { await fetch('/api/auth/sessions-current', { method: 'DELETE', headers: authHeaders() }); } catch {}
      state.token = null; state.user = null; state.chats = []; state.activeChatId = null; state.messages = [];
      state.messageVersions = {};
      state._selectedChats.clear(); state._chatMultiSelectMode = false;
      clearAuthModalState();
      localStorage.removeItem('deeprwa_token');
      renderUser(); renderChatList(); renderWelcome(); settingsModal.classList.add('hidden');
      toast('Logged out', 'info');
    }
  });
}

// ============ SHARE ============
async function shareChat(chatId) {
  const chat = state.chats.find(c => c.id === chatId); if (!chat) return;
  let msgs = chat.messages || [];
  if ((!msgs || !msgs.length) && state.user && !isLocalId(chatId)) {
    try {
      const res = await fetch(`/api/conversations/${chatId}/messages`, { headers: authHeaders() });
      const d = await res.json();
      msgs = (d.messages || []).map(m => ({ id: m.id, role: m.role, content: m.content, files: m.files || [] }));
      (d.messages || []).forEach(m => {
        if (m.role === 'user' && m.versions && m.versions.length > 0) {
          state.messageVersions[m.id] = { versions: m.versions, files: m.version_files || [], aiReplies: m.ai_replies || [], aiFiles: m.ai_files || [], currentIndex: m.current_version_index || 0 };
        }
      });
    } catch {}
  }
  if (!msgs.length) { toast('Nothing to share yet', 'error'); return; }
  await postShare(msgs, { includeVersions: true });
}

async function shareSingleMessage(idx) {
  const msg = state.messages[idx]; if (!msg) return;
  let userMsg = null, assistantMsg = null;
  if (msg.role === 'assistant') {
    assistantMsg = msg;
    const prev = state.messages[idx - 1];
    if (prev && prev.role === 'user') userMsg = prev;
  } else if (msg.role === 'user') {
    userMsg = msg;
    const next = state.messages[idx + 1];
    if (next && next.role === 'assistant') assistantMsg = next;
  }
  const msgs = [];
  let currentUserContent = userMsg?.content || '';
  let currentUserFiles = userMsg?.files || [];
  let currentAiContent = assistantMsg?.content || '';
  let currentAiFiles = assistantMsg?.files || [];
  if (userMsg && userMsg.id && state.messageVersions[userMsg.id]) {
    const v = state.messageVersions[userMsg.id];
    const i = Math.max(0, Math.min(v.currentIndex || 0, v.versions.length - 1));
    currentUserContent = v.versions[i] ?? currentUserContent;
    currentUserFiles = v.files[i] ?? currentUserFiles;
    currentAiContent = v.aiReplies[i] ?? currentAiContent;
    currentAiFiles = v.aiFiles[i] ?? currentAiFiles;
  }
  if (userMsg) msgs.push({ role: 'user', content: currentUserContent, files: currentUserFiles });
  if (assistantMsg) msgs.push({ role: 'assistant', content: currentAiContent, files: currentAiFiles });
  if (!msgs.length) { toast('Nothing to share', 'error'); return; }
  await postShare(msgs, { includeVersions: false });
}

async function postShare(msgs, opts = {}) {
  const includeVersions = opts.includeVersions === true;
  const enriched = msgs.map(m => {
    const out = { role: m.role, content: m.content, files: m.files || [] };
    if (includeVersions && m.id && state.messageVersions[m.id]) {
      const v = state.messageVersions[m.id];
      out.versions = v.versions || [];
      out.versionFiles = v.files || [];
      out.aiReplies = v.aiReplies || [];
      out.aiFiles = v.aiFiles || [];
      out.currentVersionIndex = v.currentIndex || 0;
    }
    return out;
  }).filter(m => (m.content && m.content.trim()) || (m.files && m.files.length));
  const payloadStr = JSON.stringify({ messages: enriched });
  if (payloadStr.length > 25 * 1024 * 1024) { toast('Share is too large. Try removing some files.', 'error'); return; }
  try {
    const res = await fetch('/api/share/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payloadStr });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showShareModal(data.url);
    toast(includeVersions ? 'Chat share created — versions included.' : 'Message share created.', 'success');
  } catch { toast('Could not create share link', 'error'); }
}

function showShareModal(url) { shareLinkInput.value = url; shareModal.classList.remove('hidden'); }
shareModalClose.addEventListener('click', () => shareModal.classList.add('hidden'));
shareModal.addEventListener('click', (e) => { if (e.target === shareModal) shareModal.classList.add('hidden'); });
copyShareLink.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareLinkInput.value); } catch {}
  copyShareLink.textContent = 'Copied!';
  toast('Link copied', 'success', 2000);
  setTimeout(() => copyShareLink.textContent = 'Copy', 1500);
});

function closeAllModals() {
  authModal.classList.add('hidden');
  profileModal.classList.add('hidden');
  settingsModal.classList.add('hidden');
  shareModal.classList.add('hidden');
  renameModal.classList.add('hidden');
  confirmModal.classList.add('hidden');
  fileViewModal.classList.add('hidden');
  accountDropdown.classList.add('hidden');
  clearAuthModalState();
}

// ============ BOOT ============
init();
