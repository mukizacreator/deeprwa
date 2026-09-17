# DeepRWA — Your AI Guide to Rwanda 🇷🇼

[![Live](https://img.shields.io/badge/live-deeprwa.agentdomains.co-blue)](https://deeprwa.agentdomains.co)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Made in Rwanda](https://img.shields.io/badge/made%20in-Rwanda%20🇷🇼-1eb53a)](https://deeprwa.agentdomains.co)

**DeepRWA** is a free, multilingual AI assistant specialised in everything about Rwanda — history, culture, tourism, geography, notable people, education, agriculture, business, and daily life. Ask anything about Rwanda, in any language.

👉 **Try it live: [https://deeprwa.agentdomains.co](https://deeprwa.agentdomains.co)**

---

## Table of contents

- [What DeepRWA does](#what-deeprwa-does)
- [Why DeepRWA](#why-deeprwa)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Running locally](#running-locally)
- [Environment variables](#environment-variables)
- [Deployment](#deployment)
- [Security](#security)
- [Roadmap](#roadmap)
- [About](#about)
- [License](#license)

---

## What DeepRWA does

- **Rwanda-only focus** — deliberately scoped. DeepRWA answers questions about Rwanda and politely declines off-topic ones, keeping responses accurate and focused on the domain it knows best.
- **Multilingual by design** — replies in the exact language the user writes in. Kinyarwanda → Kinyarwanda. French → French. Swahili, Arabic, Chinese, and dozens more are all supported.
- **File understanding** — users can attach images, PDFs, and text files. DeepRWA analyses files that relate to Rwanda and declines out-of-scope files with a clear explanation.
- **Persistent chat history** — signed-in users get conversations that sync across devices.
- **Message versioning** — editing a sent message preserves the previous versions, allowing users to compare branches of the same conversation, similar to ChatGPT.
- **Public sharing** — any chat or a single message pair can be shared as a read-only public link with a stable URL.
- **Multi-session security** — email-verified signup, optional TOTP-based 2FA, per-device session management, and the ability to remotely log out any session.
- **Universal responsiveness** — designed and tested to work identically on phones, tablets, foldables, touch laptops, digital pens, and desktops.

---

## Why DeepRWA

Information about Rwanda is scattered across the web, often in English only, and frequently outdated or shallow. DeepRWA exists to make that information accessible to anyone — in their own language, on any device, for free.

Built by a Rwandan developer, for Rwandans and for everyone curious about the country.

---

## Tech stack

**Frontend** — vanilla JavaScript, HTML, and CSS. No framework, no build step, no bundler. Deliberately lightweight so the app loads fast on slow connections and cheap devices.

**Backend** — Node.js + Express, streaming AI responses over Server-Sent Events (SSE).

**Database, Auth & Storage** — [Supabase](https://supabase.com) (PostgreSQL + GoTrue Auth + S3-compatible object storage).

**Transactional email** — [Brevo](https://brevo.com) for verification codes and password-reset codes.

**AI providers** — a resilience waterfall so no single provider outage takes DeepRWA down:

| Purpose | Provider order |
|---|---|
| Text generation | Groq → Gemini → Cloudflare Workers AI → OpenRouter → NVIDIA → Pollinations |
| Vision (images) | Gemini Vision → OpenRouter Vision → NVIDIA Vision |
| Title generation | Groq → OpenRouter → Gemini → local fallback |

**Hosting** — [Render](https://render.com) (free tier, kept awake by UptimeRobot).

**Analytics** — Cloudflare Web Analytics (privacy-friendly, no cookies, no PII).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (index.html + main.js)          │
│  • Chat UI         • Auth flows       • File previews       │
│  • Sidebar         • Settings modals  • Version switcher    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS / SSE
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Node.js + Express (server.js)           │
│  • /api/auth/*       — signup, login, 2FA, password reset   │
│  • /api/chat/*       — SSE streaming, title generation      │
│  • /api/conversations — CRUD, messages, version sync        │
│  • /api/files/*      — uploads, listing, deletion           │
│  • /api/share/*      — public read-only share links         │
│  • /health           — keep-alive endpoint                  │
└──────┬─────────────────────┬───────────────────────┬────────┘
       │                     │                       │
       ▼                     ▼                       ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Supabase    │    │   AI providers   │    │     Brevo        │
│  • Postgres  │    │   (waterfall)    │    │  (verification   │
│  • GoTrue    │    │                  │    │   emails)        │
│  • Storage   │    │                  │    │                  │
└──────────────┘    └──────────────────┘    └──────────────────┘
```

---

## Project structure

```
deeprwa/
├── public/                  # Static frontend served by Express
│   ├── index.html           # Main chat UI
│   ├── main.js              # Client-side application logic
│   ├── share.html           # Public share viewer
│   └── style.css            # Universal responsive stylesheet
├── av.png                   # DeepRWA logo
├── server.js                # Express backend (auth, chat, files, shares)
├── package.json             # Node dependencies
├── LICENSE                  # MIT
└── README.md                # This file
```

---

## Running locally

### Prerequisites

- **Node.js 20 or newer** — [download](https://nodejs.org)
- A **Supabase project** with the following tables created:
  - `profiles` — user metadata, TOTP status
  - `conversations` — chat sessions
  - `messages` — user messages, AI replies, file metadata, version history
  - `sessions` — active sessions per device
  - `guest_shares` — public read-only share payloads
- Optional: a **Brevo** account for transactional email
- Optional: at least one **AI provider API key** (Groq's free tier is the easiest starting point)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/mukizacreator/deeprwa.git
cd deeprwa

# 2. Install dependencies
npm install

# 3. Create a .env file (see the next section)
cp .env.example .env
# then edit .env with your credentials

# 4. Start the server
npm start
```

Open [http://localhost:5000](http://localhost:5000) in your browser.

---

## Environment variables

Create a `.env` file at the root of the project:

```env
# ── Server ────────────────────────────────────────────────
PORT=5000
JWT_SECRET=change-me-to-a-long-random-string

# ── Supabase ──────────────────────────────────────────────
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key

# ── Brevo (email) — optional but required for signup ─────
BREVO_API_KEY=your-brevo-api-key
EMAIL_FROM=noreply@yourdomain.com

# ── AI providers — provide at least one ──────────────────
GROQ_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
NVIDIA_API_KEY=
CF_ACCOUNT_ID=
CF_API_TOKEN=
```

**Important:** Never commit `.env` to version control. The `.gitignore` in this repo already excludes it.

---

## Deployment

DeepRWA is designed to run entirely on free-tier infrastructure.

### Render

1. Push the repository to GitHub.
2. Create a new **Web Service** on [Render](https://render.com), pointing at this repo.
3. Set the environment variables above in the Render dashboard.
4. Build command: `npm install`. Start command: `npm start`.
5. Render assigns a public URL immediately.

### Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, create the tables listed in [Prerequisites](#prerequisites).
3. Enable Row Level Security (RLS) and add policies so users can only read their own data.
4. Copy the project URL, anon key, and service-role key into your Render environment variables.

### Keep-alive (free tier)

Free tier services sleep when idle:

- **Render** sleeps after 15 minutes of inactivity — ping `/health` every 5 minutes via [UptimeRobot](https://uptimerobot.com).
- **Supabase** pauses after 7 days of inactivity — ping `/rest/v1/` twice a week via [cron-job.org](https://cron-job.org).

---

## Security

- Passwords are hashed and managed by Supabase Auth — the app never stores them.
- Signup and login are gated by email-verified one-time codes.
- Optional TOTP-based 2FA is available for every account.
- Sessions are tracked per device and can be revoked individually or en masse.
- All API routes that mutate user data require a valid JWT and check ownership.
- Uploaded files are stored under a per-user path in Supabase Storage.
- Rate limiting is applied to all `/api/*` routes.

If you find a security issue, please open a private GitHub issue or contact the maintainer directly rather than filing a public report.

---

## Roadmap

- [ ] Image generation (currently DeepRWA can only analyse images, not create them)
- [ ] Web search integration for time-sensitive questions
- [ ] Voice input and text-to-speech output
- [ ] Native mobile wrappers (PWA install already works)
- [ ] Public API for developers

---

## About

DeepRWA is built and maintained by **[Emmanuel Mukiza](https://github.com/mukizacreator)** under **The Star🌟**, a two-person studio founded on **August 8, 2023**, alongside **Ms. Ornella Mutuyimana**.

The mission is simple: make information about Rwanda easily accessible to everyone, in every language, for free.

---

## License

Released under the **MIT License** — see [LICENSE](./LICENSE) for details.

You are free to use, modify, and distribute this software, subject to the terms of the license.

---

⭐ **If you find DeepRWA useful, please star this repository.** It helps other people discover the project and supports future development.
