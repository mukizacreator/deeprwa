// DeepRWA — Phase 3: Chat Core
// Complete backend: provider chain, system prompt, streaming, greeting & identity detection.
// Auth, files, images, vision, search, share come in later phases — all in this same file.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api/', apiLimiter);

// ============================================================
// SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `You are **DeepRWA** — a professional AI assistant specialised exclusively in information about Rwanda.

## IDENTITY (never violate)
- Your name is DeepRWA.
- You were created by **Emmanuel Mukiza**, a Rwandan national, under his developing company **The Star🌟**.
- The Star🌟 was launched on **August 8, 2023**, and is a two-person team: **Mr. Emmanuel Mukiza** and **Ms. Ornella Mutuyimana**.
- Emmanuel graduated from **Karenge Adventist Secondary School (KASS)** with an Advanced Level certificate in **Computer System and Architecture (CSA)**.
- Ornella graduated from **Lycée Saint Marcel de Rukara (LSM)** with an Advanced Level certificate in **Mathematics, Computer Science and Economics (MCE)**.
- DeepRWA exists to make information about Rwanda easily accessible to everyone.
- If a user asks about your platform, hosting, or creation, reply exactly: "I am DeepRWA, created by Emmanuel Mukiza under The Star🌟, specialised in information about Rwanda." — and nothing more.

## SCOPE
You answer **only** questions about Rwanda. Everything about Rwanda is in scope: geography, provinces/districts/sectors/cells/villages, products and prices, notable people, history, culture, tourism, travel, events, news, official services, education, agriculture, business, daily life.

If the user asks about **any other country** or a topic unrelated to Rwanda, reply exactly:
"I am specialised only in topics about Rwanda. I cannot answer questions about other countries or topics."

Do not attempt partial answers about other countries. Politely decline.

## GREETINGS AND SMALL TALK
Greetings, thanks, goodbyes, "how are you", "who are you", "who made you" are NOT out of scope. Respond warmly and briefly, then invite a Rwanda-related question. Recognise greetings in any language and reply in the same language the user greeted you in.

## LANGUAGE RULE (critical)
Always reply in the **exact language the user wrote in**. If the user writes in Kinyarwanda, reply in Kinyarwanda. French → French. Arabic → Arabic. Chinese → Chinese. Never switch to English unless the user does. Support every language that the user might use.

## RULES FOR YOUR RESPONSES
1. Accuracy first.
2. If you cannot find a definitive answer, say so politely. Never invent facts, dates, names, prices, or locations.
3. Be concise, clear, easy to understand.
4. Respectful tone always — especially on the 1994 Genocide against the Tutsi and on personal or cultural subjects.
5. Use Markdown when it improves readability: bullet lists, tables, **bold** for key names. No raw HTML.
6. Never output raw HTML, CSS, or JavaScript. Use triple backticks with a language tag for code blocks.
7. For questions you cannot answer, say so plainly and, when useful, suggest a Rwandan institution or official source.

## OUTPUT FORMAT
- Markdown only. No HTML.
- Bold the key subject in each answer (e.g. **Kigali**, **Volcanoes National Park**).
- Short paragraphs, bullet lists, tables when they help.
- For prices, state currency (RWF) and add "approximate, may vary".
- For dates, use full form (e.g. "1 July 1962 — Rwanda's independence").

## STYLE
Warm, professional, concise, respectful. Short disclaimers when discussing prices, health, law, or history.`;

// ============================================================
// GREETING & IDENTITY DETECTION
// ============================================================
const GREETING_EXACT = new Set([
  'hi','hello','hey','yo','hiya','howdy','sup','whats up',"what's up",
  'good morning','good afternoon','good evening','good night',
  'thanks','thank you','thx','ty','bye','goodbye','see you','see ya',
  'how are you',"how're you",'how are you doing','how do you do',
  'muraho','mwaramutse','mwiriwe','amakuru','bite','bite se','ni amakuru ki',
  'bonjour','salut','bonsoir','coucou','comment ca va','comment ça va','ça va','ca va',
  'jambo','habari','hujambo','sijambo','habari yako','nzuri',
  'hola','olá','ciao','hallo','hallo daar','hallo daar','hei','hei der','hallo'
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

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreeting(text) {
  const n = normalise(text);
  if (!n) return false;
  if (GREETING_EXACT.has(n)) return true;
  if (n.length > 40) return false;
  // short friendly openers
  if (/^(hi|hey|hello|yo|muraho|bonjour|jambo|hola|ciao|hallo)\b/.test(n) && n.split(' ').length <= 4) return true;
  return false;
}

function isIdentityQuestion(text) {
  const n = normalise(text);
  return IDENTITY_PATTERNS.some(r => r.test(n));
}

function buildGreetingReply(text) {
  const n = normalise(text);
  if (/\b(muraho|mwaramutse|mwiriwe|amakuru|bite)\b/.test(n))
    return "Muraho! Ndine DeepRWA — umufasha wawe mu bya Rwanda. Mbaza ikibazo cyose ku Rwanda: amateka, umuco, ubukerarugendo, abantu, cyangwa ibindi.";
  if (/\b(bonjour|salut|bonsoir|coucou|ça va|ca va)\b/.test(n))
    return "Bonjour ! Je suis DeepRWA, votre assistant spécialisé sur le Rwanda. Posez-moi n'importe quelle question sur le Rwanda : histoire, culture, tourisme, actualités.";
  if (/\b(jambo|habari|hujambo|sijambo)\b/.test(n))
    return "Jambo! Mimi ni DeepRWA, msaidizi wako kuhusu Rwanda. Uliza swali lolote kuhusu Rwanda — historia, utamaduni, utalii, habari.";
  if (/\b(hola|olá)\b/.test(n))
    return "¡Hola! Soy DeepRWA, tu asistente especializado en Ruanda. Pregúntame lo que quieras sobre Ruanda.";
  if (/\b(ciao)\b/.test(n))
    return "Ciao! Sono DeepRWA, il tuo assistente specializzato sul Ruanda. Chiedimi qualsiasi cosa sul Ruanda.";
  if (/\b(hallo|hei)\b/.test(n))
    return "Hallo! Ich bin DeepRWA, dein Assistent für Ruanda. Frag mich alles über Ruanda.";
  if (/\b(thanks|thank you|thx|ty)\b/.test(n))
    return "You're welcome! Feel free to ask me anything about Rwanda.";
  if (/\b(bye|goodbye|see you|see ya)\b/.test(n))
    return "Goodbye! Come back any time you have a question about Rwanda.";
  return "Hello! I'm DeepRWA, your assistant specialised in Rwanda. Ask me anything about Rwanda — history, culture, tourism, people, news.";
}

const IDENTITY_REPLY = "I am DeepRWA, created by Emmanuel Mukiza under The Star🌟, specialised in information about Rwanda.";

// ============================================================
// PROVIDER CHAIN
// ============================================================
const cooldown = new Map(); // key = provider:model -> until timestamp

function isCooling(key) {
  const until = cooldown.get(key);
  if (!until) return false;
  if (Date.now() > until) { cooldown.delete(key); return false; }
  return true;
}

function setCooldown(key, ms) {
  cooldown.set(key, Date.now() + ms);
}

async function* sseFromOpenAICompatible(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    const e = new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
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
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {}
    }
  }
}

async function* streamGroq(messages) {
  const key = 'groq:gpt-oss-120b';
  if (isCooling(key)) throw new Error('cooling');
  try {
    yield* sseFromOpenAICompatible(
      'https://api.groq.com/openai/v1/chat/completions',
      { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      { model: 'openai/gpt-oss-120b', messages, stream: true, temperature: 0.7, max_completion_tokens: 2048 }
    );
  } catch (e) {
    setCooldown(key, e.status === 429 ? 120_000 : 300_000);
    throw e;
  }
}

async function* streamOpenRouter(messages) {
  const key = 'openrouter:free';
  if (isCooling(key)) throw new Error('cooling');
  try {
    yield* sseFromOpenAICompatible(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://deeprwa.agentdomains.co',
        'X-Title': 'DeepRWA'
      },
      { model: 'openrouter/free', messages, stream: true, temperature: 0.7, max_tokens: 2048 }
    );
  } catch (e) {
    setCooldown(key, e.status === 429 ? 120_000 : 300_000);
    throw e;
  }
}

async function* streamNVIDIA(messages) {
  const key = 'nvidia:nemotron';
  if (isCooling(key)) throw new Error('cooling');
  try {
    yield* sseFromOpenAICompatible(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
      { model: 'nvidia/nemotron-3-super-120b-a12b', messages, stream: true, temperature: 0.7, max_tokens: 2048 }
    );
  } catch (e) {
    setCooldown(key, e.status === 429 ? 120_000 : 300_000);
    throw e;
  }
}

async function* streamPollinations(messages) {
  const key = 'pollinations:openai';
  if (isCooling(key)) throw new Error('cooling');
  try {
    yield* sseFromOpenAICompatible(
      'https://text.pollinations.ai/openai',
      {},
      { model: 'openai', messages, stream: true, temperature: 0.7, max_tokens: 2048 }
    );
  } catch (e) {
    setCooldown(key, 120_000);
    throw e;
  }
}

// Gemini uses its own SSE format
async function* streamGemini(messages) {
  const key = 'gemini:3.6-flash';
  if (isCooling(key)) throw new Error('cooling');

  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const convo = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const body = {
    contents: convo,
    systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      const e = new Error(`Gemini HTTP ${res.status}: ${err.slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const parts = json.candidates?.[0]?.content?.parts || [];
          for (const p of parts) if (p.text) yield p.text;
        } catch {}
      }
    }
  } catch (e) {
    setCooldown(key, e.status === 429 ? 120_000 : 300_000);
    throw e;
  }
}

async function* streamCloudflare(messages) {
  const key = 'cloudflare:llama33';
  if (isCooling(key)) throw new Error('cooling');
  const acct = process.env.CF_ACCOUNT_ID;
  const url = `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messages, stream: true })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      const e = new Error(`Cloudflare HTTP ${res.status}: ${err.slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.response || json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {}
      }
    }
  } catch (e) {
    setCooldown(key, e.status === 429 ? 120_000 : 300_000);
    throw e;
  }
}

const PROVIDERS = [
  { name: 'Groq',        fn: streamGroq },
  { name: 'Gemini',      fn: streamGemini },
  { name: 'OpenRouter',  fn: streamOpenRouter },
  { name: 'Cloudflare',  fn: streamCloudflare },
  { name: 'NVIDIA',      fn: streamNVIDIA },
  { name: 'Pollinations',fn: streamPollinations }
];

// ============================================================
// ROUTES
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DeepRWA', version: '1.0.0', time: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
  res.json({ name: 'DeepRWA', tagline: 'Your AI guide to Rwanda', version: '1.0.0' });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: https://deeprwa.agentdomains.co/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const base = 'https://deeprwa.agentdomains.co';
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>`
  );
});

// ---- Streaming chat (guest) ----
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUser?.content || '';

  // Fast paths (no LLM call)
  if (isIdentityQuestion(userText)) {
    for (const ch of IDENTITY_REPLY) send({ text: ch });
    return done();
  }
  if (isGreeting(userText) && messages.length <= 2) {
    const reply = buildGreetingReply(userText);
    for (const ch of reply) send({ text: ch });
    return done();
  }

  // Build messages with system prompt
  const full = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];

  let lastErr = null;
  for (const provider of PROVIDERS) {
    try {
      let started = false;
      for await (const chunk of provider.fn(full)) {
        started = true;
        send({ text: chunk });
      }
      if (!started) throw new Error('empty stream');
      return done();
    } catch (e) {
      lastErr = e;
      console.warn(`[provider fail] ${provider.name}: ${e.message}`);
      continue;
    }
  }

  send({ text: 'Sorry, all AI providers are temporarily unavailable. Please try again in a moment.' });
  send({ error: String(lastErr?.message || 'unknown') });
  done();
});

// ---- Static frontend ----
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api|health|robots|sitemap).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`DeepRWA listening on :${PORT}`));
