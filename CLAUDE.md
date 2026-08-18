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

Every one of these was paid for twice or more. The sections below cite them
instead of deriving them again.

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

## The client is not always a browser

On the owner's phone this once ran inside a WebView in his own Android app
(`android_client` in the devops repo). A WebView has no asynchronous Clipboard
API, no Notification API, no file chooser and no PWA install, and it cannot be
opened in devtools; every clipboard, image and notification bug reported here
came from that gap. The app injects a bridge — `window.PockNative` with `copy`,
`read`, `commitInput`, `setImeMode`, `notify` and `appVersion`. The page prefers
it when present and falls back to browser APIs where there are any; a call the
installed app does not know returns false rather than throwing, which is how the
page tells "no" from "this app is older than the request".

`commitInput` ends a composition, which a page cannot do; `setImeMode` asks for
a different kind of field. Neither is fixable inside the page — see
`TerminalWebView` in the devops repo for what the app asks the keyboard for. The mode is cycled from the drawer (text → raw →
raw-strict) and stored; `?ime=` still wins on load but is unreachable inside the
app, whose address is fixed (`POCKTERM_URL` in `MainActivity`). The URL is read
once at load, or a lingering `?ime=` undoes every tap. The terminal defaults to
`raw` since 2026-08-03, measured rather than argued: under app 2.3 a backspace
arrives as `deleteContentBackward` instead of an `insertCompositionText`
rewriting the whole word, and the composing region covers the last word rather
than everything typed. `raw-strict` (`VISIBLE_PASSWORD` + `NO_SUGGESTIONS`,
app 2.1) brought up **no keyboard at all** — `sawKeyboard:false` for a whole
session — so the page's default undoes the app's own; a drifting keyboard is bad
and no keyboard is worse.

**None of that lever exists on the client the owner actually uses.** The phone
has been a Chrome PWA since at least 2026-08-05 (`"native":false` in the `hello`
line — check that before explaining anything here by the bridge), and without
`PockNative` both `setImeMode` and `commitInput` do nothing at all. So the `⌨`
button cycles a mode, remembers it and changes nothing, and the Enter held in
`ender.js` waits on its 90ms bound rather than on a commit. This section
describes the app; the ones below describe the phone.

## The word came back because the field still had it

The drift was read for two releases as the keyboard corrupting what was typed.
It is not: **the word is written twice**, and the second copy is the keyboard's
own, offered because the page left the word where the keyboard could find it.

Measured on the owner's phone (Chrome PWA, Gboard, 2026-08-06) at `chars`,
typing `порт`, a space, then a backspace:

```
compositionend        "порт"   field="порт"   ← sent, and the field is not cleared
insertText " "                 field="порт "
deleteContentBackward          field="порт"
compositionstart      ""       field="порт"   ← the keyboard re-opens over it
insertCompositionText "порт"   field="порт"   ← sent a SECOND time
```

— and the same block for every further space-and-backspace: three presses, three
copies. That is what `❯ орарь орарл` on the screenshot was. Nothing is corrupted:
the residue in the field *is* the defect, because what a keyboard finds in a
field is what it takes for the word being written now.

**The same phone in its other mood opens no composition at all**: 83 keyups and
zero composition events in half a minute of the same recording, with twelve
`insertText` spaces growing the field 4 → 16 and never shrinking. Different
route, same residue — which is why the fix is about the field rather than about
compositions, and why another keyboard mode would have needed two.

`fieldHygiene` in `web/js/imefield.js` empties the field once an edit is over,
and the two bounds are the whole of it. **Never while a composition is open** —
what is in the field then is being written. **Never in the same task as the
event** — xterm reads the field on a `setTimeout(0)` scheduled from
`compositionend`, so a clear that ran first would send an empty string, and
sending nothing is worse than sending twice. It reads, replaces and sends
nothing; the one operation is emptying a field the keyboard has finished with,
which keeps it from becoming a fifth author in the buffer that "One owner for
typing" in `app.js` exists to prevent.

**Whether the rule did anything is its own question, with two silent wrong
answers**: never wired (xterm's textarea not yet there when `keepEmpty` is
called) and wired but never firing look identical from a phone, and both look
like the drift. `field-guard` says which at load, `field-clear` reports the first
clear with its length. On the owner's phone, v133: `{"wired":true}`,
`{"len":6,"first":true}`.

**Measured again with the log on, and the defect is gone.** 316 events, the field
emptied fourteen times and never grew past 8 where the day before it ran to 16
and kept going. The number that decides it: eight `compositionstart`, seven of
them over an empty field. A keyboard that finds nothing has no previous word to
offer.

The eighth is a different animal, and it must not be fixed by widening the rule.
Gboard sometimes **restarts a composition without ending the one before** —
`compositionupdate` with `len:0`, no `compositionend`, then a fresh
`compositionstart` over the character the previous region left, with the next
region appended rather than replacing it (field 1 → 3 on a two-character
update). Nothing ended, so by its own bounds the field is still the keyboard's.
xterm sends a composition at `compositionend`, so the character sitting there has
*not* been sent: clearing it would lose a keystroke. A recording at `chars` did
not reproduce any loss (`слово1 слово2 слово3` typed and arrived, with the
space-and-backspace in the middle of it), and the restart is rare — two of eight
in one run, none in the next. Unmeasured cost is not a reason to widen a rule
against a keystroke that might simply vanish.

## The bar carries what the keyboard cannot

Every key on the bar earns its cell against one question: does the on-screen
keyboard already do this? Erasing does, so the backspace left on 2026-08-12 and
its cell went to **Ctrl as a latch** — one tap arms it, the next character typed
goes as a control code, the arm is spent. `^R`, `^D`, `^Z`, `^L` are what an
agent's console asks for and no on-screen keyboard offers; `applyCtrl` in
`js/keys.js` had been written for this and sat unused.

**The modifier alone was the wrong answer, and the phone said so within the
hour**: "Ctrl, letter — and out comes text, with Ctrl still lit". Gboard
composes, so xterm is handed a whole word when the composition closes —
`compositionend` with len 3, 5, 7, 8, 9 and only twice len 1 (2026-08-12). There
is no keystroke to modify; a latch waiting for one character waits for something
this keyboard does not send.

So Ctrl also opens **a pad of the control keys themselves** (`#ctrlpad`), which
asks the keyboard for nothing: `^A ^E ^K ^U ^W ^R ^L ^D ^Z ^P`, one tap each,
closing on use — a pad left open covers the output it was opened over. The two
share one state: arming shows the pad *and* latches the next character, and they
must not disagree about whether Ctrl is on.

**And the keyboard can be made to hand the letter over, which is what the pad
stood in for.** A composition can be ended by moving the focus (`endEditByBlur`,
written for the held Enter), and a composition that has ended is a letter xterm
sends at once. With Ctrl armed, the first edit inside a composition is ended a
task later (`ctrlSawEdit`), the letter arrives at `onData`, and the latch turns
it into a control code. Arming also ends a word already in flight: it goes as the
typing it is, and the next letter then arrives in a field of its own. Which
question is asked of the field rule (`fieldHygiene`'s `onEdit`, beside
`onCompose`), not of a listener of its own.

**The layout is the other half.** The owner's keyboard is Russian, and a page can
switch neither layout nor language — there is no API in the browser or in
Android. So `applyCtrl` reads a Cyrillic letter **by the key it sits on**: `к` is
where `r` is, so Ctrl+`к` is `^R`, which is what a terminal does one layer down,
applying Ctrl to the keycode rather than to the letter the layout produced.
Letters only: `х ъ ж э б ю` sit on brackets and punctuation and pass through
untouched. A test checks that every key the pad offers has a Cyrillic letter
reaching it.

**So the pad is now for a screen with no keyboard on it** — reading back through
output with the bars away, where `^C` still has to be reachable. With a keyboard
up the letter comes from there (`keyboardUp`, the page's own measurement), so on
a desktop the pad behaves exactly as before.

Three properties of the latch, each a way it could have gone wrong quietly:

- **Spent, not sticky, and visible while armed.** A latch left on turns a
  sentence into control codes with nothing on screen reacting until one of them
  means something. The button lights with the same `on` class every lever here
  uses, and the test asserts the class goes out when the arm is used.
- **One character only.** A paste and a composed word arrive as several, and
  turning the first into a control code would mangle the rest.
- **A mouse report neither is typing nor spends the arm.** xterm hands the wheel
  to the same callback as the keyboard, so a scroll between arming and typing
  would otherwise leave the latch quietly off.

Another bar key **spends** the arm rather than being modified by it: those keys
are sequences of their own, and a Ctrl+Esc sending something else is a key nobody
asked for. `test/ui/bytes.test.mjs` reads all of it off the wire through
`cat -v` — `^R` from a composed `к`, `^R` from a typed `к`, `^[r` for that last
case, and the pad staying away with the viewport shortened. Each was checked
against the defect first: with `onEdit` unwired the composed letter never reaches
the pty at all.

## The bar's Enter waits for the keyboard's word

Gboard holds the word being typed as a composing region. Only the app can end
that (`PockNative.commitInput()`), and calling it before Enter was necessary and
not sufficient: the committed text reaches the page in a later task, so an Enter
in the same tick overtook it — the line went without its last word, and the word
turned up after the newline.

`web/js/ender.js` holds the key: released a moment after input arrives, or after
90ms when nothing was being composed. Both bounds matter — a commit can arrive in
more than one chunk, and an Enter that sometimes does nothing is worse than the
defect. Only keys that end an input go through it (`enter`, `alt-enter`, the
`accept` macro); `esc` and `ctrl-c` interrupt one and must not wait. The bridge
cannot say whether anything was composing, so the page waits on the data rather
than on the answer.

**A browser was assumed not to need any of it, which stopped being true when the
phone stopped being the app.** `commitPendingInput` answered `false` without a
bridge, and the ender reads `false` as "nothing to wait for" — so on a Chrome PWA
the wait never happened and the 90ms bound never applied. Reported as the last
word not being sent while **dictating by voice**: dictation is one long composing
region, so the word is always still in the field when the Enter goes. Typing by
thumb hides it, a word ending often enough that the field is usually empty.

A page cannot ask Android to restart the input, but it can end a composition the
ordinary way: taking the focus off the field makes the keyboard finish the word
and fire `compositionend`, which xterm forwards to the pty; focus goes straight
back, so the keyboard stays up. `commitComposition` chooses between the two and
answers **false when nothing is being composed** — the right answer rather than a
missing one, since what was typed has already gone as key events. Whether a word
is being composed is asked of `keepEmpty` in `js/imefield.js`, which hands back
`isComposing` — the one owner of that fact.

The device answers with a line per Enter (`ender`): what was asked, whether a
composition was open, how much the field held. "The last word did not go" and
"there was nothing to wait for" are the same thing from a thumb, and that line
separates them — dictating, `asked:true composing:true` with 41, 46 and 67
characters held. It lives behind `🔍 Input log`: a line per Enter is a request per
Enter, and that is not the price of typing once the answer is known.

## The blur that ends the word is the blur that wipes it

For one release the blur did not merely delay the word — it **destroyed it**.
Reported as "the last word is not sent" again, and the journal said the wait had
happened this time (`ender asked:true composing:true len:4`, 2026-08-08), with a
`compositionend` carrying the word above it and no data event after it at all.

Both halves of the mechanism are xterm's own, and a blur runs them in the order
that loses. `_handleTextAreaBlur` is literally `this.textarea.value = ""`, and
`compositionend` schedules a `setTimeout(…, 0)` that reads the field and sends
**what is in it then**. The word was ended, wiped and read as nothing.

`endEditByBlur` in `js/ender.js` puts back what xterm wiped, inside our own call,
before the task that reads it runs. It is the one write to that field on this
page and deliberately **not an edit**: the value goes back to exactly what the
keyboard left, nothing is read out and nothing is sent. Owners are unchanged —
xterm still sends, `fieldHygiene`'s deferred clear still empties after the read.
A field a browser did not wipe gets no write at all, and the journal carries how
much was put back (`restored`).

**The stand can judge this one.** The composition is faked, but only the part not
under test: events are dispatched at the real field and `compositionend` is fired
from a **capture-phase** blur listener, which is where Chrome fires it and ahead
of xterm's own listener. `test/ui/bytes.test.mjs` reads the pty through `cat -v`:
against the two-line `blur(); focus();` it is `^M`, with the fix `ab^M`.

## Holding the focus is asking for the keyboard

The general rule is above; two places learned it first. `attach` — a session
switch kept raising the keyboard for somebody who had just put it away, and
nothing on that path focuses anything. And the ⇩ that goes back to the live end,
reported as the scroll arrow bringing the keyboard up over the output it had just
returned to: leaving copy-mode is exactly a layout moving.

The way back is unchanged — tapping the terminal asks for a keyboard and gets
one. The stand has no soft keyboard, so the tests assert the lever (does the
textarea still hold focus) with the keyboard played by the viewport and waited
for on `data-kb`. `keepsTerminalFocus` stays on the ⇩ itself: it hides a moment
later, and hiding a focused element hands focus back to whatever had it before.

## A message that did not go out is still the owner's

`send()` drops what it is given when the socket is not open, which is right for a
keystroke: nowhere to put it, and nobody typed it twice. The composer handed it a
whole message and cleared its field in the same tick, as though the socket had
taken it — reported as the text disappearing when the send does not go through.
The moments when a send fails are exactly the ones with a long message in the
box: a reconnect, a Wi-Fi/cellular handover, the unit restarted by CI under
whoever is typing.

So `send()` answers whether the socket took the bytes and the composer clears
only then. **Held, not queued**: a message delivered on the next connect would
arrive minutes later into whatever the session is doing by then, and nothing
downstream — pty, tmux, the agent — knows it is a latecomer.

**And what did go out is kept**, because the other half cannot be detected at all
(an open dead socket looks like a quiet one, see the watchdog below). The last
twenty messages live in `localStorage` (`pt-sent`, `js/compose.js`), newest
first, a repeat moved rather than added — sending the same line twice is what a
retry looks like. `↻` opens them and is hidden until there is one; a recalled
message goes **into the field, not down the socket**, since it is usually being
recalled because something went wrong with it.

**The draft is written down as it is typed** (`pt-draft`, 300ms timer). The page
asks for a reload after a deploy and Android kills a WebView whenever it likes;
both used to take a half-written message with them. That is also the fear behind
the update bar being a button rather than an automatic reload.

## A quiet socket and a dead socket look the same from in here

Reported as the screen freezing: a message typed on the phone had plainly been
sent — the laptop showed the agent answering it — while the phone sat on the same
frame and caught up "about a minute later". Nothing was frozen. The socket had
been handed between Wi-Fi and cellular, the far end was a black hole,
`readyState` stayed OPEN and sends appeared to succeed. The minute is TCP giving
up.

**`ping` was answered by the server before anything sent one.** The protocol had
the question and the page never asked it. `linkAction` in `web/js/link.js`
decides, and it is a pure function because the alternative is a timer nobody can
test: after `PING_AFTER` of silence the page asks, and if nothing arrives within
`PONG_WAIT` the socket is discarded and `connect()` runs again — fifteen seconds
against the minute it was. Any inbound traffic counts as the answer, so a busy
session is never pinged.

**Only while the page is on screen.** A backgrounded page has its timers
throttled to roughly one firing a minute, so every measurement it takes is late
by construction. A pocketed phone keeps its socket, and `visibilitychange` asks
the moment it comes back — which is when the answer is most often "gone".

**Discarding a socket means both its handlers, and `onclose` is the one that
matters.** Closing a socket fires it, and `onclose` schedules a reconnect of its
own — so the first version of this watchdog left the page with two sockets, then
four, each writing every frame into the same terminal and carrying every
keystroke. Reported within the hour: "терминал затроил", "по три сообщения
начали отправляться".

**The reconnect a close armed is the other half of the same rule.** Anything that
opens a socket before that timer fires — a tab tapped, the watchdog, the restore
on load — leaves it to open a **second** one on top of the one now in hand. Every
deploy makes the race: a restart drops every socket at once and the page is
reattached by hand within the second the backoff is armed for. Reported after two
deploys in an evening as everything on screen being drawn twice, which reads as a
message having been sent again; nothing is, the page writes to the newest socket
and reads frames from both, so what doubles is the picture. `dropSocket` is the
one way a socket is let go, it clears the pending timer with the handlers, and
`connect` calls it first.

The backoff resets when the watchdog fires: this is a socket being thrown away,
not a host that cannot be reached. `socket-stalled` goes to the journal with the
length of the silence.

Two tests, each made rather than waited for. The UI test drops the page's own
sends (`WebSocket.prototype.send` swallowed) and requires the journal line, the
reconnect and a terminal that types again; with the watchdog's timer commented
out it times out. The race test closes the page's socket from outside and taps a
tab inside the second, then counts open sockets in the page and clients at
`/api/presence` — one, where the old code gives two.

## A client attaches at a size, and the wrong one is everyone's problem

Sessions here are grouped (`new-session -t <name>`, one window, several clients)
and tmux's `window-size latest` gives the shared window the size of the newest
client. A client attached at a default 80x24 and told its real size a moment
later resizes the window under **every other client on that session**, the laptop
included, which keeps drawing at its own width while tmux fills lines to 80: on
screen, halves of two lines in one row and a cursor landing nowhere.

Reported twice as a desync — "на всех вкладках курсор прыгает, потом прошло" —
and both halves of that sentence are the mechanism: every tab switch attaches a
new client, and the page's first `resize` a moment later fixed it.

The size travels in the socket's address (`/ws?session=…&cols=…&rows=…`) and
`requestedSize` reads it there, so the pty is created at the page's size. Missing
or absurd values fall back to 80x24, the value coming from a query string.

**Measuring this after an ordinary attach proves nothing**, which the first
version of the test demonstrated by passing against the defect: `sendResize`
corrects the window first. The test drops resize frames on their way out and
compares `#{window_width}` with what the page says its size is — 80 against 44 on
the old code. The page publishes that size on `#term` (`data-size`, `fitNow`).

## Scrolled back is not the same as copy-mode

While the pane is scrolled back the page shows the round ⇩ that returns to the
live end, and no prompt buttons, the numbered lines on screen belonging to the
past.

Both used to follow `#{pane_in_mode}`, which is a different state. tmux's own
`WheelUpPane` enters copy-mode with `-e`, which leaves it again when a scroll
reaches the bottom — but only when a scroll is what got there. The page's glide
keeps sending notches after the finger is gone, a second client has its own idea
of the position, and a mode entered by hand never had a scroll to end: all of
those sit in copy-mode showing the present, which is what "the ⇩ stays at the
bottom" was. The mode frame carries `#{scroll_position}` as well now, and the
page shows both by whether there is history above. Nothing here asks tmux to
leave the mode — the pane is shared and a laptop chose it (the one exception is
typing, below).

**What the ⇩ is on screen with is a pager**: `⇞` and `⇟` above it, a screen at a
time, because the swipe moves by what a thumb covers and reading back through a
long output was a handful of lines and a glide per go.

**⇞ is on screen at the live end too, and that is what makes it a way in.** For
one release it came and went with the ⇩, which left the only way to reach the
pager being the swipe it exists to replace. ⇟ and the ⇩ stay tied to having
history above. The three are one stack (`#pager`, `column-reverse`), so the one
always present is nearest the thumb.

**And it is permanent only while something is being scrolled.** Three circles in
the corner of a screen being read are chrome for a control nobody is using, so
the stack fades `PAGER_IDLE` after the last scrolling and comes back with the
next (`wakePager`). What counts as the next scrolling is every way this pane can
move — the wheel the swipe and the buttons send, the scrollbar's request, the
position changing under a second client — **and a finger arriving on the pane at
all** (a pointerdown, so a laptop's mouse says the same). Without that last one ⇞
would have stopped being a way in. The position wakes it, not the frame: the mode
frame carries the history size, so a printing pane sends one every poll.

**Faded, and untouchable while faded** (`pointer-events: none`): an invisible
44px circle over the answer row's Esc is the same defect as a visible one, only
harder to report.

**▴ takes the corner the fade frees.** With every bar hidden it is the only thing
on screen; it sits left of the stack (`right: 76px`) only because the stack is
there, and slides into the freed slot on the same quarter second the fade takes,
so the two never share it. `right` rather than a transform, the button's position
being stated that way already. What went into that corner first was ☰, and that
was a misreading of "кнопку открытия меню сдвигай вправо на место кнопки
возврат" — the button that opens a menu is this ▴ opening the bars, not the
hamburger. It cost a release (a second ☰ over the pane, the header's stepping
aside on a timer, a rule in `stand.tapMenu()` about which to click), all of it
now gone. The sentence named a button by what it does, and two buttons matched.

**The stack lives inside `#term`.** It was pinned 64px above the bottom of the
viewport — a guess about how tall the bars are, harmless while the button only
appeared during a scroll, and a button sitting on the key bar's ▾ and the
composer's ▶ once ⇞ was always on screen. Three browser tests caught it as a
click nothing could reach. The terminal's box ends where the bars begin, so the
stack is bottom-right *of it*. That brought one thing with it: a tap on the pager
or the bar now arrives at `#term`'s own click handler, whose job is to hand focus
back to the terminal. Both are excluded there by name — a control drawn over the
terminal is not the terminal.

**And its corner is somebody else's corner.** The answer row and the control pad
are drawn over the pane's last rows, so a 44px circle 10px off the bottom sat on
the row's `Esc` and the pad's last key — reported as Esc not answering. The
answer is measurement rather than another number: `liftFloaters` publishes the
height of whatever overlay is on screen and the stack stands that much higher
(`--over-h`). The row is as tall as the menu it was drawn from (up to 45vh), so
nothing fixed would have covered it. The scrollbar still takes 18px off the right
edge of the row's buttons, which is a rail rather than a target.

The pager sends **the wheel the swipe already sends**, not tmux's `page-up`, so
it needs no state of its own: a notch enters copy-mode by itself and a scroll
down reaching the live end leaves it. The step is `floor((rows - 2) / wheelLines)`
notches — **rounded down, and the remainder is overlap**. Rounding up skips the
lines between two pages, and a line nobody knows they have not read is the one
failure here that says nothing about itself. Neither number is assumed: the rows
are the page's own, the lines per notch are what the server asked tmux for. It
inherits the two traps above — stop the glide, give up the focus. The browser
test asserts the bounds rather than the formula: at least half a screen, never
more than one, and forward undoing back exactly.

## The bar says where in the output you are, which no step can

The swipe and the pager both move by a step; neither says how much is behind the
screen or how far through it you are. `#scrollbar` answers that: the thumb covers
the screen's share of the whole scrollback, the top of the track is the oldest
line kept, the bottom is the live end.

**It asks for a place, not a movement.** `{"type":"scroll-to","back":N}` names
where to be and the server works the difference out against a reading taken there
and then. That also keeps a drag from being several hundred notches:
`tmuxcmd.ScrollHistory` is one `send-keys -X -N <count>`, with `copy-mode -e` in
front because `-X` needs a mode to send to and the bar is drawn before there is
one. The `-e` is what makes a drag to the very bottom leave the history.

**Both numbers come from tmux.** `PaneMode` reports `#{history_size}` beside the
mode and the position, comma-separated — the middle field is empty out of a mode,
and `strings.Fields` on `0  800` gives two fields and reads the size as the
position. tmux answers the size out of a mode too, which is what lets the bar be
drawn before the first scroll. The cost is a mode frame whenever the pane prints;
that is the point rather than the price, a bar drawn against a minute-old total
being wrong by everything printed since. The journal line stays on the state the
page *shows* changing.

**A hidden element measures zero, and the first version deadlocked on it**: the
track was read off the bar, the bar starts `hidden`, so it had no height, so it
was never shown. It is measured off `#term`, the same box by construction.

**Pointer events, not touch** — the one place here that uses them, for the defect
the rows met below: a touch is delivered to the node it started on.
`setPointerCapture` says outright that the bar owns the drag, which is also what
lets a finger slide off an 18px track and go on dragging; one set of handlers
covers the laptop's mouse. Two widths and that is the design: a 4px rail over
output that has to stay readable, an 18px target for a thumb. The floating
buttons moved from `right: 10px` to `22px` to clear it.

## Typing into copy-mode goes nowhere, and nothing on screen says so

tmux discards what is typed into a pane it holds in copy-mode. On a laptop that
is visible and the way out is `q`; on a phone it is invisible — the page enters
copy-mode by its own scroll gesture, and **a pane sitting in copy-mode at the
live end looks exactly like a live one**, which is why the ⇩ is hidden then.

Reported as the terminal refusing text and a pasted image never arriving, with
the cure found by hand: scroll up and come back. The journal had written down
what nothing on screen did — four uploads in a minute, each `ok`, each preceded
by `{"event":"mode","in":true,"back":0}`. The image had been saved every time and
the path typed into a pane throwing it away.

**So typing ends the mode**, and it is the one thing allowed to. Typing is an act
rather than a guess: somebody is writing to the program now. Against every
keystroke on the phone going nowhere, a laptop taken to the live end is the
cheaper loss, and `leave-mode` in the journal says how often it happens. Three
things make it safe: it is a request (`tmuxcmd.CancelMode`, `send-keys -X
cancel`, which tmux refuses with a message when there is no mode — it types
nothing, and the server handles the frame in the same loop that writes the
keystrokes, so the mode is gone before the bytes arrive); the glide is stopped
first, typing right after a swipe being the commonest way to meet that trap; and
**a mouse report is not typing** — with tmux's mouse on, a scroll arrives at the
same `onData` as `\x1b[<64;…M`, and read as typing it would cancel the very
copy-mode the scroll just entered.

## A tab carries three answers, and none of them is the others

Which sessions exist is the row, which one you are in is a **frame**, and what
each is doing is the **fill**: nothing for a session the watcher has no claim
about, a moving purple while output arrives, green once it has gone quiet after
doing something. "Attached" used to be the fill, which left the session you were
sitting in as the only tab that could not tell you whether its agent was running.
The border is always present and only changes colour, or every switch would move
the row by two pixels.

The state is `watch.Activity`, read off the same bookkeeping the "finished"
notification is decided from, so the colour and the notice cannot disagree.
`ActivityUnknown` is deliberately not called idle: the honest claim is that
nothing has been seen.

**The end of a turn is read off the agent, not waited out.** `detect.Live` looks
for the counter an agent keeps on screen while a turn runs — `✶ Doing… (1m 13s ·
↓ 3.9k tokens)` — and its going away is the event: "done" once it has stayed away
for `liveGrace`, four seconds, instead of thirty seconds after the last change.
The silence rule remains for a pane with no counter (a shell running a build).

**One poll without the counter is not an answer.** It was, and the report was
"часто зеленеет на время и отправляет уведомление": a capture landing between the
footer being erased and painted again is one screen without a counter on a turn
still running. Two polls keep almost all of the advantage, and `Activity` waits
exactly as long as the notification does. Sampling the author's sessions at twice
the poll rate found no flicker in this release, so this is a guard rather than a
fix for something caught in the act.

**Every event is written down** (`Options.Log`) with the session and the rule that
raised it — `counter gone for 4s`, `quiet for 32s` — and, when nothing was sent,
why. Before that line "it goes green for no reason" could not be told from a real
finish an hour later, and what looked from the page's side like a burst of
notices was one event delivered to the several sockets a stalled reconnect had
left behind.

Three readings say a turn is running, and the first had to be widened after it
sent a "finished" notice mid-thought:

- **Brackets opening with a duration** — and nothing else in them is required.
  The first version also demanded `tokens`, which is gone while the agent only
  thinks: `✢ Crunching… (4m 23s · still thinking)` read as a turn that had ended.
  A 40-second sample missed it entirely, tokens happening to flow throughout.
- **`esc to interrupt`**, which older releases show instead of a counter.
- **One of a small set of stars followed by a word ending in an ellipsis** —
  `✻ Pondering…`, `✢ Crunching…`. The ellipsis is what makes it safe: a turn in
  flight is named with one, the line left behind when it ends is not. `●` is
  deliberately not in the set — that is the mark on the agent's own sentences,
  the thing a notification is *for*.

  **The set was observed, and observing it left a frame out.** Read out of Claude
  Code 2.1.234, the spinner cycles `["·", "✢", "*", "✶", "✻", "✽"]`, and `·`
  (U+00B7) was missing — one poll in six blind. Harmless while the brackets carry
  a duration, and not harmless on the shape a long think draws:
  `✻ Unravelling… (thinking with xhigh effort)`, captured off two live sessions
  on 2026-08-18, has no duration in it, so two polls landing on `·` inside the
  four seconds report a turn as finished mid-thought. The dot is also the one
  frame that can be prose, so it was measured first: no line in 2000 rows of
  scrollback from four working panes begins with one, and the cost if it happens
  is a tab that stays purple rather than a notice saying the opposite of what is
  true.

What is never matched is the verb — Pondering, Crunching, Cooked, Sautéed turn
over between releases, and the line left behind is the same words in the past
tense (`✻ Crunched for 4m 3s · 1 monitor still running`). The counter outranks
the silence threshold while it is there: a turn that thinks for a minute can
redraw to the same bytes. The search window is the last 20 non-blank lines, not
the footer's four, because what the agent draws under the counter is as tall as
it feels like.

**Once a session has been seen counting, the counter is the whole answer, and a
change on screen is not an answer at all.** Any change used to count as work
resuming, and the change a person makes most often is typing the next message
into the agent's input box: the tab went green when the turn ended and purple at
the first keystroke — "it does not detect the stop and jumps from green to
purple". It cost notifications too: every keystroke re-armed "finished", so a
turn already reported was reported again. The regression test types four
characters and demands one event; the old rule produced five. So `sawLive` is a
property of the session, and `Activity` answers `done` for any session that has
counted before and is not counting now.

**Attaching is not work either.** Tapping a green tab turned it purple for the
whole idle threshold: a page attaching makes tmux give the new client its own
size and the pane is redrawn, so the screen differs through nobody's effort.
Leaving cost more — the pane resizes back, nobody is looking, and thirty seconds
later the session was announced as *finished* for having been left.
`Watcher.Rebase` marks the next screen as ours; `Presence.Join`/`Leave` call it.
The immunity is a short window rather than one poll, because tmux redraws and the
agent redraws its own box a moment later — with the window removed the test shows
the first redraw forgiven and the second not.

**Typing into a session that has never counted is not work either.** `sawLive`
was written for a session whose agent had already run a turn; a session just
opened has not, so the only evidence of work was the screen changing, and it was
changing because the first message was being written into it. The tab swept
purple beside the one really running, and thirty seconds after the last keystroke
the watcher announced it as finished — four times in five minutes (`watch: done
pockterm (quiet for 30s)`). `detect.InputBox` answers it: the box and the counter
are drawn by the same TUI, so a pane showing the box and no counter has no turn
running, whether or not one has ever been seen. The tab is neutral and nothing is
announced. It is read fresh every poll: a session that ran an agent and dropped
back to a shell is a shell now.

**`ActivityAsking` outranks both and waits for nothing.** A menu on screen is the
only state about the person holding the phone, so it beats working and done, it
needs no change to the screen, and it survives the idle threshold. The tab goes
blue with a yellow `!` centred on its top edge, half of it above the tab — the
mark may break the row's outline because the question is the one thing here that
needs a person. Same keyframes as working, so speed and per-tab phase cannot
drift. It is the same detection the answer buttons are drawn from
(`detect.Question`), and those exist only for the session on screen while the
question you want to know about is usually in another.

**Every session is watched; only the ones a page has opened are announced.**
Those were one thing, so a session was not watched until a page attached — and
after a deploy every tab went neutral and stayed there, the watcher's state being
per process and CI installing a new binary several times a day. Found by reading
`/api/sessions` and seeing no `state` on a session that was visibly working.
`Options.Sessions` is the roster, swept every tick, and `observe` adds what it
finds; `Watch` — the attach path — is the only thing that sets `notify`. Sessions
leave the same way: a `capture-pane` that fails removes one.

**Green expires after ten minutes** (`doneFresh`). Green means gone quiet *after
doing something*, which is news while recent and nothing once old — a distinction
that used to come for free when a session was watched only from the moment a page
attached. Reading everything from the start turned every session that had ever
run green for good: "only now everything is green", a strip that has stopped
saying anything. Stale goes back to neutral, which already means "quiet for
hours". The badge does not fade with it: what is still running is a fact about
now.

The page polls every 3s, only while the terminal is on screen and the page is in
front, plus a `visibilitychange` refresh — coming back is when the answer is most
out of date. The purple sweeps over 4.2s and `alternate`, with a per-tab phase
from the session name (`workingPhase`); it was 1.4s one-way with every tab in
step, which read as one decoration flickering along the strip.

The state rides in the session list (`state` on each entry, filled from
`Presence.Activity`) rather than in an endpoint of its own: a name and its state
fetched separately can disagree, and the disagreement shows as the wrong tab lit
up. tmux never fills that field. The `!`'s upper half lives in `#tabs`'
`padding-top`, given back by an equal negative margin — the strip clips both
axes, and a taller strip would move `☰` down, the drawer's `❮` being measured
against it.

**The fill answers what the agent is saying; a fourth question is what it left
running.** `watch.Background` reads the shells and monitors off the agent's own
footer (`detect.ReadBackground`, on the same poll as the colour) and the tab
carries how many in its bottom-right corner — in the corner rather than after the
name because the row scrolls sideways and the names are what is worth reading
along it. A session at "done" with two monitors alive is not one with nothing
left, and the colour cannot say so.

**One plate per kind.** The sum answered "is anything still running" and refused
every follow-up: a shell is something started and forgotten, a monitor something
still watching for an answer, and `3` said neither. The argument for summing was
that two glyphs in a corner that size are a smudge; the owner, who reads the
strip, says otherwise. The plate carries a number, and shape and colour say which
kind: the monitor keeps the heraldic shield (`clip-path`: flat top, pointed
bottom), the shell is a triangle pointing right — the same `▸` the strip gives a
shell session; cyan for shells, green for monitors, green being the strip's own
"gone quiet after doing something". Both began with a glyph in front of the
number and neither kept it: two of them at 9px in a corner 20px wide were exactly
the smudge. A triangle is tallest down its left edge, so the room goes to the
digit.

**On a tab they hang off the edge, one above the other** — side by side they cost
the name twice the width. Each hangs a third of itself past the tab, out to the
right and over the top (triangle) or under the bottom (shield), because two
plates inside a tab 34px tall crowd each other and the name. The triangle is as
wide as it is tall: drawn longer, its point read as an arrow leaving. The room is
`#tabs`' own padding given back by a negative margin, the same trick as the `!`
above. The drawer's rows keep them side by side, a row being three times as tall.
They are pseudo-elements of a `.bg` span (`data-sh`, `data-mon`), the button's
own `::before` being the `!`; `data-bg` counts the plates rather than the
processes, which is what the corner reserves room for.

Only the footer counts, and only its lowest line with a number in it. The same
words appear in the line an agent prints when a turn ends ("Cogitated for 2m 23s
· 1 shell, 1 monitor still running"), which was true when printed and says
nothing about now — skipped by its wording, and output scrolled above the last
few lines is out of range by position.

**The top edge says who is running for it.** A subagent is not a background
process: it is another agent with its own turn, and the session is waiting on it.
Claude Code lists them under its status lines (`● main`, then a `◯` per subagent),
and the tab carries **one head per agent on its top edge**, right-aligned with the
name, the mirror of the plates below. No number — two heads are seen where a `2`
has to be read — and four is the cap. What they claim is what the agent's own list
claims: an agent that has finished but not been collected is still on that list.
`detect.ReadAgents` needs the block's own `● main` above the circles, so an answer
that happens to use `◯` grows no heads. **The block is footer**, and counting it as
content cost the plates their line: it sits below the status lines and is as tall
as the session has subagents, so with three of them "1 shell, 2 monitors" fell out
of the four-line window. `ReadBackground` steps over it.

**The drawer says all of it too, in the strip's own colours** — the same three
states, keyframes, duration and per-session phase, the same CSS for the shapes and
glyphs, differing only in size and padding: the sweep runs the row's width, the `!`
straddles its top edge at the left, the plates stand in its bottom-right corner one
size larger. A row and a tab describing one session differently is worse than
either saying nothing. Two things keep it honest: the rows are painted, never
rebuilt (`paintRows`, which here also protects the armed `✕`), and **the poll runs
while the drawer is open** — with nothing attached the drawer is all there is.

**The mark is a cell of its own beside the name, never inside it.** `.name` is the
session's name and nothing else — the page reads it back to attach, rename and
close — and a glyph spliced into it produced a session called
`⭐pockterm-ui-oWck6x` that tmux had never heard of.

## The answer row presses what the menu says it takes

The row is drawn over the pane's last rows (see the flow rule at the top; the same
shrinking is why a *waiting* session read as finished on the strip — the watcher
reads the very same pane, and while the menu was out of it there was no question
to see). A swipe on the row scrolls the row: six options with labels are taller
than the room it has, and `ownsGesture` gives it its own gesture.

`detectQuestion` reports `navigate` (`digits` or `arrows`, read off the footer
line) and `cursor` (which option carries the `❯`); `answerKeys` turns the two into
bytes. The count of arrow presses starts from where the pointer **is** — a menu
already navigated sits somewhere else — and no pointer means no honest count and
therefore no button. `internal/detect` parses neither field: it renders
notifications, and a notification presses nothing.

**Not a digit.** "Type the digit and press Enter" was the rule from the beginning
and it is an assumption about every menu that looks like one. It holds for a
permission prompt and is false for the question with a description under each
answer, which lists its keys underneath — `Enter to select · ↑/↓ to navigate · Esc
to cancel`, digits not among them: the digit fell on the floor and the Enter took
whatever was highlighted, so **every button answered option 1**.

**The walk and the Enter are two writes, because in one they answer option one.**
Sent as a single write, `↓↓↓\r` is applied by the menu against the position it had
*before* the arrows — measured on a real `AskUserQuestion` at 51 columns: three
arrows alone move the pointer to the fourth option, the same three with an Enter
attached answer the first, and so does a single `↓` with one. Reported as "Chat
about this and Type something do not work", which is what the two options at the
bottom look like when they quietly pick the top one.

So `answerKeys` returns `{move, commit}` apart and `pressAnswer` in `js/app.js`
sends the walk, **waits until it can see the pointer arrive** — the same detector
the row is drawn from, polled for up to a second — and only then the Enter. A
pointer that never arrives means nothing is pressed at all, with a line in the
journal and a word on screen.

**A menu scrolls its own list, and reading an option by its place lost it twice.**
`AskUserQuestion` keeps its pointer in view by scrolling the options under it, so
at 51 columns walking down to the fourth answer pushes the first two off the top:
what is left is a run beginning at `3.`, and a run had to begin at `1.` to be a
menu at all — the row went away at the moment it was tapped. Then the press
compared the cursor's index with the index the button carried, and after a scroll
those are two different rows. So a run may start at any number; the leading 1 was
never what kept prose out (that is the chrome and the indentation rule in
`continues`), and the number now only has to be one past the option before it. The
press follows the option rather than the row: it finds it by label in a fresh
scan and watches for the pointer by **the option's own number**, the one thing a
scroll does not change. The prompt is checked too, every one of these menus
carrying a "Type something." and a "Chat about this".

What a scrolled menu costs is its prompt: the question is off screen with the
options, so `prompt` is whatever line sits above the run — a fragment of the
previous option's description. A notification then names the fragment, which is
worse than the question and much better than the silence it replaced.
`test/fixtures/menus.json` carries the real scrolled pane.

**The press reads the screen again instead of trusting the row.** The row is drawn
from an older scan and a menu is painted a line at a time: one built before its
footer had arrived carries *digits*. That window is a tenth of a second and it is
the same wrong answer as everything else here. Between the two scans the pointer
can also have moved or the menu been replaced, so the press checks the option
still has the label the button was drawn with.

**A menu's options do not have to be adjacent, and requiring it found nothing.**
The rule was a run of lines numbered 1,2,3 with nothing between — a permission
prompt exactly and an `AskUserQuestion` not at all, that one drawing a description
under every answer and a rule before "chat about this". The run broke at the first
option, so no menu was found and the tab stayed neutral in front of a screen full
of question. A numbered line now continues the run when everything between it and
the previous option belongs to that option: blank, box glyphs only, or **indented
past the column the numbers sit in**. That indentation tells a description from a
paragraph, and it is measured in columns rather than bytes — the descriptions are
in whatever language the prompt is, and one Cyrillic letter is two bytes against a
box glyph's three.

**But the rule across the menu is where the list ends**, not something between two
options. Swallowed as chrome it drew a fifth button for the one option the arrows
cannot reach: `AskUserQuestion` puts `Chat about this` below that rule, outside the
ring its arrows walk. Measured 2026-08-10 on a five-option menu — tapping the last
button sent four downs and the pointer came back to option **1**, twice:
`{"want":4,"key":"5","from":0,"on":"1","moved":false}`. A ring of four. Not the
press being wrong: the walk went out, the pointer was watched, it never arrived and
nothing was sent, so the cost was a toast rather than a wrong answer.

An empty row inside a border stays chrome (`│      │` pads a boxed prompt). What
ends the run is a horizontal line with nothing else on it, which is why `RULE` is
deliberately blind to the border glyphs.

**An offer is not a menu, and the page reads both.** A TUI menu carries chrome — a
pointer, a box — and that chrome is the whole defence against reading a numbered
list in prose as something to press. But an agent that has finished its turn and
written "Что делаем? 1. … 2. …" is asking a question too. `detectOffer` requires
four things, each removing a way to be wrong: the agent's input box is on screen
and **empty**; the list is inside the agent's last message (below the last `●`);
that message **ends in a question**, a list of what was done not being an offer;
and the numbers run 1,2,3… in order, at least two of them. The button types the
number and presses Enter, which is what the owner would have done. `detectPrompt`
asks the strict question first. This lives on the page alone — `internal/detect`
does not read offers, so the tab's blue and the "asks for an answer" notice keep
meaning a menu is on screen; otherwise an agent that ends every second answer with
a list would have a phone buzzing about its prose.

**And the agent's own input box is not a menu, though it is drawn like one.** It
carries the very same `❯`, and under it is whatever is being typed: a message
beginning "1. …" newline "2. …" drew two answer buttons before it had been sent,
and pressing one would have submitted the half-written message with a digit on the
end. What tells the two apart took a capture: the composer draws a **non-breaking**
space after the glyph, a menu pointer an ordinary one. That is also what made the
indentation rule miss it — `indentOf` counted the non-breaking space as text, so
the option line measured one column shallower than the lines wrapped under it,
exactly the shape of an option with a description. Both halves are fixed and either
would do alone (`indentOf` counts it as a space; `composerPrompt`/`detect.InputBox`
bring no chrome). Measured on v2.1.222 at 51 columns off two real panes — the box
with a list in it, and `/model`, a real menu still detected — and both are in the
shared fixtures.

## `Type something.` is a field, not an answer, and an Enter on it is a refusal

For two releases this was read as a feature: the button presses it correctly, the
menu closes, the tool comes back cancelled. Reported 2026-08-17 — *the button sends
a refusal, `user declined to answer`* — and the reading was wrong.

That line is **not an option**. `AskUserQuestion` puts a text input in its own list
and the pane shows its **placeholder**:
`{type:"input",value:"__other__",label:"Other",placeholder:"Type something."}` in
Claude Code 2.1.233, with `Type something` (no dot) when the question takes several
answers. Selecting it hands the keyboard to that field; Enter submits what has been
typed, and at the moment a button is tapped the field is empty — an empty
`__other__` reaches the agent as "User declined to answer questions". Nothing was
broken in the press (`{"want":3,"key":"4","on":"4","moved":true}` from that tap).

So this is the one option with **no commit**: `answerKeys` returns the walk and an
empty string, `pressAnswer` stops when the pointer arrives, and `openForTyping`
puts the keyboard where the answer can be written — the composer when that bar is
on screen (an ordinary field, which is what dictation wants, its `▶` sending the
text with the Enter behind it), the terminal otherwise. The bar it finds is the bar
it uses: switching to the composer here would rewrite a remembered choice
(`pt-bar`) as a side effect of answering a question. The button is drawn outlined
rather than filled, a thumb reading a row of identical buttons as a row of answers.

Two bounds. **The label is matched whole** (`TYPE_FIELD`) — a vocabulary rule,
which this file otherwise avoids, and there is no shape to read instead: the field
is drawn exactly like an option. And **a menu that has not yet said how it is
answered gets no button for the field**: digits are the assumption before the
footer arrives, and a digit cannot put the pointer on the field without taking what
is under it.

`test/ui/pockterm.test.mjs` reads it off the wire: the walk goes out, the pane
redraws with the pointer on the field, and the assertion is that **no `\r`
follows**. With the Enter put back it fails on that byte.

**The row cannot stay where the answer is being typed.** Reported within the hour
of the fix, typing into the field the button had just opened: the word came out
over three of the buttons. Nothing is mispositioned — xterm draws what is being
composed at the cursor, inside the pane, and a menu's own text field puts that
cursor in the very rows `#answers` covers. So what moves is the row's visibility:
off screen while a composition is open, back when it is over. Composition state is
asked of `fieldHygiene`'s `onCompose`; `paintAnswers` is the only owner of
`hidden`, with `answersDrawn` saying whether there is a row at all — a row hidden
because a word is being written has to come back, one never drawn must not. The
stand can judge this one: the composition is faked at xterm's own field and what is
asserted is the page's geometry, both halves.

**Only that field asks for a keyboard — the answers must not.** Reported the day
after: a tap on any button brought the keyboard up over the menu it was answering.
Two paths did it, either enough alone: the handler called `term.focus()` after every
press, and the row lives inside `#term`, whose click handler hands focus back to the
terminal for anything not named there (the pager and the scrollbar were named, the
answer row and the control pad were not — and the pad exists for a screen with *no*
keyboard on it). So a button takes no focus (`keepsTerminalFocus`), which also
leaves the keyboard up for whoever is typing into the field.

Taking no focus was half of it. The terminal's field keeps the focus from whenever
it was last typed into, and answering a menu moves the layout by definition — so an
answer **gives the focus up** (`releaseFocus`, which also releases the pressed
button, since a browser ignoring `keepsTerminalFocus` leaves focus on a button the
row rebuilds away a frame later). And the field's own button has to **ask inside the
touch** (`askKeyboard`, `openForTyping` called from the click rather than after the
pointer arrives): Android gives a keyboard to a focus taken inside the gesture and
to no other, and focusing what is already focused raises nothing. That it worked
before was the blanket `term.focus()` doing it by accident. A menu that changed in
between costs a keyboard nobody wanted, which is cheaper than the one button
*about* typing opening nothing. `askKeyboard`'s blur is safe here only because the
row is off screen while a word is being composed.

The tests assert the lever rather than the symptom, three halves of it: an answer
and Esc leave the focus alone from nothing, an answer gives it up when typing left
it there (keyboard played by the viewport, waited for on `data-kb`), and the field
takes it — counted as focus *events*, taking a focus already held being exactly the
case that raises nothing. Each was checked against its own defect.

## A question that takes several answers is toggled, not answered

`AskUserQuestion` has a second shape the page could not see at all: the one that
takes several answers draws a checkbox after every number (`1. [ ] …`, `[✔]` once
chosen), a `Submit` entry under the last option, and — this is what hid it — **its
descriptions at the very column the numbers sit in**. Reported as the buttons
having disappeared, in front of a menu six options long.

Nothing was wrong with the page: `continues` requires a continuation to be set
*past* the column of its number, which is the defence against reading prose as a
menu and is exactly true of the single-answer variant. The checkbox buys the
exception (`flush` in both detectors): it is a widget rather than prose, and a
paragraph back at the margin is still not a description — the fixture with one
under a pointer holds this to `<` rather than `<=`. Both implementations changed,
a notification and a row of buttons disagreeing being what the shared fixtures
exist to prevent.

**The box comes off the label**, which is not cosmetic: the label is what
everything here compares, and `[ ] Type something` is not `Type something` — the
menu's own field stopped being recognised as one, which is yesterday's refusal in
a shape nothing was watching for. The state travels beside the label (`checked`,
absent rather than false when a menu has no boxes) and the button carries it as
`☐`/`☑`, because **Enter on one of these toggles it**: measured off the owner's own
answering session, `[ ]` became `[✔]` and the list stayed up.

**`Submit` had no button, so the row could set an answer without ever giving it.**
Where that unnumbered row sits in the ring the arrows walk was unmeasured, and this
file has paid for a guess about that ring once already. It is measured now, off the
binary rather than off a pane: in Claude Code 2.1.234 the multi-select list draws
the row from `submitButtonText` — `Submit` on the last question of a set, `Next`
before it, which is why both words are read — and its key handling puts it **one `↓`
past the last option**, with `↑` coming back and a further `↓` going on to `Chat
about this` below the rule. Enter on an option toggles; Enter on that row ends the
question.

**The walk steps rather than counting.** The page sees a window, not a list — the
widget scrolls its options to keep the pointer in view — so how far the pointer is
from the end is not on screen. A batch that fell short leaves the pointer on an
option, where Enter ticks a box and reports the question answered; one that
overshot lands on `Chat about this`. So `submitKeys` hands back one `↓` at a time
and `pressSubmit` reads the screen between them, which also ends the walk when the
menu is gone. Three things that were each a way to be wrong:

- **The pointer standing on that row is chrome for the list above it.** All the
  chrome these panes carry is the pointer itself, so a walk that reached the submit
  row took it off every option and the run read as prose: the buttons went away one
  step from being pressed. The exception is narrow — a list of checkboxes with a `❯`
  on a `Submit` of its own is a widget, and prose does not draw one.
- **A step hands back the screen it settled on**, the pointer arriving on the next
  option before the row below it is repainted; a step that re-read then found no row
  and called the menu gone.
- **The prompt says which menu this is, and it is asked once.** A scrolling list
  changes the line the prompt is read from, so asking every step would abort the
  walk halfway down exactly the menu stepping exists for. What holds afterwards is
  the pointer's own number, which only goes up while one list is walked down.

The button is drawn green rather than in the row's accent, a row of identical
buttons reading as a row of answers. `test/ui/pockterm.test.mjs` reads it off the
wire: `↓`, `↓`, and the `\r` only on the screen showing the pointer on the row,
checked against the naive one-write walk. Both panes are in
`test/fixtures/menus.json`, captured at 51 columns: the fresh menu, and the same
question part-answered — two boxes ticked, the pointer moved, the list scrolled past
its own first option, which is three of this file's lessons in one screen.

## The row is the owner's, and a held tab is carried

tmux orders sessions by name, which is the one order nobody chose: the strip is read
dozens of times a day, and the session you keep coming back to is not the one whose
name sorts first.

**The gesture is the press that already existed.** A hold picks the tab up — and
puts the plate under it, which is what the hold used to be for — travel then
rearranges the row, and a press that does not travel is still the question about the
mark. Not a plain drag: that scrolls the strip, which a row wider than the screen
needs. The one non-passive listener here is that `touchmove`, because while a tab is
carried the browser must not take the gesture as its own sideways scroll.

**Where the tab goes is the finger's x, and reading the y as well is what broke
it.** The first version asked `elementFromPoint` what was under the finger, which
needs the finger to stay inside a strip 34px tall at the top edge of the screen; a
thumb travelling sideways arcs out of it within a centimetre, the point lands on the
terminal, and the row stops rearranging while the gesture is plainly still going.
`dropIndex` in `web/js/carry.js` counts how many of the other tabs the finger is past
the middle of, and there is no y to pass it — there is one row and no second place to
drop a tab.

**And the hand holding the tab covers it** — "под пальцем не видно". Two answers,
both about what sticks out around a thumb: the lift is a ring in the accent colour
rather than a shade (a shade is only readable on the part that is hidden), and the
plate stays — the same `#kind-help` that answers what a mark means, now saying which
session is in hand and following it along the row, dropped `CARRY_DROP` (44px) below
the strip rather than the 4px the question's plate uses. One element, two claims, so
it carries `carrying` while making the second and the question's timer is cleared: a
carry lasts as long as it lasts.

**A mouse carries a tab by a plain drag, and needs no hold.** Every listener here
was for touches, so on a laptop the row could not be rearranged at all. The hold is
not copied over — it buys the gesture back from the strip's sideways scroll, and a
mouse scrolls that with a wheel; five pixels of travel is what tells a drag from the
click that switches session. `carryTo` and `dropCarry` are shared, and
`mousemove`/`mouseup` are on the document for the same reason the y is not read.
A release ends in a click on whatever is under it, so the drag sets `helpHeld`, the
same thing that swallows the click at the end of a hold. **A touch leaves mouse
events behind it, and those are not a mouse**: they arrive after `touchend` and
would clear that suppression, turning "what is this tab" into a switch to it —
anything within 700ms of a touch on the strip is ignored.

**The order lives in tmux, on the sessions themselves** (`@pockterm-order`, beside
`@pockterm-kind`), for the three reasons the kind does: CI restarts this binary
several times a working day, a second phone must see the same row, and a closed
session takes its slot with it instead of leaving a hole. `SortByOrder` puts the
placed ones first and leaves everything else where tmux had it, so a session started
after the last drag lands at the end rather than in the middle of a row somebody
arranged. The sort is applied where the list is served, not in the page, or the
drawer and the strip would disagree.

The page sends **names, not indices** (`/api/sessions/order`) and the server stamps
each with its place: a session closed between the drag and the save is simply not
found, and the row is redrawn from tmux on the next poll anyway. Every name is
checked against the list the server just produced, the value reaching a tmux command
line. `saveTabOrder` writes the new signature itself, `renderTabs` refusing to
rebuild while a tab is carried.

**And a row three screens wide has to scroll itself to where you were sent.** Which
tab is current is said by a frame around it, and a frame off screen says nothing —
reported after following a notification, which is the one switch nobody's finger was
on the strip for: the page attached to the session the notice named and the row stayed
wherever it had been left. `showCurrentTab` centres it, and three things bound it. It
**yields to the finger** — never while a tab is carried, while a press is asking what
a mark means, or within 700ms of a touch on the strip, a flick being a scroll somebody
chose. It moves **only when the current tab changed** (`tabShown`) and only when the
tab is not already whole on screen, a strip that jumps when it did not have to being
worse than one that stays put. And the tap is asked **even when there is nothing to
switch to**: half the taps in the journal name the session already on screen, so the
switch that used to do the scrolling never happened.

## A tab also says what it is, and that is a different question

Colour says what a session is doing; **form says what it is**. A tab carries the
glyph of the button that started it, before the name — `▸` shell, `❄️` claude,
`⚡` yolo, `↻` continue, `★` for one the owner added — and the drawer names that
button in the row's meta line. The glyphs are the `+` menu's own, so there is
nothing to learn. One vocabulary (`web/js/kinds.js`), shared by the menu, the strip
and the drawer.

The question exists because **the name stopped being able to answer it**: sessions
are named after the folder they were started in, so `natal` and `natal-2` are one
project opened two different ways, and which is the yolo one was nowhere on screen.

The drawer's row carries two more facts, both replacing `1 window` — a constant, the
Makefile creating one window and the page having no window switcher. What is there
now varies: **where the pane actually is** (`pane_current_path` through
`session.ShortDir`; the name says where the session was *opened*, and one opened in
`~/work` spent an afternoon in `~/work/self` with nothing saying so) and **how long
it has been up** (`shortAge`, one coarse unit). The path is shortened on the server,
the paths it is measured against being the host's: `/api/dirs` tells the page what
the root is *called*, never where it is.

**tmux keeps the fact, and the Makefile writes it there.** The server passes `KIND=`
beside `DIR=` and `PREFIX=`, the Makefile stamps it as a user option
(`@pockterm-kind`), and the server reads it back in the same `list-sessions` that
fetches the row — so a name and its type cannot be fetched separately and disagree.
Through the Makefile for the same reason `PREFIX` goes that way: only it knows which
number came out free. Three things follow from where it is kept: it survives a
rename, it survives this binary's restarts, and there is no register of the server's
own to drift out of step with tmux.

`session.Kind` is the gate — the value reaches a make command line and then a tmux
command inside the recipe — and what may pass is a known preset's name or
`custom:<id>` of a button that exists, **by id and not by label**, so renaming keeps
the sessions it started; an id the store no longer has draws the shared `★` and no
name rather than guessing.

**Make's own variables do not travel into the session.** A variable given on a make
command line is exported to the recipe *and* carried in `MAKEFLAGS`, so every session
the page started held `PREFIX`, `DIR`, `KIND` and `CMD` in its environment, and a
`make` typed by hand inside it inherited them: `make custom CMD=qwen` came out named
after the folder of the session it was run from and stamped with the button that had
started *that* one. **The cleaning goes on the pane's command**, and the obvious
placement does nothing: `env -u … tmux new-session …` changes the environment of the
tmux *client*, while the pane is started by the *server*, running since the first
session. That version was written, shipped and then measured — the variables were
still there. What works is wrapping the command the pane runs (`clean="env -u …";
cmd=$(1)`, the pane getting `"$clean $cmd"`), tmux handing that string to `sh`, which
honours the quoting the callers already use. `-e VAR=` on `new-session` reaches the
pane but only empties the variables, and an empty `DIR` is worse than an inherited
one (`DIR ?= $(CURDIR)` keeps the empty value).
`TestExampleMakefileKeepsMakesVariablesOutOfTheSession` reads the `spawn` definition
rather than the file, a mention in a comment not being a variable unset, and the UI
test reads `/proc/<pane_pid>/environ` of a session the page started — which is what
caught the placement being wrong.

**No `=` before the name in `set-option`.** That prefix means "exact match" to the
commands that take a session (`rename-session`, `kill-session` use it here), and
`set-option` reads its `-t` as a pane instead: it answers `no such session: =claude`
and the stamp silently never lands. `TestExampleMakefileStampsTheKind` refuses the
form outright.

A session nobody stamped says nothing and the page draws nothing. The one exception
is coarse on purpose: `tmuxcmd.KindFromStart` reads `#{pane_start_command}` and
answers **"shell" or nothing** — which button ran `agent-run
--dangerously-skip-permissions` is the Makefile's knowledge and this program refuses
to hold it. It never overrules a stamp.

**The mark is picked from a grid**, which replaced a trick: the way to give a button
a glyph was to type an emoji at the front of its label, something you had to know and
a character out of a name that has 24. `MARKS` in `web/js/kinds.js` is the vocabulary
— curated rather than a keyboard, the glyph being read at 13px — and the picker is a
popup grid beside the label field, mark and label being the pair a button is named
by. Picking the glyph already chosen clears it.

Four things about it were wrong on the first devices that saw it, and each is a rule:
**the grid opens under the button that opens it** (it was appended at the end of the
panel, a screen away from a 44px target); **that button had been drawn as a full-width
bar**, `#buttons-box .add button` styling the Add button and an id selector losing to
it — `#buttons-box .add #custom-mark` is what wins; **nothing in the picker may move
the focus** (`keepsTerminalFocus` on the button and every glyph), hiding the grid
hiding the element that has focus; and **the mark has to share its line with the
name** — every input in this form is `flex: 1 1 100%`, so the name wrapped to the next
row and left the mark button belonging to nothing, until `#buttons-box .add
#custom-label` gave that field `auto`. The field is labelled `название`, since what it
holds is the button's own name.

**The form shows the glyph the button will be drawn with, not the one that was
picked.** Nothing picked is the common case, and a `⭐` on the form while the row two
lines up shows `❄️` describes the form's own state instead of what is being edited —
"сейчас там звезда всегда". `paintMarkButton` asks `markOf` the same question the row
and the tab ask, and follows the label as it is typed. The button is only *lit* for a
glyph actually chosen — a different claim, and the grid's highlight is where it
belongs.

**U+FE0F asks for the colour form and does not get it on its own.** The marks were
stored and drawn with the selector and still came out monochrome on the tabs and in
the `+` menu, while the drawer's list — heavier weight, larger size — reached the
colour font: two answers for one glyph. `font-family: system-ui` resolves to a font
that has a *text* glyph for `❄` and `☀`, and a font that has the glyph is where the
lookup stops. So the mark lives in a `.kind` cell on every surface, and that cell puts
the colour fonts first (`Noto Color Emoji`, `Apple Color Emoji`, `Segoe UI Emoji`) and
asks outright with `font-variant-emoji: emoji`. Both halves are needed: the property
is recent, and the stack alone still loses to a text glyph in a font listed ahead of
it. The monochrome-only marks (`▸ ✦ ↻ ⬡`) are untouched. Two things follow from the
cell: the tab's mark is no longer dimmed (`opacity: 0.7` on a coloured glyph reads as
a washed-out label), and the gap between mark and label is a margin on the cell rather
than a space in the text — `assert.match(text, /⚡ Ярость/)` had to become
`/⚡\s?Ярость/`.

The glyphs carry U+FE0F where they have a colour form (`❄️`, not `❄`): in text
presentation a mark takes the colour of whatever it sits in, so on a tab it came out
the same shade as the name. `markOf` is the one order of precedence and every surface
goes through it — the mark that was picked, then a mark the label leads with, then
what the id is known for (a default's own glyph, or the name of an agent this
recognises), then the shared `★`. `kindMark` answers a tab by looking the button up
and calling the same function. Two names are guessed at and no more: **Claude is
cold, Codex is sol** (`❄`, `☀`, the owner's own vocabulary), and one tap in the grid
overrules either. The mark lives in a span of its own, never in the label — the kind
arrives on a later poll than the name.

**A long press asks what a glyph means.** There is no hover on a phone and the mark is
too small to be a target, so the press that would switch session holds instead and a
plate appears under the tab with the mark and the button's name — under it, the strip
*being* the top edge of the screen. It cancels if the finger travels, and it swallows
the click it ends in. The UI test drives it through the browser's own touch input
(CDP `Input.dispatchTouchEvent`), only a real press producing the click that has to be
swallowed.

## A session is started in a folder, and named after it

The drawer has two lists and shows one at a time: the sessions, and the folders of the
projects root (`/api/dirs`, one level deep, no dotted directories). The root is the
first row and by its own name — a label like "the root" hides which directory that is.
Tapping a folder starts nothing; it points the buttons at that folder, which is the
only menu there is, because two would drift.

`POCKTERM_SESSION_DIR` is both the Makefile's directory and the projects root. One
setting rather than two: the second would have to be kept in step with the first.

**The name is still the Makefile's to choose.** The server passes `DIR=` and `PREFIX=`
and nothing else; which number is free as *both* a session and a group name stays in
the one place that knows (see the trap below). `session.Prefix` only decides what to
number: the folder, sanitised to what tmux and a phone tab can carry (no `.` or `:`,
24 characters), and the root's own basename for the root. An empty result passes no
`PREFIX` at all, leaving the Makefile's default rather than inventing a session called
`-`. A Makefile that knows neither variable still works, make taking an override for a
variable it never reads — which matters because the host's Makefile is a template in
the `pockterm_app` ansible role, so the folder reaches the tab only once that role has
been applied.

`session.ResolveDir` is a gate, not a formality: the value becomes make's `DIR=`, and
the page may only name one plain folder inside the root. `..`, a separator, a leading
dot and an absolute path are refused, and the reason travels back as text.

**`pockterm-` was too wide a namespace to reserve.** Client sessions are
`pockterm-client-<id>` since 2026-08-04, because sessions are named after folders now
and `~/work/pockterm` is a folder: its second session is `pockterm-2`, which the old
prefix hid from the list and made unattachable. Worse, ids count from 1 per process,
so that name is one of the first two a page takes for itself — and `new-session -A -s
pockterm-2` would have attached the phone to the user's own session.

## A session name can be a group in disguise

tmux names a session group after the session it was created from and never renames it.
Rename that session and the old name lives on as a group — and `new-session -t <name>`,
which is how every client attaches, resolves a group before a session of the same name.
Hand the freed name to another session and its tab opens the first session's window.

This is not cosmetic: attaching merges the two sessions into one group permanently.
Renaming out of it does not separate them, and `move-window` out of the group destroys
the other session's windows. The only way out is to close one of the pair.
`tmuxcmd.NameConflict` refuses such a name at the rename endpoint, and the session
Makefile picks numbers free as both a session and a group name. Both guards exist
because the trap is invisible from the page: two tabs, one window, and nothing saying
why.

## The session list is a drawer, not a screen

It was a screen of its own, and switching to it tore the terminal down: the socket
closed, `term.reset()` ran, and coming back redrew from tmux. The list is what you open
to see what else is running, so what is running has to survive it.

`#screen-sessions` is a fixed panel over the terminal, off-screen by a transform rather
than by `hidden` — a transform animates and leaves the terminal untouched, where
`display: none` would reflow it. `☰` toggles it, `✕` sits where `☰` is, and a tap on the
scrim closes it. The tab strip is the same list in miniature, so it carries the same `+`
with the same handler.

**A swipe to the left closes it**, which is where the panel goes anyway. It closes once
the drag is unmistakably horizontal and past 45px; nothing follows the finger, the
transition already covering the distance. Two other drags must not trigger it, and both
were the reason for the guard: the list scrolls vertically under the same finger, and
the rename field drags a caret sideways.

**And a swipe to the right over the terminal brings it back.** ☰ is at the top edge and
the thumb is at the bottom, so the way in cost a reach the way out did not. It rides on
the terminal's own gesture, the two sharing a finger: the drawer takes the swipe only
when it is unmistakably sideways (past `DRAWER_SWIPE` and further across than down), and
takes it whole — `scroller.cancel` ends the swipe the way a browser stealing it does,
with no glide, or the terminal would go on scrolling behind an open drawer. Where a
swipe was never the terminal's (the composer, the frozen copy, the header, the answer
row) it is not the drawer's either. That cancel is why the gesture report grew a `by`:
the journal counts cancelled gestures to tell a fact of the platform from a defect, and
folding the page's own swipes into that number would spoil the measurement.

**Closing the tab you are in steps back to the one you came from.** It used to land on
the modal drawer whatever else was running, reported as the interface sticking: the tab
under the finger was gone and its place was no longer anything to tap. `visited` is the
order tabs were attached in and `stepBackFrom` walks it, skipping names tmux no longer
has; the tab beside the closed one is the fallback, and the drawer is what is left when
nothing is running at all.

**With nothing attached the drawer is modal.** The terminal screen is hidden then and
`☰` lives in its header, so a drawer that could still be dismissed left a black page
with nothing to tap and no way back but a reload. `❮` and the scrim are gone in that
state rather than inert: an exit that does nothing is worse than no exit. The swipe
goes through `closeDrawer`, which refuses then, rather than checking for itself.

**A touch aimed at the terminal must wait for the drawer to be gone.** The panel slides
out over 200ms; `stand.attach()` waited only for the terminal to appear, so a gesture
dispatched right after it landed on a `<ul>` in the drawer and the test timed out
waiting for a move nobody received. Latent while the page was quick enough, it started
failing when the drawer grew four rows — a change to the timing, not to the page.
`attach()` waits on the geometry too, and anything in the tests that clicks a session
opens the drawer **by its state**: `☰` toggles, and the restore of the last session
happens after load, so a blind tap raced it (two suites failed that way about one run
in three before `startStand` grew `openDrawer`).

## The settings are in the drawer, and the ⋯ menu is gone

Text size, the notification switch, `〰 smooth`, the keyboard mode, the input log, the
version line and Install used to sit behind `⋯` over the terminal. That is the surface
you work on: levers touched once a month were taking permanent space from the one place
where every tap matters. So they moved, **and they moved rather than being copied** —
two places holding one lever is how the two drift — and the `⋯` button went with them.

`#settings` is a panel at the bottom of the drawer with the toggle pinned under it, so
opening the drawer never costs the settings a scroll and a long list of custom buttons
cannot push the toggle off screen. `closeDrawer` collapses it, for the same reason it
closes the rename field.

**A pull down inside the panel closes it** — it opens upward from the row at the bottom,
so dragging it back down says what the animation shows. It counts only from the top of
the panel (`scrollTop <= 0`) and only when the drag is mostly vertical, the panel
scrolling under the same finger. **A pull up anywhere in the drawer opens it**, and the
bound there is the scroll rather than the place: whatever is under the finger keeps the
gesture while it still has somewhere to go down, asked of the ancestors rather than of
one list. A short list has nowhere to go, which is the common case and the one that
reads as "anywhere".

**The click the gesture ends in is not a tap**, and widening the gesture widened that
too: from anywhere it lands on whatever the finger came down on, and what is in there is
sessions — a pull up over the list would open the settings and switch session on the
way. It is caught on the drawer in the capture phase, and the suppression is cleared at
the next touch rather than by the click it is waiting for: a browser that decides a 45px
drag was a scroll sends no click at all, and a flag left set would eat the next honest
tap.

**Collapsing it is not the same as closing it**, and for one version it was. Open or
closed is remembered (`pt-settings-open`), and the drawer collapsing the panel on the
way out wrote "closed" down every time, so it had to be reopened on every visit.
`showSettings` is the owner's answer and records it; `paintSettings` only draws,
`collapseSettings` is what the drawer calls, `openDrawer` paints what was last answered.
A preference must not be overwritten by the mechanics of the thing it is a preference
about.

`▾ hide the bars` stayed in the key bar: a one-tap action on the working surface, not a
setting, and its way back (`▴`) is the only thing on screen when everything is hidden.
Anything in the tests that pulls a lever goes through `startStand`'s `openSettings` and
`shutDrawer`, both by state — and `shutDrawer` waits on the panel's geometry, not its
class.

## A custom button carries a command, and the Makefile still launches it

The presets are make targets, and the rule they were built on holds: the page sends a
name, and the Makefile is the only thing that knows what a session is — the sandbox
wrapper, a free number, its own systemd scope. What the four could not answer is a fifth
agent: `qwen` or `opencode` meant editing a Makefile that on the host this serves is an
ansible template, so a laptop, a deploy and a working day stood between wanting it on
the phone and having it.

So a custom button **parameterises one target instead of adding its own**:
`session.CustomTarget` (`custom`) takes the command in `CMD=`, and the recipe wraps it in
the same launcher as everything else. A Makefile without that target fails with make's
own message, which the drawer shows as text.

`session.ValidCustom` is a gate: the value reaches a make command line and make hands it
to a shell inside the recipe, single-quoted. Letters, digits, spaces and `- _ . / = : ,
@ +`, starting with a letter, a digit or a path — nothing that can end that quoting or
start an expansion. A refusal travels back as the reason it was refused, there being no
log to open on a phone.

The list lives on the host (`POCKTERM_PRESETS_FILE`, next to the notification mode) for
the three reasons that switch does: what the buttons start happens on the host, a second
phone or a reinstalled PWA must find the same ones, and CI restarts this binary several
times a working day. Ids are the host's to hand out, and the page saves **the whole
list** and draws what came back — never what was just typed.

**A button may name a make target instead of carrying a command.** A Makefile has others
the presets do not cover — the author's own has `cont-yolo` — and reaching one meant
typing `make cont-yolo` into the command field, which runs make *inside* the session the
button just created: a second session appears beside it and the first one dies. So
`make <target>` in that field now means that target (`asMake`, `Custom.Target`), which is
also what the rows show for the defaults. `targetOK` is a narrower gate than `cmdOK`: a
name, no arguments, no path, nothing that reaches a shell.

**A button can be changed, and that is what the id was for.** `✎` on a row loads it into
the two fields the form already has and `Добавить` becomes `Сохранить`; the row being
edited is outlined, because with the label retyped nothing else on screen says which
button the fields are about, and the keyboard has by then put them a screen apart. One
form rather than a pair of fields per row, for the same reason the session list has one
rename field. Without it the way to fix a command was to remove the button and type it
again — the same button to look at, and a different id, so every session that button had
started would be left marked by a button that no longer exists, drawing the shared `★`
and no name. The edit sends the same list with the same id in place; `Buttons.Set` keeps
an id that arrives and hands out numbers only for entries without one.

**`✕` takes two taps, and the first is the question.** It took one, on the argument that
this removes a button rather than a running agent — and a stray thumb removed one with
nothing asked. The argument was about what a mistake costs, and the gesture is the wrong
place to encode that: the two lists look alike, live in the same drawer, and are hit the
same way, so a `✕` that asks in one and not in the other is a `✕` nobody reads before
pressing. `armTwice` is the one implementation both use, and the arming lapses after
`ARM_MS`. A second tap on `✎` cancels, and `closeDrawer` cancels too: a form still saying
`Сохранить` about a button chosen a day ago saves the wrong thing when it is finally
tapped. The UI test proves the id survives by reading `data-preset` off the menu entry
before and after.

## The four buttons are entries in the list, not a menu written into the page

They were a map in Go (`session.Presets`) and four `<button>`s in the HTML, and both were
the answer to "what can be started". That is two answers, and it showed the moment either
could change: a default renamed or removed was still in the menu, in its stock words,
starting what it always had.

So the stored list is the whole set. A default is an entry whose **id is a make target**
(`shell`, `claude`, `yolo`, `continue`) and whose command is empty, which is
`Custom.Builtin()` and the one case `ValidCustom` lets through without a command.
`DefaultButtons()` carries their labels, a label that can be renamed having to be stored
somewhere; the glyph stays in the page.

**Editing a default's command moves it onto the `custom` target and keeps its id**, so
`claude --model opus` is still `❄️ claude` on every tab it opens. `Buttons.Resolve` is the
only place that turns a preset name into a target and a command, and **the list is the
authority**: a button the owner removed cannot be started however well-known its name, or
removing it would have been hiding it. The UI test asks the endpoint for a removed
`shell` and requires a 400.

**The stored file grew a shape**: it was a bare array, now it is `{"buttons":[…]}`. The
difference carries a fact no array could — an empty list means every button was removed
and must stay removed, while a bare array is a store written before the defaults were in
it, and `parseButtons` puts them back in front of what it holds. Without that the first
release would have looked like it deleted the four on every host that had ever saved a
custom button.

**A reset restores the defaults and nothing else.** `Buttons.Reset` drops the built-in
entries, puts `DefaultButtons()` back in front, and leaves the owner's own where they
are. It is the store's operation rather than a list the page could send, because a page
older than the binary would otherwise install whatever it thought the defaults were — the
endpoint takes `{"reset":true}`. Two taps, like every other removal here.

Both menus are written from the list (`renderCustom`), and opening one waits for
`customReady` — the first `/api/presets` answer, a `+` tapped before it arriving opening
an empty popup that reads as "nothing can be started". On a host with no store at all
(404) the page falls back to `DEFAULT_BUTTONS`, which is not a second source of truth,
there being no list there to disagree with.

## A session that could not start took its own reason with it

The endpoint answers 200 and the journal says `started`, because both are true: make ran,
tmux made the session, and everything this program can see went right. What happens next
is between the pane and the command it was given, and a command that fails on startup — a
binary that is not installed, a typo in a custom button, `claude -c` in a folder with no
conversation to continue — exits within the second. The pane goes with it, tmux closes
the session, and on a phone that is **a tab that appears and vanishes**.

Reported as new sessions no longer opening, and the two halves of the report are the two
halves of the mechanism: the tab did appear, and what was left afterwards was the
previous session redrawn, which is `stepBackFrom` doing its job over a session that had
just died. Nothing in the journal said anything was wrong — `start-session ok:true`, a
`watch: question` off the dying screen, then silence. It was found by running the
button's command by hand: `No conversation found to continue`, exit 1, twice, in two
folders.

So the Makefile holds a pane whose command failed: the message stays on screen and the
pane **drops into a shell in the same directory**. A live shell rather than a dead pane,
because what is typed into a dead pane goes nowhere — the failure this file keeps meeting
— and because the commonest thing to want next is to look at the folder and try again.
**Bounded by how long the command ran, not by its status alone**: `make shell` runs an
interactive shell, where `exit` reports the status of the last command run in it, so a
non-zero exit is the ordinary way out of a session somebody worked in. Ten seconds is far
above every startup failure and far below any session anyone used.

The recipe lives in two files that must not diverge — `deploy/sessions.mk.example` here
and the `pockterm_app` role's template in the devops repository.

## Notifications are decided in one place

`internal/watch` reads each watched session's pane with `capture-pane` and emits two
events: a menu appeared, or the screen went quiet after doing something. Both channels —
Telegram and a `notify` frame to an open page — render that same event, through
`watch.Format` and `watch.Notice`.

The page decides nothing. It used to, and the result was notifications nobody could
predict: it counted "activity" from bytes on the socket, but tmux redraws its status line
on a clock, so the silence never lasted; and the timer that checked was throttled once
Android backgrounded the WebView. If you are tempted to raise a notice from the browser
again, read the header of `web/js/notify.js` first.

Body text comes from `watch.Tail`, not from the last non-blank line: agent TUIs draw an
input box and a shortcut hint under their output, so the honest last line is usually
`? for shortcuts` or a row of `─`. What that function has had to learn:

**What the agent said comes before what it ran.** Its own lines are marked with `●`, and
what sits under the last of them is the output of whatever it did last — which is how
"pockterm закончил" reached the phone with `{"name":"devops",` as its whole body, a
fragment of a `curl` that was honestly the last line on screen. `Tail` looks for the
lowest `●` line that is a sentence and strips the marker; `● Bash(…)` is skipped by its
shape, the agent pointing at a command rather than speaking. Reading up from the bottom
is the fallback, for a pane with no marker in it.

**A pane wraps a sentence, and the body used to be one line of it.** The notice read
`API Error: 529 Overloaded. This is a` and stopped there, while the same message from a
session last attached from a laptop arrived whole: the pane was 51 columns against 175.
The marker is on the first line only and the rest is a continuation indented under it, so
`wrapped` puts them back together, ending the paragraph where the pane does — a blank
line, a line back at the margin, another `●`, a tool's `⎿`, or anything already known to
be interface. `clip` caps the result at 200 characters with an ellipsis.

**Two lines of pure interface had to be named**, both full of words and none of them
about the work. The **status line** (`ctx 71% | dms@ai:~/work/exante (main) $ | Opus 5`)
arrived as the entire body of "exante закончил", and the **turn summary**
(`✻ Cooked for 19s`) is true and says nothing the title has not. Both are matched by
shape — `^ctx \d+%\s*\|` and `<one word> for <duration>` — and the shape has to start the
line, or a "собрал за 4s" in prose would vanish from a notice too. A notification cannot
be coloured either (`title` and `body` are plain strings), which is another reason not to
send a line whose colour is most of what makes it readable.

**And what was said *to* the agent is not what it said.** The `❯` marks the human's side
twice over: the input box at the bottom of the TUI, and the echo of every message already
sent, standing in the transcript above the answer to it. Claude Code writes a reply it
suggests into that box, so with no `●` in the visible screen — a long answer, its marker
scrolled off the 51 columns a phone gives the shared window — the fallback read one of the
two and the phone was told "✅ elect закончил" over a line the machine had proposed for the
owner to send. Measured on the owner's own panes 2026-08-18: devops answered
`❯ согласуй мост с mesh`, which is the message he had sent, not a word the agent said.
`withoutTheHumanSide` cuts the box structurally (`detect.InputBoxAt`: it is the bottom of
the TUI, so everything from it down is interface, whatever the footer looks like this
release) and blanks the echoes above it together with their wrapped continuations. The
space after the glyph tells the two apart — non-breaking in the box, ordinary in the echo
— and neither of them is the agent speaking, so `humanSaid` matches both.

**Nor is what a tool answered, and nor is one line of a paragraph.** Both were
found by checking the fix above against the live panes rather than by a report.
`wrapped` has ended a sentence at `⎿` from the beginning — the agent pointing at
output — and the fallback had no such rule, so it answered `59  loglevel = 4`
off mesh and `⎿  Interrupted· What should Claude do` off devops, where a turn had
been stopped by hand. `withoutTheOtherVoices` now blanks those blocks with their
wrapped lines, beside the input box and the echoes. And on a pane with no `●` the
last line on screen is the last line of a *paragraph*: elect would have been
announced with `станет ещё ниже.`, which is true and says nothing. `paragraphAt`
puts the paragraph back together, **only for text the pane indented** — a line at
the margin is a shell's output, where what is above belongs to another command.
The cap is counted in runes now, in both places: 200 bytes of Russian is a
hundred characters, and `clip`'s own bound is two hundred.

**A frame of the spinner is also a box glyph.** The fallback trims box-drawing
characters off a line so a boxed sentence reads as text — and `·`, added to the
spinner set on 2026-08-18, is in that set. Trimmed, `· Nebulizing… (thinking with
xhigh effort)` no longer looks like a counter to `detect.Live`, and it came out of
the loop as a body. Chrome is asked of both shapes now: the line as it is, and the
line with the frame off.

**What is wanted is one switch, and it is the server's.** `watch.Pref` holds `off`, `pwa`
or `pwa+tg`, `watch.Deliver` turns it into the two booleans the notifier obeys, and the
page reads and writes it over `/api/notify` — plus `notify` in the config frame, so the
button is right the moment it is drawn. Three reasons it is not a browser preference:
half of what it controls is sent from the host to a phone that has this page closed; a
second phone or a reinstalled PWA would disagree with what the host actually does; and
`off` has to mean silence in Telegram too. It is remembered on disk
(`POCKTERM_NOTIFY_FILE`) because CI restarts this binary on every push to `main`, and
`off` is the state whose loss is loud. Default is `pwa+tg`: an install must not silence a
phone that was being notified before it. The middle state exists only where a bot token
does — `NotifyMode` answers `telegram` alongside the mode, and `nextMode` drops `pwa+tg`
from the ring without one.

**Two paths raise a notice in a browser, and the weaker one looked like the only one.**
`new Notification(...)` is illegal in Android Chrome: the API is present, the permission
is granted, and the constructor throws — and the throw escaped `show()`, taking the rest
of the frame handler with it, so an installed PWA showed nothing at all until 2026-08-04.
`deliver()` prefers the service worker's registration, which is also the only path that
can carry a tap to a page that is gone: `notificationclick` in `sw.js` focuses an open
window and posts it the session, or opens one at `?session=`. Which path ran goes to the
journal (`notify via: …`).

**A notice goes to every open page, not to the pages attached to its session.** That
routing was the whole of "PWA notifications do not arrive" (2026-08-04, Telegram off).
Two sensible rules cancelled out: the watcher stayed silent about a session somebody had
visible, and `Notices` delivered only to sockets attached to *that* session — so the only
session a frame could reach was the one it was never sent for. `Notices` is keyed by
client id now and `Send` takes just the notice; the notice already names its session, and
a tap on it already switches there.

**Being on screen is a per-page answer, and it was everyone's.** That is right for
Telegram, which is one recipient, and no answer at all for the pages: with a phone open on
one session and a laptop showing the one beside it, a finish on the laptop's session
reached nobody. So `OnScreen` travels on the event, Telegram skips it, and `Notices.Send`
takes a `showing` predicate that drops only the sockets with that very session visible.
Every send says how many pages took it and how many were skipped.

**A page that was never asked cannot notify, and that looked identical to a broken
switch.** The default notifies, so a fresh install starts in a notifying state — and
permission used to be requested only on the way *into* one, which nobody walks when the
switch already says what they want; `show()` then returned silently on
`Notification.permission !== 'granted'`. Now the bell asks whenever the mode it moves to
notifies, an unpermitted `🔔` wears a dashed outline, the permission is in the `hello`
line, and a dropped notice says why. **And the bell is no longer the only place that asks
— the first touch does** (`shouldAskPermission` in `js/notify.js`, fired by
`armPermissionAsk` from a one-shot `pointerdown`). Two bounds, both learned from what
browsers do rather than from what they document: not **on load**, a prompt raised without
a gesture being refused outright by some browsers and shown as a quieter UI by others; and
**once per install**, which is why `pt-notify-asked` exists rather than reading
`Notification.permission` — `default` is also what a *dismissed* prompt leaves behind, and
a page that asks on every load is one the browser stops letting ask. The flag is written
before the answer comes back for the same reason. The UI stand grants `notifications`
alongside the clipboard, the first touch in most tests being the start of a swipe being
measured.

**Every notice names its own icon.** Left unset, Chrome draws a generic bell — and
unpredictably: two notices sat in the owner's shade one above the other, one bell and one
app mark, depending on whether the page was still there when the worker raised it.
`icons/icon-192-notify.png` is the app's own drawing in **white on nothing at all**,
passed as both `icon` and `badge`; no plate behind it, the shade drawing its own circle,
and the mark scaled to fill its box rather than keeping the installed icon's margin. It is
generated from `icon-192.png` (luminance to alpha), so the two cannot drift.

`show()` no longer consults the page's own copy of the switch: the frame's existence *is*
the decision, the server having read the mode at the moment of the event.

## The wheel step is a tmux setting, and it is the floor for everything here

A wheel notch is the smallest movement tmux can draw, so it bounds every smoothness
question on this page: the residue the shift gives back at the end of a gesture, the size
of a jump when a prediction is wrong, the band of background at the leading edge. The page
does not assume it — the server asks tmux (`list-keys -T copy-mode WheelUpPane`) on every
connect and sends it in the `config` frame.

On the owner's host it is **one line since 2026-08-03**, set in `~/.tmux.conf`: five
(tmux's default) meant a short swipe moved nothing until the finger had travelled five
rows, two still left a residue that read as the screen sliding back at the release. That
file lives in the `dotfiles` repository (`tmux/tmux.conf`, the small step behind an `%if`
on the hostname — one line is a step for a thumb, not for a mouse), so changing the step
is a change to it and to nothing here.

**The count in that binding has to be a literal.** tmux does expand a format in
`send-keys -N`, but `list-keys` prints the binding unexpanded and that output is all this
server knows: `ParseWheelLines` falls back to 5 on anything non-numeric, and tmux would
scroll one row while the page compensated for five.

## A touch belongs to the element it started on, and xterm replaces that element

Reported from the browser as the scroll jumping and refusing to go more than a screen or
two back: some swipes covered a screen and a half, the next moved two lines, with no
pattern to which. The pattern is **where the finger landed**.

Every touch event after `touchstart` is delivered to the node the gesture started on, and
a node taken out of the document has no ancestors left to bubble to. xterm's DOM renderer
rebuilds a row's spans on every write, so a swipe that started on drawn text was over at
the first redraw tmux answered with: one move delivered, two lines scrolled, the rest of
the travel dispatched into a detached span. A swipe that started past the end of a short
line hit the row's own `div`, which xterm keeps, and ran to the end. Measured on the
stand, six identical swipes: the first delivered 10 moves and scrolled 50 lines, every one
after it delivered 1 and scrolled 2, with `target.isConnected` false for each. That is
also why it got worse the further back you were — the more of the screen is text, the
fewer places there are to land that survive.

`.xterm-rows { pointer-events: none }` is the fix: the finger lands on `.xterm-screen`,
which xterm creates once and keeps. Nothing is lost — xterm's own mouse handling listens
there and works from coordinates, and selection is made from the frozen copy.

**What it is not** is anything about tmux, which is where two earlier readings went. tmux
does hold the copy-mode position as an offset from the bottom of the history, so a pane
still producing output drags a reader forward — measured, and real — but the session this
was reported from had a stopped agent and a silent pane, and the page was sending its
notches (33 to 66 per gesture in the journal). The gesture was being cut off before it
became notches at all, which is visible from neither end.

## The copy window had nothing to scroll, because the page has no history

Selection mode lays a frozen copy of the screen over the terminal, and for as long as it
existed that copy was the screen and nothing else — exactly as tall as its own box.
Measured on the stand: `scrollHeight` equal to `clientHeight` after eighty lines of
output, and `scrollTop = 9999` leaving it at 0.

**The obvious fix reads xterm's own scrollback, and there is none.** The terminal is
created with `scrollback: 5000` and it stays empty: tmux owns the history and repaints its
pane rather than letting lines scroll off it, so the browser's buffer sits at the top with
`viewportY` at 0. That was measured before it was believed — the first version of this fix
read the buffer and the copy window came out one screen tall exactly as before.

So it is asked of the host (`tmuxcmd.CaptureHistory`, `capture-pane -p -S -N`), over the
socket the page already has rather than an endpoint of its own: the session is the one
this socket is attached to, so there is no name to pass and no second way in to guard. The
count is clamped on both sides (`proto.CaptureMax`) — a nonsense number is answered with
the screen rather than with an error, what answers this frame being text on a phone with
no console. The control frame goes out as **text**: `send` encodes to binary, which is the
keystroke path, so the first version asked for the capture by typing
`{"type":"capture","lines":2000}` into the pane.

**The mode opens on the frame it was asked for.** The screen is frozen at once and the
history replaces it a round trip later, pinned at the bottom; a copy window that appeared
only after the answer would read as a button that does nothing. The answer is dropped
unless a copy window is still waiting for it (`captureWanted`), or one arriving late would
overwrite a newer screen with older text. **And nothing floats over a frozen copy**: the
pager stack and the scrollbar are about a pane that is not moving here, and what they did
was take drags from the one gesture this mode has — they are gone while it is up.

Which of the two texts is on screen is published as `data-from` on `#snapshot` (`screen`,
then `host`). A diagnostic first, like `data-kb` and `data-size` beside it — the two look
identical from a phone, so "there is nothing above the screen in there" is either a capture
that never came back or a pane with no history — and it is what the tests wait on, a
measurement taken in that round trip being a measurement of a window about to be redrawn.

## A selection does not stop where the copy window does

Reported as the clipboard taking more than was selected. The window opens at its own bottom
edge, the last line being what is wanted most often, so a handle dragged downwards ends up a
notch past it — and a document selection does not stop at an element. Measured on the stand:
two lines taken at the end of the frozen copy came back with
`\n📋 Copy\n✕ Done\n✂\n📥 Paste\n📎\n💬` after them, the labels of the bars a thumb is
covering while it drags.

**Only the bars, and that is luck rather than design.** The terminal's own rows sit *behind*
the frozen copy drawing the same lines it ends with, and they stay out of this because xterm
marks them `user-select: none`. What they would have added is a duplicate of every line, with
nothing on screen to see it by.

`insideSnapshot` clamps every range of the selection to the copy window's own contents, and
the `copy` event does the same through `e.clipboardData.setData`: Android's own Copy and a
desktop Ctrl+C write the clipboard themselves, so the event is the only place to say what
they may take. What a selection reached past the window and did not get goes to the journal
as `outside`, which separates a copy of exactly what was highlighted from the copy that used
to take the chrome as well.

## A paragraph is picked, not dragged

Dragging Android's handles through a copy window 2000 lines deep is the least precise gesture
on this page: the handle meets the edge, the container scrolls under it, and what was aimed at
three lines ends somewhere nobody can see. So **a long press picks the paragraph under the
finger whole** and marks it where it stands — additive by a press somewhere else, subtractive
by a press on what is already marked. Copy hands over what is picked in screen order rather
than tap order, separated by the blank line that separated them there, and with no trailing
newline: this text goes into a shell as often as into a message (`pickedText`).

A paragraph is a run of lines with no blank line in it (`chunks` in `js/select.js`), read off
the text and nothing else — the shape cannot go wrong in a way that needs a release to
explain. The window is laid out one span per paragraph with the newlines kept **inside** the
spans, so a native selection dragged across it still reads as it looks (`Range.toString`
concatenates text data and adds nothing for a block boundary).

Five things that were each a way to be wrong:

- **The browser makes a selection of its own out of the same press, and refusing it needs a
  clock of its own.** `user-select: none` goes on at `PARA_BAN` (200ms), well under Chrome's own
  500ms, and comes back a beat after the finger lifts — so a plain drag still scrolls and a
  double tap still selects a word, which is how half a line is taken on a phone. `contextmenu`
  is refused for **any** touch press that started on a paragraph, pick or no pick.

  It was the pick's own timer that did both, and that made every way the pick could miss a way
  the refusal never happened: a thumb drifting past a travel bound of 8px — inside the drift of
  a thumb resting on text, now 14px, which is about Chrome's own slop — or a 400ms timer
  delivered late on a main thread that polls and renders. Reported as the second long press
  selecting a word instead of marking a paragraph, with the handles and Android's own
  Копировать/Поделиться over the copy window. The journal named it: `pick paras:1 on:true`
  **twice running**, where the second should have said 2 — the set had been emptied in between by
  the tap that dismisses that menu, so one defect wore two symptoms. A press that stopped being
  a pick and is worth knowing about now says so as `pick-missed`.
- **Touch and pen only.** On a laptop a drag already selects exactly what is wanted, and a
  mouse held still cannot be told from the start of a careful drag — the gesture a pick would
  break.
- **The click a long press ends in is not a tap**, and a tap on the frozen copy is the way out
  of the mode: it would leave, taking the pick with it. Swallowed, and the flag is cleared at
  the next press rather than by the click it waits for — a browser that read the press as a
  scroll sends no click at all.
- **A tap with paragraphs picked neither leaves nor clears, unless it lands where no paragraph
  is.** Losing a set of marks to a stray thumb is the more expensive mistake, and the stray thumb
  turned out to be the one dismissing the menu above: that tap lands on the paragraph under it.
  So a tap on text does nothing at all, the blank room around it starts over, and marks otherwise
  go the way they came — a press each.
- **The host's answer arrives after the mode opens**, and redrawing the window costs every pick
  made in that round trip. Identical text is left alone — the ordinary case on a pane with no
  history above its screen — and `data-from` says the answer came either way.

`test/ui/pockterm.test.mjs` reads both off the clipboard: a selection dragged past the window
copies what the window holds and nothing after it, and a press, a second press elsewhere and a
press back on the same paragraph leave the picks the pair of them describe.

## The pane draws Markdown, and a copy of the drawing has none

What the agent wrote as `**слово**` reaches the pane as an attribute, and the copy handed over a
bare word — reported as the copy losing Markdown. The text was never the message; it was a
picture of it.

tmux gives the attributes back when asked, so `CaptureHistory` asks (`-e`) and `markdownFrom` in
`js/select.js` reads two of them into text. **Bold is `**`**, headers included — an agent's `##`
is drawn bold and nothing else, so bold is as much of it as can honestly be recovered. **And the
light blue is a backtick.** That one is a colour rather than a shape, which this file otherwise
refuses to read a TUI by, and there is no shape to read instead: an inline code span is coloured
text and nothing more. So it was measured rather than assumed — off four live panes, Claude Code
2.1.x, `38;5;153` wrapped `apps.cikrf.ru`, `SUMMARY.md`, `scripts/deputy_family_card.py`,
`python3`, `e4cf208`, `min-width:`, `280px`, `origin/main`, every one of them backticked in what
the agent wrote. The pink beside it (`38;5;211`, `⏵⏵ bypass permissions on`) is chrome and gets
no marks; everything else is dropped, escapes included.

**The marks are set word by word, and a span has to be put back together.** The renderer emits
the attribute per word — `\x1b[1mВажная\x1b[0m \x1b[1mпоправка,\x1b[0m` is one `**…**` in the
source, `\x1b[38;5;153mmake\x1b[39m \x1b[38;5;153mcheck\x1b[39m` is one `` `make check` `` — so
neighbours of one style are joined across the space between them, and across a single newline,
which is where the pane wrapped a sentence. Not across a blank line: that is two paragraphs, and
joining them would put one pair of marks around both. The marks never wrap the space beside a
word either, `** foo**` being two asterisks and a word to every reader of Markdown there is.

**What is shown is what is copied.** The conversion happens where the capture lands, before
anything else looks at the text, so the copy window, the paragraphs `chunks` cuts, the picks and a
selection dragged across them are all one string. The window therefore reads like source rather
than like the screen — which is the point: it is what a paste will produce.

Two things this costs. The frame is bigger, escapes being most of a styled line — one frame per
entry into the mode, and the alternative was a clipboard without the formatting. And the text the
mode opens on has **no** marks: that is the page's own screen, read out of xterm's buffer where
the attributes are not, and it is replaced by the host's answer a round trip later (`data-from`
says which is on screen). A capture that never comes back is a copy window without Markdown in
it, which is the same failure as a copy window without history — and it says so the same way.

## What the shift under the finger does not cover

The page shifts the drawn rows to follow the finger between whole lines (`track` in
`web/js/scroll.js`). What was learned by shipping it:

- **The lift changes nothing.** For one version the shift was handed back the moment the
  finger left, on the theory that a glide is too fast to judge a fraction of a line in.
  With the cap at three steps that is a screen flying six rows backwards at the release.
  The shift stands for content that has not arrived; it goes back as that content lands,
  and the two cancel to no movement. A glide keeps more messages in the air than the cap
  allows, so the picture rides at the cap instead of following exactly — what it does not
  do is jump.
- **`track()` expires before it decides.** `owed()` is both the question and the expiry,
  so asking whether anything is left before calling it leaves the sub-line residue on
  screen for good — a terminal parked a few pixels off its grid.
- **Notches dropped with the queue must be disowned** (`dropped()`): leaving the history
  throws away what was queued, and only a message that went out can expire on the
  backstop.
- **tmux's status line is not chrome.** It is drawn into the bottom row of the same grid
  the pane lives in, so a transform takes it along — reported as the green strip rising
  two rows on an upward swipe. The server asks tmux how tall it is (`show-options -gv
  status`) and says so in the `config` frame; the page takes the shift straight back off
  those rows with the same transition, so the two cancel at every point of the settle.
  Guessing is wrong here: too high pins a row of real output, so anything unreadable
  counts as none.
- **One repaint accounts for every message it can have drawn.** Counting one batch per
  repaint was the first rule and the numbers killed it: xterm renders once per animation
  frame, so several of tmux's answers arrive in one repaint, the rest stayed owed, and the
  shift sat at `MAX_TRACK`. A repaint now clears everything sent more than a frame ago
  (`ACK_MARGIN`).
- **A clock cannot say when a notch landed.** The shift first predicted it from the
  measured round trip, and the device settled that: the trip averages 40-50ms and peaks at
  130. A short swipe has one notch and gets away with it; a longer one has twenty,
  mispredicts several, and every miss is a step back and then forward — reported as
  juddering, and as sticking where a misprediction ran the shift into `MAX_TRACK`. The
  page counts what it can observe: one message out (`batched`), one repaint of the whole
  viewport back (`drew`). `movedWholeScreen` tells a scroll from output — measured on the
  stand, a printed character repaints one row and a scroll repaints all of them. A batch
  nobody answers expires after `AIR_MAX`: that is the top of the history, where there is
  no scroll for tmux to make.
- **The cap is a decision, not a safety valve.** The shift is content that has not
  arrived, so it shows as a band of background at the leading edge; while it is at the cap
  the picture stops following the finger. Three steps (six rows here) is where that trade
  sits.
- **The whole terminal screen is the gesture surface**, not the box the text is drawn in:
  the bars take a third of a phone, and a thumb reaching them mid-swipe is how a long
  swipe ends. `#composer`, `#snapshot` and the tab strip keep their own gestures.
- **The gesture is the page's, and the browser has to be told.** `#term` sets
  `touch-action: none`; without it the browser may decide mid-swipe that a long drag is
  its own scroll and stop delivering moves. `touchcancel` is handled too, the declaration
  being a request rather than a guarantee: a cancelled gesture ends without a throw and
  says so in the journal as `cancelled`.
- **A pane with no history cannot answer anything.** Every message is then one tmux has
  nothing to draw, the air fills up and the shift pins at the cap. Two measurements were
  read as defects before this was noticed, so a test that swipes has to print output
  first.
- **`〰 smooth` turns the shift off.** Whether holding the picture between whole lines
  reads better than moving in whole ones is a question about feel — and the shift moves
  everything in the pane, an agent's own input box included. The lever is remembered, so
  answering costs a tap instead of a deploy.

`lag`, `predicted` and `lost` in the gesture report are diagnostics now, not controls.

## The installer does what the README used to ask of a reader

Everything `deploy/install.sh` gained is one shape of defect: a step that was written down
instead of done, and whose absence does not look like an absence.

**A host without `tmux` is refused, not served** — the phone otherwise gets an empty
session list, which reads as a broken terminal rather than as a package nobody installed.
`make` is a warning instead, only the `+` button going through it. The refusal carries the
command that fixes it, picked off the package manager that exists rather than off
`/etc/os-release`.

**The session Makefile is installed, and `POCKTERM_SESSION_DIR` points at it.** Those were
four steps in the README — copy, edit, set the variable, restart — and the moment they are
wanted is the moment a phone has no session on it, which is the worst possible moment to
be reading a README. The root defaults to the served account's home. Two refusals inside
that, both about not owning what we did not write: a Makefile already in the root is never
overwritten (`make claude` in somebody else's Makefile is an unknown target, not a
session), and then the variable is not written either, since pointing the `+` button at
unknown targets is worse than leaving it off. A copy of ours is recognised by
`pockterm-sessions` in the header and left exactly as edited, the file being meant for
editing. `GNUmakefile` and `makefile` count as the Makefile that is there — make reads the
first of the three, so writing `Makefile` beside a `GNUmakefile` would install a file make
never opens and report success.

**A restart happens when the env file changed, and only then.** systemd reads that file at
start, so anything added is not in force yet; and a restart drops every open terminal, so
an install that changed nothing must cost nobody a reconnect.

**`--tg` runs the pairing that already existed.** `pockterm tg-setup` has done the
mechanical half since it was written; what it could not do is be remembered, and the part
left out afterwards was the restart. Its failure ends only itself — the install stands and
prints the link, a bot that is not ready being no reason to have no terminal.

`test/install_test.sh` covers each of those, including both answers where a machine can
only give one: `REQUIRE_TMUX`/`REQUIRE_MAKE` name the tool to look for, so the missing-tool
path is exercised on a host that has it, and a stub `tmux` on `PATH` lets the happy path
run in a container that has none.

## Diagnostics

The page posts what decides an outcome to `/api/log`, which the server writes to its
journal (`journalctl -u pockterm | grep client:`): the environment on load — version,
secure context, which clipboard APIs exist, whether the native bridge is there — plus
copy/paste/upload results and uncaught errors. The device this serves has no console
anyone can open, and every fix before this was a guess.

**A refused upload had been the one outcome that wrote nothing down.** Only the successful
path reported, so "413 при загрузке фото" arrived with nothing in the journal to put
beside it — and 413 is a status this server never sends. It comes from the nginx in front,
whose default body limit is one megabyte: a screenshot is a few hundred kilobytes and went
through for months, a camera frame is several megabytes and never did. The limit lives in
the `pockterm_vhost` role in the devops repository (`client_max_body_size 12M`, just above
`upload.MaxBytes` so an oversized image is refused by this program's own words rather than
by the proxy's status code), and it takes a deploy of that role to be in force. The page
names the proxy instead of pasting nginx's HTML into a toast, and logs the failure with
its status and the size.

## A message about screens is usually about several of them

One upload is one request — `/api/upload` takes a body, not a form — so a selection of
screenshots is a request each. `attachImages` sends them **one after another**: the phone
reaches this host down a single tunnel, the proxy in front bounds each body rather than the
batch, and the paths have to be typed in the order they were picked.

**The paths go out in one write**, once the last upload is in. `term.paste` honours
bracketed paste, so what the agent is handed is one message naming several files rather
than one message per picture — and a message per picture is a turn per picture.

Where several can arrive: the file chooser (`multiple`, and on a phone the only such path —
the clipboard holds one picture and there is nothing to drag a file onto), a drop from a
desktop file manager, and a paste. `pickImages` reads `files` **whole when it holds any
image** and falls back to `items` only otherwise: a drop exposes the same picture through
both lists, and collecting from each in turn uploaded it twice. `imageFiles` filters the
chooser's own answer, `accept="image/*"` being a hint to the picker rather than a promise
from it.

Two bounds, both about saying what happened. `ATTACH_MAX` is 10 — a gallery keeps "select
all" within reach of the thumb that picks two screenshots, and each one is a request and a
file on this host's disk — and what is left over is **said** rather than dropped quietly.
And a batch that lost one of its pictures says so against what was picked: the paths that
did arrive are on screen, so counting them is the only way to notice from a phone. Every
upload keeps its own journal line, now with `n` and `of` in it, which is what tells a batch
from three separate pastes.

## Deploy

A push to `main` builds, tests and hands the binary over, and **the host installs it at
once**. Do not install by hand on the RPi5, and do not run the `pockterm_app` ansible
role's binary copy against it.

`.forgejo/workflows/deploy.yml` runs on the runner that lives on that same box. The job
builds in a container and drops `pockterm.new` plus an HMAC signature into
`/var/lib/pockterm/incoming`; the host watches that path (`pockterm-deploy.path`) and
`/usr/local/sbin/pockterm-deploy` verifies the signature and takes it from there.
Identical bytes are a no-op, so a docs-only push does not drop anyone's terminal; a binary
that fails to start is rolled back.

**That no-op needs the build to be reproducible, and for a day it was not.** `go build`
stamps the commit hash into the binary and the build directory along with it, so every
push produced new bytes and every push restarted the unit — found on 2026-08-04 by a
commit that touched only this file. `BUILD_FLAGS` in `make/go.mk` is `-trimpath
-buildvcs=false` for that reason, and `make test-repro` builds the tree twice under
different paths to prove it. It is two real cross-compiles, so it is not part of `make
check` — run it when the build line changes. The cost is that the binary no longer says
which commit it is; the page's `APP_VERSION` is what identity there is.

The deploy used to wait for nobody to be looking, which cost a parked build, a retry
timer, a `waiting` flag on `/api/presence` and a line in the menu explaining why the
version would not change — and the person waiting for the fix was the one holding it up.
**The wait was removed on 2026-08-03.** A restart costs a reconnect, the tmux session
behind it is untouched, and the page says what to do about the rest: the server names the
page it serves in the socket's `config` frame, and a page running anything else shows a
bar with **Обновить** on it. A reload rather than an automatic one, because the composer
can have half a message in it; the button is a plain `location.reload()`, the service
worker being network-first.

`APP_VERSION` in `web/js/app.js` and `VERSION` in `web/sw.js` are that mechanism's single
number, bumped by hand in two files; `assets_test.go` fails if they drift, because a page
misreporting its own version never looks out of date and no bar is ever raised. The server
reads the number out of its own embedded `app.js` (`PageVersion` in `assets.go`) rather
than keeping a third copy.

The host-side pieces — `pockterm-deploy`, its `.path` and `.service` — live in `deploy/`
and are covered by `test/deploy_test.sh` (`make test-deploy`), which stubs systemctl.

That path installs on the RPi5 only. For everyone else there are releases:
`.github/workflows/release.yml` fires on a `v*` tag, runs `make release` (both
architectures plus `SHA256SUMS`) and publishes them, and `deploy/install.sh` downloads one
when no Go toolchain is present. The checksum check is not decoration — a binary that does
not match is refused, and `test/install_test.sh` covers both outcomes with a `file://`
release.

The signing key is the repo Actions secret `DEPLOY_HMAC_KEY` and
`/etc/pockterm/deploy-hmac.key` on the host. It exists because the drop directory is
mounted into a job container and the runner serves other repositories too — without it,
any workflow could have the host install a binary as root.
