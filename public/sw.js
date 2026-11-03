// Unwrapped v2 — Offline Service Worker (Network-First for App Shell)
const CACHE_NAME = 'unwrapped-v2-shell-v7';

const STATIC_SHELL_URLS = [
  '/js/router.js',
  '/',
  '/index.html',
  '/styles.css',
  '/js/admin.js',
  '/js/api.js',
  '/js/assignments.js',
  '/js/autofill.js',
  '/js/gifts.js',
  '/js/guest.js',
  '/js/items.js',
  '/js/listeners-admin.js',
  '/js/listeners-auth.js',
  '/js/listeners-lists.js',
  '/js/lists.js',
  '/js/main.js',
  '/js/notifications.js',
  '/js/offline.js',
  '/js/passkeys.js',
  '/js/qr.js',
  '/js/session.js',
  '/js/share-links.js',
  '/js/state.js',
  '/js/ui.js',
  '/manifest.json',
  '/icon.svg',
  '/icons.svg',
  '/fonts/fraunces-latin-wght-normal.woff2',
  '/fonts/inter-latin-wght-normal.woff2',
];

const READONLY_API_ENDPOINTS = [
  '/api/guest/view',
  '/api/assignment/view',
];

// 1. Install Event: Precache static app shell and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_SHELL_URLS);
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Clean up all older caches & claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event Handler
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never intercept token redemption routes (/g/, /a/, /invite/, /assisted/)
  if (
    url.pathname.startsWith('/g/') ||
    url.pathname.startsWith('/a/') ||
    url.pathname.startsWith('/invite/') ||
    url.pathname.startsWith('/assisted/')
  ) {
    return;
  }

  // Handle SPA navigation requests: Network-First, fallback to cached /index.html only when offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/index.html')) || (await cache.match('/'));
      })
    );
    return;
  }

  // Handle read-only Guest & Assignment views: Network-First with Cache Fallback
  const isReadonlyView = READONLY_API_ENDPOINTS.some((endpoint) =>
    url.pathname.startsWith(endpoint)
  );

  if (request.method === 'GET' && isReadonlyView) {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response && response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
          return new Response(
            JSON.stringify({
              error: 'Offline: You are currently offline and no cached view is available.',
              offline: true,
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        })
    );
    return;
  }

  // Handle static assets (CSS, JS, manifest, SVG, HTML): Network-First so updates apply immediately!
  if (
    request.method === 'GET' &&
    (url.pathname === '/' ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.json') ||
      url.pathname.endsWith('.svg') ||
      url.pathname.endsWith('.woff2'))
  ) {
    event.respondWith(
      fetch(request)
        .then(async (networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          return cachedResponse;
        })
    );
    return;
  }
});
