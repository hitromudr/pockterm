# The font the pane is drawn in

Why the face travels in the binary instead of being named in a stack, and what
each of the three CSS variables is for. These sections were moved out of
`CLAUDE.md`, which keeps the rule and a pointer; the derivation, the measurements
and the dates are here. Read them before changing this area.

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
resolved `Noto Sans Mono`, this Linux host `DejaVu Sans Mono` (`fc-match
monospace`), Windows `Consolas`. That is what a stack does — it names candidates
and takes the first one present, so the answer is a property of the machine. It
also means the **cell width** is a property of the machine: `Consolas` is about
550/1000 em against 600 for Noto Sans Mono, so the same session at the same font
size is a different number of columns depending on where it is opened.

So the face travels in the binary (v185): `web/fonts/pockterm-mono-{400,700}.woff2`,
declared as `Pockterm Mono` in `css/app.css` and first in `--mono`.

## What is in the subset, and what deliberately falls through

Built by `tools/subset-font.py` (`make font-subset`) from the system
`NotoSansMono-{Regular,Bold}.ttf` — Debian `fonts-noto-core`, OFL 1.1, licence
copied to `web/fonts/OFL.txt`. The whole face is 499 KB a weight; the subset is
**63.6 KB and 64.9 KB**, 1308 characters, hinting kept (dropping it saves 47 KB
across the pair and costs sharpness at 14px on a 1.2× Windows scale, which is
where this was reported from).

The ranges are blocks rather than the exact characters seen so far, because a
pane draws whatever the program in it draws: Latin, Latin-1, Latin Extended-A,
Cyrillic, General Punctuation, Currency, Letterlike, Maths, Misc Technical, Box
Drawing, Block Elements, Geometric Shapes, Misc Symbols, Dingbats.

**Noto Sans Mono does not have every glyph a terminal here shows**, checked
rather than assumed — `✳ ❯ ✓ ⏵ ⏎ ❄ ☀ ⇩ ⇞ ↵` are absent, and `✳` and `❯` are
exactly what the agent's TUI and this page's own composer draw. The subset script
prints that list on every run. Which is why the system faces stay in `--mono`
behind the embedded one: a glyph this file cannot draw falls through to a face
that can, as it always did. Removing them would replace a wrong typeface with a
missing character.

Both weights are shipped because xterm draws bold text with the font rather than
by thickening it, and a synthesised bold is a different width in a grid of cells.
Italic is left to the browser to synthesise — two more files for a face the pane
almost never asks for.

## Three variables, because xterm measures the cell once

`--mono-embedded`, `--mono-system`, `--mono: var(--mono-embedded),
var(--mono-system)`. The pane is built on `--mono-system` and handed `--mono`
after the file has loaded, and both halves of that are needed:

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
- `font-display: swap`, not `block`: a pane that is blank for up to three seconds
  reads as a terminal that has hung.

The frozen copy (`#snapshot`) reads `--mono` straight from the stylesheet. It is a
picture of the same screen, and a picture in another typeface reads as another
screen.

## The two silent ways to lose it

**The precache list.** `web/sw.js` must name both files: an installed PWA with no
network draws the pane in whatever the device has, which is the thing the
embedded font is here to stop. Covered by `TestEmbeddedFontIsAskedFor`, which
also resolves every `url()` in a `@font-face` against the stylesheet's own
directory and refuses a file that is not in the binary — a stylesheet asking for
a path that is not there fails nothing at build time and looks exactly like the
old behaviour.

**The journal.** Which font the pane actually ended up in is not a question a
screenshot answers on a phone, so the page reports `font` with `embedded` true or
false (`journalctl -u pockterm | grep '"event":"font"'`). The browser test asserts
that line as well as the computed family.

`make font-subset` is deliberately outside `check` and `build`: it needs fonttools
and the system Noto, the two `.woff2` files are committed, and a build that
regenerated them would make every push look like a new binary — which is what CI
uses to decide whether to restart anybody's terminal.
