const CACHE_VERSION = 'deeprwa-v1';
const STATIC_ASSETS = ['/', '/index.html', '/style.css', '/main.js', '/av.png', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/share/') ||
      url.pathname === '/health' ||
      url.pathname.startsWith('/auth/')) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => {
          if (req.headers.get('accept')?.includes('text/html')) return caches.match('/');
          return new Response('', { status: 503 });
        });
    })
  );
});
