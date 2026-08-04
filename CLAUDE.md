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
↓ 3.9k tokens)` — and its going away is the event: `watch` reports "done" in the
poll that sees it leave, instead of thirty seconds after the last change. The
silence rule is still there and still needed — a shell running a build has no
counter to read — but it is no longer the only one, and it was costing thirty
seconds of a tab painted as working after the answer was already on it.

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

The mark's upper half lives in `#tabs`' own `padding-top`, given back to the layout
by an equal negative margin: the strip scrolls sideways, so it clips both axes, and
a taller strip would move `☰` down — the drawer's `❮` is measured against it.

It rides in the session list (`state` on each entry, filled by the server from
`Presence.Activity`) rather than having an endpoint of its own: a name and its
state fetched separately can disagree, and the disagreement would show as the
wrong tab lit up. tmux never fills that field.

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
describe different moments) and the tab carries how many on a **green heraldic
shield in its bottom-right corner** (a `clip-path` polygon: flat top, pointed
bottom, the digit in the upper half) — in the corner rather than after the name
because the row
scrolls sideways and the names are the only thing worth reading along it, and green
because what it counts is what is still running after the tab went quiet.
A session at "done" with two monitors alive is not a session with nothing left,
and the colour cannot say so: it goes green the moment the agent stops speaking.
The badge is drawn from `data-bg` through a `::after`, for the same reason the
state is a class — the label is the session's name and rewriting it rebuilds the
button under the finger.

Only the footer counts, and only its lowest line with a number in it. The same
words appear in the line an agent prints when a turn ends ("Cogitated for 2m 23s ·
1 shell, 1 monitor still running"), which was true when printed and says nothing
about now — that one is skipped by its wording, and output scrolled above the last
few lines is out of range by position.

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

Body text comes from `watch.Tail`, not from the last non-blank line: agent TUIs
draw an input box and a shortcut hint under their output, so the last line on
screen is usually `? for shortcuts` or a row of `─`.

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

**A page that was never asked cannot notify, and that looked identical to a broken
switch.** The default mode is `pwa+tg`, so a fresh install starts in a notifying
state — and permission used to be requested only on the way *into* one, which
nobody walks when the switch already says what they want. `show()` then returned
silently on `Notification.permission !== 'granted'`, the one silent return left on
the path. Now the bell asks whenever the mode it moves to notifies, an unpermitted
`🔔` wears a dashed outline saying one tap is the fix, the permission is in the
`hello` line of the journal, and a dropped notice says why it was dropped.

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
