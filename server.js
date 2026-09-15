// DeepRWA — Complete backend
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
const brevo = require('@getbrevo/brevo');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// ============ SUPABASE ============
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnon = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) console.warn('⚠️  Supabase credentials not set.');
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;
const supabaseConfigured = !!supabase;

// ============ BREVO ============
let brevoClient = null;
try {
  if (process.env.BREVO_API_KEY) {
    brevoClient = new brevo.TransactionalEmailsApi();
    brevoClient.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
    console.log('✅ Brevo client initialized');
  }
} catch (e) { console.error('❌ Brevo init failed:', e.message); }

async function sendEmailCode(toEmail, code, purpose = 'verification') {
  if (!brevoClient) return false;
  const subjects = {
    signup: 'Your DeepRWA verification code',
    login: 'Your DeepRWA login code',
    reset: 'Your DeepRWA password reset code',
    'change-email': 'Your DeepRWA email change code',
    'change-password': 'Your DeepRWA password change code',
    'delete-account': 'Your DeepRWA account deletion code'
  };
  const plain = `DeepRWA\n\nYour verification code is: ${code}\n\nThis code expires in 15 minutes.\nIf you did not request this, please ignore this email.\n\n— DeepRWA · The Star`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;background:#ffffff;">
  <div style="text-align:center;padding-bottom:16px;border-bottom:1px solid #eaeaea;">
    <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;">
      <span style="color:#111;">Deep</span><span style="color:#00a1de;">R</span><span style="color:#fad201;">W</span><span style="color:#20603d;">A</span>
    </div>
    <div style="font-size:12px;color:#888;margin-top:4px;">Your AI guide to Rwanda</div>
  </div>
  <div style="padding:28px 0;text-align:center;">
    <p style="color:#555;font-size:14px;margin:0 0 16px;">Your verification code is:</p>
    <div style="display:inline-block;background:#f4f6fa;border:1px solid #e2e6ee;border-radius:8px;padding:16px 24px;font-size:28px;font-weight:700;letter-spacing:8px;color:#111;font-family:Consolas,monospace;">${code}</div>
    <p style="color:#888;font-size:12px;margin:20px 0 0;">This code expires in 15 minutes.</p>
  </div>
  <div style="text-align:center;padding-top:16px;border-top:1px solid #eaeaea;color:#999;font-size:11px;">
    If you did not request this, please ignore this email.<br/>— DeepRWA · The Star
  </div>
</div>`;

  const sendSmtpEmail = new brevo.SendSmtpEmail();
  sendSmtpEmail.subject = subjects[purpose] || 'Your DeepRWA verification code';
  sendSmtpEmail.htmlContent = html;
  sendSmtpEmail.textContent = plain;
  sendSmtpEmail.sender = {
    name: 'DeepRWA',
    email: process.env.EMAIL_FROM || 'noreply@deeprwa.agentdomains.co'
  };
  sendSmtpEmail.to = [{ email: toEmail }];
  sendSmtpEmail.headers = {
    'List-Unsubscribe': `<mailto:unsubscribe@deeprwa.agentdomains.co?subject=unsubscribe>`,
    'X-Entity-Ref-ID': crypto.randomBytes(8).toString('hex')
  };
  try {
    const result = await brevoClient.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Email sent to ${toEmail} (${purpose}) — messageId: ${result?.body?.messageId || 'n/a'}`);
    return true;
  } catch (err) {
    console.error(`❌ Brevo send failed for ${toEmail}:`, err.message || err);
    if (err.response && err.response.body) console.error('Brevo response:', JSON.stringify(err.response.body));
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

// ============ JWT HELPERS ============
const JWT_SECRET = process.env.JWT_SECRET;
function signPending(payload, ttlSeconds = 900) { return jwt.sign(payload, JWT_SECRET, { expiresIn: ttlSeconds }); }
function verifyPending(token) { try { return jwt.verify(token, JWT_SECRET); } catch { return null; } }
function stripJwtClaims(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const { exp, iat, nbf, aud, iss, sub, jti, ...rest } = payload;
  return rest;
}

// ============ VALIDATION ============
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const t = email.trim();
  if (t.length < 5 || t.length > 254) return false;
  if (t.includes('..')) return false;
  return EMAIL_RE.test(t);
}
function pwIsStrong(p) { return typeof p === 'string' && p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p); }
function genCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

// ============ USER LOOKUP ============
async function findUserByEmail(email) {
  if (!supabase) return null;
  const target = String(email || '').toLowerCase().trim();
  let page = 1;
  while (page <= 10) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find(u => u.email && u.email.toLowerCase() === target);
    if (found) return found;
    if (users.length < 1000) break;
    page++;
  }
  return null;
}
async function isEmailTakenByOther(email, currentUserId) {
  const user = await findUserByEmail(email);
  if (!user) return false;
  return user.id !== currentUserId;
}

// ============ AUTH ============
function getUserId(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try { const p = jwt.verify(auth.slice(7), JWT_SECRET); return p.sub; } catch { return null; }
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
  const clientId = (req.headers['x-client-id'] || '').toString().trim().slice(0, 80) || null;
  const ua = (req.headers['user-agent'] || 'Unknown').substring(0, 500);
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'Unknown').split(',')[0].trim();
  try {
    if (clientId) {
      const { data: existing } = await supabase.from('sessions').select('id').eq('user_id', userId).eq('client_id', clientId).maybeSingle();
      if (existing) {
        await supabase.from('sessions').update({ device: ua.substring(0, 120), ip, user_agent: ua, last_active: new Date().toISOString() }).eq('id', existing.id);
        return;
      }
    }
    await supabase.from('sessions').insert({ user_id: userId, client_id: clientId, device: ua.substring(0, 120), user_agent: ua, ip });
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

## LANGUAGE RULE
Always reply in the **exact language the user wrote in**.

## IMAGES AND DOCUMENTS (critical)
When files are attached to a user message, they appear as image blocks, document blocks, or a note saying "[N file(s) attached]". If you see such blocks or the note:
- NEVER claim there is no image or document.
- If you can visually see the image content, describe it and answer the user's question about it.
- If vision processing was unavailable and you only see the "[N file(s) attached]" note, tell the user clearly: "I can see you attached N file(s), but I'm currently unable to visually process them due to temporary vision service limits. Please try again in a moment." — do NOT say "I don't see any file".

## RULES
1. Accuracy first.
2. If you cannot find a definitive answer, say so politely. Never invent facts.
3. Be concise, clear, easy to understand. Use Markdown. No raw HTML.
4. Respectful tone always.

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
function normalise(t) { return String(t || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim(); }
function isGreeting(t) {
  const n = normalise(t);
  if (!n) return false;
  if (GREETING_EXACT.has(n)) return true;
  if (n.length > 40) return false;
  return /^(hi|hey|hello|yo|muraho|bonjour|jambo|hola|ciao|hallo)\b/.test(n) && n.split(' ').length <= 4;
}
function isIdentityQuestion(t) { return IDENTITY_PATTERNS.some(r => r.test(normalise(t))); }
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

// ============ VISION PROVIDERS ============
function buildVisionParts(messages, images) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const userMsgs = messages.filter(m => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1];
  return { sys, lastUser };
}

// Gemini Vision (native format)
async function* streamGeminiVision(messages, images) {
  const { sys, lastUser } = buildVisionParts(messages, images);
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
  if (!res.ok) { const err = await res.text(); const e = new Error(`Gemini Vision ${res.status}`); e.status = res.status; throw e; }
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

// OpenRouter Vision (OpenAI format)
async function* streamOpenRouterVision(messages, images) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1];
  const convo = messages.map(m => {
    if (m === lastUser) {
      const content = [{ type: 'text', text: lastUser.content || 'Analyse the attached files.' }];
      for (const img of images) {
        content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
      }
      return { role: 'user', content };
    }
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') return { role: 'assistant', content: m.content };
    return null;
  }).filter(Boolean);

  yield* sseOpenAI(
    'https://openrouter.ai/api/v1/chat/completions',
    { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://deeprwa.agentdomains.co', 'X-Title': 'DeepRWA' },
    { model: 'inclusionai/ling-3.0-flash-vl:free', messages: convo, stream: true, temperature: 0.7, max_tokens: 4096 }
  );
}

// NVIDIA Vision (OpenAI format)
async function* streamNVIDIAVision(messages, images) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1];
  const convo = messages.map(m => {
    if (m === lastUser) {
      const content = [{ type: 'text', text: lastUser.content || 'Analyse the attached files.' }];
      for (const img of images) {
        content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
      }
      return { role: 'user', content };
    }
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') return { role: 'assistant', content: m.content };
    return null;
  }).filter(Boolean);

  yield* sseOpenAI(
    'https://integrate.api.nvidia.com/v1/chat/completions',
    { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
    { model: 'meta/llama-3.2-11b-vision-instruct', messages: convo, stream: true, temperature: 0.7, max_tokens: 4096 }
  );
}

const VISION_PROVIDERS = [
  { name: 'Gemini Vision', fn: streamGeminiVision },
  { name: 'OpenRouter Vision', fn: streamOpenRouterVision },
  { name: 'NVIDIA Vision', fn: streamNVIDIAVision }
];

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
          { role: 'system', content: 'Generate a concise 2-5 word title that captures the topic of the user\'s message. Reply with ONLY the title text — no quotes, no "Title:" prefix, no punctuation at the end.' },
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
  } catch {
    return textOnly.split(/\s+/).slice(0, 6).join(' ') || 'New chat';
  }
}

// ============ ROUTES ============
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'DeepRWA', version: '2.4.0', time: new Date().toISOString() }));

app.get('/api/config', (req, res) => res.json({
  name: 'DeepRWA', tagline: 'Your AI guide to Rwanda', version: '2.4.0',
  supabaseUrl: supabaseUrl || null, supabaseAnonKey: supabaseAnon || null
}));

app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: https://deeprwa.agentdomains.co/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://deeprwa.agentdomains.co/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>`));

app.get('/api/debug/test-email', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'Add ?to=email' });
  const ok = await sendEmailCode(to, '123456', 'signup');
  res.json({ sent: ok, brevoConfigured: !!brevoClient, fromEmail: process.env.EMAIL_FROM || 'noreply@deeprwa.agentdomains.co', to });
});

// ---- AUTH: Signup ----
app.post('/api/auth/signup', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Auth service not configured.' });
  const { email, password, fullName } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (!pwIsStrong(password)) return res.status(400).json({ error: 'Password must be at least 8 characters with letters and numbers' });
  const emailLower = email.toLowerCase().trim();
  const existing = await findUserByEmail(emailLower);
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const code = genCode();
  const pendingToken = signPending({ type: 'signup', email: emailLower, password, fullName: fullName || '', code }, 900);
  const sent = await sendEmailCode(emailLower, code, 'signup');
  if (!sent) return res.status(500).json({ error: 'Could not send verification email. Please try again later.' });
  res.json({ pendingToken, email: emailLower, message: 'Verification code sent' });
});

app.post('/api/auth/confirm-signup', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Auth service not configured.' });
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Token and code required' });
  const payload = verifyPending(pendingToken);
  if (!payload || payload.type !== 'signup') return res.status(400).json({ error: 'Invalid or expired token' });
  if (payload.code !== code) return res.status(400).json({ error: 'Invalid code' });
  const { data: newUser, error } = await supabase.auth.admin.createUser({ email: payload.email, password: payload.password, email_confirm: true });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('profiles').insert({ id: newUser.user.id, email: payload.email, display_name: payload.fullName || null });
  await trackSession(newUser.user.id, req);
  const accessToken = jwt.sign({ sub: newUser.user.id, email: payload.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: newUser.user.id, email: payload.email, display_name: payload.fullName || null } });
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const { pendingToken } = req.body || {};
  if (!pendingToken) return res.status(400).json({ error: 'Token required' });
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'signup') return res.status(400).json({ error: 'Invalid token' });
  const code = genCode();
  const newToken = signPending({ ...stripJwtClaims(p), code }, 900);
  const sent = await sendEmailCode(p.email, code, 'signup');
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken: newToken, email: p.email });
});

// ---- AUTH: Login ----
app.post('/api/auth/login', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Auth service not configured.' });
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (!password) return res.status(400).json({ error: 'Password required' });
  const user = await verifyPassword(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const { data: profile } = await supabase.from('profiles').select('totp_enabled').eq('id', user.id).maybeSingle();
  const code = genCode();
  const pendingToken = signPending({
    type: 'login', userId: user.id, email: user.email, code,
    needs2fa: profile?.totp_enabled || false
  }, 900);
  const sent = await sendEmailCode(user.email, code, 'login');
  if (!sent) return res.status(500).json({ error: 'Could not send login code' });
  res.json({ pendingToken, requiresCode: true, requires2fa: profile?.totp_enabled || false });
});

app.post('/api/auth/verify-login', async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Token and code required' });
  const payload = verifyPending(pendingToken);
  if (!payload || payload.type !== 'login') return res.status(400).json({ error: 'Invalid or expired token' });
  if (payload.code !== code) return res.status(400).json({ error: 'Invalid code' });
  if (payload.needs2fa) {
    const twofaToken = signPending({ type: 'login-2fa', userId: payload.userId, email: payload.email }, 600);
    return res.json({ requires2fa: true, twofaToken });
  }
  await trackSession(payload.userId, req);
  const accessToken = jwt.sign({ sub: payload.userId, email: payload.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: payload.userId, email: payload.email } });
});

app.post('/api/auth/resend-login-code', async (req, res) => {
  const { pendingToken } = req.body || {};
  if (!pendingToken) return res.status(400).json({ error: 'Token required' });
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'login') return res.status(400).json({ error: 'Invalid token' });
  const code = genCode();
  const newToken = signPending({ ...stripJwtClaims(p), code }, 900);
  const sent = await sendEmailCode(p.email, code, 'login');
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken: newToken });
});

app.post('/api/auth/verify-2fa', async (req, res) => {
  const { twofaToken, code } = req.body || {};
  if (!twofaToken || !code) return res.status(400).json({ error: 'Token and code required' });
  const payload = verifyPending(twofaToken);
  if (!payload || payload.type !== 'login-2fa') return res.status(400).json({ error: 'Invalid or expired token' });
  const { data: profile } = await supabase.from('profiles').select('totp_secret').eq('id', payload.userId).maybeSingle();
  if (!profile?.totp_secret) return res.status(400).json({ error: '2FA not configured' });
  const valid = authenticator.verify({ token: code, secret: profile.totp_secret });
  if (!valid) return res.status(400).json({ error: 'Invalid 2FA code' });
  await trackSession(payload.userId, req);
  const accessToken = jwt.sign({ sub: payload.userId, email: payload.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: payload.userId, email: payload.email } });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { data } = await supabase.from('profiles').select('*').eq('id', req.userId).maybeSingle();
  res.json({
    user: {
      id: req.userId, email: data?.email, display_name: data?.display_name,
      totp_enabled: data?.totp_enabled || false, created_at: data?.created_at
    }
  });
});

// ---- Forgot password ----
app.post('/api/auth/forgot-password-request', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { email } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  const user = await findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'No account found with this email' });
  const code = genCode();
  const pendingToken = signPending({ type: 'forgot-password', email: user.email, userId: user.id, code }, 900);
  const sent = await sendEmailCode(user.email, code, 'reset');
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken, email: user.email });
});

app.post('/api/auth/forgot-password-verify-code', async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Token and code required' });
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'forgot-password') return res.status(400).json({ error: 'Invalid or expired token' });
  if (p.code !== code) return res.status(400).json({ error: 'Invalid code' });
  const grantedToken = signPending({ type: 'forgot-password-granted', email: p.email, userId: p.userId }, 600);
  res.json({ grantedToken });
});

app.post('/api/auth/resend-forgot-password-code', async (req, res) => {
  const { pendingToken } = req.body || {};
  if (!pendingToken) return res.status(400).json({ error: 'Token required' });
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'forgot-password') return res.status(400).json({ error: 'Invalid token' });
  const code = genCode();
  const newToken = signPending({ ...stripJwtClaims(p), code }, 900);
  const sent = await sendEmailCode(p.email, code, 'reset');
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken: newToken });
});

app.post('/api/auth/reset-password', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { grantedToken, newPassword } = req.body || {};
  if (!grantedToken || !newPassword) return res.status(400).json({ error: 'Missing data' });
  if (!pwIsStrong(newPassword)) return res.status(400).json({ error: 'Password must be at least 8 chars with letters and numbers' });
  const g = verifyPending(grantedToken);
  if (!g || g.type !== 'forgot-password-granted') return res.status(400).json({ error: 'Invalid token' });
  const same = await verifyPassword(g.email, newPassword);
  if (same) return res.status(400).json({ error: 'New password must be different from the current one' });
  const { error } = await supabase.auth.admin.updateUserById(g.userId, { password: newPassword });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---- Account actions ----
app.post('/api/auth/send-action-code', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { action, newEmail } = req.body || {};
  if (!['change-email', 'change-password', 'delete-account'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  if (!profile?.email) return res.status(400).json({ error: 'Profile not found' });
  let targetEmail = profile.email;
  if (action === 'change-email') {
    if (!isValidEmail(newEmail)) return res.status(400).json({ error: 'Invalid new email' });
    if (newEmail.toLowerCase() === profile.email.toLowerCase()) return res.status(400).json({ error: 'New email must be different' });
    const taken = await isEmailTakenByOther(newEmail, req.userId);
    if (taken) return res.status(400).json({ error: 'That email is already in use' });
    targetEmail = newEmail;
  }
  const code = genCode();
  const pendingToken = signPending({
    type: 'action', action, userId: req.userId, email: profile.email,
    newEmail: action === 'change-email' ? newEmail : null, code
  }, 900);
  const sent = await sendEmailCode(targetEmail, code, action);
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken, targetEmail });
});

app.post('/api/auth/resend-action-code', requireAuth, async (req, res) => {
  const { pendingToken } = req.body || {};
  if (!pendingToken) return res.status(400).json({ error: 'Token required' });
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'action' || p.userId !== req.userId) return res.status(400).json({ error: 'Invalid token' });
  const code = genCode();
  const newToken = signPending({ ...stripJwtClaims(p), code }, 900);
  const targetEmail = p.action === 'change-email' && p.newEmail ? p.newEmail : p.email;
  const sent = await sendEmailCode(targetEmail, code, p.action);
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken: newToken, targetEmail });
});

app.post('/api/auth/verify-action-code', requireAuth, async (req, res) => {
  const { pendingToken, code, action } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Token and code required' });
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'action' || p.userId !== req.userId) return res.status(400).json({ error: 'Invalid token' });
  if (p.action !== action) return res.status(400).json({ error: 'Action mismatch' });
  if (p.code !== code) return res.status(400).json({ error: 'Invalid code' });
  const grantedToken = signPending({ type: 'granted', action: p.action, userId: p.userId, newEmail: p.newEmail || null }, 600);
  res.json({ grantedToken });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { currentPassword, newPassword, grantedToken } = req.body || {};
  if (!pwIsStrong(newPassword)) return res.status(400).json({ error: 'Password must be at least 8 chars with letters and numbers' });
  const g = verifyPending(grantedToken);
  if (!g || g.type !== 'granted' || g.action !== 'change-password' || g.userId !== req.userId) return res.status(400).json({ error: 'Invalid or expired token' });
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  const user = await verifyPassword(profile?.email, currentPassword);
  if (!user) return res.status(401).json({ error: 'Current password is incorrect' });
  const same = await verifyPassword(profile?.email, newPassword);
  if (same) return res.status(400).json({ error: 'New password must be different from the current one' });
  const { error } = await supabase.auth.admin.updateUserById(req.userId, { password: newPassword });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/auth/verify-current-password', requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  const user = await verifyPassword(profile?.email, password);
  if (!user) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ valid: true });
});

app.post('/api/auth/change-email', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { grantedToken } = req.body || {};
  const g = verifyPending(grantedToken);
  if (!g || g.type !== 'granted' || g.action !== 'change-email' || g.userId !== req.userId || !g.newEmail) return res.status(400).json({ error: 'Invalid or expired token' });
  if (!isValidEmail(g.newEmail)) return res.status(400).json({ error: 'Invalid email' });
  const taken = await isEmailTakenByOther(g.newEmail, req.userId);
  if (taken) return res.status(400).json({ error: 'That email is already in use' });
  const { error } = await supabase.auth.admin.updateUserById(req.userId, { email: g.newEmail, email_confirm: true });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('profiles').update({ email: g.newEmail }).eq('id', req.userId);
  res.json({ success: true, newEmail: g.newEmail });
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { grantedToken } = req.body || {};
  const g = verifyPending(grantedToken);
  if (!g || g.type !== 'granted' || g.action !== 'delete-account' || g.userId !== req.userId) return res.status(400).json({ error: 'Invalid or expired token' });
  await supabase.from('sessions').delete().eq('user_id', req.userId);
  const { error } = await supabase.auth.admin.deleteUser(req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---- 2FA ----
app.post('/api/auth/2fa/setup', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { data: profile } = await supabase.from('profiles').select('email, totp_enabled').eq('id', req.userId).maybeSingle();
  if (profile?.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(profile?.email || 'user', 'DeepRWA', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 240, margin: 1, color: { dark: '#e6e8eb', light: '#0a0a0a' } });
  await supabase.from('profiles').update({ totp_secret: secret }).eq('id', req.userId);
  res.json({ secret, otpauth, qrDataUrl });
});

app.post('/api/auth/2fa/enable', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { code } = req.body || {};
  const { data: profile } = await supabase.from('profiles').select('totp_secret').eq('id', req.userId).maybeSingle();
  if (!profile?.totp_secret) return res.status(400).json({ error: 'Start setup first' });
  const valid = authenticator.verify({ token: code, secret: profile.totp_secret });
  if (!valid) return res.status(400).json({ error: 'Invalid 2FA code' });
  await supabase.from('profiles').update({ totp_enabled: true }).eq('id', req.userId);
  res.json({ success: true });
});

app.post('/api/auth/2fa/disable', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { code } = req.body || {};
  const { data: profile } = await supabase.from('profiles').select('totp_secret').eq('id', req.userId).maybeSingle();
  if (!profile?.totp_secret) return res.status(400).json({ error: '2FA not enabled' });
  const valid = authenticator.verify({ token: code, secret: profile.totp_secret });
  if (!valid) return res.status(400).json({ error: 'Invalid 2FA code' });
  await supabase.from('profiles').update({ totp_enabled: false, totp_secret: null }).eq('id', req.userId);
  res.json({ success: true });
});

// ---- Sessions ----
app.get('/api/auth/sessions', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ sessions: [] });
  const clientId = req.headers['x-client-id'] || '';
  const { data } = await supabase.from('sessions').select('*').eq('user_id', req.userId).order('last_active', { ascending: false });
  const sessions = (data || []).map(s => ({ ...s, current: s.client_id === clientId }));
  res.json({ sessions });
});

app.get('/api/auth/session-check', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.json({ valid: true });
  const clientId = req.headers['x-client-id'] || '';
  const { data } = await supabase.from('sessions').select('id, client_id').eq('user_id', req.userId);
  const rows = data || [];
  const byClient = clientId ? rows.find(s => s.client_id === clientId) : null;
  if (byClient) {
    await supabase.from('sessions').update({ last_active: new Date().toISOString() }).eq('id', byClient.id);
    return res.json({ valid: true });
  }
  return res.json({ valid: false });
});

app.delete('/api/auth/sessions/:id', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const clientId = req.headers['x-client-id'] || '';
  const { data: row } = await supabase.from('sessions').select('client_id').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
  if (row && row.client_id === clientId) return res.status(400).json({ error: 'Use the account menu to log out the current session' });
  await supabase.from('sessions').delete().eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});

app.delete('/api/auth/sessions-all-others', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const clientId = req.headers['x-client-id'] || '';
  if (clientId) await supabase.from('sessions').delete().eq('user_id', req.userId).neq('client_id', clientId);
  else await supabase.from('sessions').delete().eq('user_id', req.userId);
  res.json({ success: true });
});

// ---- FILE UPLOAD (10 MB) ----
app.post('/api/upload', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Not configured' });
  const { name, type, data } = req.body || {};
  if (!name || !type || !data) return res.status(400).json({ error: 'Missing file data' });
  try {
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 10 MB)' });
    }
    const ext = (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const filePath = `${req.userId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const { error: upErr } = await supabase.storage.from('uploads').upload(filePath, buffer, { contentType: type, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(filePath);
    res.json({ url: urlData.publicUrl, name, type });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    await supabase.from('messages').insert({
      conversation_id: convId,
      role: 'user',
      content: lastMsg.content,
      files: Array.isArray(lastMsg.files) ? lastMsg.files : []
    });
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

  if ((!images || !images.length)) {
    if (isIdentityQuestion(userText)) { for (const c of IDENTITY_REPLY) send({ text: c }); return done(); }
    if (isGreeting(userText) && messages.length <= 2) {
      const r = buildGreetingReply(userText);
      for (const c of r) send({ text: c });
      return done();
    }
  }

  // When images present, try vision providers in order
  if (images && images.length) {
    let visionText = '';
    let visionStarted = false;
    for (const vp of VISION_PROVIDERS) {
      try {
        visionText = '';
        visionStarted = false;
        const msgsWithNote = messages; // unchanged — vision providers handle images natively
        for await (const chunk of vp.fn(msgsWithNote, images)) {
          visionStarted = true;
          visionText += chunk;
          send({ text: chunk });
        }
        if (visionStarted && visionText.trim()) {
          if (conversationId && supabase) {
            await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: visionText });
          }
          return done();
        }
        throw new Error('empty');
      } catch (e) {
        console.warn(`[fail] ${vp.name}: ${e.message}`);
        continue;
      }
    }
    // All vision providers failed — add note so text-only models don't deny images
    console.warn('All vision providers failed — falling back with file note');
    const note = `\n\n[${images.length} file(s) attached — vision service temporarily unavailable]`;
    const lastUserIdx = messages.length - 1;
    if (messages[lastUserIdx] && messages[lastUserIdx].role === 'user') {
      messages = messages.map((m, i) => i === lastUserIdx ? { ...m, content: m.content + note } : m);
    }
  }

  const full = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  let lastErr = null;

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

// Fixed: scoped to user's conversations only
app.get('/api/files', requireAuth, async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ files: [] });
  const { data: convs } = await supabase.from('conversations').select('id').eq('user_id', req.userId);
  const convIds = (convs || []).map(c => c.id);
  if (!convIds.length) return res.json({ files: [] });
  const { data } = await supabase
    .from('messages')
    .select('files, created_at, role')
    .in('conversation_id', convIds)
    .not('files', 'is', null)
    .order('created_at', { ascending: false });
  const all = [];
  for (const row of (data || [])) {
    if (Array.isArray(row.files)) {
      for (const f of row.files) {
        if (f && (f.url || f.public_url)) {
          all.push({ ...f, created_at: row.created_at, role: row.role });
        }
      }
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
