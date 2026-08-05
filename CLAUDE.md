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

## A message that did not go out is still the owner's

`send()` drops what it is given when the socket is not open, and that is right
for a keystroke: there is nowhere to put it and nobody typed it twice. The
composer handed it a whole message and then cleared its field in the same tick,
as though the socket had taken it. Reported from the phone as the text
disappearing when the send does not go through, with nothing anywhere to get it
back from — and the moments when a send fails are exactly the ones with a long
message in the box: a reconnect, a handover between Wi-Fi and cellular, the unit
restarted by CI under whoever is typing.

So `send()` answers whether the socket took the bytes, and the composer clears
its field only then. **Held, not queued.** A message delivered on the next
connect would arrive minutes later into whatever the session is doing by then,
and nothing downstream — pty, tmux, the agent — knows it is a latecomer. The
text stays where the person holding the phone can decide.

**And what did go out is kept**, because the other half of this cannot be
detected at all: a socket that is open and dead looks exactly like a quiet one
from in here (see the watchdog above), so the page cannot refuse to send on a
suspicion. The last twenty messages live in `localStorage` (`pt-sent`,
`js/compose.js`), newest first, a repeat moved rather than added — sending the
same line twice is what a retry after this defect looks like. `↻` in the
composer opens them, and it is hidden until there is one: a way back to nothing
is a control that explains itself only by being pressed. A recalled message goes
**into the field, not down the socket** — it is usually being recalled because
something went wrong with it the first time.

The list is drawn over the terminal and never beside it, which is the same rule
`#answers` follows and for the same reason: a panel in the flow shortens the
pane, tmux redraws to the new height, and what the page reads changes under it.

**The draft is written down as it is typed** (`pt-draft`, on a 300ms timer).
The page asks for a reload itself after a deploy, and Android kills a WebView
whenever it likes; both used to take a half-written message with them. That is
also the fear behind the update bar being a button rather than an automatic
reload — the fear is smaller now, and the button stays, because a reload also
interrupts whatever is on screen.

## A quiet socket and a dead socket look the same from in here

Reported from the phone as the screen freezing: a message typed on it had plainly
been sent — the laptop's window showed the agent answering it — while the phone sat
on the same frame and caught up "about a minute later". Nothing in the page was
frozen. The socket had been handed between Wi-Fi and cellular, the far end was a
black hole, and `readyState` stayed OPEN with sends appearing to succeed. The minute
is TCP giving up.

**`ping` was answered by the server before anything sent one.** That is the whole
defect: the protocol had the question and the page never asked it, so a dead
connection was indistinguishable from a session with nothing to say.

`linkAction` in `web/js/link.js` decides, and it is a pure function because the
alternative is a timer nobody can test. After `PING_AFTER` of silence the page asks;
if nothing arrives within `PONG_WAIT` the socket is discarded and `connect()` runs
again — fifteen seconds against the minute it was. Any inbound traffic counts as the
answer, pong or output alike, so a busy session is never pinged.

**Only while the page is on screen.** A backgrounded page has its timers throttled to
roughly one firing a minute, so every measurement it takes is late by construction —
tearing down a socket because Android slowed the clock is worse than the freeze this
fixes. A pocketed phone keeps its socket, and `visibilitychange` asks the question the
moment it comes back, which is also when the answer is most often "gone".

**Discarding a socket means both its handlers, and onclose is the one that matters.**
Closing a socket fires it, and `onclose` schedules a reconnect of its own — so the
first version of this watchdog left the page with two sockets on the session, then
four, each writing every frame into the same terminal and each carrying every
keystroke. Reported from the phone within the hour: "терминал затроил", "по три
сообщения начали отправляться", and a reload put it right, which is exactly what a
page holding several sockets looks like. Every other deliberate close on this page had
the pattern already (`showSessions`, `attach`); this one did not. The test asks
`/api/presence` how many clients the server sees and requires one.

The backoff is reset when the watchdog fires: this is a socket being thrown away, not
a host that cannot be reached. And `socket-stalled` goes to the journal with how long
the silence was — "иногда зависает" becomes a count with timestamps.

The UI test drops the page's own sends (`WebSocket.prototype.send` swallowed) so
nothing reaches the server and nothing comes back, then requires the journal line, the
reconnect, and a terminal that types again. With the watchdog's timer commented out it
times out — checked, because a test that passes against the defect is worse than none,
which happened once already in this file.

## A client attaches at a size, and the wrong one is everyone's problem

Sessions here are grouped — `new-session -t <name>`, one window, several clients —
and tmux's own `window-size latest` gives the shared window the size of the newest
client. So a client attached at a default 80x24 and told its real size a moment
later does not merely look wrong to itself: it resizes the window under **every
other client on that session**, the laptop included, and they keep drawing at
their own width while tmux fills lines to 80. On screen that is halves of two
lines in one row and a cursor landing nowhere.

It was reported twice from the phone as a desync — "на всех вкладках курсор
прыгает, потом прошло" — and both halves of that sentence are the mechanism. Every
tab switch attaches a new client, which is why it recurred; the page's first
`resize` message arrived a moment later and fixed it, which is why it passed.

The size travels in the socket's address now (`/ws?session=…&cols=…&rows=…`) and
`requestedSize` reads it there, so the pty is created at the page's size and the
window is never handed a number nobody asked for. Missing or absurd values fall
back to 80x24, since the value comes from a query string.

**Measuring this after an ordinary attach proves nothing**, which the first version
of the test demonstrated by passing against the defect: `sendResize` corrects the
window before any assertion can run. The test drops resize frames on their way out
of the page and then compares `#{window_width}` with what the page says its own
size is — that difference is 80 against 44 on the old code.

The page publishes that size on `#term` (`data-size`, set in `fitNow`). It is a
diagnostic first: a screenshot of a broken redraw then answers the first question
about it.

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

## A tab carries three answers, and none of them is the others

Which sessions exist is the row, which one you are in is a **frame**, and what
each is doing is the **fill**: nothing for a session the watcher has no claim
about, a moving purple while output arrives, green once it has gone quiet after
doing something. The frame is not decoration — "attached" used to be the fill,
which left the session you were sitting in as the only tab that could not tell
you whether its agent was still running. The border is always present and only
changes colour, or every switch would move the rest of the row by two pixels.

The state is `watch.Activity`, read off the same per-session bookkeeping the
"finished" notification is decided from — so the colour and the notification
cannot disagree about what a session is doing. `ActivityUnknown` is deliberately
not called idle: the honest claim is that nothing has been seen since watching
began, and a tab then paints itself neutral instead of inventing a fact.

**The end of a turn is read off the agent, not waited out.** `detect.Live` looks
for the counter an agent keeps on screen while a turn runs — `✶ Doing… (1m 13s ·
↓ 3.9k tokens)` — and its going away is the event: `watch` reports "done" once it
has stayed away for `liveGrace`, four seconds, instead of thirty seconds after the
last change. The silence rule is still there and still needed — a shell running a
build has no counter to read — but it is no longer the only one, and it was costing
thirty seconds of a tab painted as working after the answer was already on it.

**One poll without the counter is not an answer.** It was, and the report was "часто
зеленеет на время и отправляет уведомление": a capture landing between the footer
being erased and painted again, or a release that stops drawing the counter during a
tool call, is one screen without a counter on a turn still running. The window is
four seconds — two polls — which keeps almost all of the advantage over the silence
rule. `Activity` waits exactly as long as the notification does, because the whole
reason both are decided here is that they cannot disagree about what a session is
doing. Sampling the author's own sessions at twice the poll rate found no flicker in
this release (30s and 55s, no transitions), so this is a guard rather than a fix for
something caught in the act.

**Every event is written down** (`Options.Log`, `journalctl -u pockterm | grep
watch:`) with the session, the rule that raised it — `counter gone for 4s`, `quiet
for 32s` — and, when nothing was sent, why: the session was on screen, or no page
had ever opened it. Before that line the watcher's state lived in this process and
nothing recorded it, so "it goes green for no reason" could not be told from a real
finish an hour later. It was measurable only from the page's side, and even there
what looked like a burst of notices was one event delivered to the several sockets a
stalled reconnect had left behind.

Three readings say a turn is running, and the first of them had to be widened
after it sent a "finished" notice mid-thought:

- **Brackets opening with a duration** — and nothing else in them is required.
  The first version also demanded the word `tokens`, which is there while the
  agent spends them and gone while it only thinks: `✢ Crunching… (4m 23s · still
  thinking)` read as a turn that had ended. That is what put a live counter in
  the body of "pockterm закончил", and what made a working tab go green for a few
  seconds at a time. A 40-second sample of a real session missed it entirely,
  because tokens happened to be flowing throughout.
- **`esc to interrupt`**, which older releases show instead of a counter.
- **One of a small set of stars, followed by a word ending in an ellipsis** —
  `✻ Pondering…`, `✢ Crunching…` — from the owner's observation that the line
  always opens with one and that those characters turn up in prose about never.
  The ellipsis is what makes it safe: a turn in flight is named with one, and the
  line left behind when it ends is not. `●` is deliberately not in the set — that
  is the mark on the agent's own sentences, the thing a notification is *for*.

What is never matched is the verb. Pondering, Crunching, Deciphering, Scampering,
Cooked, Sautéed — they turn over between releases, and the line left behind when
a turn ends is the same words in the past tense: `✻ Crunched for 4m 3s · 1 monitor
still running`. Shapes, not vocabulary.

The counter also outranks the threshold while it is *there*: a turn that thinks
for a minute can redraw to the same bytes, and silence alone called that
finished. And the search window is the last 20 non-blank lines rather than the
footer's four, because what the agent draws under the counter — its input box,
its own status line, a task list, a tip — is as tall as it feels like.

**Once a session has been seen counting, the counter is the whole answer, and a
change on screen is not an answer at all.** Any change used to count as work
resuming, and the change a person makes most often is typing the next message into
the agent's own input box: the tab went green when the turn ended and purple again
at the first keystroke — reported from the phone as "it does not detect the stop
and jumps from green to purple". A tab was calling the human's typing the machine's
work. It cost notifications as well, and worse: every keystroke re-armed
"finished", so a turn already reported was reported again. The regression test
types four characters and demands one event; against the old rule it produced five.

So `sawLive` is a property of the session rather than an arming flag, and
`Activity` answers `done` for any session that has counted before and is not
counting now. Silence keeps its job where there is nothing else: a shell running a
build has no counter, and for it a change on screen is still the only evidence of
work there is.

**And attaching is not work either.** Tapping a green tab turned it purple for the
whole idle threshold: a page attaching makes tmux give the new client its own size
and the pane is redrawn to it, so the screen differs from the one before through
nobody's effort — which for a session that has never counted is the only evidence
of work there is. Leaving costs more: the pane resizes back, nobody is looking any
more, and thirty seconds later the session was announced as *finished* for having
been left. `Watcher.Rebase` marks the next screen as ours rather than the agent's,
and `Presence.Join`/`Leave` call it. It is a short window rather than a single poll
because tmux redraws and then the agent redraws its own box a moment later — the
test proves that too: with the window removed the first redraw is still forgiven
and the second one is not.

**`ActivityAsking` outranks both and waits for nothing.** A menu on screen is the
only state that is about the person holding the phone — output arriving is the
machine's business, a question is theirs — so it beats working and done, and it
does not require the screen to have changed once: a pane already showing a
question is showing it now. It also survives the idle threshold, where "done"
would be a tab claiming the opposite of what is true. The tab goes blue with a
yellow `!` centred on its top edge, half of it above the tab: the mark is allowed
to break the row's outline because the question is the one thing here that needs a
person. The sweep is the same keyframes as working, so the speed and the per-tab
phase cannot drift apart from it. This is the same detection the answer buttons are
drawn from (`detect.Question`) — and those exist only for the session on screen,
while the question you want to know about is usually in the one that is not.

**The answer buttons press what the menu says it takes, not a digit.** "Type the
digit and press Enter" was the rule from the beginning, and it was an assumption
about every menu that looks like one. It holds for a permission prompt. It is
false for the question with a description under each answer, which lists its keys
directly underneath — `Enter to select · ↑/↓ to navigate · Esc to cancel`, and
digits are not among them: the digit fell on the floor and the Enter took whatever
was highlighted, so **every button answered option 1**. Reported from the laptop as
a click on the third one coming back as the first, and that is the worst shape a
defect can take here — a wrong answer looks exactly like the right one until you
read what it did. It also only became reachable when the fix below made those menus
detectable at all.

**The row is drawn over the terminal, never beside it.** It used to sit in the
terminal screen's own flex column, so drawing it shrank the terminal — nine rows
of thirty-five, measured on the stand. tmux redrew the pane that much shorter, the
top of the menu scrolled out of the grid, nothing was detected any more, the row
went away, the pane grew back, and round again: reported from the phone as the
buttons blinking. A row whose own presence decides whether it should be there
cannot be in the flow. It is `position: absolute` inside `#term` now, opaque, over
the last rows — what it covers is the text it repeats. The same shrinking is why a
*waiting* session read as finished on the strip: the watcher reads the very same
pane, and while the menu was out of it there was no question to see. The test
asserts the invariant rather than the symptom — showing the row must not change
`#{pane_height}`.

A swipe on the row scrolls the row: six options with their labels are taller than
the room it is allowed, and `ownsGesture` gives it its own gesture for the same
reason the composer and the tab strip have theirs.

`detectQuestion` reports `navigate` (`digits` or `arrows`, read off that footer
line) and `cursor` (which option carries the `❯`), and `answerKeys` turns the two
into bytes. The count of arrow presses starts from where the pointer **is**, not
from the top: a menu already navigated on screen sits somewhere else. No pointer
means no honest count, and then no button — one that guesses gives an answer
indistinguishable from the one the owner meant. `internal/detect` parses neither
field: it renders notifications, and a notification presses nothing.

**A menu's options do not have to be adjacent, and requiring it found nothing.**
The rule was a run of lines numbered 1,2,3 with nothing in between, which is a
permission prompt exactly and an `AskUserQuestion` not at all: that one draws a
description under every answer, and a rule across the menu before "chat about
this". So the run broke at the first option, no menu was found, and the tab stayed
neutral in front of a screen full of question — reported from a phone looking at
one. A numbered line now continues the run when everything between it and the
previous option belongs to that option: blank, box glyphs only, or **indented past
the column the numbers sit in**. That indentation is what tells a description from
a paragraph, and it is measured in columns rather than bytes — the descriptions
this exists to read are in whatever language the prompt is, and one Cyrillic letter
is two bytes against a box glyph's three. `test/fixtures/menus.json` carries the
real screen, captured off the pane rather than typed from memory, and both
implementations run against it.

**And the agent's own input box is not a menu, though it is drawn like one.** It
carries the very same `❯`, and what sits under that `❯` is whatever is being
typed: a message beginning "1. …" newline "2. …" drew two answer buttons before it
had been sent, and pressing one would have submitted the half-written message with
a digit on the end. Reported from the phone as the buttons appearing while the text
was still in the box.

What tells the two apart is the space after the glyph, and it took a capture to
find: the composer draws a **non-breaking** one, a menu pointer an ordinary one.
That is also what made the indentation rule miss it — `indentOf` counted the
non-breaking space as text, so the option line measured one column shallower than
the lines wrapped under it, which is exactly the shape of an option with a
description. Both halves are fixed and either would do alone: a non-breaking space
is a space to `indentOf`, and a line of the input box brings no chrome with it
(`composerPrompt`, `detect.InputBox`). Measured on Claude Code v2.1.222 at 51
columns off two real panes — the box with the list in it, and `/model`, which is a
real menu and still detected. Both are in the shared fixtures.

**Typing into a session that has never counted is not work either.** The rule that
a person at the keyboard is not the machine was written for a session whose agent
had already run a turn — `sawLive` — and a session just opened has not. So the only
evidence of work was the screen changing, and the screen was changing because the
first message was being written into it: the tab swept purple beside the one that
was really running, and thirty seconds after the last keystroke the watcher
announced the session as *finished*, four times in five minutes (`watch: done
pockterm (quiet for 30s)` in the journal, which is what made this measurable rather
than an impression).

`detect.InputBox` answers it, and it is the same measurement as above: the box and
the counter are drawn by the same TUI, so a pane showing the box and no counter has
no turn running in it, whether or not one has ever been seen. The tab is neutral —
`ActivityUnknown`, nothing has happened, which is the honest claim — and nothing is
announced, because an agent that has not started a turn has not finished one. It is
read fresh on every poll rather than remembered: a session that ran an agent and
dropped back to a shell is a shell now, and for a shell a changed screen is still
the only evidence of work there is.

The mark's upper half lives in `#tabs`' own `padding-top`, given back to the layout
by an equal negative margin: the strip scrolls sideways, so it clips both axes, and
a taller strip would move `☰` down — the drawer's `❮` is measured against it.

It rides in the session list (`state` on each entry, filled by the server from
`Presence.Activity`) rather than having an endpoint of its own: a name and its
state fetched separately can disagree, and the disagreement would show as the
wrong tab lit up. tmux never fills that field.

**Every session is watched; only the ones a page has opened are announced.** Those
were one thing, and being one thing meant a session was not watched at all until a
page attached to it — so after a deploy every tab went neutral and stayed there.
The watcher's state is per process and CI installs a new binary several times a
working day: a session started in the morning and left running had no colour and
raised no "finished" until it was opened again by hand. Found by reading
`/api/sessions` on the host and seeing no `state` on a session that was visibly
working.

`Options.Sessions` is the roster, swept on every tick, and `observe` adds what it
finds; `Watch` — the attach path — is the only thing that sets `notify`. So the
strip is right about everything tmux has, and the phone is told about the sessions
it was asked to be told about, attaching once being the asking. Sessions still
leave the same way: a `capture-pane` that fails removes one, which is what keeps
the sweep from re-adding a closed session for ever.

**Green expires after ten minutes** (`doneFresh`), and that is the other half of
watching everything. Green means gone quiet *after doing something*, which is news
while it is recent and nothing at all once it is old — and the distinction used to
come for free, because a session was watched only from the moment a page attached
to it and had no history to go stale. Reading everything from the start turned every
session that had ever run green for good: reported as "only now everything is
green", which is a strip that has stopped saying anything. Stale goes back to
neutral rather than to a fourth colour, because "quiet for hours" is exactly what
the neutral tab already means. The badge does not fade with it: what is still
running is a fact about now, however long ago the agent stopped speaking.

The page polls it every 3s, and only while the terminal is on screen and the page
is in front — a pocketed phone holds its socket for hours, and polling tmux for a
strip nobody can see is work for nobody. A `visibilitychange` refresh goes with
it, because coming back is exactly when the answer is most out of date. **The
state is applied as a class, never by rebuilding the row**: a rebuild takes the
focused button with it and a WebView answers that by raising the keyboard, so a
session flipping between working and done would flip the keyboard with it.

The purple sweeps over 4.2s and `alternate`, with a per-tab phase set from the
session name (`workingPhase`). It was 1.4s one-way with every tab in step, which
read as one decoration flickering along the whole strip; the name is the source of
the offset so a tab keeps its phase when the row is rebuilt instead of jumping.

**The fill answers what the agent is saying, and a fourth question is what it left
running.** `watch.Background` reads the shells and monitors off the agent's own
footer (`detect.ReadBackground`, on the same poll as the colour, so the two cannot
describe different moments) and the tab carries how many on **heraldic shields in
its bottom-right corner** (a `clip-path` polygon: flat top, pointed bottom, the
digit in the upper half) — in the corner rather than after the name because the row
scrolls sideways and the names are the only thing worth reading along it.
A session at "done" with two monitors alive is not a session with nothing left,
and the colour cannot say so: it goes green the moment the agent stops speaking.

**One plate per kind, and for a while it was one shield for both.** The sum
answered "is anything still running" and refused every follow-up: a shell is
something started and forgotten, a monitor is something still watching for an
answer, and `3` said neither. The argument for adding them up was that two glyphs
in a corner that size are a smudge — the owner, who is the one reading the strip,
says otherwise. Nothing else moved: the footer has always counted them apart and
the session list has carried both numbers since the badge existed, so what
changed is only that the page stopped summing them.

**Three signals, all decided by looking at them on the phone.** Glyph: `▸` for
the shells, the same mark the strip gives a shell session, and `◉` for the
monitors. Colour: cyan for the shells, green for the monitors — green is the
strip's own "gone quiet after doing something", and of the two a monitor is the
one still waiting to report. Shape: the monitor keeps the heraldic shield, the
shell points right, in the same box and at the same size. Two identical shapes in
one corner were being told apart by colour alone, which is one signal for a plate
read at 9px; the shell's is flat down the left with the point on the right rather
than a bare triangle, because the digit has to stay readable inside it.

They are drawn as the pseudo-elements of a `.bg` span (`data-sh`, `data-mon`),
because the button's own `::before` is the question's `!` and one pseudo-element
cannot carry two plates. Still not text in the button, for the same reason the
state is a class — the label is the session's name and rewriting it rebuilds the
button under the finger — and `data-bg` on the button counts the plates rather than
the processes, which is what the corner reserves room for.

Only the footer counts, and only its lowest line with a number in it. The same
words appear in the line an agent prints when a turn ends ("Cogitated for 2m 23s ·
1 shell, 1 monitor still running"), which was true when printed and says nothing
about now — that one is skipped by its wording, and output scrolled above the last
few lines is out of range by position.

**The drawer says all of it too, in the strip's own colours.** It is the list you
open to see what else is running, and it was the one surface that could not answer
that: a row said what a session *is* — its button, its folder, its age — and nothing
about what it was doing. The same three states, the same keyframes at the same
duration, the same per-session phase, because a row and a tab describing one session
differently is worse than either of them saying nothing. What differs is only what a
row has room for: the sweep runs its width, the `!` straddles its top edge at the
left instead of centred, and the plates stand in its own bottom-right corner, one
size larger. They are the very same rule — the CSS for the shapes, the glyphs and
the colours is shared, and only the size and the padding differ — because a row
and a tab disagreeing about a session is exactly what this section exists to
prevent.

Two things make it honest rather than decorative. **The rows are painted, never
rebuilt** (`paintRows`) — the same rule the strip follows, and here it also protects
the armed `✕`: a session flipping between working and done would otherwise disarm a
confirmation half way through. And **the poll runs while the drawer is open**, the
terminal being on screen no longer being the only reason to ask: with nothing
attached the drawer is all there is, and a colour that was true when the drawer
opened is exactly the claim this was built to stop making.

**The mark is a cell of its own beside the name, never inside it.** `.name` is the
session's name and nothing else — the page reads it back to attach, to rename and to
close — and a glyph spliced into it produced a session called `⭐pockterm-ui-oWck6x`
that tmux had never heard of. Four tests failed on that, which is the cheap version
of the same defect on a phone.

## The row is the owner's, and a held tab is carried

tmux orders its sessions by name, which is the one order nobody chose: the strip is
read left to right dozens of times a day, and the session you keep coming back to is
not the one whose name sorts first.

**The gesture is the press that already existed.** A hold picks the tab up — and
puts the plate under it, which is what the hold used to be for on its own — travel
then rearranges the row, and a press that does not travel is still just the question
about the mark. Which of the two it was is decided by the finger rather than by a
mode. Not a plain drag: that scrolls the strip, which a row wider than the screen
needs, so the pickup costs a hold exactly like the plate. The one non-passive
listener here is that `touchmove`, because while a tab is being carried the browser
must not take the gesture as its own sideways scroll.

**Where the tab goes is the finger's x, and reading the y as well is what broke
it.** The first version asked `elementFromPoint` what was under the finger and
inserted the held tab beside whatever tab that was — which needs the finger to stay
inside a strip 34 pixels tall at the very top edge of the screen. A thumb travelling
sideways across it arcs out of it within a centimetre, the point then lands on the
terminal, and the row stops rearranging while the gesture is plainly still going:
reported from the phone as the carrying stopping when the finger is taken up or
down. `dropIndex` in `web/js/carry.js` counts how many of the other tabs the finger
is past the middle of, and there is no y to pass it — vertical travel during a carry
means nothing, because there is one row and no second place to drop a tab.

**And the hand holding the tab covers it.** Everything the carry had to say was said
under the finger: the tab lifts, the row rearranges beneath it, and none of that is
visible to whoever is doing it — "под пальцем не видно". Two answers, both about what
sticks out around a thumb. The lift is a ring in the accent colour rather than a
shade, since a shade is only readable on the part that is hidden. And the plate stays
— the same `#kind-help` that answered what the mark means, now saying which session is
in hand and following it along the row, dropped `CARRY_DROP` (44px) below the strip
rather than the 4px the question's plate uses, which is under the pad of the finger.
It is one element and two claims, so it carries `carrying` while it is making the
second, and the question's own timer is cleared: a carry lasts as long as it lasts,
where the answer about a mark expires.

**A mouse carries a tab by a plain drag, and needs no hold.** Every listener here
was for touches, so on a laptop the row could not be rearranged at all — reported
as the tabs not moving in the web version. The hold is not copied over, because the
hold buys the gesture back from the strip's own sideways scroll and a mouse scrolls
that with a wheel instead of by pushing it: five pixels of travel is what tells a
drag from the click that switches session. `carryTo` and `dropCarry` are shared by
both, since two implementations would be two answers to where a tab goes, and
`mousemove`/`mouseup` are on the document for the same reason the y is not read —
the pointer leaves the row. A release ends in a click on whatever is under it, so
the drag sets `helpHeld`, which is the same thing that swallows the click at the end
of a hold.

**A touch leaves mouse events behind it, and those are not a mouse.** They arrive
after `touchend`, and read as a gesture they would clear the suppression the hold
had just set — turning "what is this tab" into a switch to it. Anything within 700ms
of a touch on the strip is that echo and is ignored.

**The order lives in tmux, on the sessions themselves** (`@pockterm-order`, beside
`@pockterm-kind`), for the same three reasons the kind does: CI restarts this binary
several times a working day, a second phone must see the same row, and a session
that is closed takes its slot with it instead of leaving a hole in a list somewhere.
`SortByOrder` puts the placed ones first, in their numbers, and leaves everything
else where tmux had it — so a session started after the last drag lands at the end
of the strip rather than in the middle of a row somebody arranged. The sort is
applied where the list is served, not in the page, because the drawer's list and the
strip must not disagree about it.

The page sends **names, not indices** (`/api/sessions/order`), and the server stamps
each one with its place: a session closed between the drag and the save is then
simply not found, which costs nothing — the row is redrawn from tmux on the next
poll anyway. Every name is checked against the list the server itself just produced,
because the value reaches a tmux command line.

`renderTabs` refuses to rebuild the row while a tab is being carried, and
`saveTabOrder` writes the new signature itself: a rebuild takes the button out from
under the finger, and on a WebView it hands focus back to the terminal, which raises
the keyboard.

## A tab also says what it is, and that is a different question

Colour says what a session is doing; **form says what it is**. A tab carries the
glyph of the button that started it, before the name — `▸` shell, `✦` claude,
`⚡` yolo, `↻` continue, `★` for one the owner added — and the drawer names that
button in the row's meta line, before the window count. The glyphs are the `+`
menu's own, so there is nothing to learn: a tab marked `⚡` carries the mark of the
button that was tapped to make it. Two vocabularies would drift, so there is one
(`web/js/kinds.js`), shared by the menu, the strip and the drawer.

The question exists because **the name stopped being able to answer it**. Sessions
are named after the folder they were started in, so `natal` and `natal-2` are one
project opened two different ways, and which of them is the yolo one was nowhere
on screen.

The drawer's row carries two more facts for the same reason, and both replaced
`1 window`. That count was a constant: the Makefile creates a session with one
window, and the page can neither make a second nor reach one — it attaches with
`new-session -t`, sharing the session's windows, and has no window switcher. So it
said the same thing on every row for as long as it existed. What is there now
varies: **where the pane actually is** (`pane_current_path` through
`session.ShortDir` — the name says where the session was *opened*, and one opened
in `~/work` spent an afternoon in `~/work/self` with nothing saying so) and **how
long it has been up** (`shortAge`, one coarse unit — which of these is from
yesterday). The path is shortened on the server because the two paths it is
measured against are the host's: `/api/dirs` tells the page what the root is
*called*, never where it is.

**tmux keeps the fact, and the Makefile is what writes it there.** The server
passes `KIND=` beside `DIR=` and `PREFIX=`, the Makefile stamps it on the session
as a user option (`@pockterm-kind`), and the server reads it back in the same
`list-sessions` that fetches the row — so a name and its type cannot be fetched
separately and disagree. Through the Makefile for the same reason `PREFIX` goes
that way: only it knows which number came out free, so only it can say what to
stamp. That also means a session started by hand from a shell is typed, because
each target carries its own default.

Three things follow from where it is kept rather than from what it is. It survives
a rename, because the option belongs to the session and not to its name. It
survives this binary's restarts, which CI does several times a working day. And
there is no register of the server's own to drift out of step with tmux — the
mistake that would show up as a tab labelled after a button that started something
else.

`session.Kind` is the gate: the value reaches a make command line and then a tmux
command inside the recipe, and what may pass is a known preset's name or
`custom:<id>` of a button that exists. A button by **id and not by label**, so
renaming it keeps the sessions it started; an id the store no longer has draws the
shared `★` and no name at all, rather than guessing.

**And make's own variables do not travel into the session.** A variable given on a
make command line is exported to the recipe *and* carried in `MAKEFLAGS`, so every
session the page started held `PREFIX`, `DIR`, `KIND` and `CMD` in its environment
— and a `make` typed by hand inside that session inherited them. Measured on the
author's own host: `make custom CMD=qwen` in such a session came out named after the
folder of the session it was run from and stamped with the button that had started
*that* one, which is a session lying about what it is.

**The cleaning goes on the pane's command, and the obvious placement does nothing.**
`env -u … tmux new-session …` changes the environment of the tmux *client*, and the
pane is started by the *server* — running since the first session, carrying whatever
it was started with. That version was written, shipped and then measured: the
variables were still there. What works is wrapping the command the pane runs
(`clean="env -u …"; cmd=$(1)`; the pane gets `"$clean $cmd"`), because tmux hands
that string to `sh`, which splits the words and honours the quoting the callers
already use. `-e VAR=` on `new-session` also reaches the pane but only empties the
variables, and an empty `DIR` is worse than an inherited one — `DIR ?= $(CURDIR)`
then keeps the empty value.

`TestExampleMakefileKeepsMakesVariablesOutOfTheSession` reads the `spawn` definition
rather than the file, because a mention in a comment is not a variable being unset,
and the UI test reads `/proc/<pane_pid>/environ` of a session the page started —
which is what caught the placement being wrong. The host's own Makefile is an
ansible template (`pockterm_app`), so the same lines have to go there separately.

**No `=` before the name in `set-option`.** That prefix means "exact match" to the
commands that take a session (`rename-session`, `kill-session` both use it here),
and `set-option` reads its `-t` as a pane instead: it answers `no such session:
=claude` and the stamp silently never lands. Found by a real run, which is also
what proved the rest of the chain; `TestExampleMakefileStampsTheKind` now refuses
the form outright.

A session nobody stamped says nothing, and the page draws nothing — the same rule
as `ActivityUnknown`. The one exception is coarse on purpose:
`tmuxcmd.KindFromStart` reads `#{pane_start_command}` and answers **"shell" or
nothing**. Which button ran `agent-run --dangerously-skip-permissions` is the
Makefile's knowledge and this program refuses to hold it, so the stamp is the
answer about buttons and this is the answer about shells — for a session started
before the Makefile knew how, or by hand with `tmux new`. It never overrules a
stamp.

**The mark is picked from a grid, and that replaced a trick.** The way to give a
button a glyph was to type an emoji at the front of its label: something you had to
know, and a character out of a name that has 24. The owner's own row was three
custom buttons all drawing the same `★`, which is what he was looking at when he
asked for this. `MARKS` in `web/js/kinds.js` is the vocabulary — a curated set
rather than a keyboard, because the glyph is read at 13px on a tab — and the picker
is a popup grid beside the label field, since the mark and the label are the pair a
button is named by. Picking the glyph already chosen clears it: one tap in, one tap
out, rather than a button of its own for "no mark".

Three things about it were wrong on the first phone that saw it, and each is a rule
worth keeping. **The grid opens under the button that opens it** — it was appended at
the end of the panel, a screen away from a 44px target. **That button had been drawn
as a full-width bar**, because `#buttons-box .add button` styles the Add button and
an id selector loses to it: `#buttons-box .add #custom-mark` is what wins.
**Nothing in the picker may move the focus** (`keepsTerminalFocus` on the button and
on every glyph): hiding the grid hides the element that has focus, and Android hands
focus back to whatever had it before — which raised the keyboard over the grid being
used.

A fourth followed on a laptop: **the mark has to share its line with the name.**
Every input in this form is `flex: 1 1 100%` — one field per line, which the command
wants — and the name inherited that basis and wrapped to the next row, leaving the
mark button alone above it, a control belonging to nothing on screen.
`#buttons-box .add #custom-label` gives that one field `auto` instead. The field is
labelled `название` rather than `подпись`, because what it holds is the button's own
name and the row it appears in reads as one.

**The form shows the glyph the button will be drawn with, not the one that was
picked.** Nothing picked is the common case, and a `⭐` on the form while the row two
lines up shows `❄️` describes the form's own state instead of what is being edited —
reported as "сейчас там звезда всегда". `paintMarkButton` asks `markOf` the same
question the row and the tab ask, so the form previews the answer; it follows the
label as it is typed, because that is one of the things `markOf` reads. The button is
only *lit* for a glyph that was actually chosen — that is a different claim, and the
grid's highlight is where it belongs.

**U+FE0F asks for the colour form and does not get it on its own.** The marks were
stored and drawn with the selector and still came out monochrome on the tabs and in
the `+` menu, while the drawer's list — heavier weight, larger size — reached the
colour font and showed them properly: two answers for one glyph, which is the defect
whichever of the two is prettier. The stack is the reason. `font-family: system-ui`
resolves to a font that has a *text* glyph for `❄` and `☀`, and a font that has the
glyph is where the lookup stops. So the mark now lives in a `.kind` cell on every
surface — the strip, both `+` menus, the drawer's rows and its button list — and that
cell puts the colour fonts first (`Noto Color Emoji`, `Apple Color Emoji`, `Segoe UI
Emoji`) and asks outright with `font-variant-emoji: emoji`. Both halves are needed:
the property is recent, and the stack alone still loses to a text glyph in a font
listed ahead of it. The monochrome-only marks (`▸ ✦ ↻ ⬡`) are untouched, since no
emoji font has them and the lookup falls through as it always did.

Two things follow from the cell. The tab's mark is **no longer dimmed** — `opacity:
0.7` on a coloured glyph reads as a washed-out version of the label, which is the
thing this was fixing. And the gap between mark and label is a **margin on the cell**
rather than a space in the text, so a button with no mark is not indented by a space
standing for nothing — `assert.match(text, /⚡ Ярость/)` had to become `/⚡\s?Ярость/`,
the space having stopped being text.

**The glyphs carry U+FE0F where they have a colour form** (`❄️`, not `❄`). In text
presentation a mark takes the colour of whatever it sits in, so on a tab it came out
the same shade as the session's name — a mark nobody notices. The ones with no colour
form stay monochrome and are on offer as such; two of the four defaults are drawn
with them.

`markOf` is the one order of precedence, and every surface goes through it: the mark
that was picked, then a mark the label leads with (which is how this worked before
and still does), then what the id is known for — a default's own glyph, or the name
of an agent this recognises — and the shared `★` when nothing says anything.
`kindMark` answers a tab by looking the button up and calling the same function, so
the menu and the strip cannot drift into two glyphs for one button.

Two names are guessed at and no more: **Claude is cold, Codex is sol** (`❄`, `☀`,
the owner's own vocabulary, and `claude`'s stock glyph changed from `✦` to match).
Two agents are what this serves; a third would be a guess, and one tap in the grid
overrules either.

**The mark lives in a span of its own, never in the label.** Same reason the state
is a class and the badge an attribute: the kind arrives on a later poll than the
name — the session list is fetched before `/api/presets` answers — and rebuilding
a button under a finger is what raises the keyboard. Rewriting a child's text does
not.

**A long press asks what a glyph means.** There is no hover on a phone and the mark
is far too small to be a target of its own, so the press that would switch session
holds instead and a plate appears under the tab with the mark and the button's name.
Under it, because the strip *is* the top edge of the screen. It cancels if the finger
travels — that gesture is the strip's own sideways scroll — and it swallows the click
it ends in, or asking what a tab is would switch to it. The UI test drives it through
the browser's own touch input (CDP `Input.dispatchTouchEvent`), because only a real
press produces the click that has to be swallowed.

## A session is started in a folder, and named after it

The drawer has two lists and shows one at a time: the sessions, and the folders
of the projects root (`/api/dirs`, one level deep, no dotted directories). The
root is the first row and by its own name — a session in `~/work` is ordinary,
and a label like "the root" hides which directory that is. Tapping a folder does
not start anything; it points the four presets at that folder, which is the only
menu there is, because two would drift.

`POCKTERM_SESSION_DIR` is both the Makefile's directory and the projects root.
One setting rather than two: the second would have to be kept in step with the
first, and in every deployment this was written for the answer is the same path.

**The name is still the Makefile's to choose.** The server passes `DIR=` and
`PREFIX=` and nothing else; which number is free as *both* a session and a group
name stays in the one place that knows — see the trap below for what happens when
that is got wrong. `session.Prefix` only decides what to number: the folder,
sanitised to what tmux and a phone tab can carry (no `.` or `:`, 24 characters),
and the root's own basename for the root. An empty result — a folder whose name
survives none of that — passes no `PREFIX` at all, leaving the Makefile's own
default rather than inventing a session called `-`.

A Makefile that knows neither variable still works: make takes an override for a
variable it never reads, so the session opens where it always did under the name
it always used. That matters here because the host's Makefile is not this
repository's file — it is a template in the `pockterm_app` ansible role — so the
folder reaches the tab only once that role has been applied.

`session.ResolveDir` is a gate, not a formality: the value becomes make's `DIR=`,
and the page may only name one plain folder inside the root. `..`, a separator, a
leading dot and an absolute path are all refused, and the reason travels back as
text the drawer shows.

**`pockterm-` was too wide a namespace to reserve.** Client sessions are
`pockterm-client-<id>` since 2026-08-04, because sessions are named after folders
now and `~/work/pockterm` is a folder: its second session is `pockterm-2`, which
the old prefix hid from the list and made unattachable, with nothing anywhere
saying why. Worse, ids count from 1 per process, so that name is one of the first
two a page takes for itself — and `new-session -A -s pockterm-2` would have
attached the phone to the user's own session instead of making a client for it.

## The settings are in the drawer, and the ⋯ menu is gone

Text size, the notification switch, `〰 smooth`, the keyboard mode, the input log,
the version line and Install used to sit behind `⋯` over the terminal. That is the
surface you work on: levers touched once a month were taking permanent space from
the one place where every tap matters, and the drawer — where you go to decide
something rather than to do something — had room to spare. So they moved, **and
they moved rather than being copied**: two places holding one lever is how the two
drift, and the ⋯ button went with them.

`#settings` is a panel at the bottom of the drawer with the toggle pinned under it,
so opening the drawer never costs the settings a scroll and a long list of custom
buttons cannot push the toggle off screen. `closeDrawer` collapses it for the same
reason it closes the rename field: leaving it open would have it waiting behind a
closed drawer.

**A pull down inside the panel closes it**, because that is where the panel goes:
it opens upward from the row at the bottom of the drawer, so dragging it back down
says the same thing as tapping that row — and it is what a hand tries first. It
counts only from the top of the panel (`scrollTop <= 0`) and only when the drag is
mostly vertical: the panel scrolls under the same finger, and a list of buttons that
collapsed while being scrolled would be worse than one more tap. It goes through
`showSettings`, so it is remembered as the owner's answer.

**Collapsing it is not the same as closing it, and for one version it was.** Open
or closed is remembered (`pt-settings-open`) because for anyone who keeps the text
size or the keyboard mode within reach it is a preference, not a state — and the
drawer collapsing the panel on the way out wrote "closed" down every time, so the
panel had to be reopened on every visit. `showSettings` is the owner's answer and
records it; `paintSettings` only draws, and `collapseSettings` is what the drawer
calls. `openDrawer` paints what was last answered. A preference must not be
overwritten by the mechanics of the thing it is a preference about.

`▾ hide the bars` stayed in the key bar. It is a one-tap action on the working
surface, not a setting, and its way back (`▴`) is the only thing on screen when
everything is hidden.

Anything in the tests that pulls a lever goes through `startStand`'s `openSettings`
and `shutDrawer`, both by state — and `shutDrawer` waits on the panel's geometry,
not its class: it slides out over 200ms, and a swipe aimed at the terminal in the
meantime lands on the drawer still covering it.

## A custom button carries a command, and the Makefile still launches it

The four presets are make targets, and the rule they were built on holds: the page
sends a name, and the Makefile is the only thing that knows what a session is —
the sandbox wrapper, a free number, its own systemd scope. What the four could not
answer is a fifth agent. `qwen` or `opencode` meant editing a Makefile that on the
host this serves is an ansible template: a laptop, a deploy and a working day
between wanting it on the phone and having it.

So a custom button **parameterises one target instead of adding its own**:
`session.CustomTarget` (`custom`) takes the command in `CMD=`, and the recipe wraps
it in the same launcher as everything else. A Makefile without that target fails
with make's own message, which the drawer shows as text — that is also what the
host here will do until the `pockterm_app` role's template has it.

`session.ValidCustom` is the gate, and it is a gate: the value reaches a make
command line and make hands it to a shell inside the recipe, single-quoted. Letters,
digits, spaces and `- _ . / = : , @ +`, starting with a letter, a digit or a path —
nothing that can end that quoting or start an expansion. A refusal travels back as
the reason it was refused, because on a phone there is no log to open.

The list lives on the host (`POCKTERM_PRESETS_FILE`, next to the notification mode)
for the same three reasons that switch does: what the buttons start happens on the
host, a second phone or a reinstalled PWA must find the same ones, and CI restarts
this binary several times on a working day. Ids are the host's to hand out, so a
rename keeps the button rather than making a new one, and the page saves **the whole
list** and draws what came back — never what was just typed.

## The four buttons are entries in the list, not a menu written into the page

They were a map in Go (`session.Presets`) and four `<button>`s in the HTML, and both
were the answer to "what can be started". That is two answers, and it showed the
moment either could change: a default renamed or removed was still in the menu, in
its stock words, starting what it always had.

So the stored list is the whole set. A default is an entry whose **id is a make
target** (`shell`, `claude`, `yolo`, `continue`) and whose command is empty, which is
`Custom.Builtin()` and the one case `ValidCustom` lets through without a command —
the Makefile decides what that target does, as it always did. `DefaultButtons()`
carries their labels, because a label that can be renamed has to be stored
somewhere; the glyph stays in the page (`web/js/kinds.js`), which is its own
vocabulary and shared by the menu, the strip and the drawer.

**Editing a default's command moves it onto the `custom` target and keeps its id.**
The id is what `KIND=` stamps and what a tab is marked from, so `claude --model opus`
is still `✦ claude` on every tab it opens. `Buttons.Resolve` is the only place that
turns a preset name into a target and a command, and **the list is the authority**: a
button the owner removed cannot be started however well-known its name, or removing
it would have been hiding it. The UI test asks the endpoint directly for a removed
`shell` and requires a 400.

**The stored file grew a shape.** It was a bare array of the owner's own buttons;
now it is `{"buttons":[…]}`. The difference carries a fact no array could: an empty
list means every button was removed and must stay removed, while a bare array is a
store written before the defaults were in it — `parseButtons` puts them back in
front of what it holds. Without that, the first release would have looked like it
deleted the four on every host that had ever saved a custom button.

**A reset restores the defaults and nothing else.** `Buttons.Reset` drops the
built-in entries, puts `DefaultButtons()` back in front, and leaves the owner's own
where they are: the four are a default, and `qwen` typed on a phone is not. It is the
store's operation rather than a list the page could send, because a page older than
the binary would otherwise install whatever it thought the defaults were — the
endpoint takes `{"reset":true}`. Two taps on the button, like every other removal
here, since it does undo renames and commands.

Both menus are written from the list (`renderCustom`), and opening one waits for
`customReady` — the first `/api/presets` answer. A `+` tapped before it arrived would
open an empty popup, which reads as "nothing can be started". On a host with no store
at all (404) the page falls back to `DEFAULT_BUTTONS`: not a second source of truth,
since there is no list there to disagree with.

**A button may name a make target instead of carrying a command.** The four are
targets; a Makefile has others that they do not cover — the author's own has
`cont-yolo` — and reaching one from a phone meant typing `make cont-yolo` into the
command field. That runs make *inside* the session the button just created: a second
session appears beside it and the first one dies. So `make <target>` in that field
now means that target (`asMake`, `Custom.Target`), which is also what the rows
already show for the defaults — one vocabulary, and the thing to type is the thing
on screen. `targetOK` is a narrower gate than `cmdOK`: a name, no arguments, no
path, nothing that reaches a shell. The target is the owner's own Makefile's, at the
same trust as the four, and make answers an unknown one with its own message which
the drawer shows as text.

**A button can be changed, and that is what the id was for.** `✎` on a row loads it
into the two fields the form already has and `Добавить` becomes `Сохранить`; the row
being edited is outlined, because with the label retyped there is nothing else on
screen saying which button the fields are about, and the keyboard has by then put
them a screen apart. The one form rather than a pair of fields per row, for the same
reason the session list has one rename field: there is no room, and a form that
appeared under the row would appear under the keyboard.

Without it the way to fix a command was to remove the button and type it again — the
same button to look at, and a different id. The id is what the tabs it opened are
marked with (`custom:<id>`, `session.Kind`), so every session that button had started
would have been left marked by a button that no longer exists, drawing the shared `★`
and no name. Nothing on screen would have said that retyping cost anything. The edit
sends the same list with the same id in place, which the server already supported —
`Buttons.Set` keeps an id that arrives and hands out numbers only for entries without
one.

**`✕` takes two taps, and the first is the question.** It took one, on the argument
that this removes a button rather than a running agent and typing it back is two
fields — and a stray thumb removed one with nothing asked, which is how it was
reported. The argument was about what a mistake costs, and the gesture is the wrong
place to encode that: the two rows look alike, live in the same drawer, and are hit
the same way, so a `✕` that asks in one list and not in the other is a `✕` nobody
reads before pressing. `armTwice` is the one implementation both use — the session
list had it first, inline — because two copies of a confirmation drift into two
different answers to one gesture. The arming lapses after `ARM_MS`, since a button
left armed is a button whose next tap, minutes later, does something other than what
it says.

A second tap on `✎` cancels, and `closeDrawer` cancels too: a form still saying
`Сохранить` about a button chosen a day ago saves the wrong thing when it is finally
tapped. The UI test proves the id survives by reading `data-preset` off the menu
entry before and after — the label and the command are what the owner sees, and both
of them changing is exactly the case where a new id would look identical.

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

## The session list is a drawer, not a screen

It was a screen of its own, and switching to it tore the terminal down: the
socket closed, `term.reset()` ran, and coming back redrew from tmux. The list is
what you open to see what else is running, so what is running has to survive it.

`#screen-sessions` is a fixed panel over the terminal now, off-screen by a
transform rather than by `hidden` — a transform animates and leaves the terminal
underneath untouched, where `display: none` would reflow it. `☰` toggles it, `✕`
sits where `☰` is so the same spot closes it, and a tap on the scrim closes it
too. With no session attached the terminal screen is hidden and the drawer is all
there is, which is where the page starts and where closing the last session
lands.

The tab strip is the same list in miniature, so it carries the same `+` with the
same four presets — and the same handler, because two would drift.

**A swipe to the left closes it too**, which is where the panel goes anyway — the
closed state is a transform off the left edge, so the gesture and the animation say
the same thing. It closes once the drag is unmistakably horizontal and past 45px;
nothing follows the finger, because the transition already covers the distance. Two
drags must not trigger it and both were the reason for the guard: the list scrolls
vertically under the same finger, and the rename field drags a caret sideways.

**Closing the tab you are in steps back to the one you came from.** It used to land
on the modal drawer whatever else was running, which was reported as the interface
sticking: the tab under the finger was gone and the place it had been was no longer
anything to tap. `visited` is the order tabs were attached in, and `stepBackFrom`
walks it, skipping names tmux no longer has; the tab beside the closed one is the
fallback for a session nothing was visited before, and the drawer is what is left
when nothing is running at all — which is the case it was built for.

**With nothing attached the drawer is modal.** The terminal screen is hidden then
and `☰` lives in its header, so a drawer that could still be dismissed left a
black page with nothing to tap and no way back but a reload — reported after
closing the very session being used. `❮` and the scrim are gone in that state
rather than inert: an exit that does nothing is worse than no exit. The swipe obeys
that too — it goes through `closeDrawer`, which refuses then, rather than checking
for itself.

**A touch aimed at the terminal must wait for the drawer to be gone**, and that is
the same lesson as `shutDrawer`'s, learned a second time. The panel slides out over
200ms; `stand.attach()` waited only for the terminal to appear, so a gesture
dispatched right after it landed on a `<ul>` in the drawer, never reached
`#screen-term`, and the test timed out waiting for a move nobody received. It was
latent for as long as the page was quick enough and started failing when the drawer
grew four rows — a change to the timing, not to the page. `attach()` now waits on the
geometry too.

Anything in the tests that clicks a session has to open the drawer **by its
state**, never by tapping `☰`. `☰` toggles, and the restore of the last session
happens after load, so a blind tap raced it: the drawer that had just opened
itself was closed again and the next click landed on the terminal. Two suites
failed that way about one run in three before `startStand` grew its own
`openDrawer`.

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

**A pane wraps a sentence, and the body used to be one line of it.** The notice
that reached the phone said `API Error: 529 Overloaded. This is a` and stopped
there. The same message from another session arrived whole, which is the tell: a
pane is as wide as the narrowest client attached to it and this page attaches
phones — that session was 51 columns, the other 175. So the marker `●` is on the
first line only and the rest is a continuation indented under it. `wrapped` puts
them back together, ending the paragraph where the pane does: a blank line, a line
back at the margin, another `●`, a tool's `⎿`, or anything already known to be
interface. `clip` still caps the result, so a long answer is cut at 200 characters
with an ellipsis rather than mid-clause with nothing.

Body text comes from `watch.Tail`, not from the last non-blank line: agent TUIs
draw an input box and a shortcut hint under their output, so the last line on
screen is usually `? for shortcuts` or a row of `─`.

**What the agent said comes before what it ran.** Its own lines are marked with
`●`, and what sits under the last of them is the output of whatever it did last —
which is how "pockterm закончил" reached the phone with `{"name":"devops",` as its
whole body, a fragment of a `curl` that was honestly the last line on screen. `Tail`
looks for the lowest `●` line that is a sentence and strips the marker; `● Bash(…)`
is skipped by its shape, because that is the agent pointing at a command rather
than speaking. Reading up from the bottom is the fallback, for a pane with no
marker in it — a shell, or an agent this does not recognise.

Two more lines had to be named there, and both are the interface at its most
convincing — full of words, none of them about the work. The **status line**
(`ctx 71% | dms@ai:~/work/exante (main) $ | Opus 5`) arrived on the phone as the
entire body of "exante закончил": how much context was left and in which
directory, under a title about a session finishing. And the **turn summary**
(`✻ Cooked for 19s`) is true and says nothing the title has not, while sitting
between the title and the sentence you actually want. Both are matched by shape —
`^ctx \d+%\s*\|` and `<one word> for <duration>` — because the numbers and the
verbs change with every release while the shapes do not. The shape has to start
the line, or a "собрал за 4s" in prose would vanish from a notice too.

**A notification cannot be coloured**, and that is the API rather than a decision
here: `title` and `body` are plain strings, and the shade renders them in its own
type. So the colour the status line has on screen cannot come along — which is
another reason not to send that line at all, since colour is most of what makes it
readable in the terminal.

**What is wanted is one switch, and it is the server's.** `watch.Pref` holds
`off`, `pwa` or `pwa+tg`, `watch.Deliver` turns it into the two booleans the
notifier obeys, and the page reads and writes it over `/api/notify` — plus
`notify` in the config frame, so the button is right the moment it is drawn
rather than one request later. Three reasons it is not a browser preference, and
each of them was the design: half of what it controls is sent from the host to a
phone that has this page closed, so the page cannot be the one holding it; a
second phone or a reinstalled PWA would otherwise disagree with what the host
actually does; and `off` has to mean silence in Telegram too, which the old bell
could not do at all. It is remembered on disk (`POCKTERM_NOTIFY_FILE`, under the
user's config directory by default) because CI restarts this binary on every
push to `main` — a mode in memory would come back as the default several times a
working day, and `off` is the state whose loss is loud. Default is `pwa+tg`: an
install must not silence a phone that was being notified before it.

The middle state exists only where a bot token does. `NotifyMode` answers
`telegram` alongside the mode for that reason, and `nextMode` in `js/notify.js`
drops `pwa+tg` from the ring without it — a label promising delivery that cannot
happen is worse than a shorter cycle.

**Two paths raise a notice in a browser, and the weaker one looked like the only
one.** `new Notification(...)` is illegal in Android Chrome: the API is present,
the permission is granted, and the constructor throws. The owner's phone runs
this as an installed PWA, so no notification was shown there at all until
2026-08-04 — and the throw escaped `show()`, taking the rest of the frame handler
with it. `deliver()` prefers the service worker's registration, which is also the
only path that can carry a tap to a page that is gone: a worker's notification
delivers its click to the worker, so `notificationclick` in `sw.js` focuses an
open window and posts it the session, or opens one at `?session=`. Which path ran
goes to the journal (`notify via: …`) — the silence is what hid the defect for as
long as it lasted.

**A notice goes to every open page, not to the pages attached to its session.**
That routing was the whole of "PWA notifications do not arrive", reported on
2026-08-04 with Telegram switched off. The two rules were each sensible and
together they cancelled out: the watcher stays silent about a session somebody has
**visible**, and `Notices` delivered only to sockets attached to *that* session. A
phone has one socket, on the session being looked at — so the only session the
frame could reach was the one it was never sent for, and a question in the session
next to it reached nobody at all. `Notices` is keyed by client id now and `Send`
takes just the notice. Nothing else had to change: the notice already names its
session, and a tap on it already switches there.

**Being on screen is now a per-page answer, and it was everyone's.** The watcher
stayed silent about a session somebody had visible — one rule, decided once, for
every recipient there is. That is the right answer for Telegram, which is one
recipient: a message about what the owner is looking at is noise. It is no answer at
all for the pages, which are several. With a phone open on one session and a laptop
showing the one beside it, a finish in the session on the laptop reached nobody: the
phone was silenced by a screen it cannot see, which is exactly the notice it is
holding the phone for.

So `OnScreen` travels on the event, and the two channels read it differently.
Telegram skips it. `Notices.Send` takes a `showing` predicate and drops only the
sockets that have that very session visible — a page is silenced by what it is
itself showing and by nothing else. Every send says how many pages took it and how
many were skipped (`journalctl -u pockterm | grep notify:`), because "уведомления
не приходят" is otherwise an impression on both sides of the socket.

**A page that was never asked cannot notify, and that looked identical to a broken
switch.** The default mode is `pwa+tg`, so a fresh install starts in a notifying
state — and permission used to be requested only on the way *into* one, which
nobody walks when the switch already says what they want. `show()` then returned
silently on `Notification.permission !== 'granted'`, the one silent return left on
the path. Now the bell asks whenever the mode it moves to notifies, an unpermitted
`🔔` wears a dashed outline saying one tap is the fix, the permission is in the
`hello` line of the journal, and a dropped notice says why it was dropped.

**And the bell is no longer the only place that asks — the first touch does.** The
dashed outline is a fix for whoever notices it, which is a poor thing to hang a
whole install on: the default notifies, so nothing on a fresh install ever asks the
one question standing between the frames arriving and a notice appearing.
`shouldAskPermission` (in `js/notify.js`, so it is testable) decides, and
`armPermissionAsk` fires it from a one-shot `pointerdown`.

Two bounds, both learned from what browsers do rather than from what they document.
It is not asked **on load**: a prompt raised without a gesture is refused outright
by some browsers and shown as a quieter, easier-to-miss UI by others, and a phone
touches the page within seconds anyway. And it is asked **once per install**, which
is why `pt-notify-asked` exists rather than reading `Notification.permission`:
`default` is what a *dismissed* prompt leaves behind too, so the state alone cannot
tell "never asked" from "asked and ignored" — and a page that asks on every load is
one the browser stops letting ask at all. The flag is written before the answer
comes back for the same reason.

The UI stand grants `notifications` alongside the clipboard. Not for convenience:
the first touch in most of those tests is the start of a swipe being measured, and a
permission prompt in the middle of a gesture is a different measurement.

**Every notice names its own icon.** Left unset, Chrome draws a generic bell — and
unpredictably: two notices from this page sat in the owner's shade one above the
other, one bell and one app mark, because whether the manifest icon resolves
depends on whether the page was still there when the worker raised the notice.
`icons/icon-192-notify.png` is the app's own drawing — the prompt and its
underscore — in **white on nothing at all**, and it is passed as both `icon` and
`badge`. No plate behind it: the shade draws its own circle and background, so an
icon carrying one arrives as a square inside a circle. The mark is scaled to fill
its box rather than keeping the installed icon's margin, which left it a smudge at
24px. It is generated from `icon-192.png` (luminance to alpha), so the two cannot
drift into different drawings.

`show()` also no longer consults the page's own copy of the switch. The frame's
existence *is* the decision — the server read the mode at the moment of the event —
and the page's copy is the stale second owner of one fact, changed from whichever
page happened to be in hand.

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
sliding back at the release. One is the floor. That file lives in the `dotfiles`
repository since 2026-08-03 (`tmux/tmux.conf`, symlinked by its installer, and
the small step is behind an `%if` on the hostname — one line is a step for a
thumb, not for a mouse) — changing the step is a change to it and to nothing in
here.

**The count in that binding has to be a literal.** tmux does expand a format in
`send-keys -N`, so a variable works as far as tmux is concerned, but `list-keys`
prints the binding with the format unexpanded and that output is all this server
knows: `ParseWheelLines` falls back to 5 on anything non-numeric. tmux would
scroll one row while the page compensated for five.

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
- **One repaint accounts for every message it can have drawn.** Counting one
  batch per repaint was the first rule and the numbers killed it: xterm renders
  once per animation frame, so several of tmux's answers arrive in one repaint,
  the rest stayed owed, and the shift sat at `MAX_TRACK` — where it stops
  following the finger. A repaint now clears everything sent more than a frame
  ago (`ACK_MARGIN`), because tmux acts on a message at once and it is the
  picture coming back that is slow.
- **The whole terminal screen is the gesture surface**, not the box the text is
  drawn in: the bars take a third of a phone, and a thumb reaching them mid-swipe
  is how a long swipe ends. `#composer`, `#snapshot` and the tab strip keep their
  own gestures.
- **`〰 smooth` in the ⋯ menu turns the shift off.** Whether holding the picture
  between whole lines reads better than moving in whole ones is a question about
  feel — and the shift moves everything in the pane, an agent's own input box
  included, which is what it looks like when it is not wanted. The lever is
  remembered, so answering costs a tap instead of a deploy.
- **A pane with no history cannot answer anything.** Every message is then a
  message tmux has nothing to draw, the air fills up and the shift pins at the
  cap. Two measurements were read as defects before this was noticed, so a test
  that swipes has to print some output first.
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

## The installer does what the README used to ask of a reader

Everything `deploy/install.sh` gained is one shape of defect: a step that was
written down instead of done, and whose absence does not look like an absence.

**A host without `tmux` is refused, not served.** Nothing here works without it —
the phone gets an empty session list, which reads as a broken terminal rather than
as a package nobody installed. `make` is a warning instead, because only the `+`
button goes through it, and its absence turns that button off just as quietly.
Neither was checked at all before. The refusal carries the command that fixes it,
picked off the package manager that exists rather than off `/etc/os-release`.

**The session Makefile is installed, and `POCKTERM_SESSION_DIR` points at it.**
Those were four steps in the README — copy, edit, set the variable, restart — and
the moment they are wanted is the moment a phone has no session on it and no way to
start one, which is the worst possible moment to be reading a README. The root
defaults to the served account's home; `POCKTERM_SESSION_DIR` names another.

Two refusals inside that, and both are about not owning what we did not write. A
Makefile already in the root is never overwritten — `make claude` in somebody
else's Makefile is an unknown target, not a session — and then the variable is not
written either, because pointing the `+` button at unknown targets is worse than
leaving it off. A copy of ours is recognised by `pockterm-sessions` in the header
and left exactly as edited, the file being meant for editing. `GNUmakefile` and
`makefile` count as the Makefile that is there: make reads the first of the three,
so writing `Makefile` beside a `GNUmakefile` would install a file make never opens
and report success.

**A restart happens when the env file changed, and only then.** systemd reads that
file at start, so anything added to it is not in force yet — and the README's
`tee -a` plus `systemctl restart` was where people stopped reading. The condition
matters as much: a restart drops every open terminal, so an install that changed
nothing must cost nobody a reconnect.

**`--tg` runs the pairing that already existed.** `pockterm tg-setup` has done the
mechanical half since it was written; what it could not do is be remembered, and
the part left out afterwards was the restart. Its failure ends only itself — the
install stands and prints the link, because a bot that is not ready yet is not a
reason to have no terminal.

`test/install_test.sh` covers each of those, including both answers where a machine
can only give one: `REQUIRE_TMUX`/`REQUIRE_MAKE` name the tool to look for, so the
missing-tool path is exercised on a host that has it, and a stub `tmux` on `PATH`
lets the happy path run in a container that has none.

## Diagnostics

The page posts what decides an outcome to `/api/log`, which the server writes
to its journal (`journalctl -u pockterm | grep client:`): the environment on
load — version, secure context, which clipboard APIs exist, whether the native
bridge is there — plus copy/paste/upload results and uncaught errors. It is
there because the device this serves has no console anyone can open, and every
fix before it was a guess.

**A refused upload had been the one outcome here that wrote nothing down.** Only
the successful path reported, so "413 при загрузке фото" arrived as a sentence from
the owner with nothing in the journal to put beside it — and 413 is a status this
server never sends. It comes from the nginx in front, whose default body limit is
one megabyte: a screenshot is a few hundred kilobytes and went through for months,
a camera frame is several megabytes and never did. The limit lives in the
`pockterm_vhost` role in the devops repository (`client_max_body_size 12M`, chosen
just above `upload.MaxBytes` so an oversized image is refused by this program's own
words rather than by the proxy's status code), and it takes a deploy of that role
to be in force. The page now names the proxy instead of pasting nginx's HTML into a
toast, and logs the failure with its status and the size.

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

**That no-op needs the build to be reproducible, and for a day it was not.**
`go build` stamps the commit hash into the binary and the build directory along
with it, so every push produced new bytes and every push restarted the unit —
found on 2026-08-04 by a commit that touched only this file and dropped the
terminal anyway. `BUILD_FLAGS` in `make/go.mk` is `-trimpath -buildvcs=false`
for that reason, and `make test-repro` builds the tree twice under different
paths to prove it: same source, same bytes. It is two real cross-compiles, so it
is not part of `make check` — run it when the build line changes. The cost of
the flags is that the binary no longer says which commit it is; the page's
`APP_VERSION` is what identity there is.

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
