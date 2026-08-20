// Version-stamped static cache. Bump VERSION on any static change:
// the old cache is dropped on activate.
const VERSION = 'v177';
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
  '/js/inputdiag.js',
  '/js/imefield.js',
  '/js/scroll.js',
  '/js/update.js',
  '/js/ender.js',
  '/js/kinds.js',
  '/js/carry.js',
  '/js/bar.js',
  '/js/link.js',
  '/js/compose.js',
  '/vendor/xterm.js',
  '/vendor/xterm.css',
  '/vendor/addon-fit.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-192-notify.png',
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

// A notice raised from here is tapped here too.
//
// Android Chrome refuses `new Notification`, so the page raises its notices
// through this worker's registration (see deliver() in js/notify.js) — and a
// notification shown by a worker delivers its click to the worker, never to the
// page. Without this listener the tap did nothing at all.
//
// An open window is focused and told which session to attach: the page is
// probably showing another one, and "the session you had open" is the wrong
// answer about as often as not when several are running. With no window open
// the session travels in the address instead — the same `?session=` the Android
// client uses, dropped from the URL by the page once it has been read.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const session = (e.notification.data && e.notification.data.session) || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== location.origin) continue;
      // focus() is allowed to refuse; the notice is already closed, so falling
      // through to a new window is better than ending here.
      try {
        await w.focus();
        w.postMessage({ type: 'notification-click', session });
        return;
      } catch (_) { /* try the next window, then open one */ }
    }
    await self.clients.openWindow(session ? `/?session=${encodeURIComponent(session)}` : '/');
  })());
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
