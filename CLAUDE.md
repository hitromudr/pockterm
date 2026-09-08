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

## Rules this file keeps re-learning

Every one of these was paid for twice or more. The files under `docs/lessons/` cite
them instead of deriving them again.

- **Nothing that reacts to the pane may sit in the flow.** A panel in the
  terminal's flex column shortens the pane, tmux redraws to the new height, and
  what the page reads changes under it: the answer row cost nine rows of
  thirty-five, the menu scrolled out of the grid, the row went away, the pane
  grew back, round again — reported as the buttons blinking. So `#answers`,
  `#ctrlpad`, `#pager`, `#scrollbar`, the sent list and `#snapshot` are
  `position: absolute` inside `#term`, drawn over the last rows they repeat. A
  browser test asserts `#{pane_height}` does not move when one is shown.
- **Anything drawn inside `#term` must be named in the click handler's skip list**
  (`#pager, #scrollbar, #answers, #ctrlpad, #cmdpad, #cmds`): the handler focuses the pane, so a
  control that takes no focus and even releases the field's still gets the focus handed back a
  moment later — which on Android is the keyboard. Four of the six names were added after the
  same report. `nothing but a tap on the terminal takes focus` walks the whole surface.
- **Focus is the keyboard on Android.** The system raises one for whatever
  *takes* focus, and raises one again for whatever *holds* focus as soon as the
  layout moves under it. Hence three levers: a control takes no focus
  (`keepsTerminalFocus`); anything that moves the layout gives it up
  (`releaseTerminalFocus`, `releaseFocus`, which also takes the pressed
  element, `releaseForBarKey` for every key and button pressed to read); and a
  control that wants a keyboard asks **inside the touch** by giving the focus up
  and taking it again (`askKeyboard`) — focusing what is already focused raises
  nothing. **Giving it up is inside the touch as well**, before the move rather
  than after it: `attach` blurred in a frame callback behind its own `fitNow`,
  and a blur behind the move is no blur at all. Two bounds on giving it up:
  never while the keyboard is up, since its owner is typing, and never on a
  desktop, where focus is the only way to type at all. Two more where a word is
  in flight — a composition open, or a field the keyboard has left something in
  (`endEditByBlur`). `sawKeyboard` tells the two machines
  apart, learned by watching a keyboard appear rather than guessed from the
  user agent.
- **The keyboard is measured, not assumed** (`measureKeyboard`: the viewport,
  not focus) and the answer is published as `data-kb` on the root element.
  Tests wait on that rather than on the viewport's own number — a shrink and a
  restore in quick succession coalesce into one event, and the page then never
  sees a keyboard at all. It is a diagnostic first, like `data-size` beside it.
- **Never rebuild a row under the finger.** A rebuild takes the focused element
  with it (see above), and on a WebView that is the keyboard coming up; it also
  disarms a confirmation half way through. State is applied as classes and
  `data-` attributes, glyphs live in child spans, `paintRows`/`renderTabs`
  repaint instead of rebuilding, and `renderTabs` refuses outright while a tab
  is being carried.
- **One owner per fact.** Two listeners on the same events are two answers, and
  the one that drifts is the one that decides: composition state is asked of
  `fieldHygiene` and of nothing else. Likewise one vocabulary of kinds and
  marks (`web/js/kinds.js`), one confirmation (`armTwice`), one socket
  (`dropSocket`), one gesture arbiter (`ownsGesture`), one detector pair held
  together by shared fixtures.
- **Ask tmux for a state; do not command it.** The page's picture of the pane is
  up to one poll (400ms) old, so what goes out must be harmless against a pane
  that has moved on: `send-keys -X cancel` rather than `q`, `scroll-to` with a
  place rather than a delta. Anything sent after a flick stops the glide first —
  inertia keeps sending notches for up to a second after the finger is gone.
- **Read a TUI by shape, never by vocabulary.** Verbs, labels and spinner frames
  turn over between Claude Code releases; brackets, indentation, a pointer
  glyph, a footer line do not. Where a word is unavoidable (`TYPE_FIELD`,
  `Submit`/`Next`) it is marked as the exception it is and carries the version
  it was measured on.
- **Measure the agent's TUI off the agent** — a real pane
  (`test/fixtures/menus.json`, captured at 51 columns, which is what a phone
  gives a shared window) or the binary itself in
  `~/.local/share/claude/versions`. Every guess about it here has cost a
  release.
- **The pane carries its own fonts.** A stack names candidates and takes whichever the
  machine has, so one screen came out in three typefaces and three cell widths — Courier
  New on Windows, Droid Sans Mono on the phone, `DejaVu Sans Mono` on Linux. Two subsets
  travel in the binary (`web/fonts`, `tools/subset-font.py`): the letters, and the marks
  the letters have not got. Their **order in `--mono`** is what picks between them, and
  the system names stay last for what neither holds. `--mono-system` builds the pane and
  `--mono` replaces it once the file has loaded, because xterm measures the cell once and
  ignores an option equal to the one it holds.
- **Check a test against the defect first.** A test that passes with the fix
  reverted is worse than none. That happened once in this repository already.
- **The stand cannot compose.** Desktop Chromium has no IME (see the header of
  `js/inputdiag.js`), so IME rules are unit-tested against an injected field and
  faked only where the fake is not the thing under test (`FAKE_IME` in
  `test/ui/stand.mjs`, dispatched at xterm's own field). The phone is the judge,
  through `🔍 Input log`.
- **The journal is the instrument.** The device has no console anybody can open:
  the page posts what decides an outcome to `/api/log`, and the server writes
  its own decisions (`journalctl -u pockterm | grep -E 'client:|watch:|notify:'`).
  Every "иногда зависает" here became a fix only once a line separated two
  failures that looked identical from a thumb.
- **A wrong answer looks exactly like the right one.** Where a guess could
  answer a menu, press a button or type a byte nobody meant, silence is the
  cheap failure: no button, a toast, a line in the journal.

## Where the derivations live

The rules above are the whole of what this file asserts; each one was measured, and the
measurement — the pane it was captured off, the date, the numbers, the wrong answer that came
first — lives in `docs/lessons/`. Before changing any area, read the relevant file below to
understand what invariants a change must not break.

| Topic | File |
|---|---|
| Keyboard, IME, the key bar | `docs/lessons/input-and-keyboard.md` |
| The socket, attaching at a size | `docs/lessons/socket-and-attach.md` |
| Scrolling, copy-mode, the shift | `docs/lessons/scroll-and-copy-mode.md` |
| The tab strip: state, order, kind | `docs/lessons/tabs-and-strip.md` |
| Answering the agent's menus | `docs/lessons/answering-the-agent.md` |
| Sessions, the drawer, the buttons | `docs/lessons/sessions-and-drawer.md` |
| Notifications | `docs/lessons/notifications.md` |
| Selection, the copy window, Markdown | `docs/lessons/selection-and-markdown.md` |
| Uploads, limits, the journal | `docs/lessons/uploads-and-diagnostics.md` |
| The fonts the pane is drawn in | `docs/lessons/the-pane-font.md` |
| The installer | `docs/lessons/install-and-deploy.md` |

## Deploy

A push to `main` builds, tests and hands the binary over, and **the host installs it at
once**. Do not install by hand on the RPi5, and do not run the `pockterm_app` ansible role's
binary copy against it.

`.forgejo/workflows/deploy.yml` runs on the runner that lives on that same box: the job builds
in a container and drops `pockterm.new` plus an HMAC signature into
`/var/lib/pockterm/incoming`, the host watches that path (`pockterm-deploy.path`) and
`/usr/local/sbin/pockterm-deploy` verifies the signature and takes it from there. Identical
bytes are a no-op, so a docs-only push drops nobody's terminal; a binary that fails to start
is rolled back. The host-side pieces live in `deploy/` and are covered by
`test/deploy_test.sh` (`make test-deploy`).

**That no-op needs a reproducible build**, which is why `BUILD_FLAGS` in `make/go.mk` is
`-trimpath -buildvcs=false` and `make test-repro` builds the tree twice under different paths.
It is two real cross-compiles, so it is not part of `make check` — run it when the build line
changes. The cost is that the binary no longer says which commit it is; the page's
`APP_VERSION` is what identity there is.

**A page older than the server raises its own update bar**, so `APP_VERSION` in
`web/js/app.js` and `VERSION` in `web/sw.js` are bumped by hand together — `assets_test.go`
fails if they drift, because a page misreporting its version never looks out of date. The bar
is a button rather than an automatic reload: the composer can hold half a message.

The deploy waits for nobody (removed 2026-08-03: the person waiting for the fix was the one
holding it up). The signing key is the repo Actions secret `DEPLOY_HMAC_KEY` and
`/etc/pockterm/deploy-hmac.key` on the host, and it exists because the drop directory is
mounted into a job container while the runner serves other repositories too.

That path installs on the RPi5 only. For everyone else there are releases:
`.github/workflows/release.yml` fires on a `v*` tag, runs `make release` (both architectures
plus `SHA256SUMS`) and publishes them, and `deploy/install.sh` downloads one when no Go
toolchain is present, refusing a binary whose checksum does not match. What else that
installer does instead of asking a reader — refusing a host without `tmux`, installing the
session Makefile without ever overwriting one, restarting only when the env file changed,
`--tg` — is in `docs/lessons/install-and-deploy.md`, with `test/install_test.sh` covering each.
