// Is the socket still there? A connection that has stopped delivering and a
// connection that is quiet look identical from inside the page.
//
// Reported from the phone as the screen freezing: a message typed on it had
// clearly been sent — the laptop's window showed the agent answering it — while
// the phone sat on the same frame, and then caught up "about a minute later".
// That minute is TCP giving up, not anything here. A phone hands its socket
// between Wi-Fi and cellular whenever it feels like it, and the far end of a
// handed-over connection is a black hole: `readyState` stays OPEN, sends look
// like they succeed, and nothing arrives.
//
// So the page asks. `ping` has been answered with `pong` by the server since the
// protocol existed, and nothing was sending one.
//
// Two numbers, both about a person waiting for their own keystroke to appear:
// the question is asked after PING_AFTER of silence, and the answer is given
// PONG_WAIT to arrive. Together they put the worst case at about fifteen seconds
// against the minute it was.
export const PING_AFTER = 10000;
export const PONG_WAIT = 5000;

// linkAction says what to do about the socket right now: nothing, ask, or give
// up on it.
//
//   open     the socket says it is open (readyState === OPEN)
//   visible  the page is on screen
//   lastRx   when anything last arrived — a pong, a byte of output, any frame
//   pingSent when a ping was sent and not yet answered; 0 for none outstanding
//
// Any inbound traffic counts as an answer, so a busy session is never pinged and
// never suspected. Only silence raises the question.
//
// `visible` is a condition and not a detail: a backgrounded page has its timers
// throttled to about one firing a minute, so every measurement it takes is late
// by construction — and tearing down a socket because Android slowed the clock
// is worse than the freeze this fixes. A pocketed phone keeps its socket; coming
// back to it is when the question gets asked, which is also exactly when the
// answer is most likely to be "gone".
export function linkAction({ open, visible, now, lastRx, pingSent = 0 }) {
  if (!open || !visible) return 'idle';
  // Answered: anything that arrived after the ping went out settles it.
  if (pingSent && lastRx >= pingSent) return 'idle';
  if (pingSent) return now - pingSent >= PONG_WAIT ? 'dead' : 'idle';
  return now - lastRx >= PING_AFTER ? 'ping' : 'idle';
}
