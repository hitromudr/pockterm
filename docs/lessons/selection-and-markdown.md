# Selection, the copy window and the Markdown behind the drawing

The pane is a picture of a message; a copy has to put the message back. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

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
- **A tap on text does nothing, and the room around it is the way out.** Two releases went the
  other way and each cost the same thing: the tap that leaves cannot also be half of a gesture that
  selects. First it left at once, then it held the exit for 300ms so a pair could form — and the
  thumb answered that within the hour, "два средне быстрых тапа выкидывают", the two landing either
  side of the window. A window wide enough for a slow pair is a mode that takes half a second to
  leave. So a tap on text does what it already did with paragraphs picked — nothing — and the ways
  out are the ones in plain sight: `✕ Done`, the blank room, Android's own Copy.

## Less than a paragraph is this page's own doing

The pick takes a whole paragraph, and the answer to "how do I take part of one" was wrong twice in
this file before it was measured. **On Android the gesture that selects a word is the long press** —
and this mode has taken it: it marks the paragraph, and the browser's own is refused so that it can.
A double tap selects a word on a desktop and **nothing at all** on the phone, which is what "выделения
слова ни при каких тапах не происходит" meant. Both earlier answers here were about a gesture that
could not happen.

So the double tap is free — a `width=device-width` page has no double-tap zoom either — and what it
does is ours: **the second tap of a pair selects the line under the finger, and a pair over the same
line again narrows to the word in it** (`selectAt`, `TAP_PAIR` 500ms). The line first because that is
what a script or a run of output is read and pasted in; the word because a line is not always little
enough. Nothing is asked of the platform, so it behaves the same whether or not Android offers its
handles for a selection it did not make itself.

Four things it has to get right, three of them found by the stand:

- **The picks go when a selection is made.** `selectedText` prefers a pick, so a selection standing
  beside one would be invisible to Copy — the same one-owner rule as everywhere here.
- **The ban comes off.** A selection under `user-select: none` is not drawn at all, and the class is
  on from the press that just ended (it is armed at 200ms, and a medium tap is longer than that).
  It exists to refuse the browser's *long* press, which this is not.
- **What was taken last is remembered here, not read back off the selection.** A tap on a highlight
  is how a phone dismisses it, so by the time the pair that should narrow arrives there is nothing
  standing to compare with — on the stand the second pair kept re-taking the line. `lastGrab` holds
  the line and the grain, and is dropped when the window is redrawn, its text node going with it.
- **The pair is counted before any other branch can return.** The early return for "a tap inside a
  selection is not a way out" used to run first, which left the narrowing pair measuring itself
  against a tap two gestures old.

Inside the window every further tap is a second one, so tapping on without stopping cycles line,
word, line — which is why the test pauses between pairs. `test/ui/pockterm.test.mjs` drives it with
real touches (CDP `Input.dispatchTouchEvent`; a synthetic click is not a tap): a single tap selects
nothing and leaves the mode standing, a pair takes exactly the middle line of a three-line
paragraph, a pair over it again takes the first word, Copy hands that word over, and a tap on the
room beside a short line ends the mode.

## The pane draws Markdown, and a copy of the drawing has none

What the agent wrote as `**слово**` reaches the pane as an attribute, and the copy handed over a
bare word — reported as the copy losing Markdown. The text was never the message; it was a
picture of it.

tmux gives the attributes back when asked, so `CaptureHistory` asks (`-e`) and `markdownFrom` in
`js/select.js` reads them into text. **Bold is `**`**, and it is what the pane leaves of `##` and
`###` — see the header note below for the one level that is recoverable and why the other two are
not.

**`#` is the one level the pane carries, and it carries it as an underline** (`headingsFrom`). Four
live panes said there was no level to be had — `\x1b[4m` occurs **0** times across all of them, no
rule sits under a heading, no colour marks one, and the only literal `##` lines are a
`print("## …")` inside displayed source and a command's own stdout. They were wrong in one place,
and only a pane that had printed an `#` could say so: agents write `##` and `###`.

So the measurement was taken **off this program's own pane** — a tape of `capture-pane -e` sampled
every two seconds while an agent printed all three levels, 37800 lines of it, Claude Code 2.1.234:

```
# один     →  \x1b[1;3;4mодин\x1b[0m   bold + italic + underline, one span
## два     →  \x1b[1mдва\x1b[0m        bold, one span for the whole line
### три    →  \x1b[1mтри\x1b[0m …      bold, and set per word
```

`1;3;4` is the only sequence in that tape that turns underlining on, so a line whose every visible
character is underlined is a first-level header and comes back as one. **`##` and `###` stay
`**bold**`**: telling those two apart — one span against one per word — would be reading a
line-breaking decision as a level, and telling either from a bold sentence on a line of its own is
not possible at all. Claiming a level is the failure this section keeps refusing.

Two bounds. **Only a whole line**, its spaces excluded from the vote — tmux pads a row with
underlined blanks, and a pad would otherwise decide the answer. And **consecutive underlined lines
are one header**, which is a header the pane wrapped: an agent does not write two `#` lines with no
blank between them, and the pane puts a blank line after a header either way.

Both of those were then measured rather than left as arguments, on a second tape at 47 columns. **A
wrapped header reopens the region on every physical line** (`1;3;4` four times for a four-line one),
which is what makes the run the right unit — and **the reset can arrive on the next line, ahead of
its indent**: `…панелью на` ends with no reset at all and the following line opens
`\x1b[0m  \x1b[1;3;4mдве или три…`. That is why the state is carried across the break and the
indent's spaces take no part in the vote; read line by line, the fourth line would have counted as
plain text. And **`####`, `#####` and `######` are the same `\x1b[1m` as `##`** — there is no
seventh shape to look for, and levels two to six collapse into bold by construction. Run against the four
live panes and the tape — 6700 lines — this created exactly one header, the real one, and touched
nothing else; the `# pass 240` lines a test suite prints are literal text and stayed literal.

(The Bun-packed binary answers nothing here: its JS is compressed, and the box glyphs a grep finds
in it belong to Bun's own TOML writer. Two attempts at it were two too many.) **And the
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
mode opens on carries **no inline marks**: that is the page's own screen, read out of xterm's buffer
where the attributes are not, and it is replaced by the host's answer a round trip later
(`data-from` says which is on screen). The block passes do run on it — a table and a rule are drawn
in plain text and need no attributes — so what the two texts differ by is bold, code and links. A
capture that never comes back is a copy window without those, which is the same failure as a copy
window without history, and it says so the same way.

**A link is an escape sequence too, and the SGR reader was blind to it.** Found by running this
converter over the owner's own live panes rather than by a report: 72 escape bytes survived a
screenful of scrollback, every one of them OSC — `\x1b]8;id=…;<uri>\x1b\` around the text and
`\x1b]8;;\x1b\` after it. Left in, the copy window shows the target raw and then the text again.

What is done with the target was measured too. On those panes it is nearly always the visible text
itself — a bare URL the terminal made clickable, or a `file:///` path an agent printed — and
`[STATE.md](file:///home/…/STATE.md)` is worse to paste than `STATE.md`. So `linksFrom` drops the
wrapper and keeps the text, and only an http(s) target the text is **not part of** becomes
`[текст](адрес)`: that is the link an agent wrote (`[learn more](https://support.claude.com/…)`
on the owner's own pane, twice).

**A wrapped link is several spans, and each of them looked like a label.** The pane re-opens the
hyperlink on every physical line it covers, so a URL too long for the width arrives as
`…/hitromudr/yarr.g` and `it` — and the first version made two Markdown links out of that, one of
them labelled `it`. Three of four live panes carried it; nothing on the stand did. So the spans of
one address are joined first, and then: the visible text is part of the address → **the address
goes out once and whole**, which is the one form a paste can use; it is not → the link an agent
wrote, unless the run was wrapped, a label broken across lines being worse as a link than as the
text it already is. A single span whose text is a *piece* of its address stays text: half a URL, or
a short word (`yarr` under `…/yarr.git`), and this cannot tell them apart.

**And the gap between two spans is whitespace only once the escapes are out of it.** Between them
sits `\n     \x1b[94m` — the pane closes the colour at the end of a line and opens it again on the
next — so a gap tested with the escapes still in it is never whitespace and nothing was ever
joined. Measured on the elect pane, where a URL stayed split for exactly that reason. What the
joined address replaces gives up its text but **keeps its escapes**, in order: a colour reset thrown
away there would leave the colour on, and one of those colours is what a code span is read from a
line later.

A target carrying a paren takes the `<…>` form, or the first `)` would end the link; a sequence the
capture window cut in half is dropped rather than shown, 2000 lines ending wherever they end.

**A paragraph is one line in the message and several on the pane**, and the copy kept the pane's.
Reported by pasting one into a chat: every break the pane made at its own width came out as a break
in the message, each continuation carrying the two spaces of the pane's margin. The width those
lines were broken at is the width of a phone and means nothing in a clipboard, so `unwrapFrom` puts
them back together — and what tells a break the pane made from one the agent wrote is the shape of
the block, measured three ways on a tape of this session's own pane at 47 columns:

- **The renderer wraps at word boundaries and keeps no space.** So a join has to put one back — 42
  distinct breaks at the pane's own edge, every one between whole words, not one inside a token.
  (At 163 columns almost nothing wraps, which is why this had to be measured on a phone-width pane.)
- **A paragraph's lines all sit at one indent** — the agent's own margin, two columns — while what is
  deeper belongs to somebody else: a `⎿` block's output at five. Those breaks are the thing itself and
  are left alone, as are lists, tables, rules and headers, each of which begins a line of its own.
  (This bullet also said "a code block further still", and that was wrong — see the section below.)
- **A sentence after the `●` the agent's speech is marked with continues at the column after the
  marker**: `●` at 0, its continuation at 2, 941 times in that tape. A second `●` is a second
  sentence, not a continuation.

The one break this cannot put back is a token wider than the pane, which has to be cut somewhere: the
join would put a space inside it. None appeared in the tape — a URL is a link and is rejoined as one —
and the shape did turn up later, on a command echo rather than in prose; what came of it is in the
next section.

## A script is not a paragraph, and the indent could not tell them apart

Reported as a script being impossible to copy, with extra line breaks in what came out. Both halves
were true and they were the same defect twice: the rule above met a fenced code block, read it as
prose, and got it wrong in **both** directions at once.

**A code block is drawn at the agent's own margin, not deeper.** That is the measurement the bullet
above lacked, and it was taken the way this file says to take one — off this program's own pane, by
printing a shell script through the same renderer that draws everything else and capturing the result
at 56 columns:

```
 2|  #!/bin/sh
 2|  set -eu
 6|      printf 'эта строка внутри блока намеренно длиннее
 2|  панели, чтобы рисовальщик обязан был её перенести\n'
 6|      ok=1
 2|  fi
```

Two shapes in that, and each was a symptom. `#!/bin/sh` and `set -eu` are two lines at one indent, so
the paragraph rule **glued the whole script into a single line**. And a code line carrying its own
indent wraps back to **the block's margin** — 6 down to 2, shallower than the line it continues, where
prose continues at the same column — so the rule that wanted the indents equal **left that break in
the middle of a command**.

**What separates a wrap from a newline is the renderer's own decision, replayed.** It wraps at word
boundaries and keeps no space, so the next row's first word would have gone on this row unless the row
plus a space plus that word ran past the pane (`roomRanOut`). If it would have fitted, the renderer
would not have broken there and the break is the author's. That is what keeps `set -eu` on its own
line, what tells a dedent (`ok=1` at six, `fi` at two) from a continuation, and what stopped two paths
listed one per line from being glued into one path — a test that used to assert the gluing now asserts
the opposite. Rows reach the full width, measured, so the edge is `cols` and not one less.

**The shallower join is taken only on a row that stopped short of the edge, and that bound came from
the panes.** Run over the owner's own sessions, the first version glued `printf "%-5` to `s USER=…`
and `cat > fa` to `kebin/sudo` — a space in the middle of a token, which is the one failure worse than
the break it replaced. Every such row was **exactly 56 columns**: a command echo that runs past the
width is cut where it lands, and a cut eats nothing. A row that stopped short lost a space to a word
that did not fit, and putting one back is right. On a full row the two cannot be told apart — a
sentence ending flush with the edge and a token sliced through look identical, which is what this file
already said about a cut token — so what is deep keeps its break there. A visible break in a script is
a worse copy; a wrong space in it is a broken command.

What the copy still carries is the block's own two-column margin, which `sh` does not mind and a
here-doc terminator would.

**A thematic break is drawn as a rule**, and a copy of the rule is box glyphs. Found while looking
for those header underlines, which is the second Markdown construct that search turned up rather
than the one it was after. `rulesFrom` puts the `---` back, and the width is what tells a break
from chrome: measured over the four panes, a lone line of `─` comes in exactly two lengths — **40**,
twenty-four times on one pane and always between two paragraphs, on a pane 163 columns wide; and
**the pane's own width**, exactly twice per pane, above and below the `❯`, which is the input box's
frame and stays as it is. The width is passed in rather than guessed (`term.cols`, this capture
being of this client's own pane); with none given every lone rule reads as a break, which is what
a test asking for less gets. A rule with anything else on its line is not a break, and a table's
borders never reach this pass — `tablesFrom` runs first and eats its own.

**A table is drawn too, and a copy of it is a wall of box glyphs.** `tablesFrom` in
`js/select.js` is the same job as the inline pass one level up: what the agent wrote as a pipe
table reached the pane as `┌┬┐ │ ├┼┤ └┴┘`, and this puts the pipes back. It runs whether or not
anything is styled — an unstyled pane draws a table with no colour in it at all — so the inline
pass became `convertInline` and `markdownFrom` now always ends in `tablesFrom`.

Read by shape, the rule this file keeps: the box glyphs are the whole signal. A block begins at a
**top border carrying a column junction** (`┬`/`┳`/`╦`) and ends at a bottom border
(`└`/`╰`/`┗`/`╚`), every line between a row (`│…│`) or an inner rule (`├┼┤`). The column junction
is what separates a table from a box drawn round a note or the agent's own input box — those have
no `┬`, so `╭────╮ │ … │ ╰────╯` is left exactly as it is. A block that turns out to hold a line
that is neither row nor rule is left untouched rather than guessed at, and a block that collapses
to one column is a box round prose, not a table.

Two shapes measured off a live pane (Claude Code 2.1.x). **A logical row is the run of `│…│` lines
between two rules**, because a cell wraps down several physical rows (`Советские` / `мультфильмы`)
and its fragments are joined by the space the wrap ate. **The first logical row is the header**,
which is what Markdown needs and what the box draws above its first inner rule. When a block has
only its top and bottom border and no inner rules, each `│…│` line is its own row — there is
nothing then to tell a wrap from a new row, and merging them would be worse than not. A pipe
inside a cell is escaped, or it would end the cell.

**The alignment is in the padding, and nowhere else.** `:---:` and `---:` are gone by the time a
table is drawn; what is left is where the text sits in its cell — a left cell carries its spaces
on the right, a right cell in front, a centred one splits them (`alignOf`). Two bounds, and the
first is what makes it work at all:

- **Read off the data rows, never off the header.** Claude Code centres a header whatever the
  column is — `│      Приложение      │` over `│ Советские            │` — so a header taken as
  evidence calls every column centred, which three of the unit tests hold it to. Renderers that
  align the header with its column cost this nothing; it only ever has less to read.
- **Claimed only when the padding is unambiguous**, `---` otherwise. A cell filled to its width has
  no padding to read, one space on each side is what such a cell gets rather than evidence of
  centring, and padding that disagrees between rows of one column is not an alignment. Centre wants
  the two sides equal on every fragment (give or take the odd space an uneven remainder leaves) and
  at least one fragment with room on both sides; right wants the same gap after the text on every
  fragment and more room in front of it. Everything else is left, which Markdown writes as `---`
  anyway — so the reading has one honest way to say "I don't know", and it uses it.

The end-to-end test prints the box into a session with the tty echo off: the shared `cat` echoes
what is typed and then prints it again, so a box drawn into it comes out doubled — every border
and row twice — which mangles the very structure under test. Echo off, `cat` prints it once, the
way an agent draws it.

**And then it was run over the owner's own live panes**, which is where the rest of this section
came from: the server's own capture (`capture-pane -p -e -S -2000`) piped through this very
converter in node, three sessions, ~1300 lines each. What it settled, and none of it was visible
from the stand:

- **The OSC links above.** 72 escape bytes survived; the fix took it to 0 on every pane. And the
  fix itself was measured twice more before it was right: the first version made two links out of
  one wrapped URL, and the second joined nothing at all because the gap it tested for whitespace
  had a colour escape in it. What each pane says now, in one line rather than two:
  `To http://127.0.0.1:3030/hitromudr/yarr.git`,
  `http://duma.gov.ru/duma/deputies/?letter=&fraction=&district=202 -> 404`.
- **The tables convert on real data.** 66 box lines on one pane became four tables and **no box
  glyph anywhere**; a wrapped cell came out joined (`Советские мультфильмы`), and the package names
  inside its cells came out as code spans, the colour reading working inside a cell.
- **Every mark the converter adds is added in pairs.** Counted against the content's own marks:
  +92, +388, +284, +552, +144, +250 — all even. The odd totals that raised the question were
  content that already held backticks (one pane carries 269 of them), not an unbalanced span.
- **Nothing is claimed about alignment on Claude Code's own tables**, which is what the reading
  should do: its data cells are left-padded, so all four tables came out `| --- | --- | --- |`. The
  right- and centre-readings are for the tables `psql`, `rich` and `gh` print.
- **A box that is not a table did not appear at all** on those panes — the agent's input box is two
  horizontal rules rather than a box — so the `┬` rule is a guard against a shape that has not
  turned up in the wild yet, and it stays a guard.
