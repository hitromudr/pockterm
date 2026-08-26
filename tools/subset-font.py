#!/usr/bin/env python3
"""Cut the pane's fonts down to what a terminal draws and rename them.

Why the fonts are carried in the binary at all: without them, the stack in
css/app.css names whatever each system happens to have, so the same pane came
out in Droid Sans Mono on the phone, DejaVu Sans Mono on the Linux desktop and
Consolas on Windows — three typefaces and three cell widths for one screen. And
before that, in Courier New on Windows alone, which is what started this.

Two families, because no one face has everything a pane here shows:

  Pockterm Mono   the letters, from Droid Sans Mono — the face Android's own
                  `monospace` resolves to, which is the look the owner asked to
                  keep. AOSP ships a single weight and no symbols at all: 632 of
                  the characters below, and none of the box drawing.
  Pockterm Marks  everything the primary has not got, from DejaVu Sans Mono:
                  box drawing, blocks, shapes, arrows, ✓ ✳ ❯ ❄ ☀ ★ ⇩ ↵. On the
                  phone these already came from a fallback face rather than from
                  the mono, so this is not a change of look — it is the same
                  substitution, made the same on every machine.

Ordered by --mono in the stylesheet (Mono, then Marks, then the system names), so
a character is looked for in the primary first. No unicode-range: a range would
have to be kept in step with what the subsets actually hold, and a browser
fetches a family only when a character picks it either way.

Bold is left for the browser to synthesise. Droid Sans Mono has no bold weight —
neither on Android, where the pane has looked like this all along — and taking
one from another face would put a different typeface on every line the agent
emphasises. The marks do ship both weights: DejaVu has them.

The ranges are what this app has been seen to put on a pane, measured rather than
guessed:

  Latin, Latin-1, Latin Extended-A  the program's own text and paths
  Cyrillic                          the owner types in it
  General Punctuation, Currency     dashes, quotes, …, ₽ — what an editor emits
  Letterlike, Maths, Misc Technical  №, ≈, ≤, ⏎-shaped glyphs in TUIs
  Arrows                            the agent's own prose and menus
  Box Drawing, Block Elements       tables, panels, progress bars
  Geometric Shapes                  ●, ▸, ■ — how the agent marks its lines
  Misc Symbols, Dingbats            ✓, ✳, ❯ and the rest of the marks

Neither face draws ⏵, printed on every run: the system names stay last in --mono
because a character in no embedded file has to come from somewhere.

The renames are not cosmetic. A subset under its original name would win over the
real face installed on the machine — same name, and an @font-face beats a system
face — so a missing glyph would have nowhere to fall through to.

Sources: third_party/fonts/DroidSansMono.ttf (Apache 2.0, from AOSP, see
third_party/fonts/LICENSE-droid.txt for the URL and the checksum) and the system
DejaVu Sans Mono (Debian fonts-dejavu-core, licence in
web/fonts/LICENSE-dejavu.txt). Run with `make font-subset`, which is not part of
`make check`: it needs fonttools, and its output is committed.
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem

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
MARKS_FAMILY = "Pockterm Marks"

# The primary face travels in this repository because it is nowhere else: Google
# Fonts dropped Droid Sans Mono for Roboto Mono, and Debian's droid package is
# the CJK fallback only.
PRIMARY = Path("third_party/fonts/DroidSansMono.ttf")
# DejaVu names its regular weight by having no suffix at all.
MARKS = {"400": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
         "700": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"}
STYLE = {"400": "Regular", "700": "Bold"}

# The cell the primary face defines: 1229 of its 2048 units to the em, which is
# 600 of 1000 to within a rounding error. The marks are put on that grid.
EM = 1000
CELL = 600

# What the pane is expected to draw. Printed on every run, per file: a face that
# quietly lost its box drawing would look like a table that came apart, and a
# shrinking list of what neither face has would be a chance to drop the system
# names that cover it.
PROBE = "AaЯя0123─│┌┐└┘├┤┼━┃║═█░▒▓●○◆■▶▸←↑→↓…—«»№≈✓✗✳❯❄☀★⇩↵⏎⏵"


def options() -> subset.Options:
    o = subset.Options()
    # A monospace terminal has no use for shaping: xterm sets font-kerning: none
    # and a ligature in a grid of cells is a defect, not a feature.
    o.layout_features = []
    o.flavor = "woff2"
    return o


def characters(src) -> set:
    with TTFont(str(src)) as font:
        return set(font.getBestCmap())


def wanted() -> set:
    return {c for first, last in RANGES for c in range(first, last + 1)}


def cut(src, unicodes, o: subset.Options) -> TTFont:
    font = subset.load_font(str(src), o)
    subsetter = subset.Subsetter(options=o)
    subsetter.populate(unicodes=sorted(unicodes))
    subsetter.subset(font)
    return font


def rename(font: TTFont, style: str, family: str) -> None:
    """Give the subset its own family name in every record that carries one."""
    full = family if style == "Regular" else f"{family} {style}"
    ps = family.replace(" ", "") + "-" + style
    for rec in font["name"].names:
        text = {
            1: family,      # family
            2: style,       # subfamily
            4: full,        # full name
            6: ps,          # PostScript name
            16: family,     # typographic family
            17: style,      # typographic subfamily
            21: family,     # WWS family
            22: style,      # WWS subfamily
        }.get(rec.nameID)
        if text is not None:
            rec.string = text


def normalise(font: TTFont) -> None:
    """Put a face on the primary's grid: 1000 units to the em, 600 to the cell.

    DejaVu is 2048/1233 (0.602em) against the primary's 0.600, and 0.2% wider
    than the cell is not a rounding error in a terminal — it is every glyph after
    the mark on that row sitting a fraction further right than the one above it.
    """
    scale_upem(font, EM)
    hmtx = font["hmtx"]
    for name in font.getGlyphOrder():
        _, lsb = hmtx[name]
        hmtx[name] = (CELL, lsb)


def report(out: Path, font: TTFont, source, note: str) -> set:
    cmap = set(font.getBestCmap())
    print(f"{out.name}: {out.stat().st_size / 1024:.1f} KB, {len(cmap)} characters "
          f"{note}, from {Path(source).name}")
    return cmap


def build_primary(out_dir: Path) -> set:
    o = options()
    font = cut(PRIMARY, wanted() & characters(PRIMARY), o)
    rename(font, "Regular", FAMILY)
    out = out_dir / "pockterm-mono-400.woff2"
    subset.save_font(font, str(out), o)
    return report(out, font, PRIMARY, "the letters")


def build_marks(weight: str, out_dir: Path, primary: set) -> set:
    src = MARKS[weight]
    o = options()
    font = cut(src, (wanted() & characters(src)) - primary, o)
    normalise(font)
    rename(font, STYLE[weight], MARKS_FAMILY)
    out = out_dir / f"pockterm-marks-{weight}.woff2"
    subset.save_font(font, str(out), o)
    return report(out, font, src, "the primary has not got")


def main() -> int:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "web/fonts")
    out_dir.mkdir(parents=True, exist_ok=True)
    for src, hint in [(PRIMARY, "see third_party/fonts/LICENSE-droid.txt")] + \
                     [(m, "install fonts-dejavu-core") for m in MARKS.values()]:
        if not Path(src).exists():
            print(f"missing {src} — {hint}", file=sys.stderr)
            return 1

    letters = build_primary(out_dir)
    marks = build_marks("400", out_dir, letters)
    build_marks("700", out_dir, letters)

    left = "".join(c for c in PROBE if ord(c) not in (letters | marks))
    print(f"neither face draws: {left or 'nothing in the probe'} "
          f"(the system names last in --mono are what these come from)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
