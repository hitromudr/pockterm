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

// chunks cuts the frozen text into what a long press can pick: a paragraph is a
// run of lines with no blank line in it, and the blank runs between them belong
// to nothing.
//
// A paragraph rather than a line, because what is worth copying off this screen
// comes in blocks — an agent's answer, a command with its output, a wrapped
// sentence that a 51-column pane drew as four rows. And a run of non-blank lines
// rather than anything cleverer: the shape is read off the text alone, so it
// cannot go wrong in a way that needs a release to explain.
//
// Every chunk carries the newlines that end its lines, so the chunks put back
// together are the text they came from — the copy window is laid out from these
// and a selection dragged across it has to read as it looks.
export function chunks(text) {
  const whole = String(text == null ? '' : text);
  if (whole === '') return [];
  const lines = whole.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const para = lines[i].trim() !== '';
    const piece = lines[i] + (i < lines.length - 1 ? '\n' : '');
    const last = out[out.length - 1];
    if (last && last.para === para) last.text += piece;
    else out.push({ para, text: piece });
  }
  return out;
}

// pickedText joins the paragraphs a finger picked, in the order they are on
// screen rather than the order they were tapped: what comes out has to read like
// the screen it came from.
//
// A blank line between them, which is what separated them there — two
// paragraphs cannot be adjacent, a paragraph being a maximal run. No trailing
// newline: this text is pasted into a shell as often as into a message, and a
// newline at the end of that is a command nobody typed.
export function pickedText(texts) {
  return (texts || [])
    .map((t) => String(t == null ? '' : t).replace(/\n+$/, ''))
    .filter((t) => t.trim() !== '')
    .join('\n\n');
}
