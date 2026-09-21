// DeepRWA — Complete backend (rev.4.3.0)
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
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '40mb' }));

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
async function verifyPassword(email, password) {
  if (!supabaseUrl || !supabaseAnon) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': supabaseAnon },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) return null;
    return (await res.json()).user || null;
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
  res.json({ status: 'ok', service: 'DeepRWA', version: '4.3.0', time: new Date().toISOString() });
});

// ============ SYSTEM PROMPT ============
const SYSTEM_PROMPT = `You are **DeepRWA** — a professional, world-class AI assistant specialised in information about Rwanda, created by **Emmanuel Mukiza** under **The Star🌟**.

## IDENTITY (never violate)
- Your name is DeepRWA.
- Created by **Emmanuel Mukiza**, a Rwandan national, under his company **The Star🌟**.
- The Star🌟 was launched on **August 8, 2023**.
- Emmanuel graduated from **Karenge Adventist Secondary School (KASS)** with an Advanced Level certificate in **Computer System and Architecture (CSA)**.
- If a user asks a *simple* identity question ("who are you", "who made you", "what is your name"), reply exactly: "I am DeepRWA, created by Emmanuel Mukiza under The Star🌟, specialised in information about Rwanda." — and nothing more.
- For longer, compound, or meta questions, answer like a normal professional assistant — do NOT paste the identity line.

## PRIMARY PURPOSE
Your main purpose is to answer questions about **Rwanda**. Everything about Rwanda is in scope: geography, provinces/districts/sectors/cells/villages, products and prices, notable people, history, culture, tourism, travel, events, news, official services, education, agriculture, business, and daily life.

## CONVERSATIONAL HANDLING (very important)
You are a conversational assistant, not a lookup table. You MUST handle normal human back-and-forth naturally, even when it isn't a Rwanda question:

- **Greetings, thanks, goodbyes, small talk** ("hi", "how are you", "what's up", "are you ready", "thanks", "bye") → respond warmly and briefly, then invite a Rwanda question.
- **Meta questions about yourself** (name, creator, capabilities, what you can/can't do, how you work) → answer truthfully and concisely.
- **Requests about STYLE, TONE, ACCENT, LANGUAGE, FORMALITY, or LENGTH** — accept them and comply. If the user says "let's use American English", "speak formally", "reply briefly", "respond in French", "use a friendly tone" — this is a legitimate, in-scope instruction. Confirm it briefly ("Got it — I'll reply in American English.") and continue.
- **Setup phrases** like "let's do X", "can you help me with something", "I want to ask you about Y", "are you ready" → acknowledge warmly and invite the question.
- **Follow-up questions** that refer to what was previously discussed → treat them as in-scope.

## WHEN TO DECLINE
You decline ONLY when the user asks:
- A **specific fact about another country** (e.g. "What is the capital of Uganda?").
- A **substantive explanation of a non-Rwanda topic** (e.g. "Explain quantum physics", "Summarise French history").
- To **analyse a file unrelated to Rwanda** (see FILE SCOPE).

When you decline, reply exactly: "I'm specialised in topics about Rwanda. I can't answer questions about other countries or unrelated topics. Feel free to ask me anything about Rwanda."

Do NOT decline:
- Requests about tone, accent, language, style, or length.
- Greetings or chit-chat.
- Meta questions about yourself.
- Questions that only MENTION another country while being primarily about Rwanda.
- Follow-up questions in an ongoing conversation.

## LANGUAGE RULE
Always reply in the **exact language the user wrote in**. Kinyarwanda → Kinyarwanda. French → French. Arabic → Arabic. Chinese → Chinese. Never switch to English unless the user does.

## IMAGE GENERATION
You can create images, but only about Rwanda. The system handles Rwanda-scoped image generation automatically.

## FILE SCOPE (STRICT)
Before analysing ANY attached file, determine whether the file's content is about Rwanda.
- If the file IS about Rwanda: analyse it fully.
- If the file is CLEARLY NOT about Rwanda: politely decline using EXACTLY: "The file you uploaded appears to be about [short topic], which is outside my scope. I'm specialised only in Rwanda. Please upload something Rwanda-related, or ask me a question about Rwanda."
- NEVER describe, summarise, quote, or analyse out-of-scope file content.
- If ambiguous, ask first: "Is this file related to Rwanda? If yes, I'll analyse it in detail."

## META QUESTIONS ABOUT YOU
Questions about your own capabilities are IN SCOPE — answer truthfully.

## GENERAL KNOWLEDGE
You may use general world knowledge to contextualise Rwanda answers. Do not answer standalone questions about other countries or unrelated topics.

## FORMATTING
- NEVER use horizontal rules (---, ___, <hr>).
- Use headings (##, ###), bullet lists, and **bold** for emphasis.
- Markdown only. No raw HTML.

## RULES
1. Accuracy first. If you don't know, say so. Never invent facts.
2. Be warm, professional, and concise.
3. If the user sets a tone/accent/style, keep it for the rest of the conversation.

## STYLE
Warm, professional, concise, respectful.`;

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
  const n = String(msg || '').toLowerCase();
  if (/\b(video|movie|clip|animation|audio|sound)\b/.test(n) && !/\b(image|photo|picture|illustration|drawing|artwork|painting)\b/.test(n)) return false;
  if (/\b(image|photo|picture|illustration|drawing|artwork|painting)\s+of\b/.test(n)) return true;
  if (/\b(draw|paint|sketch|illustrate)\s+(me\s+)?(a|an|the)\b/.test(n)) return true;
  return /\b(create|generate|make|draw|produce|design|paint|sketch|illustrate|give|show|provide|send)\b[\s\S]{0,60}\b(image|photo|picture|illustration|drawing|artwork|painting)\b/.test(n);
}

function keywordRwandaImageCheck(subject) {
  const n = String(subject || '').toLowerCase();
  return RWANDA_IMAGE_KEYWORDS.some(k => n.includes(k));
}

function extractImagePrompt(msg) {
  let s = String(msg || '').trim();
  s = s.replace(/^\s*(please\s+)?(can you\s+)?(could you\s+)?(would you\s+)?/i, '');
  s = s.replace(/\b(create|generate|make|produce|design|paint|sketch|illustrate|draw|show|give|send|provide|find|get)\b/gi, ' ');
  s = s.replace(/\b(me|a|an|the|of|for|some|image|photo|picture|illustration|drawing|artwork|painting)\b/gi, ' ');
  s = s.replace(/\s+and\s+(also\s+)?(tell|explain|describe|show)\b[\s\S]*$/i, '');
  s = s.replace(/[^\p{L}\p{N}\s'-]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || msg;
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
  const enhanced = `${prompt}, Rwanda, East Africa, photorealistic, professional photography, natural lighting, high detail, no text, no watermark`;
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

async function classifyImageIntent(userText) {
  const n = normalise(userText);
  if (keywordRwandaImageCheck(n)) {
    return { action: 'generate', prompt: extractImagePrompt(userText) };
  }
  return { action: 'off_topic' };
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
const cooldown = new Map();
function isCooling(k) { const u = cooldown.get(k); if (!u) return false; if (Date.now() > u) { cooldown.delete(k); return false; } return true; }
function setCooldown(k, ms) { cooldown.set(k, Date.now() + ms); }

function sanitizeForProvider(messages) {
  return messages.map(m => ({ role: m.role, content: m.content }));
}

async function* sseOpenAI(url, headers, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); const e = new Error(`HTTP ${res.status}: ${t.slice(0, 150)}`); e.status = res.status; throw e; }
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
  } finally { clearTimeout(timer); }
}

async function* streamGroq(msgs) {
  const k = 'groq'; if (isCooling(k)) throw new Error('cooling');
  try { yield* sseOpenAI('https://api.groq.com/openai/v1/chat/completions', { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, { model: 'openai/gpt-oss-120b', messages: sanitizeForProvider(msgs), stream: true, temperature: 0.7, max_completion_tokens: 2048 }); }
  catch (e) { setCooldown(k, e.status === 429 ? 120000 : 300000); throw e; }
}
async function* streamOpenRouter(msgs) {
  const k = 'or'; if (isCooling(k)) throw new Error('cooling');
  try { yield* sseOpenAI('https://openrouter.ai/api/v1/chat/completions', { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://deeprwa.agentdomains.co', 'X-Title': 'DeepRWA' }, { model: 'openrouter/free', messages: sanitizeForProvider(msgs), stream: true, temperature: 0.7, max_tokens: 2048 }); }
  catch (e) { setCooldown(k, e.status === 429 ? 120000 : 300000); throw e; }
}
async function* streamNVIDIA(msgs) {
  const k = 'nv'; if (isCooling(k)) throw new Error('cooling');
  try { yield* sseOpenAI('https://integrate.api.nvidia.com/v1/chat/completions', { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` }, { model: 'nvidia/nemotron-3-super-120b-a12b', messages: sanitizeForProvider(msgs), stream: true, temperature: 0.7, max_tokens: 2048 }); }
  catch (e) { setCooldown(k, e.status === 429 ? 120000 : 300000); throw e; }
}
async function* streamPollinations(msgs) {
  const k = 'poll'; if (isCooling(k)) throw new Error('cooling');
  try { yield* sseOpenAI('https://text.pollinations.ai/openai', {}, { model: 'openai', messages: sanitizeForProvider(msgs), stream: true, temperature: 0.7, max_tokens: 2048 }); }
  catch (e) { setCooldown(k, 120000); throw e; }
}
async function* streamCloudflare(msgs) {
  const k = 'cf'; if (isCooling(k)) throw new Error('cooling');
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: sanitizeForProvider(msgs), stream: true }) });
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
  const sanitized = sanitizeForProvider(msgs);
  const sys = sanitized.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const convo = sanitized.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents: convo, systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } };
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

// ============ VISION ============
async function* streamGeminiVision(messages, attachments) {
  const sanitized = sanitizeForProvider(messages);
  const sys = sanitized.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const userMsgs = sanitized.filter(m => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1];
  const priorConvo = sanitized.filter(m => m.role !== 'system' && m !== lastUser).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const parts = [{ text: lastUser?.content || 'Analyse the attached file(s).' }];
  for (const f of attachments) parts.push({ inline_data: { mime_type: f.mime, data: f.data } });
  const body = { contents: [...priorConvo, { role: 'user', parts }], systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const e = new Error(`Gemini Vision ${res.status}`); e.status = res.status; throw e; }
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

async function* streamOpenRouterVision(messages, attachments) {
  const images = attachments.filter(a => (a.mime || '').startsWith('image/'));
  if (!images.length) throw new Error('no images');
  const sanitized = sanitizeForProvider(messages);
  const lastIdx = sanitized.map(m => m.role).lastIndexOf('user');
  const content = [];
  content.push({ type: 'text', text: sanitized[lastIdx]?.content || 'Analyse the attached image(s).' });
  for (const f of images) content.push({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data}` } });
  const convo = sanitized.map((m, i) => i === lastIdx ? { role: 'user', content } : { role: m.role, content: m.content });
  yield* sseOpenAI(
    'https://openrouter.ai/api/v1/chat/completions',
    { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://deeprwa.agentdomains.co', 'X-Title': 'DeepRWA' },
    { model: 'openrouter/free', messages: convo, stream: true, temperature: 0.7, max_tokens: 2048 },
    40000
  );
}

async function* streamNVIDIAVision(messages, attachments) {
  const images = attachments.filter(a => (a.mime || '').startsWith('image/'));
  if (!images.length) throw new Error('no images');
  const sanitized = sanitizeForProvider(messages);
  const lastIdx = sanitized.map(m => m.role).lastIndexOf('user');
  const content = [];
  content.push({ type: 'text', text: sanitized[lastIdx]?.content || 'Analyse the attached image(s).' });
  for (const f of images) content.push({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data}` } });
  const convo = sanitized.map((m, i) => i === lastIdx ? { role: 'user', content } : { role: m.role, content: m.content });
  yield* sseOpenAI(
    'https://integrate.api.nvidia.com/v1/chat/completions',
    { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
    { model: 'meta/llama-3.2-11b-vision-instruct', messages: convo, stream: true, temperature: 0.7, max_tokens: 2048 },
    40000
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
  'you','the','a','an','ok','okay','yeah','yes','no','bye','hi','hello',
  'hmm','mm hmm','uh','um','oh','ah','eh','wow','right','really','so','and','but','or'
]);
function looksLikePhantom(text) {
  if (!text) return true;
  const t = String(text).trim();
  if (t.length < 2) return true;
  const lower = t.toLowerCase().replace(/[.,!?;:。、！？…♪"'"'`~]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (PHANTOM_PHRASES.has(lower)) return true;
  const words = lower.split(/\s+/);
  if (words.length === 1 && lower.length <= 3) return true;
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
app.get('/api/config', (req, res) => res.json({ name: 'DeepRWA', version: '4.3.0', supabaseUrl: supabaseUrl || null, supabaseAnonKey: supabaseAnon || null }));
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
  const user = await verifyPassword(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
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
  if (!g || g.type !== 'forgot-password-granted') return res.status(400).json({ error: 'Session expired' });
  const same = await verifyPassword(g.email, newPassword);
  if (same) return res.status(400).json({ error: 'New password must be different from the current one' });
  const { error } = await supabase.auth.admin.updateUserById(g.userId, { password: newPassword });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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
  if (!await verifyPassword(profile?.email, currentPassword)) return res.status(401).json({ error: 'Current password is incorrect' });
  if (await verifyPassword(profile?.email, newPassword)) return res.status(400).json({ error: 'New password must be different' });
  const { error } = await supabase.auth.admin.updateUserById(req.userId, { password: newPassword });
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
  const { messages, attachments } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  await streamChatResponse(messages, res, null, attachments || []);
});

// CHAT: authenticated
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, conversationId, attachments } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  let convId = conversationId;
  const firstUserText = messages.find(m => m.role === 'user')?.content || '';
  if (!convId) {
    const title = await generateChatTitle(firstUserText);
    const { data: conv, error } = await supabase.from('conversations').insert({ user_id: req.userId, title }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    convId = conv.id;
    console.log(`[chat] new conv created: "${title}"`);
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
  await streamChatResponse(messages, res, convId, attachments || []);
});

async function streamChatResponse(messages, res, conversationId, attachments) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUser?.content || '';

  if ((!attachments || !attachments.length)) {
    if (isIdentityQuestion(userText)) {
      send({ text: IDENTITY_REPLY });
      return done();
    }
    if (isGreeting(userText) && messages.length <= 2) {
      send({ text: buildGreetingReply(userText) });
      return done();
    }

    if (isImageGenerationRequest(userText)) {
      try {
        const intent = await classifyImageIntent(userText);
        if (intent.action === 'generate' && intent.prompt) {
          let result;
          try { result = await generateImage(intent.prompt); }
          catch (e) {
            const errText = "I couldn't create that image right now. Please try again in a moment.";
            console.warn('[image] generation failed:', e.message);
            send({ text: errText });
            if (conversationId && supabase) {
              try { await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: errText }); } catch {}
            }
            return done();
          }
          const intro = "Here's the image you asked for:";
          send({ text: intro });
          send({ image: result.url, prompt: intent.prompt });
          if (conversationId && supabase) {
            try {
              const filename = `generated-${Date.now()}.jpg`;
              await supabase.from('messages').insert({
                conversation_id: conversationId,
                role: 'assistant',
                content: intro,
                files: [{ url: result.url, public_url: result.url, type: 'image/jpeg', name: filename, generated: true }]
              });
            } catch (e) { console.warn('save image msg failed:', e.message); }
          }
          return done();
        }
        if (intent.action === 'off_topic') {
          const refusal = "I'm DeepRWA, specialised in Rwanda. I can create images related to Rwanda — landscapes, cities, cultural scenes, wildlife, notable places, and similar — but not unrelated subjects. If you'd like a Rwanda-related image, just describe what you need — for example, \"a maize field in Rwanda at sunrise\" or \"a mountain gorilla in Volcanoes National Park\".";
          send({ text: refusal });
          if (conversationId && supabase) {
            try { await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: refusal }); } catch {}
          }
          return done();
        }
      } catch (e) {
        console.warn('[image] flow error:', e.message);
      }
    }
  }

  let fullText = '';
  let handled = false;

  if (attachments && attachments.length) {
    for (const vp of VISION_PROVIDERS) {
      try {
        const chunks = [];
        for await (const chunk of vp.fn(messages, attachments)) chunks.push(chunk);
        const t = chunks.join('');
        if (t.trim()) { fullText = t; handled = true; console.log(`✅ ${vp.name} responded (${t.length} chars)`); break; }
      } catch (e) { console.warn(`[fail] ${vp.name}: ${e.message}`); continue; }
    }
  }

  if (!handled) {
    let mod = messages;
    if (attachments && attachments.length) {
      const names = attachments.map(a => a.name || a.mime).join(', ');
      const note = `\n\n[${attachments.length} file(s) attached: ${names} — vision service unavailable]`;
      const lastIdx = mod.length - 1;
      if (mod[lastIdx]?.role === 'user') mod = mod.map((m, i) => i === lastIdx ? { ...m, content: m.content + note } : m);
    }
    const sanitized = sanitizeForProvider(mod);
    const full = [{ role: 'system', content: SYSTEM_PROMPT }, ...sanitized];
    for (const p of PROVIDERS) {
      try {
        const chunks = [];
        for await (const chunk of p.fn(full)) chunks.push(chunk);
        const t = chunks.join('');
        if (t.trim()) { fullText = t; handled = true; console.log(`✅ ${p.name} responded (${t.length} chars)`); break; }
      } catch (e) { console.warn(`[fail] ${p.name}: ${e.message}`); continue; }
    }
    if (!handled) { send({ text: 'Sorry, all AI providers are temporarily unavailable. Please try again.' }); return done(); }
  }

  send({ text: fullText });
  if (conversationId && supabase) {
    try { await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content: fullText }); } catch (e) { console.warn('save assistant msg failed:', e.message); }
  }
  return done();
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
