// Where a carried tab belongs in the row.
//
// The finger's x is the whole question, and that is the point of this file. The
// first version asked `elementFromPoint` what the finger was over and inserted
// the held tab before or after it — which reads the y as well, and the strip is
// 34 pixels tall at the very top edge of the screen. A thumb travelling sideways
// across it arcs out of it within a centimetre, the point then landed on the
// terminal, there was no tab under it, and the row stopped rearranging while the
// gesture was plainly still going. Reported as the carrying stopping when the
// finger goes up or down.
//
// Vertical travel during a carry means nothing here — there is one row and no
// second place to drop a tab — so it decides nothing.

// dropIndex answers how many of the other tabs the carried one goes after.
//
// `rects` are those tabs' boxes in the order the row has them, the carried tab
// itself left out; the answer is an index into that list, and inserting before
// its element (or appending, for the last index) is the move. Past the middle of
// a tab means after it, in both directions — the same rule each way, so a finger
// resting on a boundary does not swap back and forth.
export function dropIndex(rects, x) {
  let n = 0;
  for (const r of rects) {
    if (x > r.left + r.width / 2) n += 1;
  }
  return n;
}
