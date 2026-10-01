/* KVM Hub service worker — enables PWA install. Network-first so the API-driven
   dashboard always shows fresh data; caches the shell only for offline fallback. */
const CACHE = 'kvmhub-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png?v=2', '/icon-512.png?v=2'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never touch API writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // cross-origin (fonts/API) untouched
  if (url.pathname.startsWith('/api/')) return;     // never cache API reads
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match('/index.html')))
  );
});
