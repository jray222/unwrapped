// Unwrapped v2 — Offline Service Worker
const CACHE_NAME = 'unwrapped-v2-shell-v1';

const STATIC_SHELL_URLS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
];

const READONLY_API_ENDPOINTS = [
  '/api/guest/view',
  '/api/assignment/view',
];

// 1. Install Event: Precache static app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_SHELL_URLS);
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Clean up outdated caches & claim control
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

  // Handle SPA navigation requests: if offline, fall back to cached /index.html
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

  // Handle static assets (CSS, JS, manifest, SVG, HTML)
  if (
    request.method === 'GET' &&
    (url.pathname === '/' ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.json') ||
      url.pathname.endsWith('.svg'))
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        // Return cached response if found, while updating in background
        const networkFetch = fetch(request)
          .then(async (networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const cache = await caches.open(CACHE_NAME);
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || networkFetch;
      })
    );
    return;
  }

  // For state-changing mutations (POST/PUT/DELETE) or other API endpoints:
  // Default network fetch. If offline, the request will fail and app.js will enqueue it.
});
