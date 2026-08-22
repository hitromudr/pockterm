# Sessions, the drawer and the buttons that start them

Where a session comes from, what names it, and where the levers live. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

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
