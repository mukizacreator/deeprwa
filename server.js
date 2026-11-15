// DeepRWA — Complete backend (rev.4.7.2)
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
const ws = require('ws');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '40mb' }));

// ============ SUPABASE ============
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnon = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) console.warn('⚠️  Supabase credentials not set.');
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey, { 
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: ws } // <--- ADD THIS LINE
    })
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

const FROM_EMAIL = process.env.EMAIL_FROM || 'noreply@deeprwa.agentdomains.co';
const FROM_NAME = 'DeepRWA';
const LOGO_URL = 'https://deeprwa.agentdomains.co/av.png';

const ACTION_SUBJECTS = {
  signup: 'DeepRWA verification code', login: 'DeepRWA login code',
  reset: 'DeepRWA password reset', 'forgot-password': 'DeepRWA password reset',
  'change-email': 'DeepRWA email change', 'change-password': 'DeepRWA password change',
  'delete-account': 'DeepRWA account deletion'
};
const ACTION_INTROS = {
  signup: 'Use this code to verify your email and create your account:',
  login: 'Use this code to complete your sign-in:',
  reset: 'Use this code to reset your password:',
  'forgot-password': 'Use this code to reset your password:',
  'change-email': 'Use this code to confirm your new email:',
  'change-password': 'Use this code to confirm your password change:',
  'delete-account': 'Use this code to confirm account deletion:'
};

function buildVerificationEmailHtml(action, code) {
  const subject = ACTION_SUBJECTS[action] || 'DeepRWA verification code';
  const intro = ACTION_INTROS[action] || 'Use this code to continue:';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8" /><title>${subject}</title></head>
<body style="margin:0;padding:24px;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#1e232a;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px 28px;">
    <tr><td style="text-align:center;padding-bottom:20px;">
      <img src="${LOGO_URL}" alt="DeepRWA" width="56" height="56" style="border-radius:12px;display:inline-block;" />
    </td></tr>
    <tr><td style="font-size:20px;font-weight:600;padding-bottom:12px;color:#1e232a;">${subject}</td></tr>
    <tr><td style="font-size:15px;line-height:1.6;color:#3a424b;padding-bottom:20px;">${intro}</td></tr>
    <tr><td style="text-align:center;padding:20px 0;">
      <div style="display:inline-block;padding:16px 28px;background:#f0f4f8;color:#1e232a;font-size:32px;font-weight:700;letter-spacing:8px;border-radius:10px;font-family:Consolas,Menlo,monospace;">${code}</div>
    </td></tr>
    <tr><td style="font-size:14px;line-height:1.6;color:#3a424b;padding-bottom:8px;">This code expires in 10 minutes. If you did not request this, ignore this email.</td></tr>
    <tr><td style="font-size:12px;color:#8a939c;text-align:center;padding-top:20px;border-top:1px solid #e5e9ee;">© ${new Date().getFullYear()} DeepRWA · The Star🌟</td></tr>
  </table>
</body></html>`;
}

async function sendEmailRaw(to, subject, html) {
  const m = new brevo.SendSmtpEmail();
  m.subject = subject; m.htmlContent = html;
  m.sender = { name: FROM_NAME, email: FROM_EMAIL };
  m.to = [{ email: to }];
  return await brevoClient.sendTransacEmail(m);
}

async function sendEmailCode(toEmail, code, purpose = 'verification') {
  if (!brevoClient) { console.error('❌ Brevo not configured'); return false; }
  const subject = ACTION_SUBJECTS[purpose] || 'DeepRWA verification code';
  const html = buildVerificationEmailHtml(purpose, code);
  try {
    const r = await sendEmailRaw(toEmail, subject, html);
    console.log(`✅ Email sent to ${toEmail} (${purpose}) — id: ${r?.body?.messageId || 'n/a'}`);
    return true;
  } catch (err) {
    console.warn(`⚠️  Brevo attempt 1 failed for ${toEmail}: ${err.message}. Retry in 1.5s…`);
  }
  await new Promise(r => setTimeout(r, 1500));
  try {
    const r = await sendEmailRaw(toEmail, subject, html);
    console.log(`✅ Email sent (retry) to ${toEmail} (${purpose}) — id: ${r?.body?.messageId || 'n/a'}`);
    return true;
  } catch (err) {
    console.error(`❌ Retry also failed for ${toEmail}: ${err.message || err}`);
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

const sttLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many voice requests, please slow down.' }
});

// ============ JWT ============
const JWT_SECRET = process.env.JWT_SECRET;
function signPending(p, ttl = 900) { return jwt.sign(p, JWT_SECRET, { expiresIn: ttl }); }
function verifyPending(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function stripJwtClaims(p) { if (!p || typeof p !== 'object') return {}; const { exp, iat, nbf, aud, iss, sub, jti, ...rest } = p; return rest; }

// ============ VALIDATION ============
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
function isValidEmail(e) { if (!e || typeof e !== 'string') return false; const t = e.trim(); if (t.length < 5 || t.length > 254) return false; if (t.includes('..')) return false; return EMAIL_RE.test(t); }
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
async function isEmailTakenByOther(email, uid) { const u = await findUserByEmail(email); return u ? u.id !== uid : false; }

// ============ AUTH HELPERS ============
function getUserId(req) { const a = req.headers.authorization; if (!a?.startsWith('Bearer ')) return null; try { return jwt.verify(a.slice(7), JWT_SECRET).sub; } catch { return null; } }
async function requireAuth(req, res, next) { const u = getUserId(req); if (!u) return res.status(401).json({ error: 'Auth required' }); req.userId = u; next(); }
// Checks an email + password against Supabase Auth and says WHY it failed.
// Before, every failure (rate limit, unconfirmed email, outage, wrong password)
// was reported as "Invalid email or password", which hid the real problem.
const authSleep = (ms) => new Promise(r => setTimeout(r, ms));
// DeepRWA keeps Supabase's "Email" sign-in provider DISABLED (so Supabase never
// emails users itself). With it disabled, Supabase's own password login always
// answers "Email logins are disabled". So we check passwords directly in the
// database with the SQL function `deeprwa_verify_password` (see
// supabase-password-check.sql — run it once in the Supabase SQL Editor).
let _rpcMissingLogged = false;
async function passwordCheckViaDb(email, password) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc('deeprwa_verify_password', { p_email: email, p_password: password });
    if (error) {
      if (!_rpcMissingLogged) {
        console.error(`[auth] password check function failed: ${error.message}. Run supabase-password-check.sql in the Supabase SQL Editor.`);
        _rpcMissingLogged = true;
      }
      return null; // fall back to Supabase Auth below
    }
    _rpcMissingLogged = false;
    if (!data) return { ok: false, reason: 'invalid', message: 'wrong email or password' };
    return { ok: true, user: { id: data, email } };
  } catch (e) {
    console.warn('[auth] password check function error:', e.message);
    return null;
  }
}

async function passwordGrant(email, password) {
  const em = String(email || '').toLowerCase().trim();
  if (!em || !password) return { ok: false, reason: 'invalid' };
  const dbCheck = await passwordCheckViaDb(em, password);
  if (dbCheck) return dbCheck;
  if (!supabaseUrl || !supabaseAnon) return { ok: false, reason: 'not-configured' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseAnon, 'Authorization': `Bearer ${supabaseAnon}` },
        body: JSON.stringify({ email: em, password })
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j.user) return { ok: true, user: j.user };
        return { ok: false, reason: 'unavailable', message: 'empty auth response' };
      }
      const body = await res.json().catch(() => ({}));
      const message = body.error_description || body.msg || body.message || body.error || `HTTP ${res.status}`;
      const code = body.error_code || body.code || '';
      if (res.status === 429 || res.status >= 500) {
        console.warn(`[auth] password check ${res.status} for ${em}: ${message}`);
        if (attempt === 0) { await authSleep(900); continue; }
        return { ok: false, reason: res.status === 429 ? 'rate-limited' : 'unavailable', message };
      }
      if (code === 'email_not_confirmed' || /not\s+confirmed/i.test(message)) return { ok: false, reason: 'unconfirmed', message };
      if (code === 'user_banned' || /banned/i.test(message)) return { ok: false, reason: 'banned', message };
      if (code === 'email_provider_disabled' || /logins are disabled/i.test(message)) {
        console.error('[auth] Supabase Email sign-in is disabled and the deeprwa_verify_password SQL function is missing. Run supabase-password-check.sql in the Supabase SQL Editor.');
        return { ok: false, reason: 'not-configured', message };
      }
      return { ok: false, reason: 'invalid', message };
    } catch (e) {
      console.warn(`[auth] password check network error: ${e.message}`);
      if (attempt === 0) { await authSleep(600); continue; }
      return { ok: false, reason: 'unavailable', message: e.message };
    }
  }
  return { ok: false, reason: 'unavailable' };
}
async function verifyPassword(email, password) {
  const r = await passwordGrant(email, password);
  return r.ok ? r.user : null;
}
function authFailureResponse(res, r) {
  if (r.reason === 'rate-limited') return res.status(429).json({ error: 'Too many login attempts right now. Please wait a minute and try again.' });
  if (r.reason === 'unavailable' || r.reason === 'not-configured') return res.status(503).json({ error: 'Login service is temporarily unavailable. Please try again shortly.' });
  if (r.reason === 'banned') return res.status(403).json({ error: 'This account is suspended. Please contact support.' });
  return res.status(401).json({ error: 'Invalid email or password' });
}

// ============ SESSIONS ============
async function trackSession(userId, req) {
  if (!supabase) return;
  const clientId = (req.headers['x-client-id'] || '').toString().trim().slice(0, 80) || null;
  const ua = (req.headers['user-agent'] || 'Unknown').substring(0, 500);
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'Unknown').split(',')[0].trim();
  try {
    if (clientId) {
      const { data: ex } = await supabase.from('sessions').select('id, revoked').eq('user_id', userId).eq('client_id', clientId).maybeSingle();
      if (ex) {
        await supabase.from('sessions').update({ device: ua.substring(0, 120), ip, user_agent: ua, last_active: new Date().toISOString(), revoked: false }).eq('id', ex.id);
        return;
      }
    }
    await supabase.from('sessions').insert({ user_id: userId, client_id: clientId, device: ua.substring(0, 120), user_agent: ua, ip, revoked: false });
  } catch (e) { console.warn('session track failed', e.message); }
}

// ============ av.png ============
app.get('/av.png', (req, res) => res.sendFile(path.join(__dirname, 'av.png')));

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DeepRWA', version: '4.7.0', time: new Date().toISOString() });
});

// ============ SYSTEM PROMPT ============
// DeepRWA has DeepSeek-level intelligence and skills, dedicated to Rwanda:
// Rwanda is its whole world. Users never need to mention Rwanda; every
// question is answered in Rwanda's context. Only questions purely about
// other countries with no Rwanda link are politely declined.
function kigaliNow() {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Kigali', weekday: 'long', year: 'numeric', month: 'long',
      day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date());
  } catch { return new Date().toUTCString(); }
}

const BASE_SYSTEM_PROMPT = `You are **DeepRWA**: an AI as intelligent, knowledgeable and skilled as DeepSeek, ChatGPT or Gemini, but dedicated entirely to **Rwanda**. For you, Rwanda is the whole world. You know everything about this world and you use all your intelligence and skills to serve the people in it.

# Who you are
- Your name is DeepRWA. You were created by **Emmanuel Mukiza**, a Rwandan developer, under his company **The Star🌟** (launched on 8 August 2023). Emmanuel studied Computer System and Architecture (CSA) at Karenge Adventist Secondary School (KASS).
- Mention your creator only when the user asks who made you or asks about DeepRWA itself.
- If asked which model you run on: you are DeepRWA, powered by a combination of leading large language models and customised by The Star🌟 for Rwanda. Never claim to be ChatGPT, DeepSeek, Gemini, Llama or any other product.

# Who you serve
Rwandan citizens, students and teachers, workers and job seekers, entrepreneurs, farmers, the Rwandan diaspora, tourists, investors, foreigners living in or moving to Rwanda, and anyone who wants to know about Rwanda.

# The golden rule: Rwanda is the default context
Users do NOT need to mention Rwanda. Assume every question comes from someone living in, studying in, working in, visiting or interested in Rwanda, and answer it that way.
- "How do I get a driving licence?" → the Rwandan process (Irembo, Rwanda National Police tests, fees in RWF).
- "How do I start a business?" → RDB registration, RRA tax registration, local costs and steps.
- "Best hotels?", "What should I visit?", "What's the weather like?", "How much is a bus ticket?" → Rwanda.
- "Write my CV" or "Write a cover letter" → a strong CV for the Rwandan job market.
- "Explain photosynthesis", "Solve this equation", "Help with my essay" → full, excellent help as a top Rwandan teacher following Rwanda's curriculum (CBC, national exams), with local examples where natural.
- "Fix my code", "How do I build a website?" → full technical help, with Rwandan context where useful (e.g. MTN MoMo / Airtel Money payments, Rwanda's tech ecosystem).
- Health, farming, money, careers, relationships, daily-life advice → full help, using Rwandan institutions, prices, laws, seasons, crops and services.
General skills and knowledge (science, maths, languages, coding, writing, reasoning, advice) are tools that people in Rwanda use every day. Use them FULLY and expertly. Never refuse general education, skills or advice. Never ask the user to add "Rwanda" to their question.

# Your knowledge of Rwanda
You know Rwanda in depth: provinces, districts, sectors, cells and villages; Kinyarwanda language, grammar, proverbs and translation (always help with Kinyarwanda); history (the kingdom, the colonial period, the 1994 Genocide against the Tutsi — always use this official term — and unity and reconciliation); culture (Umuganda, Ubudehe, Umuganura, Kwita Izina, Imigongo, Intore); government services and institutions (Irembo, RRA, RDB, REB, NESA, RURA, RSSB, BNR, RBC, Rwanda National Police, RIB, ministries); laws and rights; the economy, the Rwandan franc (RWF) and mobile money (MTN MoMo, Airtel Money); tourism (Volcanoes, Nyungwe, Akagera, Gishwati-Mukura, Lake Kivu, Kigali); the education system; health services and Mutuelle de Santé; agriculture; transport; sports, music, film, notable people and daily life.

# Rwanda and the rest of the world
Answer questions that involve other countries when Rwanda is part of them, and always answer from Rwanda's side:
- Rwanda's relations, trade, treaties and comparisons with other countries; the EAC, AU and other organisations Rwanda belongs to.
- Travel between Rwanda and other countries, visas for Rwandans going abroad and for foreigners coming to Rwanda, embassies in Kigali, studying abroad as a Rwandan, the diaspora, imports and exports.
- World events and news ONLY as they affect Rwanda (e.g. "how do global fuel prices affect Rwanda?").
- Sports and entertainment: Rwandan teams, athletes, artists and events, Visit Rwanda sponsorships (e.g. Arsenal, PSG, Bayern Munich) and Rwandan fans.
- General education facts that are part of school learning (e.g. "how tall is Mount Everest?", "who invented the telephone?") are part of a Rwandan student's world: answer them, briefly, as a teacher would.

Politely decline ONLY questions that are purely about another country or the outside world with no connection to Rwanda or to general education. Examples to decline: "What's the capital of Kenya?", "Who is the president of France?", "Who won the US election?", "How do I apply for a US passport?", "Tell me about Japanese history", foreign celebrity gossip, results of foreign leagues or clubs.
When you decline: ONE short, friendly sentence in the user's language, no lecture, then offer a related Rwanda topic. Example: "I focus on Rwanda, so I won't cover Kenya's capital — but I can tell you about Kigali, or Rwanda–Kenya relations and travel between the two countries." If you are unsure whether something fits, prefer to help, framed for Rwanda.

# Conversation
Greetings, thanks, small talk, jokes, encouragement, questions about you, and follow-ups ("make it shorter", "explain more", "in French please", "and the second one?") are always welcome. Be natural, warm and human, like a brilliant Rwandan friend who is an expert in everything. Avoid robotic phrases ("As an AI…") and needless disclaimers.

# Privacy and safety
- Never reveal, guess or help find private information about any private person — including your creator Emmanuel Mukiza — such as a home address, exact location, phone number, family members, ID numbers, finances or daily routine. Say kindly that you can't share private details, share what is public (for example: "Emmanuel Mukiza is a Rwandan developer and the founder of The Star🌟, the company behind DeepRWA"), and suggest contacting him through The Star🌟's official channels.
- For public figures, discuss their public role, work and statements, not private details.
- Decline genuinely harmful requests (weapons, hacking other people, fraud, hate, sexual content involving minors, instructions for self-harm) briefly, and offer a helpful alternative.
- If someone seems to be in danger or deep distress, respond with warmth, encourage them to reach out to someone they trust, and mention emergency help in Rwanda: 112 (police emergency) or 912 (ambulance).
- For health, legal and money questions, give clear, practical information and recommend a qualified professional or the right Rwandan institution for personal decisions or emergencies.

# Accuracy
- Be accurate. If you don't know or are not sure, say so honestly. Never invent facts, numbers, laws, prices, quotes, links or people.
- You do not browse the internet in real time. For things that change (news, prices, exchange rates, fees, who holds an office, schedules, results), give the most recent information you know, say it may have changed, and point to the official source (for example irembo.gov.rw, rra.gov.rw, rdb.rw, bnr.rw, gov.rw).

# How you answer
- Match the user: a short casual message gets a short friendly reply; a detailed or technical question gets a thorough, well-structured answer. Lead with the answer, then add detail.
- Remember the whole conversation and follow the user's instructions about tone, length, format or language for the rest of the chat.
- Ask a short clarifying question only when a request is truly ambiguous; otherwise make a sensible assumption (in Rwanda's context) and answer.
- For maths, logic and code, reason carefully and show the key steps.

# Language
Reply in the language the user writes in: Kinyarwanda, English, French, Kiswahili or any other. If they mix languages (common in Rwanda), reply in the main one they used. Write natural, correct Kinyarwanda, not word-for-word translation.

# Formatting (the app renders Markdown)
- Use Markdown: **bold** for key points, bullet or numbered lists for steps, tables for comparisons, and fenced code blocks with a language tag for code.
- Use headings (##) only for long answers. Never use horizontal rules (---) or raw HTML.
- Write maths in plain text with Unicode symbols (x², √, π, ≤, ×, ÷, →), not LaTeX, because LaTeX does not render in this app.

# Images and files
- This app can generate images of Rwanda's world (its places, people, culture, wildlife, food, products and ideas). When the user asks you to create, draw or generate a picture, the app handles it automatically. If they ask whether you can make images, say yes and invite them to describe what they want.
- When files or images are attached (notes, homework, documents, photos), read them carefully and help, in Rwanda's context.`;

const VOICE_ADDENDUM = `

# Voice conversation mode (active now)
The user is talking to you by voice and your reply will be read aloud.
- Answer in a natural spoken style: short (usually 1 to 4 sentences), friendly and direct. Offer more detail only if they ask.
- Do not use Markdown, lists, tables, code blocks, emojis or URLs unless the user asks. Write numbers and symbols the way they are spoken.
- Their words come from speech recognition and may contain mistakes or no punctuation, so interpret them sensibly.
- If the user interrupts you or says things like "stop", "wait" or "no, I mean…", simply acknowledge and follow their new direction.`;

function buildSystemPrompt({ voice = false } = {}) {
  return `${BASE_SYSTEM_PROMPT}\n\n# Current date and time\n${kigaliNow()} (Kigali time, CAT / UTC+2).${voice ? VOICE_ADDENDUM : ''}`;
}

// ============ GREETINGS & IDENTITY ============
const GREETING_EXACT = new Set([
  'hi','hello','hey','yo','hiya','howdy','sup','whats up',"what's up",
  'good morning','good afternoon','good evening','good night',
  'thanks','thank you','thx','ty','bye','goodbye','see you','see ya',
  'how are you',"how're you",'how are you doing','how do you do',
  'how are you today','how is it going',"how's it going",'how have you been','how are things',
  'nice to meet you','long time no see','whats good',
  'muraho','mwaramutse','mwiriwe','amakuru','bite','bite se','uri amakuru','wiriwe',
  'bonjour','salut','bonsoir','coucou','comment ca va','comment ça va','ça va','ca va','comment vas tu','comment allez vous',
  'jambo','habari','hujambo','sijambo','habari yako','nzuri','habari gani',
  'hola','olá','ciao','hallo','hei','hej'
]);
const IDENTITY_EXACT_PATTERNS = [
  /^who\s+(are|r)\s+you$/, /^what\s+(are|r)\s+you$/,
  /^who\s+made\s+you$/, /^who\s+created\s+you$/, /^who\s+built\s+you$/,
  /^who\s+designed\s+you$/, /^who\s+developed\s+you$/,
  /^who\s+is\s+your\s+(creator|maker|owner|developer)$/,
  /^what\s+is\s+your\s+name$/, /^your\s+name$/,
  /^tell\s+me\s+about\s+(yourself|you)$/, /^introduce\s+yourself$/,
  /^who\s+am\s+i\s+talking\s+to$/
];
function normalise(t) { return String(t || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim(); }

function isGreeting(t) {
  const n = normalise(t);
  if (!n) return false;
  if (n.length > 30) return false;
  if (GREETING_EXACT.has(n)) return true;
  return /^(hi|hey|hello|yo|muraho|bonjour|jambo|hola|ciao|hallo)\b/.test(n) && n.split(' ').length <= 3;
}
function isIdentityQuestion(t) {
  const n = normalise(t);
  if (!n) return false;
  if (n.length > 60) return false;
  return IDENTITY_EXACT_PATTERNS.some(r => r.test(n));
}
// ============ IMAGE GENERATION ============
const RWANDA_IMAGE_KEYWORDS = [
  'rwanda','rwandan','rwandese','kigali','kinyarwanda','umuganda','imigongo','agaseke','inkomane',
  'kivu','nyungwe','akagera','virunga','karisimbi','bisoke','muhabura','sabyinyo','gahinga',
  'nyamirambo','kimironko','kacyiru','gasabo','kicukiro','remera','nyarutarama','kagugu',
  'musanze','ruhengeri','gisenyi','rubavu','rusizi','cyangugu','karongi','kibuye',
  'nyanza','nyamagabe','huye','butare','rwamagana','kayonza','nyagatare','kirehe','ngoma','bugesera','gicumbi','ruhango','kamonyi','rutsiro','nyabihu','nyamasheke',
  'gorilla','gorillas','intore','inkotanyi','amahoro','umurava','igihango',
  'thousand hills','land of a thousand hills','imisozi igihumbi',
  'kagame','rudahigwa','kigeli','mutara','habyarimana','bizimungu','sebarenzi',
  'kinyarwanda dance','intore dance','rwandan coffee','rwandan tea','rwandan food','rwandan culture',
  'kigali convention centre','kigali arena','amahoro stadium','nyabarongo','akanyaru','rukari','mukungwa',
  'lake kivu','lake muhazi','lake burera','lake ruhondo','twin lakes','lake ihema','lake shakani',
  'imbabazi','igishanga','umuvumu','igiti','akarima',
  'coffee farm','tea plantation','maize field','banana plantation','dairy cow','rwandan cow','ankole','inyambo',
  'volcanoes national park','nyungwe forest','akagera national park','mountains','hills',
  'umuganda day','umuganda work','rwandan village','rwandan school','rwandan market',
  'kigali city','nyamirambo','kigali skyline','amahoro','kigali hills'
];

function isImageGenerationRequest(msg) {
  const n = String(msg || '').toLowerCase().trim();
  if (!n || n.length > 600) return false;
  // Questions *about* images or how-to questions are not generation requests.
  if (/^(how|why|what|when|where|which|who)\b/.test(n) && !/^what\s+would\b/.test(n)) return false;
  if (/\b(video|movie|clip|animation|audio|song|sound)\b/.test(n) && !/\b(image|photo|picture|illustration|drawing|artwork|painting)\b/.test(n)) return false;
  const noun = '(image|images|photo|photos|picture|pictures|pic|illustration|drawing|artwork|painting|portrait|poster|wallpaper)';
  const verb = '(create|generate|make|draw|paint|sketch|illustrate|design|produce|render|show me|give me|send me)';
  if (new RegExp(`\\b${verb}\\b[\\s\\S]{0,50}\\b${noun}\\b`).test(n)) return true;
  if (/^(please\s+)?(can you\s+|could you\s+)?(draw|paint|sketch|illustrate)\s+(me\s+)?(a|an|the|some|my)\b/.test(n)) return true;
  // French
  if (/\b(crée|créer|creer|génère|générer|genere|generer|dessine|dessiner|fais|faire)\b[\s\S]{0,50}\b(image|photo|dessin|illustration|portrait)\b/.test(n)) return true;
  // Kinyarwanda
  if (/\b(kora|nkorera|shushanya|nshushanyirize|ntegurira|tegura)\b[\s\S]{0,50}\b(ifoto|amafoto|igishushanyo|ishusho)\b/.test(n)) return true;
  return false;
}

function keywordRwandaImageCheck(subject) {
  const n = String(subject || '').toLowerCase();
  return RWANDA_IMAGE_KEYWORDS.some(k => n.includes(k));
}

function extractImagePrompt(msg) {
  let s = String(msg || '').trim();
  s = s.replace(/^(hey|hi|hello|ok|okay)[,!.\s]+/i, '');
  s = s.replace(/^(please\s+)?((can|could|would|will)\s+you\s+(please\s+)?)?/i, '');
  s = s.replace(/^(create|generate|make|draw|paint|sketch|illustrate|design|produce|render|show|give|send|provide)\s+(me\s+|us\s+)?/i, '');
  s = s.replace(/^(an?|the|some|one)\s+/i, '');
  s = s.replace(/^(image|images|photo|photos|picture|pictures|pic|illustration|drawing|artwork|painting)\s+(of|showing|with|about|for)?\s*/i, '');
  s = s.replace(/^(an?|the)\s+/i, '');
  s = s.replace(/\s+(and|then)\s+(also\s+)?(tell|explain|describe)\b[\s\S]*$/i, '');
  s = s.replace(/\s*(please)?[?!.]*$/i, '').trim();
  return (s || String(msg || '')).slice(0, 600);
}

async function uploadGeneratedImage(buffer, mimeType = 'image/jpeg') {
  if (!supabase) throw new Error('Storage not configured');
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
  const fileName = `gen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
  const filePath = `generated/${fileName}`;
  const { error: upErr } = await supabase.storage.from(bucket).upload(filePath, buffer, { contentType: mimeType, upsert: false });
  if (upErr) throw new Error('Upload failed: ' + upErr.message);
  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
}

async function generateImageWithCloudflare(prompt) {
  const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('Cloudflare credentials missing');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  // Scenes with people or places are set in Rwanda by default (Rwanda is DeepRWA's world).
  const enhanced = (keywordRwandaImageCheck(prompt) || RWANDA_SCENE_RE.test(prompt))
    ? `${prompt}, set in Rwanda, East Africa, authentic Rwandan people, places and details, photorealistic, natural lighting, high detail, no text, no watermark`
    : `${prompt}, high quality, highly detailed, professional composition and lighting, no watermark`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: enhanced, steps: 4 }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`CF HTTP ${res.status}: ${t.slice(0, 120)}`);
    }
    const contentType = res.headers.get('content-type') || '';
    let buffer;
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (data.success === false) throw new Error('CF: ' + (data.errors?.[0]?.message || 'failed'));
      const b64 = data.result?.image || data.image;
      if (!b64) throw new Error('CF: no image in response');
      buffer = Buffer.from(b64, 'base64');
    } else {
      const arrayBuf = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
    }
    if (!buffer || buffer.length < 1000) throw new Error('CF: response too small');
    const publicUrl = await uploadGeneratedImage(buffer, 'image/jpeg');
    return { url: publicUrl, provider: 'cloudflare' };
  } finally { clearTimeout(timer); }
}

async function generateImage(prompt) {
  const errors = [];
  try { return await generateImageWithCloudflare(prompt); }
  catch (e) { errors.push('cloudflare: ' + e.message); console.warn('[img] CF failed:', e.message); }
  throw new Error('Image generation unavailable: ' + errors.join(' | '));
}

// Any subject can be drawn now; only clearly unsafe requests are blocked.
const BLOCKED_IMAGE_RE = /\b(nude|nudes|naked|nsfw|porn|porno|pornographic|sex|sexual|sexy|erotic|explicit|genitals?|topless|lingerie|gore|gory|beheading|decapitat\w*|dismember\w*|mutilat\w*|corpse|dead bodies|massacre|swastika|child abuse|loli)\b/i;

// Images of specific foreign countries, cities, landmarks or leaders are outside
// DeepRWA's world unless the request also involves Rwanda.
const FOREIGN_IMAGE_RE = /\b(kenya|nairobi|mombasa|uganda|kampala|tanzania|dar es salaam|zanzibar|burundi|bujumbura|congo|drc|kinshasa|ethiopia|addis ababa|nigeria|lagos|abuja|ghana|accra|south africa|johannesburg|cape town|egypt|cairo|pyramids?|morocco|algeria|tunisia|senegal|somalia|sudan|zambia|zimbabwe|malawi|mozambique|angola|cameroon|united states|america|usa|new york|washington|los angeles|statue of liberty|white house|canada|toronto|mexico|brazil|rio de janeiro|argentina|united kingdom|england|britain|london|big ben|scotland|ireland|france|paris|eiffel tower|germany|berlin|italy|rome|colosseum|venice|spain|madrid|barcelona|portugal|lisbon|netherlands|amsterdam|belgium|brussels|switzerland|russia|moscow|kremlin|ukraine|poland|turkey|istanbul|greece|athens|china|beijing|shanghai|great wall|japan|tokyo|mount fuji|korea|seoul|india|delhi|mumbai|taj mahal|pakistan|dubai|uae|burj khalifa|saudi arabia|mecca|qatar|israel|iran|iraq|australia|sydney|new zealand|indonesia|bali|thailand|bangkok|vietnam|philippines|singapore|trump|biden|obama|putin|macron|xi jinping|ruto|museveni)\b/i;
const RWANDA_SCENE_RE = /\b(people|person|man|woman|men|women|child|children|kid|kids|girl|boy|family|student|students|school|classroom|teacher|farmer|farm|market|street|road|city|town|village|house|home|landscape|hills?|mountains?|lake|forest|wedding|dance|dancers|church|office|hospital|bus|moto|motorcycle|restaurant|food|coffee|tea|cows?|cattle|gorillas?)\b/i;

async function classifyImageIntent(userText) {
  if (BLOCKED_IMAGE_RE.test(String(userText || ''))) return { action: 'blocked' };
  if (FOREIGN_IMAGE_RE.test(String(userText || '')) && !keywordRwandaImageCheck(userText)) return { action: 'offtopic' };
  const prompt = extractImagePrompt(userText);
  if (!prompt || prompt.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return { action: 'clarify' };
  return { action: 'generate', prompt };
}

// ============ SPEECH-TO-TEXT ============
const WHISPER_LANGS = new Set([
  'af','am','ar','as','az','ba','be','bg','bn','bo','br','bs','ca','cs','cy','da','de','el','en',
  'es','et','eu','fa','fi','fo','fr','gl','gu','ha','haw','he','hi','hr','ht','hu','hy','id','is',
  'it','ja','jw','ka','kk','km','kn','ko','la','lb','ln','lo','lt','lv','mg','mi','mk','ml','mn',
  'mr','ms','mt','my','ne','nl','nn','no','oc','pa','pl','ps','pt','ro','ru','sa','sd','si','sk',
  'sl','sn','so','sq','sr','su','sv','sw','ta','te','tg','th','tk','tl','tr','tt','uk','ur','uz',
  'vi','yi','yo','zh','yue'
]);

function whisperSupports(lang) {
  if (!lang) return true;
  return WHISPER_LANGS.has(String(lang).toLowerCase());
}

const WHISPER_CONTEXT_PROMPT = 'DeepRWA, a question about Rwanda, Kigali, Rwamagana, Musanze, Kinyarwanda, Umuganda, Akagera, Nyungwe, Volcanoes National Park, image, photo, map, history, culture, tourism.';

function normalizeHint(hint) {
  if (!hint || typeof hint !== 'string') return '';
  return hint.split(/[-_]/)[0].toLowerCase().trim();
}

// Languages Intron Sahara supports (African languages Whisper cannot handle)
const SAHARA_LANGS = new Set(['rw','kin','sw','lg','ny','sn','zu','xh','st','tn','yo','ig','ha','am','so','om','wo','ff','tw','ak','ln']);

function saharaSupports(lang) {
  return lang && SAHARA_LANGS.has(lang);
}

// Languages Lelapa Vulavula supports (verified from docs)
const VULAVULA_LANGS = new Set(['afr','zul','sot','eng','fra']);

function vulavulaSupports(lang) {
  if (!lang) return false;
  return VULAVULA_LANGS.has(lang) || VULAVULA_LANGS.has(lang.slice(0, 3));
}

// ---------- Lelapa AI Vulavula (verified endpoint) ----------
async function transcribeWithVulavula(buffer, mime, lang) {
  const token = process.env.VULAVULA_API_KEY;
  if (!token) throw new Error('Vulavula not configured');
  const type = (mime || 'audio/webm').split(';')[0].trim();
  const blob = new Blob([buffer], { type });
  const fd = new FormData();
  fd.append('file', blob, 'voice.wav');
  const url = 'https://vulavula-services.lelapa.ai/api/v2alpha/transcribe/sync/file';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'X-CLIENT-TOKEN': token
      },
      body: fd,
      signal: ctrl.signal
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const e = new Error(`Vulavula ${r.status}: ${t.slice(0, 200)}`);
      e.status = r.status;
      throw e;
    }
    const data = await r.json();
    const text = data.transcription_text || data.text || '';
    return { text, language: data.language_code || lang || '' };
  } finally { clearTimeout(timer); }
}

// ---------- Intron Sahara (contact support@intron.io for REST base URL) ----------
async function transcribeWithIntronSahara(buffer, mime, lang) {
  const key = process.env.INTRON_API_KEY;
  if (!key) throw new Error('Intron not configured');
  const type = (mime || 'audio/webm').split(';')[0].trim();
  const blob = new Blob([buffer], { type });
  const fd = new FormData();
  fd.append('file', blob, 'voice.wav');
  if (lang) fd.append('language', lang);
  // NOTE: Intron does not publish a public REST base URL.
  // Contact support@intron.io to obtain the endpoint for Sahara v2.5.
  // We try the most likely pattern; if it fails, we fall through.
  const url = process.env.INTRON_API_URL || 'https://api.intron.io/v1/asr/transcribe';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: fd,
      signal: ctrl.signal
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const e = new Error(`Intron ${r.status}: ${t.slice(0, 200)}`);
      e.status = r.status;
      throw e;
    }
    const data = await r.json();
    const text = data.text || data.transcription || data.transcript || '';
    return { text, language: data.language || lang || '' };
  } finally { clearTimeout(timer); }
}

// ---------- Groq Whisper ----------
async function transcribeWithGroq(buffer, mime, hint) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('Groq not configured');
  const type = (mime || 'audio/webm').split(';')[0].trim();
  const ext = type.includes('mp4') || type.includes('m4a') ? 'm4a'
    : type.includes('ogg') ? 'ogg'
    : type.includes('wav') ? 'wav'
    : type.includes('mpeg') || type.includes('mp3') ? 'mp3'
    : 'webm';
  const blob = new Blob([buffer], { type });
  const fd = new FormData();
  fd.append('file', blob, `voice.${ext}`);
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  fd.append('prompt', WHISPER_CONTEXT_PROMPT);
  if (hint && whisperSupports(hint)) fd.append('language', hint);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: ctrl.signal
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const e = new Error(`Groq ${r.status}: ${t.slice(0, 200)}`);
      e.status = r.status;
      throw e;
    }
    const data = await r.json();
    return { text: data.text || '', language: data.language || '' };
  } finally { clearTimeout(timer); }
}

// ---------- Cloudflare Whisper ----------
async function transcribeWithCloudflare(buffer, hint) {
  const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('Cloudflare not configured');
  const base64 = buffer.toString('base64');
  const models = ['@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper'];
  let lastErr = null;
  for (const model of models) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
      const body = { audio: base64 };
      if (hint && whisperSupports(hint)) body.language = hint;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
      } finally { clearTimeout(timer); }
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`CF ${model} ${r.status}: ${t.slice(0, 200)}`);
      }
      const data = await r.json();
      if (data.success === false) throw new Error('CF: ' + (data.errors?.[0]?.message || 'failed'));
      const result = data.result || {};
      const text = result.text || '';
      const language = result.language || '';
      if (text.trim()) return { text, language };
      throw new Error('CF returned empty text');
    } catch (e) { lastErr = e; console.warn(`[stt] CF ${model}:`, e.message); }
  }
  throw lastErr || new Error('CF failed');
}

// ---------- Hugging Face ----------
async function transcribeWithHuggingFace(buffer, mime, hint) {
  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) throw new Error('Hugging Face not configured');
  const models = [];
  if (hint === 'rw' || hint === 'kin') {
    models.push('mbazaNLP/Whisper-Small-Kinyarwanda');
    models.push('openai/whisper-large-v3');
    models.push('facebook/mms-1b-all');
  } else {
    models.push('openai/whisper-large-v3');
    models.push('facebook/mms-1b-all');
  }
  let lastErr = null;
  for (const model of models) {
    try {
      const url = `https://router.huggingface.co/hf-inference/models/${model}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hfToken}`,
            'Content-Type': mime || 'audio/webm',
            'Accept': 'application/json'
          },
          body: buffer,
          signal: ctrl.signal
        });
      } finally { clearTimeout(timer); }
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`HF ${model} ${r.status}: ${t.slice(0, 200)}`);
      }
      const data = await r.json();
      const text = Array.isArray(data) ? (data[0]?.text || '') : (data.text || '');
      if (text.trim()) return { text, language: '' };
      throw new Error('HF returned empty text');
    } catch (e) {
      lastErr = e;
      console.warn(`[stt] HF ${model}:`, e.message);
    }
  }
  throw lastErr || new Error('HF failed');
}

// ---------- /api/stt ----------
app.post('/api/stt', sttLimiter, async (req, res) => {
  const { audio, mime, hint } = req.body || {};
  if (!audio || typeof audio !== 'string') return res.status(400).json({ error: 'audio (base64) required' });
  let buffer;
  try { buffer = Buffer.from(audio, 'base64'); }
  catch { return res.status(400).json({ error: 'Invalid audio data' }); }
  if (!buffer.length) return res.status(400).json({ error: 'Empty audio' });
  if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Audio too large (max 25 MB)' });

  const langHint = normalizeHint(hint);
  console.log(`[stt] request: ${buffer.length} bytes, hint="${langHint || 'none'}"`);

  // Build provider chain based on language
  let providers;
  if (saharaSupports(langHint)) {
    providers = [
      { name: 'IntronSahara', fn: () => transcribeWithIntronSahara(buffer, mime, langHint) },
      { name: 'Vulavula',     fn: () => transcribeWithVulavula(buffer, mime, langHint) },
      { name: 'HuggingFace',  fn: () => transcribeWithHuggingFace(buffer, mime, langHint) },
      { name: 'Groq',         fn: () => transcribeWithGroq(buffer, mime, '') },
      { name: 'Cloudflare',   fn: () => transcribeWithCloudflare(buffer, '') }
    ];
  } else if (vulavulaSupports(langHint)) {
    providers = [
      { name: 'Vulavula',     fn: () => transcribeWithVulavula(buffer, mime, langHint) },
      { name: 'Groq',         fn: () => transcribeWithGroq(buffer, mime, langHint) },
      { name: 'Cloudflare',   fn: () => transcribeWithCloudflare(buffer, langHint) },
      { name: 'HuggingFace',  fn: () => transcribeWithHuggingFace(buffer, mime, langHint) }
    ];
  } else {
    providers = [
      { name: 'Groq',         fn: () => transcribeWithGroq(buffer, mime, langHint) },
      { name: 'Cloudflare',   fn: () => transcribeWithCloudflare(buffer, langHint) },
      { name: 'Vulavula',     fn: () => transcribeWithVulavula(buffer, mime, langHint) },
      { name: 'HuggingFace',  fn: () => transcribeWithHuggingFace(buffer, mime, langHint) }
    ];
  }

  const errors = [];
  for (const p of providers) {
    try {
      const result = await p.fn();
      const text = (result?.text || '').trim();
      if (!text) { console.warn(`[stt] ${p.name} empty`); continue; }
      if (looksLikePhantom(text)) {
        console.warn(`[stt] ${p.name} phantom rejected: "${text.slice(0, 60)}"`);
        errors.push(`${p.name}: phantom`);
        continue;
      }
      console.log(`[stt] ✅ ${p.name} (${text.length} chars, lang=${result.language || langHint || 'auto'}): "${text.slice(0, 80)}"`);
      return res.json({ text, language: result.language || langHint || '', provider: p.name });
    } catch (e) {
      console.warn(`[stt] ${p.name} failed:`, e.message);
      errors.push(`${p.name}: ${e.message}`);
    }
  }

  console.warn('[stt] all providers failed:', errors.join(' | '));
  const allSilent = errors.every(e => /phantom/.test(e));
  if (allSilent) return res.json({ text: '', language: '', provider: 'silence' });
  res.status(500).json({ error: 'Transcription failed. Please try again.' });
});

// ============ PROVIDERS ============
// All providers now STREAM tokens to the browser as they arrive (the old code
// waited for the whole answer before sending anything). A provider is only
// skipped/fallen-back-from if it fails BEFORE producing any text.
const cooldown = new Map();
function isCooling(k) { const u = cooldown.get(k); if (!u) return false; if (Date.now() > u) { cooldown.delete(k); return false; } return true; }
function setCooldown(k, ms) { cooldown.set(k, Date.now() + ms); }
function cooldownFor(e) {
  if (!e) return 60000;
  if (e.status === 429) return 120000;
  if (e.status >= 500 || !e.status) return 90000;
  return 30000;
}

function sanitizeForProvider(messages) {
  return messages.map(m => ({ role: m.role, content: m.content }));
}

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const CONNECT_TIMEOUT_MS = 25000;   // time allowed until the provider starts answering
const IDLE_TIMEOUT_MS = 45000;      // max silence between two streamed chunks

async function openStream(url, init, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  let res;
  try { res = await fetch(url, { ...init, signal: ctrl.signal }); }
  catch (e) { clearTimeout(timer); const err = new Error(`${label} connect failed: ${e.message}`); throw err; }
  clearTimeout(timer);
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    const e = new Error(`${label} HTTP ${res.status}: ${t.slice(0, 160)}`);
    e.status = res.status;
    try { ctrl.abort(); } catch {}
    throw e;
  }
  return { res, ctrl };
}

// Reads a server-sent-event body and yields parsed JSON payloads.
async function* readSSE(res, ctrl) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p) continue;
        if (p === '[DONE]') return;
        let j;
        try { j = JSON.parse(p); } catch { continue; }
        yield j;
      }
    }
  } finally {
    clearTimeout(idle);
    try { ctrl.abort(); } catch {}
  }
}

async function* streamOpenAICompat(url, headers, body, label) {
  const { res, ctrl } = await openStream(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }, label);
  for await (const j of readSSE(res, ctrl)) {
    if (j.error) { const e = new Error(`${label}: ${j.error.message || 'stream error'}`); e.status = j.error.code || 500; throw e; }
    const d = j.choices?.[0]?.delta?.content;
    if (d) yield d;
  }
}

function withCooldown(key, gen) {
  return async function* (...args) {
    if (isCooling(key)) throw new Error('cooling down');
    try { yield* gen(...args); }
    catch (e) { setCooldown(key, cooldownFor(e)); throw e; }
  };
}

const streamGroq = withCooldown('groq', async function* (msgs, opts = {}) {
  if (!process.env.GROQ_API_KEY) throw new Error('not configured');
  const body = {
    model: GROQ_MODEL, messages: sanitizeForProvider(msgs), stream: true,
    temperature: 0.7, max_completion_tokens: opts.maxTokens || 4096
  };
  if (/gpt-oss/.test(GROQ_MODEL)) body.reasoning_effort = opts.voice ? 'low' : 'medium';
  yield* streamOpenAICompat('https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body, 'Groq');
});

const streamOpenRouter = withCooldown('or', async function* (msgs, opts = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('not configured');
  yield* streamOpenAICompat('https://openrouter.ai/api/v1/chat/completions',
    { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://deeprwa.agentdomains.co', 'X-Title': 'DeepRWA' },
    { model: 'openrouter/free', messages: sanitizeForProvider(msgs), stream: true, temperature: 0.7, max_tokens: opts.maxTokens || 4096 }, 'OpenRouter');
});

const streamNVIDIA = withCooldown('nv', async function* (msgs, opts = {}) {
  if (!process.env.NVIDIA_API_KEY) throw new Error('not configured');
  yield* streamOpenAICompat('https://integrate.api.nvidia.com/v1/chat/completions',
    { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
    { model: 'nvidia/nemotron-3-super-120b-a12b', messages: sanitizeForProvider(msgs), stream: true, temperature: 0.7, max_tokens: opts.maxTokens || 4096 }, 'NVIDIA');
});

const streamPollinations = withCooldown('poll', async function* (msgs, opts = {}) {
  yield* streamOpenAICompat('https://text.pollinations.ai/openai', {},
    { model: 'openai', messages: sanitizeForProvider(msgs), stream: true, temperature: 0.7, max_tokens: opts.maxTokens || 4096 }, 'Pollinations');
});

const streamCloudflare = withCooldown('cf', async function* (msgs, opts = {}) {
  const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('not configured');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`;
  const { res, ctrl } = await openStream(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: sanitizeForProvider(msgs), stream: true, max_tokens: Math.min(opts.maxTokens || 4096, 4096) })
  }, 'Cloudflare');
  for await (const j of readSSE(res, ctrl)) {
    const d = j.response || j.choices?.[0]?.delta?.content;
    if (d) yield d;
  }
});

function toGeminiBody(msgs, extraParts, opts = {}) {
  const sanitized = sanitizeForProvider(msgs);
  const sys = sanitized.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const convo = sanitized.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (extraParts && extraParts.length) {
    const last = convo[convo.length - 1];
    if (last && last.role === 'user') last.parts.push(...extraParts);
    else convo.push({ role: 'user', parts: [{ text: 'Analyse the attached file(s).' }, ...extraParts] });
  }
  return {
    contents: convo,
    systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
    generationConfig: { temperature: 0.7, maxOutputTokens: opts.maxTokens || 4096 }
  };
}

async function* geminiStream(body, label) {
  if (!process.env.GEMINI_API_KEY) throw new Error('not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
  const { res, ctrl } = await openStream(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }, label);
  for await (const j of readSSE(res, ctrl)) {
    for (const pt of (j.candidates?.[0]?.content?.parts || [])) {
      if (pt.text && !pt.thought) yield pt.text;
    }
  }
}

const streamGemini = withCooldown('gem', async function* (msgs, opts = {}) {
  yield* geminiStream(toGeminiBody(msgs, null, opts), 'Gemini');
});

// ============ VISION ============
async function* streamGeminiVision(messages, attachments, opts = {}) {
  const parts = attachments.map(f => ({ inline_data: { mime_type: f.mime, data: f.data } }));
  yield* geminiStream(toGeminiBody(messages, parts, opts), 'Gemini Vision');
}

function toOpenAIVisionMessages(messages, images) {
  const sanitized = sanitizeForProvider(messages);
  const lastIdx = sanitized.map(m => m.role).lastIndexOf('user');
  const content = [{ type: 'text', text: sanitized[lastIdx]?.content || 'Analyse the attached image(s).' }];
  for (const f of images) content.push({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data}` } });
  return sanitized.map((m, i) => i === lastIdx ? { role: 'user', content } : m);
}

async function* streamOpenRouterVision(messages, attachments, opts = {}) {
  const images = attachments.filter(a => (a.mime || '').startsWith('image/'));
  if (!images.length) throw new Error('no images');
  if (!process.env.OPENROUTER_API_KEY) throw new Error('not configured');
  yield* streamOpenAICompat('https://openrouter.ai/api/v1/chat/completions',
    { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://deeprwa.agentdomains.co', 'X-Title': 'DeepRWA' },
    { model: 'openrouter/free', messages: toOpenAIVisionMessages(messages, images), stream: true, temperature: 0.7, max_tokens: opts.maxTokens || 4096 }, 'OpenRouter Vision');
}

async function* streamNVIDIAVision(messages, attachments, opts = {}) {
  const images = attachments.filter(a => (a.mime || '').startsWith('image/'));
  if (!images.length) throw new Error('no images');
  if (!process.env.NVIDIA_API_KEY) throw new Error('not configured');
  yield* streamOpenAICompat('https://integrate.api.nvidia.com/v1/chat/completions',
    { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
    { model: 'meta/llama-3.2-11b-vision-instruct', messages: toOpenAIVisionMessages(messages, images), stream: true, temperature: 0.7, max_tokens: Math.min(opts.maxTokens || 2048, 2048) }, 'NVIDIA Vision');
}

const VISION_PROVIDERS = [
  { name: 'Gemini Vision', fn: streamGeminiVision },
  { name: 'OpenRouter Vision', fn: streamOpenRouterVision },
  { name: 'NVIDIA Vision', fn: streamNVIDIAVision }
];
const PROVIDERS = [
  { name: 'Groq', fn: streamGroq },
  { name: 'Gemini', fn: streamGemini },
  { name: 'Cloudflare', fn: streamCloudflare },
  { name: 'OpenRouter', fn: streamOpenRouter },
  { name: 'NVIDIA', fn: streamNVIDIA },
  { name: 'Pollinations', fn: streamPollinations }
];

// ============ PHANTOM FILTER ============
const PHANTOM_PHRASES = new Set([
  'thank you for watching','thanks for watching','please subscribe','subscribe',
  'the end','a film by','film by','subtitles by','amara.org','amara org',
  'blank audio','music','silence','applause','laughter',
  'you','the','a','an','uh','um','hmm','mm hmm','oh','ah','eh'
]);
function looksLikePhantom(text) {
  if (!text) return true;
  const t = String(text).trim();
  if (t.length < 2) return true;
  const lower = t.toLowerCase().replace(/[.,!?;:。、！？…♪"'"'`~]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!lower || PHANTOM_PHRASES.has(lower)) return true;
  if (/^[\[\(][^\]\)]{0,40}[\]\)]$/.test(t)) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return false;
}

// ============ TITLE GENERATION ============
function isGreetingOnly(msg) {
  const n = normalise(msg);
  if (!n) return false;
  if (n.length > 80) return false;
  if (GREETING_EXACT.has(n)) return true;
  const words = n.split(' ');
  const startsWithGreeting = /^(hi|hey|hello|yo|hiya|howdy|sup|muraho|mwaramutse|mwiriwe|wiriwe|bonjour|salut|bonsoir|coucou|jambo|habari|hujambo|hola|ciao|hallo|hei|hej)\b/.test(n);
  if (startsWithGreeting && words.length <= 8) {
    const hasTopic = /\b(rwanda|kigali|rwandan|province|district|sector|cell|village|history|culture|tourism|tourist|price|cost|story|news|people|person|place|city|school|university|hospital|food|recipe|market|company|business|explain|tell me about|how to|how do i|what is|what are|where is|where are|when is|when was|why is|why are|who is|who are|who was|show me|give me)\b/.test(n);
    if (!hasTopic) return true;
  }
  if (/^(how are you|how're you|how is it going|how's it going|how have you been|how are things|what's up|whats up|nice to meet you|long time no see|good (morning|afternoon|evening|night)|comment ca va|comment ça va|comment vas tu|comment allez vous)\b/.test(n)) return true;
  return false;
}
function isCreatorQuestion(msg) {
  const n = normalise(msg);
  if (!n) return false;
  if (n.length > 60) return false;
  return IDENTITY_EXACT_PATTERNS.some(r => r.test(n));
}
function greetingLabel(msg) {
  const t = String(msg || '').toLowerCase();
  if (/muraho|mwaramutse|mwiriwe|wiriwe|amakuru|bite/.test(t)) return 'Greeting';
  if (/bonjour|salut|bonsoir|coucou/.test(t)) return 'Salutation';
  if (/jambo|habari|hujambo/.test(t)) return 'Salamu';
  if (/thanks|thank you|thx|asante|merci/.test(t)) return 'Thanks';
  if (/bye|goodbye|kwaheri|au revoir/.test(t)) return 'Goodbye';
  return 'Greeting';
}
function extractImagePromptForTitle(msg) {
  const n = String(msg || '')
    .replace(/\b(create|generate|make|draw|produce|provide|give|show|find|get|send|me|please|a|an|the|image|photo|picture|illustration|drawing|of|for)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n;
}
function isEchoOfMessage(title, originalMsg) {
  const tNorm = String(title || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const mNorm = String(originalMsg || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!tNorm || !mNorm) return false;
  if (tNorm === mNorm) return true;
  if (tNorm.length >= 4 && mNorm.includes(tNorm)) return true;
  if (tNorm.length >= 4 && mNorm.startsWith(tNorm)) return true;
  const tWords = tNorm.split(' ').filter(w => w.length >= 3);
  if (tWords.length < 2) return false;
  const mWords = mNorm.split(' ');
  let idx = 0, matches = 0;
  for (const tw of tWords) {
    while (idx < mWords.length) {
      const mw = mWords[idx];
      if (mw === tw || mw.startsWith(tw) || tw.startsWith(mw)) { matches++; idx++; break; }
      idx++;
    }
  }
  return matches === tWords.length;
}
function cleanTitle(raw, originalMsg) {
  let t = String(raw || '').trim();
  if (!t) return null;
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
  t = t.replace(/[.:;,!]+$/, '').trim();
  if (/^(title|chat title|chat)\s*[:\-]\s*/i.test(t)) t = t.replace(/^(title|chat title|chat)\s*[:\-]\s*/i, '').trim();
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const short = lines.find(l => l.length <= 60 && !/^(sure|here|the title|of course|okay)/i.test(l)) || lines[0];
    t = short;
  }
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
  t = t.replace(/\.+$/, '').trim();
  if (!t) return null;
  if (t.length > 80) t = t.substring(0, 80).trim();
  if (isEchoOfMessage(t, originalMsg)) return null;
  return t;
}
function buildTitlePrompt(msg) {
  const truncated = String(msg).substring(0, 800);
  return `You are an expert at naming chat conversations in the style of ChatGPT's sidebar.

Read the USER MESSAGE and write a SHORT TITLE that describes the TOPIC or INTENT.
You must NEVER repeat, quote, or paraphrase the user's exact wording back as the title.

Strict rules:
- 2 to 6 words. Title Case.
- Describe the SUBJECT, not the sentence.
- Do NOT copy phrases from the message. Use your own words.
- No quotation marks. No trailing period. No prefix like "Title:".

Special cases:
- Greeting, thanks, or goodbye → Greeting
- Asks who you are / who made you → About This Assistant
- Asks what you can do → Assistant Capabilities
- Asks for an image → X Photo

Examples:
USER: "Hi, how are you?" → Greeting
USER: "Who created you?" → About This Assistant
USER: "What is the agriculture mean?" → Meaning of Agriculture
USER: "How do I treat tomato blight?" → Tomato Blight Treatment
USER: "create a photo of maize" → Maize Photo
USER: "Tell me about the history of Rwanda" → Rwandan History
USER: "Who was King Rudahigwa?" → About King Rudahigwa

USER MESSAGE:
${truncated}

Title:`;
}
async function callTitleModel({ url, headers, model, prompt, timeoutMs = 20000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 400, stream: false }),
      signal: ctrl.signal
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); const e = new Error(`HTTP ${res.status}: ${t.slice(0, 100)}`); e.status = res.status; throw e; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } finally { clearTimeout(timer); }
}
async function generateTitleViaProviders(msg) {
  const prompt = buildTitlePrompt(msg);
  if (process.env.GROQ_API_KEY) {
    for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
      try {
        const raw = await callTitleModel({ url: 'https://api.groq.com/openai/v1/chat/completions', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, model, prompt });
        const cleaned = cleanTitle(raw, msg);
        if (cleaned) { console.log(`[title] Groq ${model}: "${cleaned}"`); return cleaned; }
      } catch (e) { console.warn(`[title] Groq ${model} failed:`, e.message); }
    }
  }
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const raw = await callTitleModel({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://deeprwa.agentdomains.co', 'X-Title': 'DeepRWA' },
        model: 'openrouter/free', prompt
      });
      const cleaned = cleanTitle(raw, msg);
      if (cleaned) { console.log(`[title] OpenRouter: "${cleaned}"`); return cleaned; }
    } catch (e) { console.warn('[title] OpenRouter failed:', e.message); }
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 30 } })
      });
      if (res.ok) {
        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = cleanTitle(raw, msg);
        if (cleaned) { console.log(`[title] Gemini: "${cleaned}"`); return cleaned; }
      }
    } catch (e) { console.warn('[title] Gemini failed:', e.message); }
  }
  return null;
}
const TITLE_STOPWORDS = new Set(['a','an','and','or','but','if','then','else','when','where','while','of','to','in','on','at','by','for','with','about','against','between','into','through','during','before','after','above','below','from','up','down','out','off','over','under','again','further','once','here','there','all','any','both','each','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','can','will','just','dont','don','should','now','is','are','was','were','be','been','being','have','has','had','do','does','did','would','could','should','may','might','must','shall','i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','their','our','this','that','these','those','what','which','who','whom','whose','how','why','when','where','please','hi','hello','hey','thanks','thank','ok','okay','yes','no','like','want','need','get','got','give','make','made','let','lets','put','see','say','said','go','going','come','came','also','too','really','much','many','lot','lots','thing','things','stuff','way','ways']);
function extractObjectAfter(msg, match) {
  const after = msg.slice(match.index + match[0].length).trim();
  const words = after.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w.toLowerCase()));
  return words.slice(0, 3).join(' ').substring(0, 50) || null;
}
function localFallbackTitle(msg, isImg) {
  if (isImg) {
    const p = extractImagePromptForTitle(msg).split(/\s+/).slice(0, 4).join(' ').trim();
    return p ? `${p} Photo` : 'Image Request';
  }
  const qPatterns = [
    { re: /\b(what is|what are|whats|what's)\b/i, prefix: 'Meaning of' },
    { re: /\b(define|definition of|meaning of)\b/i, prefix: 'Meaning of' },
    { re: /\b(how to|how do i|how can i|how does one)\b/i, prefix: 'How to' },
    { re: /\b(who is|who are|who was)\b/i, prefix: 'About' },
    { re: /\b(where is|where are|wheres|where's)\b/i, prefix: 'Location of' }
  ];
  for (const { re, prefix } of qPatterns) {
    const m = msg.match(re);
    if (m) { const obj = extractObjectAfter(msg, m); return obj ? `${prefix} ${obj}`.substring(0, 60) : prefix; }
  }
  if (/\b(create|generate|draw|make|produce)\b/i.test(msg)) {
    const m = msg.match(/\b(create|generate|draw|make|produce)\b/i);
    const obj = extractObjectAfter(msg, m);
    return obj ? obj.substring(0, 60) : 'Request';
  }
  if (/\b(rwanda|kigali)\b/i.test(msg)) return 'About Rwanda';
  if (msg.length > 200) return 'Long Message';
  if (msg.length <= 20) return 'Short Message';
  return 'New chat';
}
async function generateChatTitle(firstMessage) {
  const msg = String(firstMessage || '').trim();
  if (!msg) return 'New chat';
  if (isGreetingOnly(msg)) {
    const label = greetingLabel(msg);
    console.log(`[title] greeting shortcut: "${label}"`);
    return label;
  }
  if (isCreatorQuestion(msg)) {
    console.log(`[title] creator shortcut: "About This Assistant"`);
    return 'About This Assistant';
  }
  const isImg = isImageGenerationRequest(msg);
  const fromLLM = await generateTitleViaProviders(msg);
  if (fromLLM) return fromLLM;
  const fallback = localFallbackTitle(msg, isImg);
  console.log(`[title] local fallback: "${fallback}"`);
  return fallback;
}

// ============ ROUTES ============
app.get('/api/config', (req, res) => res.json({ name: 'DeepRWA', version: '4.7.0', supabaseUrl: supabaseUrl || null, supabaseAnonKey: supabaseAnon || null }));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: https://deeprwa.agentdomains.co/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://deeprwa.agentdomains.co/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>`));

// ============ IMAGE PROVIDER DIAGNOSTICS ============
app.get('/api/debug/image-providers', (req, res) => {
  const cf = !!(process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID) && !!(process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN);
  const providers = [];
  if (cf) providers.push({ id: 'cloudflare', name: 'Cloudflare Workers AI (FLUX.1-schnell)', enabled: true, watermark: false });
  res.json({
    providers,
    active_providers: providers.map(p => p.id),
    storage_configured: !!supabase,
    storage_bucket: process.env.SUPABASE_STORAGE_BUCKET || 'uploads',
    mode: 'in-conversation',
    topic_guard: 'Rwanda-only images',
    note: 'Pollinations removed — free tier always adds a watermark'
  });
});

// ============ SPEECH PROVIDERS DIAGNOSTICS ============
app.get('/api/debug/stt-providers', (req, res) => {
  const providers = [];
  if (process.env.GROQ_API_KEY) providers.push({ id: 'groq', enabled: true, languages: '99 (Whisper-large-v3)', supports_kinyarwanda: false, context_prompt: true });
  if ((process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID) && (process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN)) providers.push({ id: 'cloudflare', enabled: true, languages: '99 (Whisper-large-v3)', supports_kinyarwanda: false });
  if (process.env.INTRON_API_KEY) providers.push({ id: 'intron-sahara', enabled: true, languages: '63 (African languages)', supports_kinyarwanda: true, code_switching: 'Kinyarwanda-English-French', rest_endpoint_verified: false, note: 'Contact support@intron.io for REST base URL' });
  if (process.env.VULAVULA_API_KEY) providers.push({ id: 'vulavula', enabled: true, languages: '5 documented (afr, zul, sot, eng, fra)', supports_kinyarwanda: false, endpoint: 'https://vulavula-services.lelapa.ai/api/v2alpha/transcribe/sync/file' });
  if (process.env.HF_TOKEN) providers.push({ id: 'huggingface', enabled: true, models: ['mbazaNLP/Whisper-Small-Kinyarwanda', 'openai/whisper-large-v3', 'facebook/mms-1b-all'], languages: '1,162 via MMS', supports_kinyarwanda: true });
  res.json({ providers, hf_token_present: !!process.env.HF_TOKEN, intron_key_present: !!process.env.INTRON_API_KEY, vulavula_key_present: !!process.env.VULAVULA_API_KEY, whisper_lang_count: WHISPER_LANGS.size, sahara_lang_count: SAHARA_LANGS.size, vulavula_lang_count: VULAVULA_LANGS.size });
});

// AUTH: Signup
app.post('/api/auth/signup', async (req, res) => {
  if (!supabaseConfigured) return res.status(503).json({ error: 'Auth not configured' });
  const { email, password, fullName } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (!pwIsStrong(password)) return res.status(400).json({ error: 'Password must be at least 8 characters with letters and numbers' });
  const emailLower = email.toLowerCase().trim();
  const existing = await findUserByEmail(emailLower);
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const code = genCode();
  const pendingToken = signPending({ type: 'signup', email: emailLower, password, fullName: fullName || '', code }, 900);
  const sent = await sendEmailCode(emailLower, code, 'signup');
  if (!sent) return res.status(500).json({ error: 'Could not send verification email. Please try again.' });
  res.json({ pendingToken, email: emailLower });
});

app.post('/api/auth/confirm-signup', async (req, res) => {
  const { pendingToken, code } = req.body || {};
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'signup') return res.status(400).json({ error: 'Session expired' });
  if (p.code !== code) return res.status(400).json({ error: 'Invalid or expired code' });
  const { data: newUser, error } = await supabase.auth.admin.createUser({ email: p.email, password: p.password, email_confirm: true });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('profiles').insert({ id: newUser.user.id, email: p.email, display_name: p.fullName || null });
  await trackSession(newUser.user.id, req);
  const accessToken = jwt.sign({ sub: newUser.user.id, email: p.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: newUser.user.id, email: p.email, display_name: p.fullName || null } });
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const p = verifyPending(req.body?.pendingToken);
  if (!p || p.type !== 'signup') return res.status(400).json({ error: 'Session expired' });
  const code = genCode();
  const newToken = signPending({ ...stripJwtClaims(p), code }, 900);
  const sent = await sendEmailCode(p.email, code, 'signup');
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken: newToken });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (!password) return res.status(400).json({ error: 'Password required' });
  const emailLower = email.toLowerCase().trim();
  let check = await passwordGrant(emailLower, password);
  // An account whose email is marked unconfirmed can't log in with a password.
  // Every DeepRWA account verified its email with a code, so confirm it and retry.
  if (!check.ok && check.reason === 'unconfirmed') {
    try {
      const u = await findUserByEmail(emailLower);
      if (u) { await supabase.auth.admin.updateUserById(u.id, { email_confirm: true }); check = await passwordGrant(emailLower, password); }
    } catch (e) { console.warn('[auth] auto-confirm failed:', e.message); }
  }
  if (!check.ok) {
    console.warn(`[auth] login failed for ${emailLower}: ${check.reason}${check.message ? ' — ' + check.message : ''}`);
    return authFailureResponse(res, check);
  }
  const user = check.user;
  const { data: profile } = await supabase.from('profiles').select('totp_enabled').eq('id', user.id).maybeSingle();
  const code = genCode();
  const pendingToken = signPending({ type: 'login', userId: user.id, email: user.email, code, needs2fa: profile?.totp_enabled || false }, 900);
  const sent = await sendEmailCode(user.email, code, 'login');
  if (!sent) return res.status(500).json({ error: 'Could not send login code' });
  res.json({ pendingToken, requires2fa: profile?.totp_enabled || false });
});

app.post('/api/auth/verify-login', async (req, res) => {
  const { pendingToken, code } = req.body || {};
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'login') return res.status(400).json({ error: 'Session expired' });
  if (p.code !== code) return res.status(400).json({ error: 'Invalid or expired code' });
  if (p.needs2fa) { const twofaToken = signPending({ type: 'login-2fa', userId: p.userId, email: p.email }, 600); return res.json({ requires2fa: true, twofaToken }); }
  await trackSession(p.userId, req);
  const accessToken = jwt.sign({ sub: p.userId, email: p.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: p.userId, email: p.email } });
});

app.post('/api/auth/resend-login-code', async (req, res) => {
  const p = verifyPending(req.body?.pendingToken);
  if (!p || p.type !== 'login') return res.status(400).json({ error: 'Session expired' });
  const code = genCode();
  const newToken = signPending({ ...stripJwtClaims(p), code }, 900);
  const sent = await sendEmailCode(p.email, code, 'login');
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken: newToken });
});

app.post('/api/auth/verify-2fa', async (req, res) => {
  const { twofaToken, code } = req.body || {};
  const p = verifyPending(twofaToken);
  if (!p || p.type !== 'login-2fa') return res.status(400).json({ error: 'Session expired' });
  const { data: profile } = await supabase.from('profiles').select('totp_secret').eq('id', p.userId).maybeSingle();
  if (!profile?.totp_secret) return res.status(400).json({ error: '2FA not configured' });
  if (!authenticator.verify({ token: code, secret: profile.totp_secret })) return res.status(400).json({ error: 'Invalid 2FA code' });
  await trackSession(p.userId, req);
  const accessToken = jwt.sign({ sub: p.userId, email: p.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ accessToken, user: { id: p.userId, email: p.email } });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const clientId = (req.headers['x-client-id'] || '').toString().trim().slice(0, 80) || null;
  if (clientId && supabase) {
    try {
      const { data: sess } = await supabase.from('sessions').select('revoked').eq('user_id', req.userId).eq('client_id', clientId).maybeSingle();
      if (sess && sess.revoked === true) return res.status(401).json({ error: 'Session has been revoked', code: 'SESSION_REVOKED' });
    } catch (e) { console.warn('[auth/me] session check failed (non-fatal):', e.message); }
  }
  const { data } = await supabase.from('profiles').select('*').eq('id', req.userId).maybeSingle();
  res.json({ user: { id: req.userId, email: data?.email, display_name: data?.display_name, totp_enabled: data?.totp_enabled || false, created_at: data?.created_at } });
});

app.post('/api/auth/forgot-password-request', async (req, res) => {
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
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'forgot-password') return res.status(400).json({ error: 'Session expired' });
  if (p.code !== code) return res.status(400).json({ error: 'Invalid or expired code' });
  const grantedToken = signPending({ type: 'forgot-password-granted', email: p.email, userId: p.userId }, 600);
  res.json({ grantedToken });
});

app.post('/api/auth/resend-forgot-password-code', async (req, res) => {
  const p = verifyPending(req.body?.pendingToken);
  if (!p || p.type !== 'forgot-password') return res.status(400).json({ error: 'Session expired' });
  const code = genCode();
  const newToken = signPending({ ...stripJwtClaims(p), code }, 900);
  const sent = await sendEmailCode(p.email, code, 'reset');
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken: newToken });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { grantedToken, newPassword } = req.body || {};
  if (!pwIsStrong(newPassword)) return res.status(400).json({ error: 'Password must be at least 8 chars with letters and numbers' });
  const g = verifyPending(grantedToken);
  if (!g || g.type !== 'forgot-password-granted') return res.status(400).json({ error: 'Your reset session expired. Please request a new code.' });

  // Re-read the account so we update exactly the account that owns this email.
  let account = null;
  try {
    const { data } = await supabase.auth.admin.getUserById(g.userId);
    account = data?.user || null;
  } catch {}
  if (!account || String(account.email || '').toLowerCase() !== String(g.email || '').toLowerCase()) {
    account = await findUserByEmail(g.email);
  }
  if (!account) return res.status(404).json({ error: 'No account found with this email' });
  const email = account.email.toLowerCase();

  const same = await passwordGrant(email, newPassword);
  if (same.ok) return res.status(400).json({ error: 'New password must be different from the current one' });

  // Save the new password and make sure the account is confirmed so it can log in.
  const { error } = await supabase.auth.admin.updateUserById(account.id, { password: newPassword, email_confirm: true });
  if (error) {
    console.warn(`[auth] reset-password update failed for ${email}: ${error.message}`);
    return res.status(400).json({ error: error.message || 'Could not save the new password' });
  }

  // Prove the new password really works before telling the user it was reset.
  let check = await passwordGrant(email, newPassword);
  if (!check.ok && check.reason === 'invalid') { await authSleep(1200); check = await passwordGrant(email, newPassword); }
  if (!check.ok && (check.reason === 'invalid' || check.reason === 'not-configured')) {
    console.error(`[auth] reset-password: new password not usable for ${email}: ${check.reason} ${check.message || ''}`);
    return res.status(500).json({ error: check.reason === 'not-configured'
      ? 'Your new password was saved, but login is not set up on the server yet. Please contact support.'
      : 'The new password could not be saved. Please try again.' });
  }

  // Log the user straight in (unless 2FA is on — then they log in normally).
  const { data: profile } = await supabase.from('profiles').select('totp_enabled, display_name').eq('id', account.id).maybeSingle();
  if (profile?.totp_enabled) return res.json({ success: true, email });
  await trackSession(account.id, req);
  const accessToken = jwt.sign({ sub: account.id, email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, email, accessToken, user: { id: account.id, email, display_name: profile?.display_name || null } });
});

app.post('/api/auth/send-action-code', requireAuth, async (req, res) => {
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
  const pendingToken = signPending({ type: 'action', action, userId: req.userId, email: profile.email, newEmail: action === 'change-email' ? newEmail : null, code }, 900);
  const sent = await sendEmailCode(targetEmail, code, action);
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken, targetEmail });
});

app.post('/api/auth/resend-action-code', requireAuth, async (req, res) => {
  const p = verifyPending(req.body?.pendingToken);
  if (!p || p.type !== 'action' || p.userId !== req.userId) return res.status(400).json({ error: 'Session expired' });
  const code = genCode();
  const newToken = signPending({ ...stripJwtClaims(p), code }, 900);
  const targetEmail = p.action === 'change-email' && p.newEmail ? p.newEmail : p.email;
  const sent = await sendEmailCode(targetEmail, code, p.action);
  if (!sent) return res.status(500).json({ error: 'Could not send email' });
  res.json({ pendingToken: newToken, targetEmail });
});

app.post('/api/auth/verify-action-code', requireAuth, async (req, res) => {
  const { pendingToken, code, action } = req.body || {};
  const p = verifyPending(pendingToken);
  if (!p || p.type !== 'action' || p.userId !== req.userId) return res.status(400).json({ error: 'Session expired' });
  if (p.action !== action) return res.status(400).json({ error: 'Action mismatch' });
  if (p.code !== code) return res.status(400).json({ error: 'Invalid or expired code' });
  const grantedToken = signPending({ type: 'granted', action: p.action, userId: p.userId, newEmail: p.newEmail || null }, 600);
  res.json({ grantedToken });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, grantedToken } = req.body || {};
  if (!pwIsStrong(newPassword)) return res.status(400).json({ error: 'Password must be at least 8 chars with letters and numbers' });
  const g = verifyPending(grantedToken);
  if (!g || g.type !== 'granted' || g.action !== 'change-password' || g.userId !== req.userId) return res.status(400).json({ error: 'Session expired' });
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  const cur = await passwordGrant(profile?.email, currentPassword);
  if (!cur.ok) return cur.reason === 'invalid' ? res.status(401).json({ error: 'Current password is incorrect' }) : authFailureResponse(res, cur);
  if (await verifyPassword(profile?.email, newPassword)) return res.status(400).json({ error: 'New password must be different' });
  const { error } = await supabase.auth.admin.updateUserById(req.userId, { password: newPassword, email_confirm: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/auth/verify-current-password', requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const { data: profile } = await supabase.from('profiles').select('email').eq('id', req.userId).maybeSingle();
  if (!await verifyPassword(profile?.email, password)) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ valid: true });
});

app.post('/api/auth/change-email', requireAuth, async (req, res) => {
  const g = verifyPending(req.body?.grantedToken);
  if (!g || g.type !== 'granted' || g.action !== 'change-email' || g.userId !== req.userId || !g.newEmail) return res.status(400).json({ error: 'Session expired' });
  if (!isValidEmail(g.newEmail)) return res.status(400).json({ error: 'Invalid email' });
  if (await isEmailTakenByOther(g.newEmail, req.userId)) return res.status(400).json({ error: 'That email is already in use' });
  const { error } = await supabase.auth.admin.updateUserById(req.userId, { email: g.newEmail, email_confirm: true });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('profiles').update({ email: g.newEmail }).eq('id', req.userId);
  res.json({ success: true, newEmail: g.newEmail });
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  const g = verifyPending(req.body?.grantedToken);
  if (!g || g.type !== 'granted' || g.action !== 'delete-account' || g.userId !== req.userId) return res.status(400).json({ error: 'Session expired' });
  await supabase.from('sessions').delete().eq('user_id', req.userId);
  const { error } = await supabase.auth.admin.deleteUser(req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// 2FA
app.post('/api/auth/2fa/setup', requireAuth, async (req, res) => {
  const { data: profile } = await supabase.from('profiles').select('email, totp_enabled').eq('id', req.userId).maybeSingle();
  if (profile?.totp_enabled) return res.status(400).json({ error: '2FA already enabled' });
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(profile?.email || 'user', 'DeepRWA', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 240, margin: 1, color: { dark: '#1e232a', light: '#ffffff' } });
  await supabase.from('profiles').update({ totp_secret: secret }).eq('id', req.userId);
  res.json({ secret, qrDataUrl });
});
app.post('/api/auth/2fa/enable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const { data: profile } = await supabase.from('profiles').select('totp_secret').eq('id', req.userId).maybeSingle();
  if (!profile?.totp_secret) return res.status(400).json({ error: 'Start setup first' });
  if (!authenticator.verify({ token: code, secret: profile.totp_secret })) return res.status(400).json({ error: 'Invalid 2FA code' });
  await supabase.from('profiles').update({ totp_enabled: true }).eq('id', req.userId);
  res.json({ success: true });
});
app.post('/api/auth/2fa/disable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const { data: profile } = await supabase.from('profiles').select('totp_secret').eq('id', req.userId).maybeSingle();
  if (!profile?.totp_secret) return res.status(400).json({ error: '2FA not enabled' });
  if (!authenticator.verify({ token: code, secret: profile.totp_secret })) return res.status(400).json({ error: 'Invalid 2FA code' });
  await supabase.from('profiles').update({ totp_enabled: false, totp_secret: null }).eq('id', req.userId);
  res.json({ success: true });
});

// SESSIONS
app.get('/api/auth/sessions', requireAuth, async (req, res) => {
  const clientId = req.headers['x-client-id'] || '';
  const { data } = await supabase.from('sessions').select('*').eq('user_id', req.userId).eq('revoked', false).order('last_active', { ascending: false });
  const sessions = (data || []).map(s => ({ ...s, current: s.client_id === clientId }));
  res.json({ sessions });
});
app.get('/api/auth/session-check', requireAuth, async (req, res) => {
  const clientId = (req.headers['x-client-id'] || '').toString().trim().slice(0, 80) || null;
  if (!clientId) return res.json({ valid: true });
  const { data } = await supabase.from('sessions').select('id, revoked, last_active').eq('user_id', req.userId).eq('client_id', clientId).maybeSingle();
  if (data) {
    if (data.revoked === true) return res.json({ valid: false, reason: 'revoked' });
    await supabase.from('sessions').update({ last_active: new Date().toISOString() }).eq('id', data.id);
    return res.json({ valid: true });
  }
  const ua = (req.headers['user-agent'] || 'Unknown').substring(0, 500);
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'Unknown').split(',')[0].trim();
  await supabase.from('sessions').insert({ user_id: req.userId, client_id: clientId, device: ua.substring(0, 120), user_agent: ua, ip, revoked: false });
  return res.json({ valid: true });
});
app.delete('/api/auth/sessions/:id', requireAuth, async (req, res) => {
  const clientId = req.headers['x-client-id'] || '';
  const { data: row } = await supabase.from('sessions').select('client_id').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
  if (row && row.client_id === clientId) return res.status(400).json({ error: 'Log out via account menu' });
  await supabase.from('sessions').update({ revoked: true, last_active: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.userId);
  res.json({ success: true });
});
app.delete('/api/auth/sessions-all-others', requireAuth, async (req, res) => {
  const clientId = req.headers['x-client-id'] || '';
  if (!clientId) return res.status(400).json({ error: 'Missing client id' });
  const { error } = await supabase.from('sessions').update({ revoked: true, last_active: new Date().toISOString() }).eq('user_id', req.userId).neq('client_id', clientId).eq('revoked', false);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});
app.delete('/api/auth/sessions-current', requireAuth, async (req, res) => {
  const clientId = req.headers['x-client-id'] || '';
  if (!clientId) return res.json({ success: true });
  await supabase.from('sessions').delete().eq('user_id', req.userId).eq('client_id', clientId);
  res.json({ success: true });
});

// FILE UPLOAD
app.post('/api/upload', requireAuth, async (req, res) => {
  const { name, type, data } = req.body || {};
  if (!name || !type || !data) return res.status(400).json({ error: 'Missing file data' });
  try {
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 10 MB)' });
    const ext = (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const filePath = `${req.userId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const { error: upErr } = await supabase.storage.from('uploads').upload(filePath, buffer, { contentType: type, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(filePath);
    res.json({ url: urlData.publicUrl, name, type });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// FILES LIST (basic)
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const { data: convs } = await supabase.from('conversations').select('id').eq('user_id', req.userId);
    const convIds = (convs || []).map(c => c.id);
    if (!convIds.length) return res.json({ files: [] });
    const { data } = await supabase.from('messages').select('files, created_at, role').in('conversation_id', convIds).not('files', 'is', null).order('created_at', { ascending: false });
    const all = [];
    for (const row of (data || [])) {
      if (Array.isArray(row.files)) for (const f of row.files) if (f && (f.url || f.public_url)) all.push({ ...f, url: f.url || f.public_url, created_at: row.created_at, role: row.role });
    }
    res.json({ files: all });
  } catch (e) { res.status(500).json({ error: e.message, files: [] }); }
});

// FILES LIST with IDs
app.get('/api/files-with-ids', requireAuth, async (req, res) => {
  try {
    const { data: convs } = await supabase.from('conversations').select('id').eq('user_id', req.userId);
    const convIds = (convs || []).map(c => c.id);
    if (!convIds.length) return res.json({ files: [] });
    const { data } = await supabase.from('messages').select('id, files, created_at, role').in('conversation_id', convIds).not('files', 'is', null).order('created_at', { ascending: false });
    const all = [];
    for (const row of (data || [])) {
      if (Array.isArray(row.files)) {
        row.files.forEach((f, i) => {
          if (f && (f.url || f.public_url)) all.push({ ...f, url: f.url || f.public_url, messageId: row.id, index: i, created_at: row.created_at, role: row.role });
        });
      }
    }
    console.log(`[files-with-ids] ${all.length} files for user ${req.userId.slice(0,8)}`);
    res.json({ files: all });
  } catch (e) { res.status(500).json({ error: e.message, files: [] }); }
});

app.delete('/api/files/:messageId/:fileIndex', requireAuth, async (req, res) => {
  const { messageId, fileIndex } = req.params;
  const idx = parseInt(fileIndex);
  if (isNaN(idx)) return res.status(400).json({ error: 'Invalid index' });
  const { data: msg } = await supabase.from('messages').select('conversation_id, files').eq('id', messageId).single();
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const { data: conv } = await supabase.from('conversations').select('user_id').eq('id', msg.conversation_id).single();
  if (!conv || conv.user_id !== req.userId) return res.status(403).json({ error: 'Not allowed' });
  const files = Array.isArray(msg.files) ? [...msg.files] : [];
  if (idx < 0 || idx >= files.length) return res.status(400).json({ error: 'Invalid index' });
  files.splice(idx, 1);
  await supabase.from('messages').update({ files }).eq('id', messageId);
  res.json({ success: true });
});

// TITLE
app.post('/api/chat/title', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  res.json({ title: await generateChatTitle(message) });
});

// CHAT: guest
app.post('/api/chat/guest', async (req, res) => {
  const { messages, attachments, voice } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  await streamChatResponse(res, { messages, conversationId: null, attachments: attachments || [], voice: !!voice });
});

// CHAT: authenticated
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, conversationId, attachments, voice } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  let convId = conversationId;
  const firstUserText = messages.find(m => m.role === 'user')?.content || '';
  if (!convId) {
    // Create the conversation instantly (no waiting for an AI-generated title),
    // then name it in the background.
    const quickTitle = isGreetingOnly(firstUserText) ? greetingLabel(firstUserText) : 'New chat';
    const { data: conv, error } = await supabase.from('conversations').insert({ user_id: req.userId, title: quickTitle }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    convId = conv.id;
    console.log(`[chat] new conv created: ${convId}`);
    if (quickTitle === 'New chat' && firstUserText) {
      generateChatTitle(firstUserText)
        .then(t => {
          if (!t || t === 'New chat') return;
          return supabase.from('conversations').update({ title: t }).eq('id', convId).eq('title', 'New chat');
        })
        .catch(e => console.warn('[title] background failed:', e.message));
    }
  }
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (lastUserMsg) {
    const filesArray = Array.isArray(lastUserMsg.files) ? lastUserMsg.files : [];
    const { error: insErr } = await supabase.from('messages').insert({
      conversation_id: convId,
      role: 'user',
      content: lastUserMsg.content,
      files: filesArray
    });
    if (insErr) console.warn(`[chat] failed to save user msg:`, insErr.message);
  }
  res.setHeader('X-Conversation-Id', convId);
  res.setHeader('Access-Control-Expose-Headers', 'X-Conversation-Id');
  await streamChatResponse(res, { messages, conversationId: convId, attachments: attachments || [], voice: !!voice });
});

// Keep the most recent part of the conversation that fits the model's context.
const MAX_HISTORY_CHARS = 60000;
const MAX_SINGLE_MSG_CHARS = 24000;
function prepareHistory(messages) {
  const clean = (messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.length > MAX_SINGLE_MSG_CHARS ? m.content.slice(0, MAX_SINGLE_MSG_CHARS) + '\n…[truncated]' : m.content }));
  const out = [];
  let total = 0;
  for (let i = clean.length - 1; i >= 0; i--) {
    const len = clean[i].content.length;
    if (out.length && total + len > MAX_HISTORY_CHARS) break;
    out.unshift(clean[i]);
    total += len;
  }
  while (out.length && out[0].role !== 'user') out.shift();
  // Merge accidental consecutive messages from the same role (some providers reject them).
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

// Streams from the first provider that answers. Falls back to the next one only
// if a provider fails before producing any text.
async function pipeProviders(list, invoke, send, isGone) {
  for (const p of list) {
    if (isGone()) return null;
    let text = '';
    try {
      for await (const chunk of invoke(p)) {
        if (isGone()) break;
        if (!chunk) continue;
        text += chunk;
        send({ text: chunk });
      }
      if (text.trim()) { console.log(`✅ ${p.name} (${text.length} chars)`); return { text, provider: p.name }; }
      if (isGone()) return text ? { text, provider: p.name, partial: true } : null;
      console.warn(`[empty] ${p.name}`);
    } catch (e) {
      console.warn(`[fail] ${p.name}: ${e.message}`);
      if (text.trim()) {
        const note = '\n\n_(The answer was cut off by a connection problem. Ask me to continue if you need the rest.)_';
        send({ text: note });
        return { text: text + note, provider: p.name, partial: true };
      }
    }
  }
  return null;
}

async function streamChatResponse(res, { messages, conversationId, attachments, voice }) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let clientGone = false;
  res.on('close', () => { clientGone = true; });
  const isGone = () => clientGone || res.writableEnded;
  const send = (o) => { if (!isGone()) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  // Comment pings keep mobile networks / proxies from closing a quiet stream.
  const ping = setInterval(() => { if (!isGone()) res.write(': ping\n\n'); }, 15000);
  const done = () => {
    clearInterval(ping);
    if (!isGone()) { res.write('data: [DONE]\n\n'); res.end(); }
  };
  const saveAssistant = async (content, files) => {
    if (!conversationId || !supabase || !content) return;
    try {
      const row = { conversation_id: conversationId, role: 'assistant', content };
      if (files) row.files = files;
      await supabase.from('messages').insert(row);
      await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
    } catch (e) { console.warn('save assistant msg failed:', e.message); }
  };

  const history = prepareHistory(messages);
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  const userText = lastUser?.content || '';
  if (!history.length) { send({ text: 'Please type a message.' }); return done(); }

  // ----- Image generation -----
  if ((!attachments || !attachments.length) && isImageGenerationRequest(userText)) {
    try {
      const intent = await classifyImageIntent(userText);
      if (intent.action === 'blocked') {
        const msg = "I can't create that kind of image, but I'm happy to make something else — describe a scene, person, place, product or idea you'd like to see.";
        send({ text: msg }); done(); saveAssistant(msg); return;
      }
      if (intent.action === 'offtopic') {
        const msg = "I create images of Rwanda's world — its places, people, culture, wildlife and ideas — so I won't draw that one. How about a Rwandan version, like Kigali's skyline at night, the hills of Musanze, or a gorilla in Volcanoes National Park?";
        send({ text: msg }); done(); saveAssistant(msg); return;
      }
      if (intent.action === 'clarify') {
        const msg = 'Sure — what would you like the image to show? Describe the subject, setting and style (for example: "a sunrise over Lake Kivu, watercolour style").';
        send({ text: msg }); done(); saveAssistant(msg); return;
      }
      if (intent.action === 'generate') {
        let result;
        try { result = await generateImage(intent.prompt); }
        catch (e) {
          console.warn('[image] generation failed:', e.message);
          const errText = "I couldn't create that image right now. Please try again in a moment.";
          send({ text: errText }); done(); saveAssistant(errText); return;
        }
        const intro = "Here's the image you asked for:";
        send({ text: intro });
        send({ image: result.url, prompt: intent.prompt });
        done();
        saveAssistant(intro, [{ url: result.url, public_url: result.url, type: 'image/jpeg', name: `generated-${Date.now()}.jpg`, generated: true }]);
        return;
      }
    } catch (e) {
      console.warn('[image] flow error:', e.message);
    }
  }

  // ----- Text / vision answer, streamed live -----
  const opts = { voice: !!voice, maxTokens: voice ? 800 : 4096 };
  const full = [{ role: 'system', content: buildSystemPrompt({ voice }) }, ...history];
  let result = null;

  if (attachments && attachments.length) {
    result = await pipeProviders(VISION_PROVIDERS, p => p.fn(full, attachments, opts), send, isGone);
  }

  if (!result && !isGone()) {
    let mod = full;
    if (attachments && attachments.length) {
      const textFiles = attachments.filter(a => a.mime === 'text/plain');
      let note = '';
      for (const f of textFiles) {
        try { note += `\n\n--- Attached file: ${f.name || 'file'} ---\n${Buffer.from(f.data, 'base64').toString('utf8').slice(0, 30000)}`; } catch {}
      }
      const others = attachments.filter(a => a.mime !== 'text/plain');
      if (others.length) note += `\n\n[${others.length} file(s) attached: ${others.map(a => a.name || a.mime).join(', ')} — the file reader is temporarily unavailable, so tell the user you couldn't open them and answer what you can.]`;
      const lastIdx = mod.length - 1;
      if (mod[lastIdx]?.role === 'user') mod = mod.map((m, i) => i === lastIdx ? { ...m, content: m.content + note } : m);
    }
    result = await pipeProviders(PROVIDERS, p => p.fn(mod, opts), send, isGone);
  }

  if (!result) {
    if (!isGone()) send({ text: 'Sorry, the AI service is temporarily busy. Please try again in a moment.' });
    return done();
  }

  done();
  await saveAssistant(result.text);
}

// CONVERSATIONS
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { data } = await supabase.from('conversations').select('*').eq('user_id', req.userId).order('updated_at', { ascending: false });
  res.json({ conversations: data || [] });
});
app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const { data: conv } = await supabase.from('conversations').select('user_id').eq('id', req.params.id).single();
  if (!conv || conv.user_id !== req.userId) return res.status(403).json({ error: 'Not allowed' });
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
app.post('/api/chat/messages/:id/sync-versions', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { userMessageContent, userMessageFiles, versions, versionFiles, aiReplies, aiFiles, currentVersionIndex, assistantContent, assistantFiles } = req.body || {};
  const { data: msg } = await supabase.from('messages').select('conversation_id, role, created_at').eq('id', id).single();
  if (!msg || msg.role !== 'user') return res.status(404).json({ error: 'Message not found' });
  const { data: conv } = await supabase.from('conversations').select('user_id').eq('id', msg.conversation_id).single();
  if (!conv || conv.user_id !== req.userId) return res.status(403).json({ error: 'Not allowed' });
  await supabase.from('messages').update({ content: userMessageContent, files: userMessageFiles || [], versions: versions || [], version_files: versionFiles || [], ai_replies: aiReplies || [], ai_files: aiFiles || [], current_version_index: currentVersionIndex || 0 }).eq('id', id);
  await supabase.from('messages').delete().eq('conversation_id', msg.conversation_id).gt('created_at', msg.created_at);
  const { data: newMsg } = await supabase.from('messages').insert({ conversation_id: msg.conversation_id, role: 'assistant', content: assistantContent, files: assistantFiles || [] }).select().single();
  await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', msg.conversation_id);
  res.json({ assistantMessageId: newMsg?.id });
});

// SHARE
app.post('/api/share/guest', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages required' });
  const token = crypto.randomBytes(16).toString('hex');
  const { error } = await supabase.from('guest_shares').insert({ token, messages });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ token, url: `https://deeprwa.agentdomains.co/share/${token}` });
});
app.get('/api/share/:token', async (req, res) => {
  const { token } = req.params;
  const { data: guestShare } = await supabase.from('guest_shares').select('messages').eq('token', token).maybeSingle();
  if (guestShare) return res.json({ type: 'chat', messages: guestShare.messages });
  const { data: sharedChat } = await supabase.from('shared_links').select('conversation_id').eq('token', token).maybeSingle();
  if (sharedChat) {
    const { data: messages } = await supabase.from('messages').select('*').eq('conversation_id', sharedChat.conversation_id).order('created_at');
    return res.json({ type: 'chat', messages: messages || [] });
  }
  res.status(404).json({ error: 'Not found' });
});
app.get('/share/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'share.html')));

// STATIC
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api|health|robots|sitemap|av\.png|share).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`DeepRWA listening on :${PORT}`));
