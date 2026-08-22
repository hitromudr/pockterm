# Answering the agent's menus

How a TUI menu is read, and what a button may press once it has been read. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

## The answer row presses what the menu says it takes

The row is drawn over the pane's last rows (see the flow rule in `CLAUDE.md`; the same
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
