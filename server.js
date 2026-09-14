// DeepRWA backend — Phase 1
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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DeepRWA',
    version: '1.0.0',
    time: new Date().toISOString()
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    name: 'DeepRWA',
    tagline: 'Your AI guide to Rwanda',
    creator: 'Emmanuel Mukiza — The Star🌟',
    version: '1.0.0'
  });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nSitemap: https://deeprwa.agentdomains.co/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const base = 'https://deeprwa.agentdomains.co';
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>`
  );
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get(/^\/(?!api|health|robots|sitemap).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`DeepRWA listening on :${PORT}`);
});
