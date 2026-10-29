// The nearer door. A page opened through the public address reaches this host
// the long way round — out to a relay and back down a tunnel — even from the
// same flat as the host, and every drop of the home line or switch to the
// spare uplink was a stalled socket for whoever was looking (2026-10-26: six
// in a morning). The server names a second door that skips all of that
// (POCKTERM_DIRECT_URL), and the page tries its socket there first.
//
// Only the socket goes that way. The page stays at the address it was opened
// from: an installed app lives in its own origin, and moving the whole page to
// the other door was turned down.
//
// What decides is whether a socket actually opens, and quickly. Nothing else
// says if the door is reachable from here: away from home its address is
// somebody else's network or nobody's; a router's rebind protection may not
// resolve the name at all; the browser may ask permission to reach a private
// address, or refuse. Every one of those ends the same way — no socket within
// DIRECT_WAIT — and the page goes the way it always went.

// How long the door is given. A door on the same network opens in tens of
// milliseconds; one that is not there either fails at once or never answers,
// and this is what the second kind costs a connect.
export const DIRECT_WAIT = 1500;

// How long a miss is believed. Every tab switch is a connect, and away from
// home each would wait out DIRECT_WAIT for a door that was not there a moment
// ago. A reconnect after a drop comes later than this as often as not, which
// is when coming home is noticed.
export const MISS_HOLD = 30000;

// directBase(direct, loc) → the socket root to try ('wss://host:port'), or ''
// for none.
//
// None when there is no door, when this page came through it already, and when
// the page is https and the door is not: a browser refuses ws: from a secure
// page outright, and there is no point waiting to be told.
export function directBase(direct, loc) {
  if (!direct) return '';
  let u;
  try { u = new URL(direct); } catch (_) { return ''; }
  if (u.host === loc.host) return '';
  if (u.protocol === 'https:') return `wss://${u.host}`;
  if (u.protocol === 'http:' && loc.protocol === 'http:') return `ws://${u.host}`;
  return '';
}

// tryDirect(url, opts, done) opens a socket and hands it over only once it is
// open: done(socket, 'open', ms). Anything else — refused, failed, too slow —
// closes it and says why: done(null, 'closed' | 'timeout', ms). done is called
// once at most, and never after the returned cancel().
//
// The socket has no handlers of its own when it is handed over: whoever takes
// it installs them, and nothing from the attempt is left to fire into it.
//
// opts.warm asks the door over plain HTTP first and opens the socket once that
// has an answer, of whatever kind, all within the same wait. The door wants a
// client certificate, and Chrome picks one for a host only for an ordinary
// request: a socket that is the first thing sent to the door is cancelled
// before any HTTP, in ~16 ms, with nothing in the door's log (2026-10-29,
// headless Chrome 155 on a laptop, the same with Local Network Access checks
// switched off). One request before it and the socket after it opens. The
// browser keeps that choice until it restarts or its certificate cache is
// cleared, so the caller asks for a warm only until the door has opened, and
// again after it has missed.
export function tryDirect(url, opts, done) {
  const {
    wait = DIRECT_WAIT, WS = globalThis.WebSocket, timers = globalThis, now = Date.now,
    warm = false, fetch: get = globalThis.fetch,
  } = opts || {};
  const started = now();
  let settled = false;
  let sock = null;
  let abort = null;
  const quiet = () => {
    if (abort) { try { abort.abort(); } catch (_) { /* nothing to stop */ } abort = null; }
    if (sock) { sock.onopen = null; sock.onclose = null; sock.onerror = null; }
  };
  const settle = (ok, why) => {
    if (settled) return;
    settled = true;
    timers.clearTimeout(timer);
    quiet();
    if (!ok && sock) { try { sock.close(); } catch (_) { /* already gone */ } }
    done(ok ? sock : null, why, now() - started);
  };
  const open = () => {
    if (settled) return;
    try { sock = new WS(url); } catch (_) {
      // A malformed address throws here rather than failing the socket. Answered
      // on the next tick all the same, so the caller sees one shape of miss.
      timers.setTimeout(() => settle(false, 'closed'), 0);
      return;
    }
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => settle(true, 'open');
    // An error is always followed by a close, and a close can come without one.
    sock.onclose = () => settle(false, 'closed');
  };
  const timer = timers.setTimeout(() => settle(false, 'timeout'), wait);
  const asked = warm && get ? warmAddress(url) : '';
  if (asked) {
    if (globalThis.AbortController) abort = new AbortController();
    // The answer is opaque and nothing is read from it: what matters is that
    // the TLS handshake happened. A failure is no verdict either — the socket
    // after it is what decides, as it does without a warm.
    let p;
    try {
      p = Promise.resolve(get(asked, {
        method: 'HEAD', mode: 'no-cors', credentials: 'include', cache: 'no-store',
        signal: abort ? abort.signal : undefined,
      }));
    } catch (e) { p = Promise.reject(e); }
    p.then(open, open);
  } else {
    open();
  }
  return () => {
    if (settled) return;
    settled = true;
    timers.clearTimeout(timer);
    quiet();
    if (sock) { try { sock.close(); } catch (_) { /* already gone */ } }
  };
}

// warmAddress(url) → the door's own root over HTTP for a socket address
// ('wss://host:port/ws?…' → 'https://host:port/'), or '' when there is none.
export function warmAddress(url) {
  let u;
  try { u = new URL(url); } catch (_) { return ''; }
  if (u.protocol === 'wss:') return `https://${u.host}/`;
  if (u.protocol === 'ws:') return `http://${u.host}/`;
  return '';
}

// worthTrying(lastMiss, now) says whether the door is asked again.
export function worthTrying(lastMiss, now) {
  return !lastMiss || now - lastMiss >= MISS_HOLD;
}

// viaMark(direct, loc, via) → which way the socket in hand goes, as the drawer's
// header draws it: 'direct', 'long', or '' for nothing to say. Nothing when the
// host has no door — every socket goes the one way there is — and nothing while
// no socket is in hand. A page opened through the door itself is direct by
// definition, whatever its socket was called.
export function viaMark(direct, loc, via) {
  if (!via || !direct) return '';
  let u;
  try { u = new URL(direct); } catch (_) { return ''; }
  if (u.host === loc.host || via === 'direct') return 'direct';
  return via === 'host' ? 'long' : '';
}
