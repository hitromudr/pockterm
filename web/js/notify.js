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

// The picture in the notification, on every notice without exception.
//
// Left unset, Chrome draws its own generic bell — and it does so unpredictably:
// on the owner's phone two notices from this same page sat in the shade one above
// the other, one with a bell and one with the app's own mark. Which one arrives
// depends on whether the manifest icon could be resolved at the moment the notice
// was raised, and a notice raised by the service worker for a page that is gone
// is exactly when it cannot. Naming the file removes the question.
//
// It is the app's own drawing — the prompt and its underscore — in white on
// nothing at all. Not the installed icon: that one is a pale mark on a near-black
// plate, and a plate is the wrong shape here. The shade puts every icon in a
// circle of its own and draws its own background behind it, so an icon carrying
// one arrives as a square inside a circle; without it the mark sits on the
// shade's own dark. White for the same reason: one colour, and it is the colour
// every other icon in an Android shade is.
//
// The mark is scaled to fill its box rather than keeping the installed icon's
// generous margin — inside the circle the whole image is drawn, and that margin
// left the glyph small enough to be a smudge at 24px.
const ICON = '/icons/icon-192-notify.png';

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

// The switch, in the order the button walks it.
//
// Two channels cover two different absences: a frame down the socket reaches a
// page that is open but in the background, and Telegram reaches a phone with
// nothing open at all. So the states are cumulative — the page alone, the page
// and Telegram, neither — and there is one control rather than two, because a
// control that silences half of what arrives is a control nobody trusts.
//
// The state itself lives on the server: half of what it decides is sent from
// there, to a phone that has this page closed. What is here is only the order
// and the wording.
export const MODES = ['pwa', 'pwa+tg', 'off'];

// nextMode is where a tap leads. An unknown mode leads to the first state
// rather than nowhere: the mode comes from the server, and an installed PWA can
// be older than the binary serving it.
//
// Without a bot configured the middle state is skipped instead of offered dead
// — a label promising Telegram where there is no token reads as a promise.
export function nextMode(cur, telegram) {
  const ring = telegram ? MODES : MODES.filter((m) => m !== 'pwa+tg');
  // A mode stored while a token was configured is not unknown, it is only
  // unreachable: without a bot, pwa+tg delivers exactly what pwa does, so the
  // tap carries on from there instead of starting the ring over.
  const from = ring.includes(cur) ? cur : (cur === 'pwa+tg' ? 'pwa' : null);
  if (from === null) return ring[0];
  return ring[(ring.indexOf(from) + 1) % ring.length];
}

// shouldAskPermission decides whether this page still has to ask the browser
// before anything it is told to notify can be shown.
//
// The switch is the host's and its default notifies, so a fresh install starts
// in a notifying state — and permission used to be asked for only by a tap on
// the bell, which is the one thing nobody taps when the label already says what
// they want. Every new install was therefore silent: the page labelled 🔔, the
// server sending frames, `Notification.permission` still `default`, and nothing
// anywhere saying that the missing piece was a browser prompt.
//
// Asked once and then never again. `default` is also what a dismissed prompt
// leaves behind, so a page that reads the state alone would ask on every load —
// and browsers answer a page that does that by refusing it a prompt at all.
// `asked` is what the caller remembers; the bell's dashed outline is what is
// left for someone who dismissed it.
//
// A native notifier needs no permission from the browser: the Android client
// raises the notice itself, through the app's own.
export function shouldAskPermission({ mode, permission, native = false, asked = false } = {}) {
  if (native || asked) return false;
  if (!mode || mode === 'off') return false;
  return permission === 'default';
}

// modeLabel is what the button says, and whether it reads as on.
//
// Three states need three labels: on a phone the same bell with the same word
// would make two of them look like one, and the difference between them is
// exactly what happens while the screen is off. The title names where the next
// tap leads, so `telegram` belongs here too — with no bot the ring is shorter
// and promising one would be a lie.
export function modeLabel(mode, telegram) {
  switch (mode) {
    case 'pwa':
      return {
        text: '🔔 PWA',
        on: true,
        title: telegram ? 'Notifying this page. Tap to add Telegram' : 'Notifying this page. Tap to silence',
      };
    case 'pwa+tg':
      return {
        text: '🔔 PWA+TG',
        on: true,
        title: 'Notifying this page, and Telegram when nothing is open. Tap to silence',
      };
    default:
      return { text: '🔕 Off', on: false, title: 'Nothing is notified. Tap to notify this page' };
  }
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
        icon: ICON,
        // The tiny monochrome mark in the status bar. The same file answers for
        // both: white on nothing is exactly what that slot wants, and one file
        // cannot drift from the other.
        badge: ICON,
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
    const n = new Notifier(notice.title, {
      body: notice.body, tag: notice.tag, icon: ICON, badge: ICON,
    });
    if (env.onClick) n.onclick = () => env.onClick(notice, n);
    return 'window';
  } catch (e) {
    if (env.onError) env.onError(e);
    return 'none';
  }
}
