// OmniFlow service worker — offline app-shell caching.
//
// Subpath-safe: all cache keys are RELATIVE to the SW's own location, so it
// works at both "/" (root) and "/omniflow-web/" (GitHub Pages subpath).
//
// Strategy:
//   - navigations + index.html: NETWORK-FIRST, cache fallback only.
//     index.html is NEVER pre-cached on install, because it references the
//     hashed JS/CSS bundle — and that hash changes on every deploy. A
//     pre-cached index.html would pin the app to the OLD bundle, which is
//     the classic PWA "my deploy never shows up" / stale-number bug.
//     network-first on the shell means a fresh deploy always wins; the
//     cached copy is only the offline fallback.
//   - hashed assets + manifest + icons: cache-first (immutable).
//   - external API traffic (FX, CoinGecko, Yahoo, LLM providers) is never
//     intercepted — the app layers handle their failures with cached/manual
//     fallbacks.

const CACHE = 'omniflow-v5'; // bump on deploy so old caches get cleared.
const RELATIVE_SHELL = [
  './',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];
// NOTE: './index.html' is intentionally NOT in the install cache — see the
// header. It is written to the cache lazily by the network-first path below
// so it serves as the offline fallback, but a fresh deploy always fetches.

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
    // Network-first: always try the fresh deploy; fall back to cache only
    // when offline (or the fetch itself errors). This is what fixes the
    // "old bundle forever" problem.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const shell = await caches.match(new URL('./index.html', self.location).toString());
          return shell ?? Response.error();
        })
    );
    return;
  }

  // index.html served as a normal GET (not a navigation) also goes
  // network-first so the shell never pins to a stale bundle.
  if (key === new URL('./index.html', self.location).pathname) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
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
