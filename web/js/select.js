// The text selection mode shows: a frozen copy of the visible screen.
//
// Kept apart from the DOM so the shaping is testable — what ends up in the
// clipboard is the whole point of the mode, and "why is there a wall of
// blank lines after what I selected" is the complaint it has to avoid.

// snapshotText joins the terminal's visible rows into selectable text.
// Right-hand padding and the empty rows below the last line are dropped:
// the terminal pads every row to its full width, and selecting to the
// bottom of the screen would otherwise copy that padding too.
export function snapshotText(lines) {
  const rows = (lines || []).map((l) => String(l == null ? '' : l).replace(/[ \t]+$/, ''));
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}
