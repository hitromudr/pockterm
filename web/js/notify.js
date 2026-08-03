// Turn the server's notification frame into something the page can show.
//
// The page used to decide for itself when a run had finished: it treated every
// byte off the socket as activity and counted the silence afterwards on a
// timer. Both halves were wrong. tmux redraws its status line on a clock, so
// "output arrived" meant "a minute passed" and the countdown rarely ran out;
// and Android throttles timers in a backgrounded WebView, which is precisely
// when the notification was wanted. What arrived, and when, was unexplainable.
//
// The server already watches the pane with capture-pane — no status line in
// it, no throttling, and it stays quiet for a session somebody has open. So it
// decides; this only shapes what it sends.
//
// Kept pure and tested: what is left is small, but it is the last thing
// between a notification and the user.

const KINDS = { question: 'pockterm-question', done: 'pockterm-done' };

// Two lines are shown collapsed, the rest on expand — but a whole pane pasted
// into a notification helps nobody.
const MAX_BODY = 400;

// noticeFrom returns {title, body, tag} for a frame worth showing, or null.
//
// The tag makes a second notice of the same kind replace the first instead of
// stacking: five "asks for an answer" in a row is noise, not information.
export function noticeFrom(frame) {
  if (!frame || frame.type !== 'notify') return null;
  const tag = KINDS[frame.kind];
  if (!tag) return null;
  const title = String(frame.title == null ? '' : frame.title).trim();
  if (!title) return null;
  let body = String(frame.body == null ? '' : frame.body).trim();
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + '…';
  return { title, body, tag };
}
