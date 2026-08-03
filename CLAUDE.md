# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Overview

Mobile web terminal for a tmux session (PWA + Go single binary).

## Commands

```bash
make help     # list targets
make check    # format, lint, unit tests
make test-ui  # browser tests: real binary, private tmux, Chromium at phone size
```

`make test-ui` needs `npm install` and a chromium on the machine
(`PT_UI_CHROME` overrides the path). It exists because every clipboard and
layout bug in this app was found on a phone rather than by the unit tests:
`test/ui/stand.mjs` starts the actual binary against its own tmux server, and
`test/ui/probe.mjs` walks the same flow taking screenshots at each step.

## Conventions

Code comments are in English. User-facing documentation is bilingual:
`README.md` (Russian) and `README.en.md` (English).

## The client is not always a browser

On the owner's phone this runs inside a WebView in his own Android app
(`android_client` in the devops repo), not in Chrome. A WebView has no
asynchronous Clipboard API, no Notification API, no file chooser and no PWA
install; it also cannot be opened in devtools. Every clipboard, image and
notification bug reported here came from that gap, and the app now injects a
bridge — `window.PockNative` with `copy`, `read`, `commitInput`, `setImeMode`,
`notify` and `appVersion`. The page prefers it when present and falls back to
browser APIs where there are any; a call the installed app does not know
returns false rather than throwing, which is how the page tells "no" from "this
app is older than the request".

The keyboard's document model is the source of a whole class of bugs here.
Gboard keeps the word being typed as a composing region and rewrites it in
place, and xterm.js only clears its hidden textarea while nothing is being
composed — so under Gboard it never clears, offsets drift, and letters of one
word end up spliced into the next. `commitInput` ends a composition, which the
page cannot do itself; `setImeMode` asks for a different kind of field. Neither
is fixable inside the page — see `TerminalWebView` in the devops repo for what
the app actually asks the keyboard for.

The lever is pulled from the ⋯ menu, not from the URL. `?ime=` still works and
still wins on load, but inside the Android client the address is fixed
(`POCKTERM_URL` in `MainActivity`) and there is no address bar to type it into
— the parameter was unreachable on the only device that can test it. The
button cycles text → raw → raw-strict and stores the choice; the URL is read
once at load, because re-reading it on every call made a lingering `?ime=`
undo every tap.

**The terminal defaults to `raw` since 2026-08-03**, and that is the first
thing here decided by measurement rather than by argument. Under app 2.3 on
the owner's phone, with the mode finally staying put long enough to type in
it: a backspace arrives as `deleteContentBackward` instead of an
`insertCompositionText` rewriting the whole word — which is what put a second
copy of the word on screen — and the composing region covers the last word
instead of everything typed so far. What was typed came out right. What is
still true: xterm.js does not clear its hidden textarea while a composition is
open, so the field accumulates (17 characters of it in the journal), and that
accumulation is where the drift comes from when you edit the middle of a line.
The remaining fix is the page's own input field, not another keyboard mode.

`setImeMode` is not a fix, it is a lever with the strength picked at runtime.
The app defaults to `raw`, and the page asks for `text` everywhere — including
the terminal — because the strict variant that ships in app 2.1
(`VISIBLE_PASSWORD` + `NO_SUGGESTIONS`, now `?ime=raw-strict`) brought up no
keyboard at all on the owner's phone: `sawKeyboard:false` for a whole session
under `ime-mode raw ok:true`. A drifting keyboard is bad and no keyboard is
worse, so the default undoes the app's own, and it takes effect on reload
rather than on an install. `?ime=raw` is the gentle variant — the WebView's
negotiated input type plus "no dictionary" — kept behind a query parameter so
the next attempt costs a reload instead of an APK release. The drift itself is
still open: all that is known is that replacing the input type does not cure
it.

## The bar's Enter waits for the keyboard's word

Gboard holds the word being typed as a composing region, and only the app can
end that — `PockNative.commitInput()`, which asks Android to restart the input.
Calling it before Enter is necessary and was not sufficient: the committed text
reaches the page in a later task, so an Enter sent in the same tick overtook it.
The line went without its last word, and the word turned up after the newline.

`web/js/ender.js` holds the key instead: released a moment after input arrives,
or after 90ms when nothing was being composed. Both bounds matter — a commit can
arrive in more than one chunk, and an Enter that sometimes does nothing would be
worse than the defect. Only keys that end an input go through it (`enter`,
`alt-enter`, the `accept` macro); `esc` and `ctrl-c` interrupt one and must not
wait for anything.

The bridge cannot say whether anything was composing — `commitInput` returns
`true` whenever the app knows the call — so the page waits on the data, not on
the answer. `test/ui/bytes.test.mjs` proves the order on the wire: a real
keystroke delivered right after the tap lands before the `^M`.

## Scrolled back is not the same as copy-mode

The page shows two things while the pane is scrolled back into history: the
round ⇩ button that returns to the live end, and no prompt buttons, because the
numbered lines on screen belong to the past.

Both used to follow `#{pane_in_mode}`, and that is a different state. tmux's own
`WheelUpPane` binding enters copy-mode with `-e`, which leaves it again when a
scroll reaches the bottom — but only when a scroll is what got there. The page's
glide keeps sending notches after the finger is gone, a second client on the
shared pane has its own idea of the position, and a mode entered by hand never
had a scroll to end. All of those sit in copy-mode showing the present, which is
what "the ⇩ stays at the bottom" was: a button offering the way back from where
the screen already is.

The mode frame carries `#{scroll_position}` as well now, and the page shows both
by whether there is history above. Nothing here asks tmux to leave copy-mode:
the pane is shared, and a page that sent `q` on its own would take the laptop's
client out of a mode it chose to be in.

## A session name can be a group in disguise

tmux names a session group after the session it was created from and never
renames it. Rename that session and the old name lives on as a group — and
`new-session -t <name>`, which is how every client attaches, resolves a group
before a session of the same name. Hand the freed name to another session and
its tab opens the first session's window.

This is not cosmetic: attaching merges the two sessions into one group
permanently. Renaming out of it does not separate them, and `move-window` out
of the group destroys the other session's windows. The only way out is to
close one of the pair, which frees the other.

`tmuxcmd.NameConflict` refuses such a name at the rename endpoint, and the
session Makefile picks numbers that are free as both a session and a group
name. Both guards exist because the trap is invisible from the page: two tabs,
one window, and nothing anywhere saying why.

## Notifications are decided in one place

`internal/watch` reads each watched session's pane with `capture-pane` and
emits two events: a menu appeared, or the screen went quiet after doing
something. Both channels — Telegram and a `notify` frame to an open page —
render that same event, through `watch.Format` and `watch.Notice`.

The page decides nothing. It used to, and the result was notifications nobody
could predict: it counted "activity" from bytes on the socket, but tmux redraws
its status line on a clock, so the silence never lasted; and the timer that
checked was throttled once Android backgrounded the WebView. If you are tempted
to raise a notice from the browser again, read the header of `web/js/notify.js`
first.

Body text comes from `watch.Tail`, not from the last non-blank line: agent TUIs
draw an input box and a shortcut hint under their output, so the last line on
screen is usually `? for shortcuts` or a row of `─`.

## The wheel step is a tmux setting, and it is the floor for everything here

A wheel notch is the smallest movement tmux can draw, so it bounds every
smoothness question on this page: the residue the shift has to give back at the
end of a gesture, the size of a jump when a prediction is wrong, the band of
background at the leading edge. The page does not assume it — the server asks
tmux (`list-keys -T copy-mode WheelUpPane`) on every connect and sends it in the
`config` frame.

On the owner's host it is **one line since 2026-08-03**, set in `~/.tmux.conf`:
five (tmux's default) meant a short swipe moved nothing until the finger had
travelled five rows, two still left a two-row residue that read as the screen
sliding back at the release. One is the floor. That file is hand-made and in no
repository — changing the step is a change to it and to nothing in here.

## What the shift under the finger does not cover

The page shifts the drawn rows to follow the finger between whole lines
(`track` in `web/js/scroll.js`), and two limits on that were learned by
shipping it:

- **The lift changes nothing.** For one version the shift was handed back the
  moment the finger left, on the theory that a glide is too fast to judge a
  fraction of a line in. With the cap at three steps that is a screen flying six
  rows backwards at the release, which is what it was reported as. The shift
  stands for content that has not arrived; it goes back as that content lands,
  and the two cancel to no movement at all. A glide keeps more messages in the
  air than the cap allows, so the picture rides at the cap instead of following
  exactly — what it does not do is jump.
- **`track()` expires before it decides.** `owed()` is both the question and the
  expiry, so asking whether anything is left before calling it leaves the
  sub-line residue on screen for good — a terminal parked a few pixels off its
  grid. The browser test caught that as a shift that never came back.
- **Notches dropped with the queue must be disowned** (`dropped()`). Leaving the
  history throws away what was queued for the next message, and only a message
  that went out can expire on the backstop.
- **tmux's status line is not chrome.** It is drawn into the bottom row of the
  same grid the pane lives in, so a transform on the screen takes it along —
  reported as the green strip rising two rows on an upward swipe. The server asks
  tmux how tall it is (`show-options -gv status`) and says so in the `config`
  frame; the page takes the shift straight back off those rows, with the same
  transition so the two cancel at every point of the settle and not only at its
  end. Guessing is the wrong move here: too high pins a row of real output while
  the rest follows the finger, so anything unreadable counts as none.
- **The gesture is the page's, and the browser has to be told.** `#term` sets
  `touch-action: none`; without it the browser may decide mid-swipe that a long
  drag is its own scroll, take the touch and stop delivering moves — reported as
  a long swipe being interrupted. `touchcancel` is handled too, because the
  declaration is a request and not a guarantee: a cancelled gesture ends without
  a throw (there was no release to read a speed from) and says so in the journal
  as `cancelled`, which is how often it happens becomes a fact rather than a
  guess.
- **A clock cannot say when a notch landed.** The shift first predicted it from
  the measured round trip, and the device settled that: the trip averages 40-50ms
  and peaks at 130. A short swipe has one notch and gets away with it; a longer
  one has twenty, mispredicts several, and every miss is a step back and then
  forward — reported as juddering, and as sticking where a misprediction ran the
  shift into `MAX_TRACK`. The page now counts what it can observe: one message
  out (`batched`), one repaint of the whole viewport back (`drew`).
  `movedWholeScreen` is what tells a scroll from output — measured on the stand,
  a printed character repaints one row and a scroll repaints all of them. A batch
  nobody answers expires after `AIR_MAX`: that is the top of the history, where
  there is no scroll for tmux to make.
- **The cap is a decision, not a safety valve.** The shift is content that has
  not arrived, so it shows as a band of background at the leading edge. While it
  is at the cap the picture stops following the finger, which is the sticking
  being fixed — the cap trades one for the other, and three steps (six rows
  here) is where it sits.

`lag`, `predicted` and `lost` in the gesture report are diagnostics now, not
controls: the shift no longer reads them.

## Diagnostics

The page posts what decides an outcome to `/api/log`, which the server writes
to its journal (`journalctl -u pockterm | grep client:`): the environment on
load — version, secure context, which clipboard APIs exist, whether the native
bridge is there — plus copy/paste/upload results and uncaught errors. It is
there because the device this serves has no console anyone can open, and every
fix before it was a guess.

## Deploy

A push to `main` builds, tests and hands the binary over, and **the host
installs it at once**. Do not install by hand on the RPi5, and do not run the
`pockterm_app` ansible role's binary copy against it.

`.forgejo/workflows/deploy.yml` runs on the runner that lives on that same box.
The job builds in a container and drops `pockterm.new` plus an HMAC signature
into `/var/lib/pockterm/incoming`; the host watches that path
(`pockterm-deploy.path`) and `/usr/local/sbin/pockterm-deploy` verifies the
signature and takes it from there. Identical bytes are a no-op, so a docs-only
push does not drop anyone's terminal; a binary that fails to start is rolled
back to the previous one.

It used to wait for nobody to be looking, on the grounds that a restart drops
the terminal its author is sitting in. That cost a parked build, a retry timer,
a `waiting` flag on `/api/presence` and a line in the ⋯ menu explaining why the
version would not change — and the person waiting for the fix was the one
holding it up. **The wait was removed on 2026-08-03.** A restart costs a
reconnect, the tmux session behind it is untouched, and the page says what to
do about the rest: the server names the page it serves in the socket's `config`
frame, and a page running anything else shows a bar with **Обновить** on it.

A reload rather than an automatic one, because the composer can have half a
message in it. The button is a plain `location.reload()` — the service worker
is network-first, so the assets come from the server and the cache is only the
offline fallback.

`APP_VERSION` in `web/js/app.js` and `VERSION` in `web/sw.js` are that
mechanism's single number, bumped by hand in two files; `assets_test.go` fails
if they drift, because a page misreporting its own version never looks out of
date and no bar is ever raised. The server reads the number out of its own
embedded `app.js` (`PageVersion` in `assets.go`) rather than keeping a third
copy.

The host-side pieces — `pockterm-deploy`, its `.path` and `.service` — live in
`deploy/` in this repository and are covered by `test/deploy_test.sh`
(`make test-deploy`), which stubs systemctl. They were host-only files until
2026-08-03, owned by nothing.

That path installs on the RPi5 only. For everyone else there are releases:
`.github/workflows/release.yml` fires on a `v*` tag, runs `make release`
(both architectures plus `SHA256SUMS`) and publishes them, and
`deploy/install.sh` downloads one when no Go toolchain is present. The
checksum check is not decoration — a binary that does not match is refused,
and `test/install_test.sh` covers both outcomes with a `file://` release.

The signing key is the repo Actions secret `DEPLOY_HMAC_KEY` and
`/etc/pockterm/deploy-hmac.key` on the host. It exists because the drop
directory is mounted into a job container and the runner serves other
repositories too — without it, any workflow could have the host install a
binary as root.
