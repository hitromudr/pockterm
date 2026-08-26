#!/usr/bin/env python3
"""Cut the pane's font down to what a terminal draws and rename it.

Why the font is carried in the binary at all: without one, the stack in
css/app.css names whatever each system happens to have, so the same pane came
out in Noto Sans Mono on the phone, DejaVu Sans Mono on the Linux desktop and
Consolas on Windows — three typefaces and three cell widths for one screen.

Why it is cut: the whole face is 499 KB per weight, and a terminal draws a
fraction of it. The ranges below are what this app has been seen to put on a
pane, measured rather than guessed:

  Latin, Latin-1, Latin Extended-A  the program's own text and paths
  Cyrillic                          the owner types in it
  General Punctuation, Currency     dashes, quotes, …, ₽ — what an editor emits
  Letterlike, Maths, Misc Technical  №, ≈, ≤, ⏎-shaped glyphs in TUIs
  Arrows                            the agent's own prose and menus
  Box Drawing, Block Elements       tables, panels, progress bars
  Geometric Shapes                  ●, ▸, ■ — how the agent marks its lines
  Misc Symbols, Dingbats            ✓, ✳, ❯ where the face has them

Noto Sans Mono does not have every one of those (✳ ❯ ⏵ ✓ ❄ ☀ are absent, checked
here and printed), so the stack keeps the system faces behind this one: a glyph
this file cannot draw falls through to a face that can, as it always did.

The rename is not cosmetic. A subset under the original name would win over the
real Noto Sans Mono installed on the phone and on Linux — same name, and an
@font-face beats a system face — so a missing glyph would have nowhere to fall
through to. Under its own name the two coexist: this file first, the system's
own copy behind it. Noto declares no Reserved Font Names, and OFL 1.1 (see
web/fonts/OFL.txt) allows the derivative either way.

Run with `make font-subset`, which is not part of `make check`: it needs
fonttools and the system Noto, and its output is committed.
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

# Blocks, as (first, last) inclusive. Kept as ranges rather than as the exact
# characters seen so far: a pane draws whatever the program running in it draws,
# and a missing dash costs more than the two kilobytes a block does.
RANGES = [
    (0x0000, 0x00FF),  # Basic Latin, Latin-1 Supplement
    (0x0100, 0x017F),  # Latin Extended-A
    (0x0400, 0x04FF),  # Cyrillic
    (0x2000, 0x206F),  # General Punctuation
    (0x20A0, 0x20BF),  # Currency Symbols
    (0x2100, 0x214F),  # Letterlike Symbols
    (0x2190, 0x21FF),  # Arrows
    (0x2200, 0x22FF),  # Mathematical Operators
    (0x2300, 0x23FF),  # Miscellaneous Technical
    (0x2500, 0x257F),  # Box Drawing
    (0x2580, 0x259F),  # Block Elements
    (0x25A0, 0x25FF),  # Geometric Shapes
    (0x2600, 0x26FF),  # Miscellaneous Symbols
    (0x2700, 0x27BF),  # Dingbats
]

FAMILY = "Pockterm Mono"
WEIGHTS = {"400": ("Regular", "Regular"), "700": ("Bold", "Bold")}
SOURCE = "/usr/share/fonts/truetype/noto/NotoSansMono-{}.ttf"

# What the pane is expected to draw and what the source turned out not to have.
# Printed on every run: a face that quietly lost its box drawing would look like
# a table that came apart.
PROBE = "AaЯя0123─│┌┐└┘├┤┼━┃║═█░▒▓●○◆■▶▸←↑→↓…—«»№≈✓✳❯"


def rename(font: TTFont, style: str) -> None:
    """Give the subset its own family name in every record that carries one."""
    full = FAMILY if style == "Regular" else f"{FAMILY} {style}"
    ps = "PocktermMono-" + style
    for rec in font["name"].names:
        text = {
            1: FAMILY,      # family
            2: style,       # subfamily
            4: full,        # full name
            6: ps,          # PostScript name
            16: FAMILY,     # typographic family
            17: style,      # typographic subfamily
            21: FAMILY,     # WWS family
            22: style,      # WWS subfamily
        }.get(rec.nameID)
        if text is not None:
            rec.string = text


def build(weight: str, style: str, subfamily: str, out_dir: Path) -> None:
    src = SOURCE.format(style)
    options = subset.Options()
    # A monospace terminal has no use for shaping: xterm sets font-kerning: none
    # and a ligature in a grid of cells is a defect, not a feature.
    options.layout_features = []
    options.flavor = "woff2"
    font = subset.load_font(src, options)
    unicodes = [c for first, last in RANGES for c in range(first, last + 1)]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    rename(font, subfamily)
    out = out_dir / f"pockterm-mono-{weight}.woff2"
    subset.save_font(font, str(out), options)

    cmap = set(font.getBestCmap())
    missing = "".join(c for c in PROBE if ord(c) not in cmap)
    print(f"{out.name}: {out.stat().st_size / 1024:.1f} KB, "
          f"{len(cmap)} characters, from {Path(src).name}")
    print(f"  probe: {'every glyph present' if not missing else 'falls through for ' + missing}")


def main() -> int:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "web/fonts")
    out_dir.mkdir(parents=True, exist_ok=True)
    for weight, (style, subfamily) in WEIGHTS.items():
        if not Path(SOURCE.format(style)).exists():
            print(f"missing {SOURCE.format(style)} — install fonts-noto-core", file=sys.stderr)
            return 1
        build(weight, style, subfamily, out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
