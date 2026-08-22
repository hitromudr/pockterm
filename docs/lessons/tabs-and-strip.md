# The tab strip: state, order and kind

A tab answers four questions at once, and none of them is the others. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

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
