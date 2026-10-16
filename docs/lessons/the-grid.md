# The grid: several sessions on one screen

Asked for on 2026-10-16, off a laptop screenshot with a red line drawn down the
middle of the pane: up to six tabs at once, 3x2 or 2x3 "в зависимости от размера
экрана его типа — мобильный длинный, ноутбучный, вертикальный/горизонтальный,
короткий и длинный". What follows is what the first version decided and what it
measured on the stand.

## A cell is the page itself, in an iframe

`web/js/app.js` is written for one pane and one socket: `term`, `ws`, `current`,
the copy-mode state, the answer row, the scrollbar — every one of them a single
module-level fact. Six terminals in that page would mean turning all of them into
instances, and every rule in CLAUDE.md was measured against the single one.

So a cell is `/?cell=<session>`: the same page, the same code, in a mode that
draws the pane and what is drawn over it (`#answers`, `#pager`, `#scrollbar`,
`#ctrlpad`, `#snapshot`, `#selbar`) and nothing else (`html.cell` in the
stylesheet). Each cell has its own socket, its own copy mode, its own answer row
— for free, and identical to the one pane because it *is* the one pane.

What the cell must not do, because the page around it does it once for the
screen:

- **Write `pt-session` / `pt-last-session`.** sessionStorage is shared by every
  same-origin frame of a tab; a cell writing it would reopen its own session on
  reload instead of the grid.
- **Poll the strip, register the worker, arm push, turn the screen.** Six of each.
- **Show a notice.** Every page on the host hears every notice; six cells would
  draw it six times. The cell passes `notify` and `config` frames up
  (`postMessage`), and the page acts only on those from the first cell.
- **Measure the keyboard.** See below — this one was a bug before it was a rule.

## The page around the cells holds no socket

`window-size latest` gives a shared window the size of its newest client (see
socket-and-attach.md). A seventh client — the page's own, at the full screen's
size — would size every window it shares with a cell back up under that cell.
`gridEnter` drops the socket before the cells attach. The browser test counts
tmux clients: two cells are two clients, and with the `dropSocket` removed it is
three.

## The bars act on the active cell, by pressing the cell's own copy

The key bar, Home/End, the quick bar, ✂ and Ctrl are not imitated in the page:
a capture-phase click listener on `#screen-term` takes the press and clicks the
same element in the active cell (`ptCell.press`). The cell's handler runs — the
Ctrl latch, an Enter that waits for a word still being composed, everything that
was measured for the one pane. Ctrl lights the page's button through a message
back (`kind: 'ctrl'`).

What has no copy in the cell goes through `ptCell` directly: the composer and
everything else calling `send`/`sendInput` (`gridSend`), and pasted text
(`pasteText` → `ptCell.paste`). Paste reads the clipboard in the page, not in the
cell: the user activation of a click belongs to the frame clicked, and a cell
asked to read the clipboard from a click in its parent is refused.

The active cell is chosen by touching it: a `pointerdown` or `focusin` inside a
cell posts `kind: 'focus'`, and a tap on a cell's head does the same in the page.

## A cell must not measure the keyboard

Found on the stand the first time six cells were drawn upright: the cells of the
top two rows had no tmux status line. `measureKeyboard` decides "keyboard up"
when the window got 20% shorter at the same width — and that is exactly what the
grid does to a cell each time a row is added (1x2 → 1x3, 2x2 → 2x3). The cell
believed a keyboard had come up, held its rows (`rowsHeld`), and the pane ran
272px into a 174px cell. In a cell `keyboardUp` is always false; the test
asserts every pane fits its cell, and fails with `s1: pane 272px in a cell of
174px (kb 1)` without the fix.

The real keyboard is measured by the page, and the grid follows the same rule
as the one pane — **the keyboard takes no rows**: `liftGrid` keeps the grid at
the height it had and lifts it until the active cell's bottom is above the
keyboard. Not yet confirmed on the phone.

## The shape

`gridShape` in `js/grid.js` is a pure function of the count and the box: at most
three along a side, at most six, no empty row or column (five leave one slot,
and the last cell spans it), and among what is left the shape whose cells come
closest to an 80x24 terminal (~1.6:1 in pixels, on a log scale). That gives 3x2
on a laptop, a short laptop, an ultrawide and a phone on its side, and 2x3 on a
phone upright and a monitor on its end — the cases the request named — without
the page asking what kind of device it is. The box is re-read on every resize,
so turning the phone re-shapes the grid.

Cells are placed by CSS `order`, never by moving the iframe in the DOM: moving an
iframe reloads it, which is a socket dropped and a pane redrawn.

## ⊞ stands in the strip, beside +

It went into the drawer for an evening: beside + it takes a button's width
(~45px) from a strip that on a phone is already wider than the screen, and the
full browser run found it — the test that carries the last tab with a mouse
grabbed the tab at its middle, which was now under ⊞, pressed ⊞ and put the grid
up. The owner put it back beside + ("верни ⊞ в полосу вкладок рядом с плюсом"):
it is switched while looking at the tabs it is about. The test now grabs the
part of the tab that is on screen, which is what a hand does.

## Known limits of the first version

- The cell's `$` command pad, the drawer and the composer are not drawn inside
  cells; the page's own are used.
- A pane resized to a cell is resized for every other client of that session
  too — the same `window-size latest` as any other client, and the same history
  doubling on narrow-to-wide (socket-and-attach.md).
