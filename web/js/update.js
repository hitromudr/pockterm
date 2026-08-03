// Whether the page it is running is the page the server now serves.
//
// CI installs a build the moment it arrives — the wait for nobody to be
// looking cost a parked build, a retry timer and a line in the menu explaining
// itself, and the fix being installed is only reachable once it lands. What
// that leaves is a page whose own code is out of date, which is the one thing
// it cannot work out for itself: it reconnects after the restart and looks
// exactly as healthy as before.
//
// So the server names the version it serves in the config frame and this
// decides what to do about it. Kept pure and separate because getting it wrong
// is silent in both directions: a notice on every reconnect trains the owner
// to ignore it, and no notice at all leaves the phone running last week's page
// with no way to tell.

// staleNotice returns what to say about a served version, or null when there is
// nothing to say.
//
// served is what the server reports, running is this page's own APP_VERSION.
export function staleNotice(served, running) {
  if (!served || !running) return null; // a server too old to say, or no page version
  if (served === running) return null;
  return {
    // The version being offered, not the one being run: "обновить до v75"
    // answers the question the button raises, which is what am I getting.
    title: `pockterm ${served}`,
    body: `На сервере ${served}, на странице ${running}. Обновить, чтобы взять.`,
    // Same tag every time: a second notice replaces the first rather than
    // stacking, and the deploy can land more than once in an evening.
    tag: 'pockterm-update',
    text: `${served} на сервере · сейчас ${running}`,
  };
}
