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

// noticeFrom returns {title, body, tag, session} for a frame worth showing,
// or null.
//
// The tag makes a second notice of the same kind replace the first instead of
// stacking: five "asks for an answer" in a row is noise, not information.
//
// The session travels with the notice because a tap has to land on the session
// that finished — with several running, "the last one you had open" is the
// wrong one about as often as not.
export function noticeFrom(frame) {
  if (!frame || frame.type !== 'notify') return null;
  const tag = KINDS[frame.kind];
  if (!tag) return null;
  const title = String(frame.title == null ? '' : frame.title).trim();
  if (!title) return null;
  let body = String(frame.body == null ? '' : frame.body).trim();
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + '…';
  return { title, body, tag, session: String(frame.session == null ? '' : frame.session) };
}

// deliver raises a notice through the strongest path the browser actually
// allows, and returns which one that was: 'sw', 'window' or 'none'.
//
// There are two paths and the weaker one looked like the only one. `new
// Notification(...)` is illegal in Android Chrome — the API is present, the
// permission is granted, and the constructor throws `Illegal constructor. Use
// ServiceWorkerRegistration.showNotification() instead.` The page this serves
// runs there as an installed PWA, so for as long as the owner worked from the
// browser rather than from the Android client no notification was shown at
// all: the throw escaped and took the rest of the frame handler with it. Found
// in the journal on 2026-08-04, three uncaught TypeErrors in twenty minutes,
// and not by the switch being reported as broken — nobody was watching for a
// notice that had never worked.
//
// So the registration goes first wherever there is one: it is the path the
// phone accepts, it survives the page being backgrounded, and it is the only
// one that can carry a tap to a page that is gone. The constructor stays as
// the fallback for a browser with no worker — with its click wired here,
// because that path keeps working on a desktop.
//
// Which path ran is reported by the caller, not guessed at: the whole class of
// bug above was invisible precisely because the journal said nothing either way.
export function deliver(notice, env = {}) {
  if (!notice) return 'none';
  const reg = env.registration;
  if (reg && typeof reg.showNotification === 'function') {
    try {
      // `data` is how the session reaches the worker's notificationclick — the
      // tag is already spoken for, and the worker cannot see this page's state.
      const shown = reg.showNotification(notice.title, {
        body: notice.body,
        tag: notice.tag,
        data: { session: notice.session || '' },
      });
      // A registration can still refuse (permission revoked between the tap and
      // the notice). That is a lost notification, so it is said out loud rather
      // than dropped: the answer comes a tick after the call, which is why this
      // returns the path taken and not the outcome.
      if (shown && typeof shown.catch === 'function') {
        shown.catch((e) => { if (env.onError) env.onError(e); });
      }
      return 'sw';
    } catch (e) {
      if (env.onError) env.onError(e);
    }
  }
  const Notifier = env.Notifier;
  if (typeof Notifier !== 'function') return 'none';
  try {
    const n = new Notifier(notice.title, { body: notice.body, tag: notice.tag });
    if (env.onClick) n.onclick = () => env.onClick(notice, n);
    return 'window';
  } catch (e) {
    if (env.onError) env.onError(e);
    return 'none';
  }
}
