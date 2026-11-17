/**
 * Branch till service worker.
 *
 * A branch runs the till as an installed PWA on the shop LAN, with no internet. The service worker
 * exists so the till shell loads from cache when the LAN server is briefly unreachable, and so the
 * app can be installed to the home screen.
 *
 * It is deliberately conservative:
 *   - Only GET requests to same-origin *pages and static assets* are cached.
 *   - Any request under /api/ is never cached: a sale must reach the server (or fail into the
 *     IndexedDB outbox, which the app handles), never be served from a stale cache.
 *   - The app shell (the next/static bundles, /pos, /login and /admin) is precached at install and
 *     re-fetched in the background on every successful navigation, so a reload with no network still
 *     renders the till.
 */

const CACHE = 'erp-branch-v2';
const SHELL = [
  '/',
  '/pos',
  '/login',
  '/admin/products',
  '/admin/z-reports',
  '/manifest.webmanifest',
  '/icon.svg',
];

/** Cache the app shell at install. A single 404 must not fail the whole install. */
function precache(cache) {
  return Promise.all(
    SHELL.map((url) =>
      fetch(url, { cache: 'reload' })
        .then((response) => {
          if (response.ok) return cache.put(url, response.clone());
          return undefined;
        })
        .catch(() => undefined),
    ),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(precache).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** True for a page or static asset the shell should keep, so a reload with no network renders. */
function isShellAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname === '/' ||
    url.pathname === '/pos' ||
    url.pathname.startsWith('/pos/') ||
    url.pathname === '/login' ||
    url.pathname.startsWith('/admin') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/icon.svg'
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API. The outbox is the offline path, not a stale response.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Keep the freshest copy of an app-shell page for the next offline load.
          if (response.ok && isShellAsset(url)) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((hit) => hit ?? caches.match(url.pathname))
            .then((hit) => hit ?? caches.match('/pos'))
            .then((hit) => hit ?? Response.error()),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
