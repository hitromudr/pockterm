// What the phone tells the server about itself.
//
// Every bug in this app so far was found on a device the author cannot open a
// console on: Android Chrome, behind mTLS, over a tunnel. The desktop browser
// the tests drive has no IME, different clipboard rules and different
// permissions, so "works here" has repeatedly meant nothing. This sends the
// few facts that decide which code path ran, and the errors nobody would
// otherwise see.
let sink = null;

export function initDiag(post) {
  sink = post;
  window.addEventListener('error', (e) => {
    report('error', { message: String(e.message || e), src: `${e.filename}:${e.lineno}` });
  });
  window.addEventListener('unhandledrejection', (e) => {
    report('rejection', { message: String((e.reason && e.reason.message) || e.reason) });
  });
}

// A snapshot of everything that changes which branch the clipboard code takes.
export function environment(version) {
  const nav = window.navigator || {};
  return {
    version,
    ua: String(nav.userAgent || '').slice(0, 160),
    secure: !!window.isSecureContext,
    clipboardWrite: !!(nav.clipboard && nav.clipboard.writeText),
    clipboardRead: !!(nav.clipboard && nav.clipboard.readText),
    clipboardImages: !!(nav.clipboard && nav.clipboard.read),
    touch: (nav.maxTouchPoints || 0) > 0,
    screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    // The Android client injects this; its absence means the page is running
    // in an older build of the app and the clipboard is back to browser APIs.
    native: !!(window.PockNative && window.PockNative.copy),
  };
}

export function report(event, data) {
  if (!sink) return;
  try { sink({ event, ...data }); } catch (_) { /* diagnostics must never break the app */ }
}
