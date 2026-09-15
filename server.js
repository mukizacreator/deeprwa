// DeepRWA — Full backend: auth, 2FA, sessions, vision, files, chat, sharing
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============ SUPABASE ============
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnon = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) console.warn('⚠️  Supabase credentials not set.');
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;
const supabaseConfigured = !!supabase;

// ============ BREVO (REST API — reliable) ============
async function sendEmailCode(toEmail, code, purpose = 'verification') {
  if (!process.env.BREVO_API_KEY) {
    console.error('BREVO_API_KEY missing');
    return false;
  }
  const subjects = {
    signup: 'DeepRWA — Verify your email',
    login: 'DeepRWA — Your login code',
    reset: 'DeepRWA — Password reset code'
  };
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#000;font-family:'Inter',system-ui,-apple-system,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <img src="https://deeprwa.agentdomains.co/av.png" alt="DeepRWA" style="width:72px;height:72px;border-radius:18px;display:inline-block;" />
      <div style="margin-top:16px;font-size:28px;font-weight:800;letter-spacing:-0.02em;color:#e6e8eb;">
        <span style="color:#e6e8eb;">Deep</span><span style="color:#00a1de;">R</span><span style="color:#fad201;">W</span><span style="color:#20603d;">A</span>
      </div>
      <div style="margin-top:6px;font-size:14px;color:#8b9199;">Your AI guide to Rwanda</div>
    </div>
    <div style="background:#0f1115;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px 24px;text-align:center;">
      <p style="margin:0 0 20px;color:#8b9199;font-size:14px;">Your verification code is:</p>
      <div style="background:#1c1f26;padding:24px;border-radius:12px;font-size:36px;font-weight:800;letter-spacing:12px;color:#fff;font-family:ui-monospace,monospace;">${code}</div>
      <p style="margin:24px 0 0;color:#5c636d;font-size:12px;">This code expires in 15 minutes. If you didn't request this, ignore this email.</p>
    </div>
    <div style="text-align:center;margin-top:28px;color:#5c636d;font-size:11px;">
      © DeepRWA — The Star🌟
    </div>
  </div>
</body></html>`;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'DeepRWA', email: process.env.EMAIL_FROM || 'noreply@deeprwa.agentdomains.co' },
        to: [{ email: toEmail }],
        subject: subjects[purpose] || 'DeepRWA — Verification code',
        htmlContent: html
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Brevo error:', res.status, err);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Brevo fetch error:', err.message);
    return false;
  }
}

// ============ RATE LIMIT ============
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api/', apiLimiter);

// ============ AUTH HELPERS ============
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
async function verifyPassword(email, password) {
  if (!supabaseUrl || !supabaseAnon) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseAnon },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user || null;
  } catch { return null; }
}

// ============ SESSIONS ============
async function trackSession(userId, req) {
  if (!supabase) return;
  const clientId = req.headers['x-client-id'] || '';
  const ua = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const device = ua.includes('Mobile') ? 'Mobile' : ua.includes('Tablet') ? 'Tablet' : 'Desktop';
  try {
    if (clientId) {
      const { data: existing } = await supabase.from('sessions').select('id').eq('user_id', userId).eq('client_id', clientId).maybeSingle();
      if (existing) {
        await supabase.from('sessions').update({ last_active: new Date().toISOString() }).eq('id', existing.id);
        return;
      }
    }
    await supabase.from('sessions').insert({ user_id: userId, client_id: clientId, device, user_agent: ua, ip });
  } catch (e) { console.warn('session track failed', e.message); }
}

// ============ av.png ============
app.get('/av.png', (req, res) => res.sendFile(path.join(__dirname, 'av.png')));

// ============ SYSTEM PROMPT ============
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

## IMAGES AND DOCUMENTS
When a user sends an image, describe what you see and answer their question about it professionally. When a user sends a PDF or text document, read it, summarise it, and answer questions about it. Never claim you cannot see images or files when they are attached.

## RULES
1. Accuracy first.
2. If you cannot find a definitive answer, say so politely. Never invent facts.
3. Be concise, clear, easy to understand. Use Markdown. No raw HTML.
4. Respectful tone always.

## OUTPUT FORMAT
- Markdown only. Bold key subjects.
- For prices, state currency (RWF) and add "approximate, may vary".

## STYLE
Warm, professional, concise, respectful.`;

// ============ GREETING & IDENTITY ============
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
  /\bwho\s+(are|r)\s+you\b/, /\bwhat\s+(are|r)\s+you\b/,
  /\bwho\s+made\s+you\b/, /\bwho\s+created\s+you\b/, /\bwho\s+built\s+you\b/,
  /\bwho\s+is\s+your\s+(creator|maker|owner|developer)\b/,
  /\bwhat\s+is\s+your\s+name\b/, /\byour\s+name\b/
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
  return IDENTITY_PATTERNS.some(r => r.test(normalise(t)));
}
function buildGreetingReply(text) {
  const n = normalise(text);
  if (/\b(muraho|mwaramutse|mwiriwe|amakuru|bite)\b/.test(n)) return "Muraho! Ndine DeepRWA — umufasha wawe mu bya Rwanda. Mbaza ikibazo cyose ku Rwanda.";
  if (/\b(bonjour|salut|bonsoir|coucou|ça va|ca va)\b/.test(n)) return "Bonjour ! Je suis DeepRWA, votre assistant spécialisé sur le Rwanda.";
  if (/\b(jambo|habari|hujambo|sijambo)\b/.test(n)) return "Jambo! Mimi ni DeepRWA, msaidizi wako kuhusu Rwanda.";
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

// Gemini text-only
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

// Gemini VISION — when images/documents are present
async function* streamGeminiVision(messages, images) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const userMsgs = messages.filter(m => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1];
  const priorConvo = messages.filter(m => m.role !== 'system' && m !== lastUser).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const parts = [{ text: lastUser?.content || 'Analyse the attached files.' }];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
  }

  const body = {
    contents: [...priorConvo, { role: 'user', parts }],
    systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.text(); const e = new Error(`Gemini Vision ${res.status}: ${err.slice(0, 200)}`); e.status = res.status; throw e; }
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
}

const PROVIDERS = [
  { name: 'Groq', fn: streamGroq },
  { name: 'Gemini', fn: streamGemini },
  { name: 'OpenRouter', fn: streamOpenRouter },
  { name: 'Cloudflare', fn: streamCloudflare },
  { name: 'NVIDIA', fn: streamNVIDIA },
  { name: 'Pollinations', fn: streamPollinations }
];

// ============ TITLE GENERATION ============
async function generateChatTitle(firstMessage) {
  if (!firstMessage) return 'New chat';
  if (isGreeting(firstMessage)) return 'Greeting';
  if (isIdentityQuestion(firstMessage)) return 'About DeepRWA';
  const textOnly = String(firstMessage).slice(0, 400);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: 'Generate a concise 2-5 word title that captures the topic of the user\'s message. Reply with ONLY the title text — no quotes, no "Title:" prefix, no punctuation at the end. Examples: "Rwandan History Overview", "Kigali Hotels Guide", "Coffee Prices Rwanda", "Nyungwe Forest Tours"' },
          { role: 'user', content: textOnly }
        ],
        max_completion_tokens: 40,
        reasoning_effort: 'none',
        temperature: 0.3
      })
    });
    if (!res.ok) throw new Error('title api ' + res.status);
    const data = await res.json();
    let title = (data.choices?.[0]?.message?.content || '').trim();
    title = title.replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/^Title:\s*/i, '').split('\n')[0].trim();
    title = title.replace(/[.!?,;:]+$/, '');
    if (!title || title.length > 60 || title.toLowerCase() === textOnly.toLowerCase()) {
      title = textOnly.split(/\s+/).slice(0, 6).join(' ');
    }
    return title || 'New chat';
  } catch (e) {
    return textOnly.split(/\s+/).slice(0, 6).join(' ') || 'New chat';
  }
}

// ============ ROUTES ============
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'DeepRWA', version: '2.2.0', time: new Date().toISOString() }));

app.get('/api/config', (req, res) => res.json({
  name: 'DeepRWA', tagline: 'Your AI guide to Rwanda', version: '2.2.0',
  supabaseUrl: supabaseUrl || null, supabaseAnonKey: supabaseAnon || null
}));

app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: https://deeprwa.agentdomains.co/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://deeprwa.agentdomains.co/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>`));

// ---- AUTH ----
app.post('/api/auth/signup', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Auth service not configured.' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const emailLower = email.toLowerCase();
  const { data: existing } = await supabase.from('profiles').select('id').eq('email', emailLower).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const pendingToken = jwt.sign({ type: 'signup', email: emailLower, password, code }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const sent = await sendEmailCode(emailLower, code, 'signup');
  if (!sent) return res.status(500).json({ error: 'Could not send verification email. Please try again later.' });
  res.json({ pendingToken, message: 'Verification code sent' });
});

app.post('/api/auth/confirm-signup', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Auth service not configured.' });
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Token and code required' });
  let payload;
  try { payload = jwt.verify(pendingToken, process.env.JWT_SECRET); }
  catch { return res.status(400).json({ error: 'Invalid or expired token' }); }
  if (payload.type !== 'signup' || payload.code !== code) return res.status(400).json({ error: 'Invalid code' });
  const { data: newUser, error } = await supabase.auth.admin.createUser({ email: payload.email, password: payload.password, email_confirm: true });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('profiles').insert({ id: newUser.user.id, email: payload.email });
  await trackSession(newUser.user.id, req);
  const accessToken = jwt.sign({ sub: newUser.user.id, email: payload.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: newUser.user.id, email: payload.email } });
});

app.post('/api/auth/login', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Auth service not configured.' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await verifyPassword(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const { data: profile } = await supabase.from('profiles').select('totp_enabled').eq('id', user.id).maybeSingle();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const pendingToken = jwt.sign({
    type: 'login',
    userId: user.id,
    email: user.email,
    code,
    needs2fa: profile?.totp_enabled || false
  }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const sent = await sendEmailCode(user.email, code, 'login');
  if (!sent) return res.status(500).json({ error: 'Could not send login code' });
  res.json({ pendingToken, requiresCode: true, requires2fa: profile?.totp_enabled || false });
});

app.post('/api/auth/verify-login', async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Token and code required' });
  let payload;
  try { payload = jwt.verify(pendingToken, process.env.JWT_SECRET); }
  catch { return res.status(400).json({ error: 'Invalid or expired token' }); }
  if (payload.type !== 'login' || payload.code !== code) return res.status(400).json({ error: 'Invalid code' });
  if (payload.needs2fa) {
    const twofaToken = jwt.sign({ type: 'login-2fa', userId: payload.userId, email: payload.email }, process.env.JWT_SECRET, { expiresIn: '10m' });
    return res.json({ requires2fa: true, twofaToken });
  }
  await trackSession(payload.userId, req);
  const accessToken = jwt.sign({ sub: payload.userId, email: payload.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: payload.userId, email: payload.email } });
});

app.post('/api/auth/verify-2fa', async (req, res) => {
  const { twofaToken, code } = req.body || {};
  if (!twofaToken || !code) return res.status(400).json({ error: 'Token and code required' });
  let payload;
  try { payload = jwt.verify(twofaToken, process.env.JWT_SECRET); }
  catch { return res.status(400).json({ error: 'Invalid or expired token' }); }
  if (payload.type !== 'login-2fa') return res.status(400).json({ error: 'Invalid token' });
  const { data: profile } = await supabase.from('profiles').select('totp_secret').eq('id', payload.userId).maybeSingle();
  if (!profile?.totp_secret) return res.status(400).json({ error: '2FA not configured' });
  const valid = authenticator.verify({ token: code, secret: profile.totp_secret });
  if (!valid) return res.status(400).json({ error: 'Invalid 2FA code' });
  await trackSession(payload.userId, req);
  const accessToken = jwt.sign({ sub: payload.userId, email: payload.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: payload.userId, email: payload.email } });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { data } = await supabase.from('profiles').select('*').eq('id', req.userId).maybeSingle();
  res.json({ user: { id: req.userId, email: data?.email, display_name: data?.display_name, totp_enabled: data?.totp_enabled || false } });
});

// ---- 2FA ----
app.post('/api/auth/2fa/setup', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(profile?.email || 'user', 'DeepRWA', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 240, margin: 1, color: { dark: '#e6e8eb', light: '#0a0a0a' } });
  // Temporary store — secret is confirmed on enable
  await supabase.from('profiles').update({ totp_secret: secret }).eq('id', req.userId);
  res.json({ secret, qrDataUrl });
});

app.post('/api/auth/2fa/enable', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { code } = req.body || {};
  const { data: profile } = await supabase.from('profiles').select('totp_secret').eq('id', req.userId).maybeSingle();
  if (!profile?.totp_secret) return res.status(400).json({ error: 'Start setup first' });
  const valid = authenticator.verify({ token: code, secret: profile.totp_secret });
  if (!valid) return res.status(400).json({ error: 'Invalid code' });
  await supabase.from('profiles').update({ totp_enabled: true }).eq('id', req.userId);
  res.json({ success: true });
});

app.post('/api/auth/2fa/disable', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { password } = req.body || {};
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  const user = await verifyPassword(profile?.email, password);
  if (!user) return res.status(401).json({ error: 'Invalid password' });
  await supabase.from('profiles').update({ totp_enabled: false, totp_secret: null }).eq('id', req.userId);
  res.json({ success: true });
});

// ---- SESSIONS ----
app.get('/api/auth/sessions', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ sessions: [] });
  const clientId = req.headers['x-client-id'] || '';
  const { data } = await supabase.from('sessions').select('*').eq('user_id', req.userId).order('last_active', { ascending: false });
  const sessions = (data || []).map(s => ({ ...s, current: s.client_id === clientId }));
  res.json({ sessions });
});

app.delete('/api/auth/sessions/:id', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  await supabase.from('sessions').delete().eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

app.delete('/api/auth/sessions-all-others', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const clientId = req.headers['x-client-id'] || '';
  await supabase.from('sessions').delete().eq('user_id', req.userId).neq('client_id', clientId);
  res.json({ success: true });
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { password } = req.body || {};
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  const user = await verifyPassword(profile?.email, password);
  if (!user) return res.status(401).json({ error: 'Invalid password' });
  await supabase.auth.admin.deleteUser(req.userId);
  res.json({ success: true });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Invalid input' });
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  const user = await verifyPassword(profile?.email, currentPassword);
  if (!user) return res.status(401).json({ error: 'Current password is incorrect' });
  const { error } = await supabase.auth.admin.updateUserById(req.userId, { password: newPassword });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---- TITLE ----
app.post('/api/chat/title', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  const title = await generateChatTitle(message);
  res.json({ title });
});

// ---- CHAT ----
app.post('/api/chat/guest', async (req, res) => {
  const { messages, images } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  await streamChatResponse(messages, res, null, images || []);
});

app.post('/api/chat', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { messages, conversationId, images } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

  let convId = conversationId;
  const firstUserText = messages.find(m => m.role === 'user')?.content || '';

  if (!convId) {
    const title = await generateChatTitle(firstUserText);
    const { data: conv, error } = await supabase.from('conversations').insert({ user_id: req.userId, title }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    convId = conv.id;
  } else {
    const { data: conv } = await supabase.from('conversations').select('title').eq('id', convId).single();
    if (conv && (!conv.title || conv.title === 'New chat' || conv.title.length < 3) && firstUserText) {
      const title = await generateChatTitle(firstUserText);
      await supabase.from('conversations').update({ title }).eq('id', convId);
    }
  }

  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'user') {
    await supabase.from('messages').insert({ conversation_id: convId, role: 'user', content: lastMsg.content });
  }

  res.setHeader('X-Conversation-Id', convId);
  await streamChatResponse(messages, res, convId, images || []);
});

async function streamChatResponse(messages, res, conversationId, images) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUser?.content || '';

  // Fast paths only when NO images
  if ((!images || !images.length)) {
    if (isIdentityQuestion(userText)) { for (const c of IDENTITY_REPLY) send({ text: c }); return done(); }
    if (isGreeting(userText) && messages.length <= 2) {
      const r = buildGreetingReply(userText);
      for (const c of r) send({ text: c });
      return done();
    }
  }

  const full = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  let lastErr = null;

  // If images present, try Gemini Vision FIRST
  if (images && images.length) {
    try {
      let fullText = '';
      for await (const chunk of streamGeminiVision(full, images)) {
        fullText += chunk;
        send({ text: chunk });
      }
      if (conversationId && fullText && supabase) {
        await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: fullText });
      }
      return done();
    } catch (e) {
      lastErr = e;
      console.warn('[fail] Gemini Vision:', e.message);
      // fall through to text providers
    }
  }

  for (const p of PROVIDERS) {
    try {
      let started = false; let fullText = '';
      for await (const chunk of p.fn(full)) { started = true; fullText += chunk; send({ text: chunk }); }
      if (!started) throw new Error('empty');
      if (conversationId && fullText && supabase) {
        await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: fullText });
      }
      return done();
    } catch (e) { lastErr = e; console.warn(`[fail] ${p.name}: ${e.message}`); continue; }
  }
  send({ text: 'Sorry, all AI providers are temporarily unavailable. Please try again.' });
  send({ error: String(lastErr?.message || 'unknown') });
  done();
}

// ---- CONVERSATIONS ----
app.get('/api/conversations', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ conversations: [] });
  const { data } = await supabase.from('conversations').select('*').eq('user_id', req.userId).order('updated_at', { ascending: false });
  res.json({ conversations: data || [] });
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ messages: [] });
  const { data: conv } = await supabase.from('conversations').select('user_id').eq('id', req.params.id).single();
  if (!conv || conv.user_id !== req.userId) return res.status(403).json({ error: 'Not allowed' });
  const { data } = await supabase.from('messages').select('*').eq('conversation_id', req.params.id).order('created_at', { ascending: true });
  res.json({ messages: data || [] });
});

app.get('/api/files', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ files: [] });
  const { data } = await supabase.from('messages').select('files, created_at, role').not('files', 'is', null).order('created_at', { ascending: false });
  const all = [];
  for (const row of (data || [])) {
    if (Array.isArray(row.files)) {
      for (const f of row.files) all.push({ ...f, created_at: row.created_at, role: row.role });
    }
  }
  res.json({ files: all });
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { title, pinned } = req.body || {};
  const updates = {};
  if (title) updates.title = title;
  if (typeof pinned === 'boolean') updates.pinned = pinned;
  await supabase.from('conversations').update(updates).eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  await supabase.from('conversations').delete().eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

// ---- VERSION SYNC ----
app.post('/api/chat/messages/:id/sync-versions', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { id } = req.params;
  const { userMessageContent, userMessageFiles, versions, versionFiles, aiReplies, aiFiles, currentVersionIndex, assistantContent, assistantFiles } = req.body || {};
  const { data: msg } = await supabase.from('messages').select('conversation_id, role, created_at').eq('id', id).single();
  if (!msg || msg.role !== 'user') return res.status(404).json({ error: 'Message not found' });
  const { data: conv } = await supabase.from('conversations').select('user_id').eq('id', msg.conversation_id).single();
  if (!conv || conv.user_id !== req.userId) return res.status(403).json({ error: 'Not allowed' });
  await supabase.from('messages').update({
    content: userMessageContent, files: userMessageFiles || [],
    versions: versions || [], version_files: versionFiles || [],
    ai_replies: aiReplies || [], ai_files: aiFiles || [],
    current_version_index: currentVersionIndex || 0
  }).eq('id', id);
  await supabase.from('messages').delete().eq('conversation_id', msg.conversation_id).gt('created_at', msg.created_at);
  const { data: newMsg } = await supabase.from('messages').insert({
    conversation_id: msg.conversation_id, role: 'assistant',
    content: assistantContent, files: assistantFiles || []
  }).select().single();
  await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', msg.conversation_id);
  res.json({ assistantMessageId: newMsg?.id });
});

// ---- SHARE ----
app.post('/api/share/guest', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages required' });
  const token = crypto.randomBytes(16).toString('hex');
  const { error } = await supabase.from('guest_shares').insert({ token, messages });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ token, url: `https://deeprwa.agentdomains.co/share/${token}` });
});

app.get('/api/share/:token', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { token } = req.params;
  const { data: sharedChat } = await supabase.from('shared_links').select('conversation_id').eq('token', token).maybeSingle();
  if (sharedChat) {
    const { data: messages } = await supabase.from('messages').select('*').eq('conversation_id', sharedChat.conversation_id).order('created_at');
    return res.json({ type: 'chat', messages: messages || [] });
  }
  const { data: guestShare } = await supabase.from('guest_shares').select('messages').eq('token', token).maybeSingle();
  if (guestShare) return res.json({ type: 'chat', messages: guestShare.messages });
  res.status(404).json({ error: 'Not found' });
});

app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// ---- Static ----
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api|health|robots|sitemap|av\.png|share).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`DeepRWA listening on :${PORT}`));
