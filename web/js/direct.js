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
export function tryDirect(url, opts, done) {
  const { wait = DIRECT_WAIT, WS = globalThis.WebSocket, timers = globalThis, now = Date.now } = opts || {};
  const started = now();
  let settled = false;
  let sock;
  try { sock = new WS(url); } catch (_) {
    // A malformed address throws here rather than failing the socket. Answered
    // on the next tick all the same, so the caller sees one shape of miss.
    timers.setTimeout(() => { if (!settled) { settled = true; done(null, 'closed', 0); } }, 0);
    return () => { settled = true; };
  }
  sock.binaryType = 'arraybuffer';
  const quiet = () => { sock.onopen = null; sock.onclose = null; sock.onerror = null; };
  const settle = (ok, why) => {
    if (settled) return;
    settled = true;
    timers.clearTimeout(timer);
    quiet();
    if (!ok) { try { sock.close(); } catch (_) { /* already gone */ } }
    done(ok ? sock : null, why, now() - started);
  };
  const timer = timers.setTimeout(() => settle(false, 'timeout'), wait);
  sock.onopen = () => settle(true, 'open');
  // An error is always followed by a close, and a close can come without one.
  sock.onclose = () => settle(false, 'closed');
  return () => {
    if (settled) return;
    settled = true;
    timers.clearTimeout(timer);
    quiet();
    try { sock.close(); } catch (_) { /* already gone */ }
  };
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
