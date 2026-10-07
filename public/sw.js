// OmniFlow service worker — offline app-shell caching.
//
// Subpath-safe: all cache keys are RELATIVE to the SW's own location, so it
// works at both "/" (root) and "/omniflow-web/" (GitHub Pages subpath).
//
// Strategy:
//   - navigations: network-first, cache fallback (fresh deploys win offline).
//   - hashed assets + manifest + icons: cache-first (immutable).
//   - external API traffic (FX, CoinGecko, Yahoo, LLM providers) is never
//     intercepted — the app layers handle their failures with cached/manual
//     fallbacks.

const CACHE = 'omniflow-v4';
const RELATIVE_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

// Resolve a request URL to a cache key relative to the SW origin+scope.
function cacheKey(req) {
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return null;
  return url.pathname + (url.search || '');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(RELATIVE_SHELL.map((p) => new URL(p, self.location).toString())))
      .then(() => self.skipWaiting())
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

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let external APIs flow.

  const key = cacheKey(req);
  if (!key) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
          // Offline: fall back to the cached app shell.
          const shell = await caches.match(new URL('./index.html', self.location).toString());
          return shell ?? Response.error();
        })
    );
    return;
  }

  // Everything else same-origin: cache-first, fill from network.
  event.respondWith(
    caches.match(key).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
          }
          return res;
        })
    )
  );
});
