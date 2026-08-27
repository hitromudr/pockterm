# The fonts the pane is drawn in

Why the faces travel in the binary instead of being named in a stack, why there
are two of them, and what each of the CSS variables is for. These sections were
moved out of `CLAUDE.md`, which keeps the rule and a pointer; the derivation, the
measurements and the dates are here. Read them before changing this area.

## A stack does not carry a font, it picks one

Reported from the Windows desktop on 2026-08-26 as "can the ugly font be replaced
with the one Android and Linux have". The pane had no font of its own at all: no
`fontFamily` was passed to `new Terminal`, so xterm asked for its own default —
`courier-new, courier, monospace`. Courier New ships on Windows and on nothing
else the owner uses, so Windows drew a thin serif face while the phone and the
Linux desktop fell through to `monospace` and drew their own sans-serif mono. One
program, three machines, and the only one that looked wrong was the one that had
the font.

Naming the good faces instead (v184) fixed the serif and left the rest: the phone
resolved Droid Sans Mono, this Linux host `DejaVu Sans Mono` (`fc-match
monospace`), Windows `Consolas`. That is what a stack does — it names candidates
and takes the first one present, so the answer is a property of the machine. It
also means the **cell width** is a property of the machine: `Consolas` is about
550/1000 em against 600 for the others, so the same session at the same font size
is a different number of columns depending on where it is opened.

So the faces travel in the binary. v185 embedded a subset of Noto Sans Mono; the
owner's verdict on the phone was that the look had changed — "слегка" worse — and
the face Android actually resolves is **Droid Sans Mono**, not Noto. v186 is that
one, which is where it stands.

## Two families, because no one face has everything

- **`Pockterm Mono`** — the letters, from `third_party/fonts/DroidSansMono.ttf`
  (Apache 2.0, AOSP, `Version 1.00 build 113`, URL and sha256 in
  `third_party/fonts/LICENSE-droid.txt`). The face is kept in this repository
  because it is nowhere else: Google Fonts dropped it for Roboto Mono and
  Debian's `fonts-droid-fallback` is the CJK fallback only. **43.8 KB**, 632 of
  the ranges' characters, one weight, `1229/2048` em — 0.600, the cell every
  other file is put on.
- **`Pockterm Marks`** — everything the primary has not got, from the system
  DejaVu Sans Mono: box drawing, blocks, shapes, arrows, `✓ ✗ ✳ ❯ ❄ ☀ ★ ⇩ ↵`.
  **55.4 KB and 54.8 KB**, 1018 characters, both weights. Droid Sans Mono has no
  box drawing at all — checked, not assumed — so on the phone these already came
  from a fallback face rather than from the mono. Carrying them here is the same
  substitution, made the same on every machine.

`--mono` is `var(--mono-embedded), var(--mono-marks), var(--mono-system)`, and the
**order is the whole mechanism**. A `unicode-range` per face would have to be kept
in step with what the subsets actually hold — a range naming a character the file
does not have, or missing one it does, is silent both ways — while a browser
already picks a family per character and fetches one only when a character needs
it. The browser test proves that by asserting the marks family is *not* loaded
until something draws a `✳`.

**Bold is the browser's to synthesise** for the letters. Droid Sans Mono has no
bold weight, which is also true on the phone, where this pane has looked like this
all along; borrowing one from another face would put a different typeface on every
line the agent emphasises. Synthesising does not widen the cell — the advance
comes from the face either way. The marks ship both weights because DejaVu has
them.

**The system names stay last.** `⏵` is in neither embedded file (`make
font-subset` prints what neither draws, every run), and a character in no embedded
face has to come from somewhere.

## What is in the subsets

`tools/subset-font.py`, `make font-subset`. The ranges are blocks rather than the
exact characters seen so far, because a pane draws whatever the program in it
draws: Latin, Latin-1, Latin Extended-A, Cyrillic, General Punctuation, Currency,
Letterlike, Maths, Misc Technical, Box Drawing, Block Elements, Geometric Shapes,
Misc Symbols, Dingbats.

Hinting is kept: dropping it saved 47 KB across the Noto pair and cost sharpness
at 14px on the 1.2× Windows scale this was reported from.

**The marks are rescaled**, not merely subset. DejaVu is 2048 units to the em and
1233 to the advance — 0.602 against the primary's 0.600 — and 0.2% wider than the
cell is not a rounding error in a terminal: it is every glyph after the mark on
that row sitting a fraction further right than the one above it. `scale_upem` to
1000, advance pinned to 600.

**The renames are not cosmetic.** A subset under its original name would win over
the real face installed on the machine — same name, and an `@font-face` beats a
system face — so a missing glyph would have nowhere to fall through to. Under its
own name the two coexist: the subset first, the machine's own copy behind it.

## Three variables, because xterm measures the cell once

The pane is built on `--mono-system` and handed `--mono` after the file has
loaded, and every part of that is needed:

- xterm measures the cell **once**, at construction, from whatever the stack
  resolved to at that moment. A font file that has not arrived yet resolves to
  nothing, so a pane built on the full stack is measured against a system face
  and never measured again — every row then sits at a width the font it is drawn
  in does not have.
- Setting the option is what makes it measure again, and **xterm ignores an
  option equal to the one it holds** (`OptionsService._setupOptions`:
  `this.rawOptions[e] !== i` before the change fires). So re-setting the same
  stack is a no-op; the two values have to differ, which is what the split is
  for.
- `document.fonts.load` resolves whether or not a face arrived, so
  `document.fonts.check` decides. A file that never came must leave the pane on
  the system faces rather than on a measurement taken against a font nobody has.
- Only the **letters** are waited for. The marks are behind them in the stack and
  fetched when a character picks them; the cell is measured off the primary.
- `font-display: swap`, not `block`: a pane that is blank for up to three seconds
  reads as a terminal that has hung.

The frozen copy (`#snapshot`) reads `--mono` straight from the stylesheet. It is a
picture of the same screen, and a picture in another typeface reads as another
screen.

## The two silent ways to lose it

**The precache list.** `web/sw.js` must name all three files: an installed PWA
with no network draws the pane in whatever the device has, which is the thing the
embedded fonts are here to stop. Covered by `TestEmbeddedFontIsAskedFor`, which
also resolves every `url()` in a `@font-face` against the stylesheet's own
directory and refuses a file that is not in the binary — a stylesheet asking for a
path that is not there fails nothing at build time and looks exactly like the old
behaviour.

**The journal.** Which font the pane actually ended up in is not a question a
screenshot answers on a phone, so the page reports `font` with `embedded` true or
false (`journalctl -u pockterm | grep \'"event":"font"\'`). The browser test asserts
that line as well as the computed family. It is how v185 was confirmed on both
machines within a minute of the deploy — and how the phone's change of look was
established as the embedded face rather than a coincidence.

`make font-subset` is deliberately outside `check` and `build`: it needs fonttools
and the system DejaVu, the three `.woff2` files are committed, and a build that
regenerated them would make every push look like a new binary — which is what CI
uses to decide whether to restart anybody's terminal.

## And the bars are drawn in them too

Asked for on 2026-08-27, once the console pad had shipped in the pane's own fonts
and the key bar six pixels below it had not: "шрифты в нижнем и верхнем меню сделай
как в самом поктерме встроенные". It is the same rule as the pane's, one layer out
— `system-ui` is a stack, so `Esc` and `Ctrl` came out in Roboto on the phone, in
Cantarell on a desktop and in Segoe on Windows, and none of them matched the pane
they sit against.

So `--mono` on `#keybar`, `#modebar`, `#quickbar`, `#selbar`, the pager's buttons
and ▴, which is Pockterm Mono, then Pockterm Marks, then the system names.

What still falls through, read off the subsets rather than assumed — `getBestCmap`
on the two `.woff2` files:

- **⏹ (U+23F9) and ☰ (U+2630) are in neither face.** DejaVu Sans Mono has no
  either, so the quick row's stop and the header's drawer come from the system as
  they always did. Two glyphs on two buttons; the alternative was to change what
  they are drawn as, and the look is the owner's to change.
- **No emoji is, and none can be**: 📥 📎 💬 📋 keep coming from the system's colour
  font, which is what the stack's last names are for.
- **✂ (U+2702) was the one glyph this took away rather than steadied**, and it went
  back the same hour: it *is* in the marks, so it drew from there — monochrome,
  where a phone's own stack had been handing it to the colour font. `#select` asks
  for the emoji form by name now, the way the tab marks already do. Nothing else on
  these bars has a colour form at all, which is why it is the only exception.

The composer's field is deliberately not in the list: it is where the owner writes
Russian prose to an agent, and prose is not a control.

**And it cost a test its guard.** `the marks the letters have not got come from the
second embedded family` proved the stack's order by watching the family arrive:
nothing had drawn a mark yet, so it must not be loaded, and typing one must fetch
it. The key bar's own ↑ ↓ ← → and ⏎ *are* marks, so the family is now asked for the
moment the terminal screen appears and there is no "before" left to read. The order
is asserted outright instead — which is the stronger reading anyway: what a browser
has loaded says nothing about which name comes first.
