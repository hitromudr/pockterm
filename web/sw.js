// Version-stamped static cache. Bump VERSION on any static change:
// the old cache is dropped on activate.
const VERSION = 'v196';
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
  // The pane's own font, cut down and carried here so the same screen is the
  // same screen on every machine — see --mono in css/app.css. Precached because
  // an installed PWA with no network would otherwise draw the pane in whatever
  // the device has, which is the thing this file exists to stop.
  '/fonts/pockterm-mono-400.woff2',
  // And the marks the primary face has not got, which is where the box drawing,
  // ✳, ❯ and ✓ come from. Both weights: DejaVu has a bold, the letters do not.
  '/fonts/pockterm-marks-400.woff2',
  '/fonts/pockterm-marks-700.woff2',
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

// The picture on every notice, the same file the page names. Kept here as well
// because a push arrives at a worker with no page running: nothing else in this
// file can be asked what the notice should look like.
const NOTIFY_ICON = '/icons/icon-192-notify.png';

// A notice for a device whose page is not running — the only kind that reaches a
// phone in a pocket.
//
// Android suspends a backgrounded PWA: it stops answering the socket's ping, the
// server closes it a minute later, and everything written into it in between was
// counted as delivered and drawn nowhere. Measured on 2026-09-05, and it is why
// this listener exists. The push wakes this worker instead, with no page
// involved at all.
//
// The server decides everything about the notice and this draws it. The tag is
// the one the page would have used (`pockterm-<kind>:<session>`), so a notice
// raised here and one raised by a page replace each other rather than stacking;
// `renotify` is what makes a replacement alert again instead of arriving in
// silence.
//
// `userVisibleOnly` was promised at subscribe time, so every push shows
// something: a payload that fails to parse still gets a notice, because the
// alternative is Chrome drawing its own "this site was updated in the
// background" over the top of a broken one.
self.addEventListener('push', (e) => {
  let notice = {};
  try {
    notice = e.data ? e.data.json() : {};
  } catch (_) { notice = {}; }
  const title = String(notice.title || 'pockterm');
  const session = String(notice.session || '');
  const tag = String(notice.tag || 'pockterm-done');
  e.waitUntil(self.registration.showNotification(title, {
    body: String(notice.body || ''),
    tag,
    renotify: true,
    icon: NOTIFY_ICON,
    badge: NOTIFY_ICON,
    data: { session },
  }));
});

// A subscription the push service replaced under us. The browser hands out a new
// endpoint — on a renewal, or when it decides the old one is stale — and the
// server's copy stops working from that moment, silently. Resubscribing here
// keeps the phone reachable without waiting for the page to be opened.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    try {
      const key = e.oldSubscription && e.oldSubscription.options
        ? e.oldSubscription.options.applicationServerKey : null;
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch (_) { /* the page resubscribes on its next load */ }
  })());
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
