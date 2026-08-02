// Version-stamped static cache. Bump VERSION on any static change:
// the old cache is dropped on activate.
const VERSION = 'v45';
const PRECACHE = [
  '/',
  '/css/app.css',
  '/js/app.js',
  '/js/keys.js',
  '/js/detect.js',
  '/js/notify.js',
  '/js/paste.js',
  '/js/select.js',
  '/js/diag.js',
  '/vendor/xterm.js',
  '/vendor/xterm.css',
  '/vendor/addon-fit.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept non-GET or cross-origin; WebSocket upgrades bypass SW anyway.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first, cache only as the offline fallback.
  //
  // Cache first was wrong for this app: the server is one hop away over a
  // tunnel, while an installed PWA that is never fully reloaded kept serving
  // the code it was installed with — fixes shipped, and the phone went on
  // running the version that had the bug. Offline still works, because every
  // answer is written back into the cache on the way out.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
