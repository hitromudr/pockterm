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

## Diagnostics

The page posts what decides an outcome to `/api/log`, which the server writes
to its journal (`journalctl -u pockterm | grep client:`): the environment on
load — version, secure context, which clipboard APIs exist, whether the native
bridge is there — plus copy/paste/upload results and uncaught errors. It is
there because the device this serves has no console anyone can open, and every
fix before it was a guess.

## Deploy

A push to `main` builds, tests and hands the binary over; **the host decides
when to install it**, because installing restarts the unit that serves the
terminal its author is usually sitting in. Do not install by hand on the RPi5,
and do not run the `pockterm_app` ansible role's binary copy against it.

`.forgejo/workflows/deploy.yml` runs on the runner that lives on that same box.
The job builds in a container and drops `pockterm.new` plus an HMAC signature
into `/var/lib/pockterm/incoming`; the host watches that path
(`pockterm-deploy.path`) and `/usr/local/sbin/pockterm-deploy` verifies the
signature and takes it from there. Identical bytes are a no-op, so a docs-only
push does not drop anyone's terminal; a binary that fails to start is rolled
back to the previous one.

The timing question is answered by `/api/presence`, which reports attached
clients and how many have the page on screen. The script installs when that
second number is zero, and otherwise parks the build as `pockterm.pending` and
starts `pockterm-deploy.timer` to retry every minute — usually landing within
a minute of the phone being put down. Waiting on *attached* clients instead
would never end: a pocketed PWA holds its socket for hours. `FORCE_AFTER`
(default 6h) bounds the wait; a server that cannot answer counts as free,
which is also what bootstraps the scheme from a build that predates the
endpoint.

The host-side pieces — `pockterm-deploy`, its `.path`, `.service` and
`.timer` — live in `deploy/` in this repository and are covered by
`test/deploy_test.sh` (`make test-deploy`), which stubs systemctl and curl.
They were host-only files until 2026-08-03, owned by nothing.

The signing key is the repo Actions secret `DEPLOY_HMAC_KEY` and
`/etc/pockterm/deploy-hmac.key` on the host. It exists because the drop
directory is mounted into a job container and the runner serves other
repositories too — without it, any workflow could have the host install a
binary as root.
