# Scrolling, copy-mode and the shift under the finger

The pane is tmux's and the gesture is the page's; these sections are where the two meet. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

## Scrolled back is not the same as copy-mode

While the pane is scrolled back the page shows the round ⇩ that returns to the
live end, and no prompt buttons, the numbered lines on screen belonging to the
past.

**And the ⇩ says when a question is waiting down there.** The rule above is sound
and it had a hole the size of the thing it protects: an answer row is withheld
because the menu on screen may be an old one, so a question that arrives while
somebody is reading back has nothing on screen about it at all. Reported as the
menu not being drawn, and the journal said where the page was —
`{"event":"mode","in":true,"back":24}`, twenty-four lines into the past, with the
agent waiting. So the way back wears the same yellow `!` a tab wears
(`paintWayBack`), read off the same `state` the strip is coloured from, and one tap
brings both the live end and its row. The mark claims a question exists, not that
this screen holds it — and it wakes the stack, or it would be invisible exactly
when it matters, the pager fading after `PAGER_IDLE` and a question arriving being
no kind of scroll.

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
