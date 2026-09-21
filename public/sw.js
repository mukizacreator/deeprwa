// DeepRWA Service Worker — rev.4.5.0
// Strategy:
//   - HTML / CSS / JS: network-only, no cache. Ensures every deploy is picked up.
//   - Static media (av.png, manifest): cache-first.
//   - Bump CACHE_VERSION on every release to invalidate old caches.

const CACHE_VERSION = 'deeprwa-v4.5.0';

// These files are ALWAYS fetched from the network — never cached.
const NEVER_CACHE = [
  '/', '/index.html', '/main.js', '/style.css', '/sw.js',
  '/share.html'
];

self.addEventListener('install', (event) => {
  // Skip waiting so the new SW takes over immediately.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Tell every open tab to reload so it picks up the fresh code.
        return self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => {
            try { client.postMessage({ type: 'SW_UPDATED' }); } catch {}
          });
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never touch the API, share, or auth routes.
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/share/') ||
      url.pathname === '/health' ||
      url.pathname.startsWith('/auth/')) return;

  // Never cache code files — always network.
  const path = url.pathname;
  const isCode = NEVER_CACHE.includes(path) ||
                 path.endsWith('.js') ||
                 path.endsWith('.css') ||
                 path.endsWith('.html');
  if (isCode) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for static media.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => new Response('', { status: 503 }));
    })
  );
});

// Listen for a "skip waiting" message from the app.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
