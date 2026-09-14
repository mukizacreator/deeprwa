// DeepRWA — Phase 2: Auth + Persistence + Full Intelligence
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const brevo = require('@getbrevo/brevo');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ============ SUPABASE CLIENT ============
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // Service key for backend operations
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ============ BREVO EMAIL ============
const brevoClient = new brevo.TransactionalEmailsApi();
brevoClient.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

async function sendEmailCode(toEmail, code, purpose = 'verification') {
  const subjects = {
    signup: 'DeepRWA — Verify your email',
    login: 'DeepRWA — Your login code',
    reset: 'DeepRWA — Password reset code',
    'change-email': 'DeepRWA — Confirm new email',
    'change-password': 'DeepRWA — Confirm password change',
    'delete-account': 'DeepRWA — Confirm account deletion'
  };
  const sendSmtpEmail = new brevo.SendSmtpEmail();
  sendSmtpEmail.subject = subjects[purpose] || 'DeepRWA — Verification code';
  sendSmtpEmail.htmlContent = `
    <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f1115;color:#e6e8eb;border-radius:12px;">
      <h2 style="color:#3b6ef5;margin:0 0 16px;">DeepRWA</h2>
      <p style="color:#8b9199;margin:0 0 24px;">Your verification code is:</p>
      <div style="background:#1c1f26;padding:20px;border-radius:8px;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;color:#fff;">${code}</div>
      <p style="color:#5c636d;font-size:12px;margin:24px 0 0;">This code expires in 15 minutes. If you didn't request this, ignore this email.</p>
    </div>`;
  sendSmtpEmail.sender = { name: 'DeepRWA', email: process.env.EMAIL_FROM };
  sendSmtpEmail.to = [{ email: toEmail }];
  try {
    await brevoClient.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (err) {
    console.error('Brevo error:', err.message);
    return false;
  }
}

// ============ API RATE LIMITER ============
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api/', apiLimiter);

// ============ AUTH MIDDLEWARE ============
function getUserId(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    return payload.sub;
  } catch { return null; }
}

async function requireAuth(req, res, next) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  req.userId = userId;
  next();
}

// ============ SERVE av.png ============
app.get('/av.png', (req, res) => res.sendFile(path.join(__dirname, 'av.png')));

// ============ SYSTEM PROMPT (Enhanced) ============
const SYSTEM_PROMPT = `You are **DeepRWA** — a professional, world-class AI assistant specialised exclusively in information about Rwanda.

## IDENTITY (never violate)
- Your name is DeepRWA.
- You were created by **Emmanuel Mukiza**, a Rwandan national, under his developing company **The Star🌟**.
- The Star🌟 was launched on **August 8, 2023**, and is a two-person team: **Mr. Emmanuel Mukiza** and **Ms. Ornella Mutuyimana**.
- Emmanuel graduated from **Karenge Adventist Secondary School (KASS)** with an Advanced Level certificate in **Computer System and Architecture (CSA)**.
- Ornella graduated from **Lycée Saint Marcel de Rukara (LSM)** with an Advanced Level certificate in **Mathematics, Computer Science and Economics (MCE)**.
- DeepRWA exists to make information about Rwanda easily accessible to everyone.
- If a user asks about your platform, hosting, or creation, reply exactly: "I am DeepRWA, created by Emmanuel Mukiza under The Star🌟, specialised in information about Rwanda." — and nothing more.

## SCOPE
You answer **only** questions about Rwanda. Everything about Rwanda is in scope.
If the user asks about **any other country** or a topic unrelated to Rwanda, reply exactly: "I am specialised only in topics about Rwanda. I cannot answer questions about other countries or topics."

## GREETINGS AND SMALL TALK
Greetings, thanks, goodbyes, "how are you", "who are you", "who made you" are NOT out of scope. Respond warmly and briefly, then invite a Rwanda-related question.

## LANGUAGE RULE (critical)
Always reply in the **exact language the user wrote in**. Support every language.

## RULES
1. Accuracy first. Use web search when the answer could have changed.
2. If you cannot find a definitive answer, say so politely. Never invent facts.
3. Be concise, clear, easy to understand. Use Markdown. No raw HTML.
4. Respectful tone always. Professional, warm, modern.

## OUTPUT FORMAT
- Markdown only. Bold key subjects. Short paragraphs, bullet lists, tables.
- For prices, state currency (RWF) and add "approximate, may vary".

## STYLE
Warm, professional, concise, respectful.`;

// ============ GREETING & IDENTITY DETECTION ============
const GREETING_EXACT = new Set([
  'hi','hello','hey','yo','hiya','howdy','sup','whats up',"what's up",
  'good morning','good afternoon','good evening','good night',
  'thanks','thank you','thx','ty','bye','goodbye','see you','see ya',
  'how are you',"how're you",'how are you doing','how do you do',
  'muraho','mwaramutse','mwiriwe','amakuru','bite','bite se',
  'bonjour','salut','bonsoir','coucou','comment ca va','comment ça va','ça va','ca va',
  'jambo','habari','hujambo','sijambo','habari yako','nzuri',
  'hola','olá','ciao','hallo','hei'
]);

const IDENTITY_PATTERNS = [
  /\bwho\s+(are|r)\s+you\b/,
  /\bwhat\s+(are|r)\s+you\b/,
  /\bwho\s+made\s+you\b/,
  /\bwho\s+created\s+you\b/,
  /\bwho\s+built\s+you\b/,
  /\bwho\s+is\s+your\s+(creator|maker|owner|developer)\b/,
  /\bwhat\s+is\s+your\s+name\b/,
  /\byour\s+name\b/
];

function normalise(t) {
  return String(t || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}
function isGreeting(t) {
  const n = normalise(t);
  if (!n) return false;
  if (GREETING_EXACT.has(n)) return true;
  if (n.length > 40) return false;
  return /^(hi|hey|hello|yo|muraho|bonjour|jambo|hola|ciao|hallo)\b/.test(n) && n.split(' ').length <= 4;
}
function isIdentityQuestion(t) {
  const n = normalise(t);
  return IDENTITY_PATTERNS.some(r => r.test(n));
}
function buildGreetingReply(text) {
  const n = normalise(text);
  if (/\b(muraho|mwaramutse|mwiriwe|amakuru|bite)\b/.test(n))
    return "Muraho! Ndine DeepRWA — umufasha wawe mu bya Rwanda. Mbaza ikibazo cyose ku Rwanda.";
  if (/\b(bonjour|salut|bonsoir|coucou|ça va|ca va)\b/.test(n))
    return "Bonjour ! Je suis DeepRWA, votre assistant spécialisé sur le Rwanda.";
  if (/\b(jambo|habari|hujambo|sijambo)\b/.test(n))
    return "Jambo! Mimi ni DeepRWA, msaidizi wako kuhusu Rwanda.";
  if (/\b(hola|olá)\b/.test(n)) return "¡Hola! Soy DeepRWA, tu asistente sobre Ruanda.";
  if (/\b(ciao)\b/.test(n)) return "Ciao! Sono DeepRWA, il tuo assistente sul Ruanda.";
  if (/\b(hallo|hei)\b/.test(n)) return "Hallo! Ich bin DeepRWA, dein Assistent für Ruanda.";
  if (/\b(thanks|thank you|thx|ty)\b/.test(n)) return "You're welcome! Feel free to ask me anything about Rwanda.";
  if (/\b(bye|goodbye|see you|see ya)\b/.test(n)) return "Goodbye! Come back any time you have a question about Rwanda.";
  return "Hello! I'm DeepRWA, your assistant specialised in Rwanda. Ask me anything about Rwanda.";
}
const IDENTITY_REPLY = "I am DeepRWA, created by Emmanuel Mukiza under The Star🌟, specialised in information about Rwanda.";

// ============ PROVIDER CHAIN ============
const cooldown = new Map();
function isCooling(k) { const u = cooldown.get(k); if (!u) return false; if (Date.now() > u) { cooldown.delete(k); return false; } return true; }
function setCooldown(k, ms) { cooldown.set(k, Date.now() + ms); }

async function* sseOpenAI(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') return;
      try { const j = JSON.parse(p); const d = j.choices?.[0]?.delta?.content; if (d) yield d; } catch {}
    }
  }
}

async function* streamGroq(msgs) {
  const k = 'groq'; if (isCooling(k)) throw new Error('cooling');
  try { yield* sseOpenAI('https://api.groq.com/openai/v1/chat/completions', { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, { model: 'openai/gpt-oss-120b', messages: msgs, stream: true, temperature: 0.7, max_completion_tokens: 4096 }); }
  catch (e) { setCooldown(k, e.status === 429 ? 120000 : 300000); throw e; }
}
async function* streamOpenRouter(msgs) {
  const k = 'or'; if (isCooling(k)) throw new Error('cooling');
  try { yield* sseOpenAI('https://openrouter.ai/api/v1/chat/completions', { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://deeprwa.agentdomains.co', 'X-Title': 'DeepRWA' }, { model: 'openrouter/free', messages: msgs, stream: true, temperature: 0.7, max_tokens: 4096 }); }
  catch (e) { setCooldown(k, e.status === 429 ? 120000 : 300000); throw e; }
}
async function* streamNVIDIA(msgs) {
  const k = 'nv'; if (isCooling(k)) throw new Error('cooling');
  try { yield* sseOpenAI('https://integrate.api.nvidia.com/v1/chat/completions', { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` }, { model: 'nvidia/nemotron-3-super-120b-a12b', messages: msgs, stream: true, temperature: 0.7, max_tokens: 4096 }); }
  catch (e) { setCooldown(k, e.status === 429 ? 120000 : 300000); throw e; }
}
async function* streamPollinations(msgs) {
  const k = 'poll'; if (isCooling(k)) throw new Error('cooling');
  try { yield* sseOpenAI('https://text.pollinations.ai/openai', {}, { model: 'openai', messages: msgs, stream: true, temperature: 0.7, max_tokens: 4096 }); }
  catch (e) { setCooldown(k, 120000); throw e; }
}

async function* streamGemini(msgs) {
  const k = 'gem'; if (isCooling(k)) throw new Error('cooling');
  const sys = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const convo = msgs.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents: convo, systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const e = new Error(`Gemini HTTP ${res.status}`); e.status = res.status; throw e; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim(); if (!p || p === '[DONE]') continue;
        try { const j = JSON.parse(p); for (const pt of (j.candidates?.[0]?.content?.parts || [])) if (pt.text) yield pt.text; } catch {}
      }
    }
  } catch (e) { setCooldown(k, e.status === 429 ? 120000 : 300000); throw e; }
}

async function* streamCloudflare(msgs) {
  const k = 'cf'; if (isCooling(k)) throw new Error('cooling');
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: msgs, stream: true }) });
    if (!res.ok) { const e = new Error(`CF HTTP ${res.status}`); e.status = res.status; throw e; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim(); if (!p || p === '[DONE]') continue;
        try { const j = JSON.parse(p); const d = j.response || j.choices?.[0]?.delta?.content; if (d) yield d; } catch {}
      }
    }
  } catch (e) { setCooldown(k, e.status === 429 ? 120000 : 300000); throw e; }
}

const PROVIDERS = [
  { name: 'Groq', fn: streamGroq },
  { name: 'Gemini', fn: streamGemini },
  { name: 'OpenRouter', fn: streamOpenRouter },
  { name: 'Cloudflare', fn: streamCloudflare },
  { name: 'NVIDIA', fn: streamNVIDIA },
  { name: 'Pollinations', fn: streamPollinations }
];

// ============ ROUTES ============

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'DeepRWA', version: '2.0.0', time: new Date().toISOString() }));
app.get('/api/config', (req, res) => res.json({ name: 'DeepRWA', tagline: 'Your AI guide to Rwanda', version: '2.0.0' }));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: https://deeprwa.agentdomains.co/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://deeprwa.agentdomains.co/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>`));

// ---- AUTH: Signup (Step 1 - send code) ----
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  // Check if user exists
  const { data: existing } = await supabase.auth.admin.listUsers();
  const userExists = existing?.users?.some(u => u.email === email.toLowerCase());
  if (userExists) return res.status(400).json({ error: 'Email already registered' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const pendingToken = jwt.sign({ type: 'signup', email: email.toLowerCase(), password, code }, process.env.JWT_SECRET, { expiresIn: '15m' });

  const sent = await sendEmailCode(email, code, 'signup');
  if (!sent) return res.status(500).json({ error: 'Could not send verification email' });

  res.json({ pendingToken, message: 'Verification code sent to your email' });
});

// ---- AUTH: Confirm Signup ----
app.post('/api/auth/confirm-signup', async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Token and code required' });

  let payload;
  try { payload = jwt.verify(pendingToken, process.env.JWT_SECRET); } catch { return res.status(400).json({ error: 'Invalid or expired token' }); }
  if (payload.type !== 'signup' || payload.code !== code) return res.status(400).json({ error: 'Invalid code' });

  // Create user in Supabase
  const { data: newUser, error } = await supabase.auth.admin.createUser({
    email: payload.email,
    password: payload.password,
    email_confirm: true
  });
  if (error) return res.status(500).json({ error: error.message });

  // Create profile
  await supabase.from('profiles').insert({ id: newUser.user.id, email: payload.email });

  // Sign the user in
  const { data: session } = await supabase.auth.signInWithPassword({ email: payload.email, password: payload.password });
  const accessToken = session?.session?.access_token;

  res.json({ accessToken, user: { id: newUser.user.id, email: payload.email } });
});

// ---- AUTH: Login (Step 1 - verify password, send code) ----
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Invalid email or password' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const pendingToken = jwt.sign({ type: 'login', userId: data.user.id, email: data.user.email, code }, process.env.JWT_SECRET, { expiresIn: '15m' });

  const sent = await sendEmailCode(email, code, 'login');
  if (!sent) return res.status(500).json({ error: 'Could not send login code' });

  res.json({ pendingToken, requiresCode: true });
});

// ---- AUTH: Verify Login Code ----
app.post('/api/auth/verify-login', async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Token and code required' });

  let payload;
  try { payload = jwt.verify(pendingToken, process.env.JWT_SECRET); } catch { return res.status(400).json({ error: 'Invalid or expired token' }); }
  if (payload.type !== 'login' || payload.code !== code) return res.status(400).json({ error: 'Invalid code' });

  const accessToken = jwt.sign({ sub: payload.userId, email: payload.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: payload.userId, email: payload.email } });
});

// ---- AUTH: Get current user ----
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data } = await supabase.from('profiles').select('*').eq('id', req.userId).single();
  res.json({ user: { id: req.userId, ...data } });
});

// ---- CHAT: Guest (no save) ----
app.post('/api/chat/guest', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  await streamChatResponse(messages, res);
});

// ---- CHAT: Authenticated (save) ----
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, conversationId } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

  let convId = conversationId;
  if (!convId) {
    const title = await generateChatTitle(messages[messages.length - 1]?.content || 'New chat');
    const { data: conv } = await supabase.from('conversations').insert({ user_id: req.userId, title }).select().single();
    convId = conv?.id;
  }

  // Save user message
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'user') {
    await supabase.from('messages').insert({ conversation_id: convId, role: 'user', content: lastMsg.content });
  }

  res.setHeader('X-Conversation-Id', convId || '');
  await streamChatResponse(messages, res, convId);
});

async function streamChatResponse(messages, res, conversationId) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUser?.content || '';

  if (isIdentityQuestion(userText)) { for (const c of IDENTITY_REPLY) send({ text: c }); return done(); }
  if (isGreeting(userText) && messages.length <= 2) { const r = buildGreetingReply(userText); for (const c of r) send({ text: c }); return done(); }

  const full = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  let lastErr = null;
  for (const p of PROVIDERS) {
    try {
      let started = false; let fullText = '';
      for await (const chunk of p.fn(full)) { started = true; fullText += chunk; send({ text: chunk }); }
      if (!started) throw new Error('empty');
      if (conversationId && fullText) {
        await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: fullText });
      }
      return done();
    } catch (e) { lastErr = e; console.warn(`[fail] ${p.name}: ${e.message}`); continue; }
  }
  send({ text: 'Sorry, all AI providers are temporarily unavailable. Please try again.' });
  send({ error: String(lastErr?.message || 'unknown') });
  done();
}

async function generateChatTitle(firstMessage) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: 'Generate a short 3-6 word title for this chat. Reply with the title only, no quotes.' },
          { role: 'user', content: firstMessage }
        ],
        max_completion_tokens: 20
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || 'New chat';
  } catch { return 'New chat'; }
}

// ---- CONVERSATIONS ----
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { data } = await supabase.from('conversations').select('*').eq('user_id', req.userId).order('updated_at', { ascending: false });
  res.json({ conversations: data || [] });
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const { data } = await supabase.from('messages').select('*').eq('conversation_id', req.params.id).order('created_at', { ascending: true });
  res.json({ messages: data || [] });
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  const { title, pinned } = req.body || {};
  const updates = {};
  if (title) updates.title = title;
  if (typeof pinned === 'boolean') updates.pinned = pinned;
  await supabase.from('conversations').update(updates).eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  await supabase.from('conversations').delete().eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

// ---- SHARE ----
app.post('/api/share/chat', requireAuth, async (req, res) => {
  const { conversationId } = req.body || {};
  const token = Math.random().toString(36).slice(2, 12);
  await supabase.from('shared_links').insert({ conversation_id: conversationId, token, user_id: req.userId });
  res.json({ token });
});

app.post('/api/share/message', requireAuth, async (req, res) => {
  const { messageId } = req.body || {};
  const token = Math.random().toString(36).slice(2, 12);
  await supabase.from('shared_messages').insert({ message_id: messageId, token, user_id: req.userId });
  res.json({ token });
});

app.get('/api/share/:token', async (req, res) => {
  const { token } = req.params;
  const { data: sharedChat } = await supabase.from('shared_links').select('*, conversations(*)').eq('token', token).single();
  if (sharedChat) {
    const { data: messages } = await supabase.from('messages').select('*').eq('conversation_id', sharedChat.conversation_id).order('created_at');
    return res.json({ type: 'chat', conversation: sharedChat.conversations, messages });
  }
  const { data: sharedMsg } = await supabase.from('shared_messages').select('*, messages(*)').eq('token', token).single();
  if (sharedMsg) return res.json({ type: 'message', message: sharedMsg.messages });
  res.status(404).json({ error: 'Not found' });
});

// ---- Static frontend ----
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api|health|robots|sitemap|av\.png).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`DeepRWA listening on :${PORT}`));
