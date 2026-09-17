# DeepRWA — Your AI Guide to Rwanda 🇷🇼

[![Live](https://img.shields.io/badge/live-deeprwa.agentdomains.co-blue)](https://deeprwa.agentdomains.co)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**DeepRWA** is a free, multilingual AI assistant specialised in everything about Rwanda — history, culture, tourism, geography, notable people, education, agriculture, business, and daily life.

👉 **Try it live: [https://deeprwa.agentdomains.co](https://deeprwa.agentdomains.co)**

---

## What DeepRWA does

- **Rwanda-only focus** — answers questions about Rwanda and politely declines off-topic ones.
- **Multilingual** — replies in the exact language the user writes in.
- **File understanding** — reads images, PDFs, and text files related to Rwanda.
- **Persistent chat history** — syncs across devices.
- **Message versioning** — editing a message preserves previous versions.
- **Public sharing** — share any chat or single message via a read-only link.
- **Security** — email-verified signup, optional 2FA, per-device session management.
- **Universal responsiveness** — works on phones, tablets, foldables, touch laptops, desktops.

---

## Tech stack

- **Frontend** — vanilla JavaScript, HTML, CSS. No framework, no build step.
- **Backend** — Node.js + Express, streaming over SSE.
- **Database, Auth, Storage** — Supabase.
- **Email** — Brevo.
- **AI providers** — Groq → Gemini → Cloudflare → OpenRouter → NVIDIA → Pollinations.
- **Hosting** — Render.
- **Analytics** — Cloudflare Web Analytics.

---

## Project structure

```
deeprwa/
├── public/
│   ├── index.html
│   ├── main.js
│   ├── share.html
│   └── style.css
├── av.png
├── server.js
├── package.json
├── LICENSE
└── README.md
```

---

## Running locally

```bash
git clone https://github.com/mukizacreator/deeprwa.git
cd deeprwa
npm install
npm start
```

Open http://localhost:5000.

Requires Node.js 20+ and a Supabase project with tables: `profiles`, `conversations`, `messages`, `sessions`, `guest_shares`.

---

## Environment variables

```env
PORT=5000
JWT_SECRET=change-me
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
BREVO_API_KEY=
EMAIL_FROM=
GROQ_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
NVIDIA_API_KEY=
CF_ACCOUNT_ID=
CF_API_TOKEN=
```

---

## Deployment

- **Render** — Web Service pointing at this repo, `npm install` / `npm start`.
- **Supabase** — create tables, enable RLS.
- **Keep-alive** — UptimeRobot pings `/health` every 5 min. cron-job.org pings Supabase twice a week.

---

## Security

- Passwords handled by Supabase Auth.
- Email-verified signup and login codes.
- Optional TOTP 2FA.
- Per-device session revocation.
- JWT-protected API routes.
- Rate limiting on all `/api/*`.

---

## Roadmap

- Image generation
- Web search for time-sensitive questions
- Voice input / output
- PWA install (already works)
- Public API

---

## About

DeepRWA is built and maintained by **[Emmanuel Mukiza](https://github.com/mukizacreator)** under **The Star🌟**, a software studio founded on **August 8, 2023**.

---

## License

MIT — see [LICENSE](./LICENSE).

---

⭐ If you find DeepRWA useful, please star this repository.
