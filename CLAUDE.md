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
- **Focus is the keyboard on Android.** The system raises one for whatever
  *takes* focus, and raises one again for whatever *holds* focus as soon as the
  layout moves under it. Hence three levers: a control takes no focus
  (`keepsTerminalFocus`); anything that moves the layout gives it up
  (`releaseTerminalFocus`, `releaseFocus`, which also takes the pressed
  element); and a control that wants a keyboard asks **inside the touch** by
  giving the focus up and taking it again (`askKeyboard`) — focusing what is
  already focused raises nothing. Two bounds on giving it up: never while the
  keyboard is up, since its owner is typing, and never on a desktop, where
  focus is the only way to type at all. `sawKeyboard` tells the two machines
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
first — lives in `docs/lessons/`. The sections below are the index: a topic, the invariants a
change there must not break, and the file that says why. **Read the file before changing that
area.** Every section in it was paid for at least twice, and the cost of re-deriving one is a
release.

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
| The installer | `docs/lessons/install-and-deploy.md` |

## Keyboard, IME and the key bar

`docs/lessons/input-and-keyboard.md`

- **The phone is a Chrome PWA, not the owner's old Android app.** `window.PockNative` is
  absent, so `setImeMode` and `commitInput` do nothing; check `"native":false` in the `hello`
  line before explaining anything by the bridge.
- **A keyboard offers again whatever it finds in the field**, so the residue left after an
  edit is the defect, not corruption. `fieldHygiene` in `web/js/imefield.js` empties it —
  never while a composition is open, never in the same task as the event — and is the one
  owner of composition state.
- **The bar carries only what no on-screen keyboard offers**: Ctrl as a latch spent on one
  character, `#ctrlpad` for a screen with no keyboard, Tab, `^O`. `applyCtrl` in `js/keys.js`
  applies Ctrl to the keycode, so a Cyrillic letter is read by the key it sits on.
- **An Enter that ends an input waits for the composing word** (`web/js/ender.js`, 90ms
  bound); `esc` and `ctrl-c` must not wait. `endEditByBlur` puts back what xterm's own blur
  wipes, before the task that reads the field runs.

## The socket, and attaching at a size

`docs/lessons/socket-and-attach.md`

- **`send()` answers whether the socket took the bytes**, and the composer clears only then.
  A failed message is held, never queued; the last twenty live in `pt-sent` and the draft in
  `pt-draft`.
- **A quiet socket and a dead socket look identical from the page**, so it pings
  (`linkAction` in `web/js/link.js`) and only while on screen. `dropSocket` is the one way to
  let a socket go, and it clears the reconnect a close armed — two sockets draw every frame
  twice.
- **The server pings too** (`keepAlive` in `internal/server/server.go`, `pingEvery` 20s,
  `pongWait` 60s refreshed by anything inbound, `WriteControl` deliberately outside
  `writeMu`), because a notice is sent exactly when no page is looking.
- **A client attaches at its own size** — it travels in `/ws?session=…&cols=…&rows=…`
  (`requestedSize`) — or a default 80x24 resizes the shared window under every other client.

## Scrolling, copy-mode and the shift under the finger

`docs/lessons/scroll-and-copy-mode.md`

- **Scrolled back is not copy-mode.** Read `#{scroll_position}` and the history size, never
  `#{pane_in_mode}`; the ⇩ carries the same yellow `!` a tab does when a question waits below.
- **The pager stack lives inside `#term`**, fades after `PAGER_IDLE`, is untouchable while
  faded, and stands `--over-h` above whatever overlay is on screen; ⇞ stays at the live end,
  or the pager has no way in.
- **`#scrollbar` asks for a place, not a movement** (`scroll-to`, `tmuxcmd.ScrollHistory`);
  both numbers come from tmux (`PaneMode`), the track is measured off `#term`, and the drag
  uses pointer capture.
- **Typing cancels copy-mode** (`tmuxcmd.CancelMode`) and is the only thing allowed to; a
  mouse report is not typing, and the glide is stopped first.
- **The wheel step is tmux's** (`list-keys -T copy-mode WheelUpPane`, literal count, one line
  on the owner's host) and is the floor under every smoothness question here.
- **`.xterm-rows { pointer-events: none }`** — a touch belongs to the node it started on, and
  xterm rebuilds row spans on every write.
- **The shift under the finger** (`track` in `web/js/scroll.js`) counts repaints, never a
  clock; it caps at `MAX_TRACK`, takes tmux's status rows back off, and `〰 smooth` turns it
  off.

## The tab strip: state, order and kind

`docs/lessons/tabs-and-strip.md`

- **A tab answers four questions at once** and none of them is the others: the row is which
  sessions exist, the frame is where you are, the fill (`watch.Activity`) is what the agent is
  doing, the plates and heads are what it left running.
- **The end of a turn is read off the agent's counter** (`detect.Live`, `liveGrace`, two polls
  before believing it gone), never off the verb; `sawLive`, `detect.InputBox`,
  `Watcher.Rebase` with `Presence.Join`/`Leave`, and `doneFresh` are the guards that stopped
  it lying. `ActivityAsking` outranks working and done.
- **Every session is watched; only the ones a page has opened are announced**
  (`Options.Sessions` is the roster, `Watch` is the only thing that sets `notify`).
- **The state rides in the session list**, never in an endpoint of its own — a name and its
  state fetched separately disagree, and the disagreement lights the wrong tab.
- **Order and kind live in tmux, on the sessions** (`@pockterm-order`, `@pockterm-kind`,
  written by the Makefile, no `=` before the name in `set-option`), because CI restarts this
  binary several times a day. The page sends names, not indices; `markOf` is the one order of
  precedence for a glyph.
- **Rows and tabs are painted, never rebuilt**, and `renderTabs` refuses outright while a tab
  is carried.

## Answering the agent's menus

`docs/lessons/answering-the-agent.md`

- **The walk and the Enter are two writes.** `answerKeys` hands back `{move, commit}` apart,
  and `pressAnswer` waits until it can see the pointer arrive; in one write the menu answers
  option one.
- **The press reads the screen again** instead of trusting the row it was drawn from, and
  follows the option by label and by its own number — a menu scrolls its options, so a place
  in the list is not an identity.
- **`Type something.` is a field, not an answer**: the walk goes out, no `\r` follows, and
  `openForTyping` puts the keyboard where the answer is written. The label is matched whole
  (`TYPE_FIELD`), and there is no button before the footer says how the menu is answered.
- **A multi-answer menu toggles**: `submitKeys` steps one `↓` at a time and `pressSubmit`
  reads the screen between steps, because how far the pointer is from `Submit`/`Next` is not
  on screen.
- **Chrome is what tells a menu from prose** (`continues`, `flush` for checkboxes, a rule
  across the menu ends the list); an offer in the agent's own prose is read by the page alone
  (`detectOffer`), and the composer's `❯` is told from a pointer by its non-breaking space.
- **A button takes no focus, an answer gives it up, and only the field asks for a keyboard**
  (`keepsTerminalFocus`, `releaseFocus`, `askKeyboard`). The row hides while a composition is
  open (`paintAnswers`, `answersDrawn`).

## Sessions, the drawer and the buttons that start them

`docs/lessons/sessions-and-drawer.md`

- **The Makefile is the only thing that knows what a session is.** The server passes `DIR=`,
  `PREFIX=`, `KIND=` and `CMD=`, all of them gated (`session.ResolveDir`, `session.Prefix`,
  `session.Kind`, `session.ValidCustom`, `targetOK`) because each reaches a make command line
  and then a shell. Make's own variables are kept out of the session by wrapping the pane's
  command, not the tmux client.
- **A session name can be a group in disguise**, and attaching merges the two permanently
  (`tmuxcmd.NameConflict`). The page's own sessions are `pockterm-client-<id>`.
- **The session list is a drawer over the terminal**, moved by a transform so the terminal is
  never torn down; modal with nothing attached, and the settings panel remembers its own state
  (`pt-settings-open`) rather than being closed by the drawer's mechanics.
- **The stored button list is the whole set** (`POCKTERM_PRESETS_FILE`, `{"buttons":[…]}`,
  `Buttons.Resolve`, `Buttons.Reset`): a default is an entry whose id is a make target, the
  page saves the whole list and draws what came back, and every removal takes two taps
  (`armTwice`).
- **A command that fails on startup drops the pane into a shell** in the same directory,
  bounded by how long it ran. The recipe lives in `deploy/sessions.mk.example` here and in the
  `pockterm_app` role's template in devops, and the two must not diverge.

## Notifications

`docs/lessons/notifications.md`

- **`internal/watch` decides, the page decides nothing.** Both channels — Telegram and a
  `notify` frame — render one event through `watch.Format` and `watch.Notice`. If you are
  tempted to raise a notice from the browser, read the header of `web/js/notify.js` first.
- **The body is what the agent said**, not the last line on screen (`watch.Tail`: the lowest
  `●` sentence, `wrapped` for continuations, `withoutTheHumanSide` and
  `withoutTheOtherVoices` for the input box, the echoes and tool output, `paragraphAt`,
  `clip` at 200 runes).
- **The switch is the server's** (`watch.Pref`, `POCKTERM_NOTIFY_FILE`, `off` / `pwa` /
  `pwa+tg`, default `pwa+tg`), because half of what it controls is sent to a phone with this
  page closed.
- **Delivery goes through the service worker's registration** — `new Notification(...)` throws
  in Android Chrome — to every open page keyed by client id, minus the pages showing that very
  session (`OnScreen`). Permission is asked from the first touch, once per install
  (`pt-notify-asked`), and every notice names its own icon.

## Selection, the copy window and the Markdown behind the drawing

`docs/lessons/selection-and-markdown.md`

- **The page has no scrollback**, tmux does: the copy window asks the host for history over
  the socket the page already has (`tmuxcmd.CaptureHistory`, `proto.CaptureMax`, a **text**
  control frame, `captureWanted`, `data-from` saying which text is on screen).
- **A selection does not stop where the copy window does** — `insideSnapshot` and the `copy`
  event clamp it, or the bars' own labels come with it.
- **A paragraph is picked, not dragged** (`chunks`, `PARA_BAN`, touch and pen only, the click
  swallowed); a double tap takes the line and a second pair the word (`selectAt`, `TAP_PAIR`,
  `lastGrab`). A tap on text does nothing; the room around it is the way out.
- **What is on the pane is a picture of a message, and a copy has to put the message back**
  (`markdownFrom` in `js/select.js`: bold, the one recoverable `#` header, backtick colour,
  OSC 8 links, `tablesFrom`, rules by width, `unwrapFrom` with `roomRanOut`). Marks are set
  word by word, so spans of one style are rejoined; a code block sits at the agent's own
  margin, which is what tells a wrap from a newline.
- **Never claim a heading level the pane cannot carry**, and measure any reading of it off a
  real pane rather than off the agent's binary.

## Uploads, limits and the journal

`docs/lessons/uploads-and-diagnostics.md`

- **The device has no console**, so the page posts what decides an outcome to `/api/log`
  (`journalctl -u pockterm | grep client:`) — the environment at load, every copy, paste and
  upload, refusals included with their status and size.
- **A 413 is the proxy, not this server.** `client_max_body_size` lives in the
  `pockterm_vhost` role in devops and `upload.MaxBytes` here, 22 MB against 20 MB so an
  oversized file is refused in this program's own words. They are two repositories and two
  deploys: a bump here alone buys nothing.
- **One upload is one request**, sent one after another, with the paths typed in one write
  (`ATTACH_MAX` 10, and whatever is left over is said rather than dropped).
- **An image is known by its bytes, anything else by the name the browser gave it** (`?name=`,
  `safeName`, which filters punctuation and keeps the alphabet). Files are 0600 and swept
  after 24 hours; 📎 asks which source and opens the same input inside the tap.

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
