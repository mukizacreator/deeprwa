// DeepRWA — Phase 3 frontend logic

const state = {
  messages: [],
  isGenerating: false,
  abortController: null
};

const chatEl = document.getElementById('chat');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');

// Icons
function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }
refreshIcons();

// Auto-grow textarea
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}
inputEl.addEventListener('input', autoGrow);

// Submit on Enter, new line on Shift+Enter
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

// Safe markdown
function escapeHtmlOutsideCode(text) {
  const lines = text.split('\n');
  let inCode = false;
  return lines.map(line => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return line; }
    if (inCode) return line;
    return line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }).join('\n');
}

function renderMarkdown(text) {
  const safe = escapeHtmlOutsideCode(text || '');
  const html = window.marked.parse(safe, { breaks: true, gfm: true });
  return html;
}

// Scroll to bottom
function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Append user bubble
function appendUser(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  el.innerHTML = `<div class="bubble">${escapeHtmlOutsideCode(text).replace(/\n/g,'<br>')}</div>`;
  chatEl.appendChild(el);
  scrollBottom();
}

// Append assistant bubble with streaming content
function appendAssistant() {
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  el.innerHTML = `
    <div class="avatar"><img src="/av.png" alt="DeepRWA" /></div>
    <div class="assistant-body">
      <div class="assistant-name">DeepRWA</div>
      <div class="assistant-text"></div>
      <div class="thinking hidden"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-label">Initializing…</span></div>
    </div>`;
  chatEl.appendChild(el);
  scrollBottom();
  return el;
}

// Remove welcome screen
function clearWelcome() {
  const w = chatEl.querySelector('.welcome');
  if (w) w.remove();
}

// Chip buttons
chatEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  inputEl.value = chip.dataset.q || '';
  autoGrow();
  formEl.requestSubmit();
});

// New chat
newChatBtn.addEventListener('click', () => {
  if (state.isGenerating) return;
  state.messages = [];
  chatEl.innerHTML = '';
  // rebuild welcome
  chatEl.innerHTML = `
    <div class="welcome">
      <img src="/av.png" alt="DeepRWA" class="welcome-logo" />
      <h1>DeepRWA</h1>
      <p>Ask me anything about <strong>Rwanda</strong> — history, culture, tourism, people, news, and more. In any language.</p>
      <div class="chips">
        <button class="chip" data-q="Tell me about the history of Rwanda">History</button>
        <button class="chip" data-q="What are the top tourist attractions in Rwanda?">Tourism</button>
        <button class="chip" data-q="Who are some famous Rwandan people?">People</button>
        <button class="chip" data-q="Explain Umuganda and its importance">Culture</button>
      </div>
    </div>`;
});

// Send
formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.isGenerating) return;
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  autoGrow();
  clearWelcome();

  appendUser(text);
  state.messages.push({ role: 'user', content: text });

  const assistantEl = appendAssistant();
  const textEl = assistantEl.querySelector('.assistant-text');
  const thinking = assistantEl.querySelector('.thinking');

  state.isGenerating = true;
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
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
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break;
        try {
          const json = JSON.parse(payload);
          if (json.text) {
            if (firstChunk) { thinking.classList.add('hidden'); firstChunk = false; }
            full += json.text;
            textEl.innerHTML = renderMarkdown(full);
            scrollBottom();
          }
        } catch {}
      }
    }

    if (full) state.messages.push({ role: 'assistant', content: full });
    if (!full) textEl.textContent = 'No response received.';
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
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    state.abortController = null;
    thinking.classList.add('hidden');
    inputEl.focus();
  }
});

// Stop
stopBtn.addEventListener('click', () => {
  if (state.abortController) state.abortController.abort();
});

inputEl.focus();
