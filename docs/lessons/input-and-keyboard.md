# Keyboard, IME and the key bar

Everything about what the on-screen keyboard does to typed text, and what the key bar has to do about it. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

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

**The same question moved two more keys on 2026-08-19.** `✓` (accept) is a right
arrow and an Enter — both already on this bar, one cell apart — so it stopped
earning a cell of its own and `^O` took it; prompt mode's quick row, which is two
wide buttons rather than twelve cells, still carries the macro, and the wire tests
for it now press it there. `^O`'s own cell went to **Tab**, which was removed when
the bar was laid out on the grounds that "this bar answers an agent, it does not
complete filenames" — and both halves of that were a guess: the agent's own input
completes a path with Tab, and no on-screen keyboard has a Tab at all, which is
the whole of the question above. The READMEs had been listing it in the key bar
throughout.

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
`cat -vT` — `^R` from a composed `к`, `^R` from a typed `к`, `^[r` for that last
case, and the pad staying away with the viewport shortened. Each was checked
against the defect first: with `onEdit` unwired the composed letter never reaches
the pty at all.

## The console pad: whole lines, and at the top of the pane

Asked for from the phone on 2026-08-27, in one sentence: the same thing as the key
bar, but above, with `clear`, `reset`, `pwd` and the rest of what a console is
typed at. The question the bar's own keys are judged by (*does the keyboard
already do this?*) answers it for a different reason than usual — a keyboard can
type `ls -la`, and that is eight taps with a hyphen behind a shift, on a device
where the keyboard covers half the pane while you find it.

So `#cmdpad`: twenty-three commands and a ▴, cells of one size, in the pane's own typeface
because the label **is** what goes out. It borrows three things rather than
re-deciding them, and each was paid for elsewhere in this file:

- **Absolute inside `#term`**, opaque, over the rows it covers — a panel in the
  flow shortens the pane, tmux redraws to the new height, and what the page reads
  changes under it. Both new tests assert `#{pane_height}` and the row count do
  not move when it is shown.
- **No focus taken, and what the field holds given up** (`keepsTerminalFocus`,
  `releaseForBarKey`): on Android a layout that moves under a focused field is a
  keyboard coming up, which is what ▾ and the ✂ row were reported for.
- **Closed on use**, like `#ctrlpad`, and ▴ to leave without running anything — a
  pad you can only leave by sending something is a trap.

**The top rather than the bottom is the one decision that is not symmetry.** A
shell writes at the bottom: the prompt, the line, its answer. A pad of commands
drawn over the last rows would cover the answer to whichever button was pressed —
so the mirror image is also the only place it works. The way in is `$` in the
pane's top-right corner (`#cmds`), which fades with the pager and for the same
reason: a 44px circle parked over the first line costs the pane a line to have.

**Eight commands was the first answer and it lasted an hour**, and eighteen
lasted about as long. "Кнопок мало, надо в 2 раза больше" took out `ls` and
`cd -` — what a keyboard types in two taps — and brought in what a phone cannot
reasonably type: `ps uaxf`, `netstat -tupln`, `systemctl --failed`,
`systemctl -t service --no-pager`, `uname -a`, `free -h`, `uptime`, `tmux ls`,
`history 20`, `ls -al --color`. Then "ты 5 кнопок скомуниздил, а было бы ровно"
— counted off the *cells* the wide entries eat, which is the right way to count
here — and the list grew to fill them: `curl eth0.me`, `docker ps`,
`ip -br a|grep '^[ew]'`, `vcgencmd measure_temp`, `vcgencmd get_throttled`,
`journalctl -p err -n20|cat`.

Two of those went the next day on the owner's word — `vcgencmd measure_clock v3d`
and `systemctl -t service|cat` — and `ip -br a`, dropped for the arithmetic, came
back beside its filtered twin: the bridges and the veths are sometimes exactly what
is being looked for. Twenty-three commands either way, which is what keeps the
count at twenty-four cells.

**And then the spans went, which is the part worth keeping.** Equal cells with a
`span 2` here and a `span 3` there fit a phone and fall apart on a laptop: the
columns are 400px wide, nothing needs the extra room, and what is left is three
different kinds of button in one panel — reported off a desktop screen, and
correctly. The answer is not a cleverer arithmetic of spans but the absence of
them: one cell per command, a label that takes a second line when it is long, a
fixed height so every cell is identical in both directions, and **twenty-four
cells** — twenty-three commands and the ▴. The stylesheet uses two column counts, both
divisors of twenty-four — 3 on a phone, 6 beyond it — so the last row is full at
every width. Twelve was there for one release and read as twenty-four labels
nobody wants to read ("нафига ты так намельчил"): a wider screen puts its room
into the button, not into more of them, and past 1300px the cell is the key bar's
own 15px on 48px. The test measures the drawn boxes rather than
reading the CSS, because what was wrong was the drawing.

Two things a wrapped label needed, neither of them obvious:

- **The line may only be given up at a space.** Line breaking is allowed after a
  hyphen, so `systemctl --failed` came out as "systemctl --" over "failed" and
  `grep -E` was cut between the two — a label that reads as a different command.
  Each word gets a span that refuses to break.
- **A flex container swallows the whitespace between its items.** The first
  attempt appended those word-spans straight to the button, which centres its
  label with flex — and drew `ls-al--color`. They live inside one wrapper span
  now, where they are ordinary inline text again and `textContent` is still
  exactly the command.

Three things that list decides:

- **The label is the promise.** What goes out is what is written on the button, so
  a label is never shortened, never elided and never edited apart from its own
  `data-cmd` — the test reads one against the other, and reads the boxes for a
  label that does not fit the cell it is drawn in.
- **`fc -l -20`, not `history 20`, and the difference was measured rather than
  reasoned about.** Reported as "хистори так не работает почему-то выводит всю
  историю". In an interactive bash on this host `history` prints all 201 lines it
  holds and `history 20` prints twenty — so bash was never the problem. In zsh the
  number is *where to start*, not how many: `history 20` there means "from event 20
  to the end", which is the whole history minus nineteen lines. `fc -l -20` is the
  last twenty in both, and this pad has no way of knowing which shell a pane is
  running — tmux's `default-shell` here is bash, the agents' panes are bash, and a
  session started by hand is whatever the owner's `SHELL` says.
- **A pager cannot be walked into.** systemctl and journalctl hand their output to
  `less` whenever it does not fit a screen, and this pad has no `q`: hence `|cat`
  on both, which is also what let those two labels fit two lines. `git log` and
  `git diff` page by nature and are absent for the same reason.
- **The order is a walk, not a grid.** Where the rows break depends on how wide the
  screen is — three columns or twelve — so what sits next to what cannot be
  arranged; what can is the sequence. Moving about, then disks and memory, then the
  machine, its heat, its network, its services, its processes, and git.
- **Three buttons are this host's, not Linux's.** `vcgencmd` is Raspberry Pi
  firmware — temperature, throttling and the V3D clock come from it, and on the
  fleet's x86 machines those three answer "command not found". They are here
  because this pad's host is the RPi5, and because the portable reading of the same
  fact is a line of noise (`/sys/class/thermal` in millidegrees) or twelve lines of
  it (`sensors`) where these are a line of answer.
- **A pager is a trap here, so the pad refuses to walk into one.** systemctl hands
  its output to `less` whenever it does not fit a screen, and this pad has no `q`;
  hence `--no-pager` on the unit list, and hence no `git log` or `git diff` at all
  — those two page by nature and cannot be talked out of it.

**The opener does not go away with the bars, and that was measured the hard
way.** It shipped in the `panels-hidden` group on the reasoning that "hide the
bars" means the pane and one way back — and the phone answered within the hour:
"и без нижней открытой меню верхняя кнопка не появляется". Reading with the bars
away is exactly when a `clear` is wanted, and a closed pad costs the pane nothing;
the other corner already keeps ▴ for the bars themselves. A test hides the bars,
presses a command through the pad and reads it off the wire — and puts the bars
back **by the pane's height**, because `refit` lands a task later and the case
after it measured the hidden-bars height as its own baseline.

**And a command is not a keystroke: it is a line typed into whatever the pane
happens to be.** One of the things it can be is the agent's own input box, where
`clear` is not a command at all — it is a turn sent to Claude, paid for in tokens
and answered in prose. The page already knows how to tell that box apart (the ❯
and its non-breaking space; `hasInputBox` in `js/detect.js`, exported for this and
agreeing with `internal/detect/composer.go`), so the tap is asked about rather
than refused: the first arms the button, the second sends, four seconds, the
drawer's own two-tap rule and its reasoning — on a phone the wrong tap is one
thumb away.

Refusing outright was the other candidate and it is worse: an agent session left
at a shell prompt still shows the box the agent printed before it exited, so the
pad would be dead exactly where the owner can see it should work.

`test/ui/bytes.test.mjs` reads the wire through `cat -vT` — `pwd^M` and nothing
else, ▴ sending nothing — and `pwd` is deliberate: `clear` and `reset` are on the
pad because they put a screen right, and a screen put right in the middle of a
test that reads the screen is a failure nobody can read. The asking is measured in
`test/ui/pockterm.test.mjs` against a pane with the box printed into it, and it
was checked against the defect first: with the guard neutered the first tap sends,
and that test fails.

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
of xterm's own listener. `test/ui/bytes.test.mjs` reads the pty through `cat -vT`:
against the two-line `blur(); focus();` it is `^M`, with the fix `ab^M`.

## Holding the focus is asking for the keyboard

The general rule is in `CLAUDE.md` ("Focus is the keyboard on Android"); two places
learned it first. `attach` — a session
switch kept raising the keyboard for somebody who had just put it away, and
nothing on that path focuses anything. And the ⇩ that goes back to the live end,
reported as the scroll arrow bringing the keyboard up over the output it had just
returned to: leaving copy-mode is exactly a layout moving.

The way back is unchanged — tapping the terminal asks for a keyboard and gets
one. The stand has no soft keyboard, so the tests assert the lever (does the
textarea still hold focus) with the keyboard played by the viewport and waited
for on `data-kb`. `keepsTerminalFocus` stays on the ⇩ itself: it hides a moment
later, and hiding a focused element hands focus back to whatever had it before.

### Every control pressed to read, and the journal that named them

Taking no focus was applied first and read as the whole answer, so the release
arrived one control at a time: the answer row, then ▾ with the ✂/📥/📎 row, and
the keys themselves were left alone each time on the grounds that they take no
focus. They still held it. Reported again 2026-08-25 — the bars' own buttons
opening the keyboard — and this time the page had already said which ones. `kb`
is written the moment the keyboard is measured up, with the name of whatever
button was pressed last and how long ago (`measureKeyboard`, `lastPress`), and a
week of it reads:

| `after` | raises within 600ms of the press | what it is |
|---|---|---|
| `working` `done` `BUTTON` `typing` | 55 | the tab strip, by state class |
| `enter` `ctrl-o` `down` `right` `ctrl-c` `up` `left` | 42 | the key bar |
| `pick` `attach-image` `attach-photo` | 9 + 22 slower | the clip and its sources |
| `mode` | 5 | 💬, which asks for one on purpose |

So the release is on every one of them now (`releaseForBarKey`): the bar's keys,
the macros, the control pad, 📎 and the four sources. Two exceptions, and both are
about typing rather than reading — the Ctrl latch, which is spent by the next
letter the keyboard puts in that very field, and 💬, which is the button whose job
is a keyboard.

**The release has to be inside the touch, before the layout moves.** `attach`
gave the focus up in a frame callback after `fitNow()`, which is the move itself:
the journal shows `switch blurred:true` with a `kb up` line 176ms behind it in the
same second. Blurring after the system has decided to raise a keyboard is not
blurring at all. It is the first thing `attach` does now, and the `switch` line is
still written from there.

**Two bounds beyond `releaseFocus`'s own two**, and both are a word in flight: a
composition open belongs to the keyboard, and so does a field it has left
something in — xterm empties that field on losing the focus and reads it a task
later (`endEditByBlur` above), so a blur there sends the word nowhere. This is
what lets the bar's own ⏎ take the same release as the arrows.

`test/ui/pockterm.test.mjs` covers the lever with the keyboard played by the
viewport: ↓ gives the focus up and the byte still goes out, a field with a word in
it is left alone, Ctrl keeps the focus and the pad it opens gives it up.

### The list inside #term is the mechanism, not a set of exceptions

`#term`'s own click handler focuses the pane — that is how a tap types into it —
and it skips whatever is drawn *over* the pane by name:
`#pager, #scrollbar, #answers, #ctrlpad, #cmdpad, #cmds`. Four of those six were
added after the same report, from four different controls: ⇩ and the rail, then
the answer row, then the control pad, then the console pad on 2026-08-27, the
morning after it shipped — "тапы по новому меню опять активируют клавиатуру".

The shape of the defect is always the same, and it is why `keepsTerminalFocus` and
`releaseForBarKey` on the control itself are not enough: the button takes no focus
and even gives up what the field was holding, and then the click bubbles to this
handler, which hands the focus straight back. On Android that is the keyboard, at
once or at the next thing that moves the layout.

**The journal named it in one line**, which is what it is for:
`{"event":"kb","up":true,"after":"cmds","ms":193}` and the same for `cmd-hide` —
`lastPress` is recorded in the capture phase for exactly this. The long-gap lines
in the same run (`after:"session done" ms:87803`, `after:"paste" ms:3785`) are the
tail of it rather than three more defects: a field left holding the focus gets a
keyboard again at every later layout move, so the report arrives as "и так по
вкладке" and as "sometimes".

`nothing but a tap on the terminal takes focus` in `test/ui/pockterm.test.mjs` was
four selectors long when this happened, which is how a new control slipped past
it. It walks the whole surface now — the pad, its opener, its ▴, the bar keys, the
latch and the pad it opens, ▾/▴, the strip, +, 📎, ✂ and the way out of each — and
measures the pane's own field by identity, since the composer is a textarea too and
💬 is supposed to focus it. Checked against the defect: with the two names taken out
of the list again, the case fails on `#cmds`.
