// OmniFlow service worker — app-shell cache for offline use.
//
// Strategy:
//   - network-first for navigations (fresh HTML), falling back to cache.
//   - cache-first for immutable hashed assets (JS/CSS) — Vite fingerprints
//     them, so once cached they are valid forever.
//   - the PWA must keep working offline after the first load.

const CACHE = 'omniflow-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Only intercept same-origin + public (API calls, including Frankfurter /
  // CoinGecko / Yahoo, are left to the network; the app handles their errors
  // and falls back to manual prices).
  const url = new URL(req.url);
  const isAppShell = url.origin === self.location.origin;
  if (!isAppShell) return; // let external API traffic flow through normally

  // Navigations: network-first, cache fallback (so deploys update but
  // offline still works).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((m) => m || Response.error()))
    );
    return;
  }

  // Hashed assets: cache-first.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});
