// Several sessions on one screen: which shape the grid takes, and what a tap on
// a tab means while it is up.
//
// Asked for in those words on 2026-10-16: up to six tabs at once, 3x2 or 2x3
// "в зависимости от размера экрана" — a phone held upright, a phone on its side,
// a laptop, a monitor turned on its end. Nothing here asks what the device is:
// the shape is read off the box the grid is drawn in, which is what all four
// differ by, and which a window dragged narrower on a laptop changes too.

export const GRID_MAX = 6;

// What a terminal of the usual 80x24 looks like in pixels at the pane's font:
// about 672x408. The shape whose cells come closest to that is the one picked —
// on a log scale, so a cell twice too wide and one twice too tall are equally
// far from it.
const CELL_ASPECT = 1.6;

// gridShape(n, w, h) → { cols, rows, span } for n cells in a w x h box.
//
// Never more than three along a side and never more than six in all: that is
// the 3x2 / 2x3 of the request, and what it leaves for fewer cells (2x2, 3x1,
// 1x3, 2x1, 1x2). A shape with an empty row or column is not one — five cells
// get one empty slot, and the last cell `span`s it rather than leaving a hole.
export function gridShape(n, w, h) {
  const count = Math.max(1, Math.min(GRID_MAX, n | 0));
  const width = w > 0 ? w : 1;
  const height = h > 0 ? h : 1;
  let best = null;
  for (let cols = 1; cols <= 3; cols++) {
    for (let rows = 1; rows <= 3; rows++) {
      const slots = cols * rows;
      if (slots < count || slots > GRID_MAX) continue;
      const empty = slots - count;
      // An empty slot is a whole row or column wasted unless it is one short
      // of a full last row — the only kind a span can cover.
      if (empty >= cols) continue;
      const aspect = (width / cols) / (height / rows);
      const off = Math.abs(Math.log(aspect / CELL_ASPECT));
      if (!best || empty < best.empty || (empty === best.empty && off < best.off)) {
        best = { cols, rows, empty, off };
      }
    }
  }
  return { cols: best.cols, rows: best.rows, span: best.empty + 1 };
}

// gridPick(names, name) → what a tap on the tab `name` does while the grid is up.
//
//   'activate' — it is in the grid already: its cell becomes the one the keys go to
//   'add'      — there is room: it joins the grid, and its cell is the active one
//   'full'     — six are up; one has to leave first (✕ on its cell)
//
// A tap never takes a cell away. Removing is the cell's own ✕, where the cell
// being removed is the thing under the finger; a second tap on a tab meaning
// "remove" would close the one somebody was reaching for to type into.
export function gridPick(names, name) {
  if (names.includes(name)) return 'activate';
  return names.length < GRID_MAX ? 'add' : 'full';
}

// gridKeep(names, alive) → the names still worth a cell, in their order.
export function gridKeep(names, alive) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    if (typeof n !== 'string' || !n || seen.has(n) || !alive.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length === GRID_MAX) break;
  }
  return out;
}

// storedGrid(raw) → { on, names } read back from storage, whatever is there.
export function storedGrid(raw) {
  let v = null;
  try { v = JSON.parse(raw || 'null'); } catch (_) { v = null; }
  if (!v || typeof v !== 'object') return { on: false, names: [] };
  const names = Array.isArray(v.names)
    ? v.names.filter((n) => typeof n === 'string' && n).slice(0, GRID_MAX)
    : [];
  return { on: v.on === true && names.length > 0, names };
}
