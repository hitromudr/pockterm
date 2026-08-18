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

// The pane is Markdown that has already been drawn, and a copy of the drawing is
// where the Markdown went: `**слово**` reaches the screen as an attribute and
// leaves the clipboard as a bare word. tmux hands those attributes back when asked
// (`capture-pane -e`), and markdownFrom puts the two that carry meaning back into
// the text.
//
// **Bold is `**`** — headers included, an agent's `##` being drawn bold and nothing
// else, so bold is as much as can honestly be recovered of it. **And the light blue
// is a backtick**: that one is a colour rather than a shape, which this repository
// otherwise refuses to read a TUI by, and there is no shape to read instead — an
// inline code span is drawn as coloured text and nothing more. So it is measured
// rather than assumed. Off four live panes, Claude Code 2.1.x: `38;5;153` wrapped
// `apps.cikrf.ru`, `SUMMARY.md`, `scripts/deputy_family_card.py`, `python3`,
// `e4cf208`, `min-width:`, `280px`, `origin/main`, `com.vkontakte.android` — every
// one of them backticked in what the agent wrote. The pink beside it (`38;5;211`,
// `⏵⏵ bypass permissions on`) is chrome, and gets no marks.
const CODE_FG = '153';

// A run is marked word by word, because the renderer sets the attribute per word:
// `\x1b[1mВажная\x1b[0m \x1b[1mпоправка,\x1b[0m` is one `**…**` in the source, and
// `\x1b[38;5;153mmake\x1b[39m \x1b[38;5;153mcheck\x1b[39m` is one `` `make check` ``.
// So neighbours of one style are joined across the space between them — and across
// a single newline, which is where the pane wrapped a sentence. Not across a blank
// line: that is two paragraphs, and joining them would put one pair of marks around
// both.
export function markdownFrom(text) {
  const src = String(text == null ? '' : text);
  if (!src.includes('\x1b')) return src; // nothing was asked of tmux, or nothing styled
  const segs = [];
  const st = { bold: false, code: false };
  let at = 0;
  // SGR is read; every other escape sequence is dropped rather than shown.
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]/g;
  let m;
  const push = (s) => { if (s) segs.push({ text: s, bold: st.bold, code: st.code }); };
  while ((m = re.exec(src)) !== null) {
    push(src.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) applySGR(m[1], st);
  }
  push(src.slice(at));
  return emit(bridge(merge(segs)));
}

function applySGR(params, st) {
  const ps = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p === '0' || p === '') { st.bold = false; st.code = false; continue; }
    if (p === '1') { st.bold = true; continue; }
    if (p === '22') { st.bold = false; continue; }
    if (p === '39') { st.code = false; continue; }
    // An extended colour is three or five parameters, and the ones after it are
    // not colours of their own: read as such, `38;5;153` would set the code style
    // from a stray `5`.
    if (p === '38') {
      if (ps[i + 1] === '5') { st.code = ps[i + 2] === CODE_FG; i += 2; continue; }
      if (ps[i + 1] === '2') { st.code = false; i += 4; continue; }
      continue;
    }
    // Any other foreground replaces the one a code span was drawn in.
    if (/^(3[0-7]|9[0-7])$/.test(p)) { st.code = false; }
  }
}

function same(a, b) { return a.bold === b.bold && a.code === b.code; }
const blank = (s) => /^\s*$/.test(s);

function merge(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && same(last, s)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

// Whitespace between two runs of one style belongs to the run: see the note above
// about words. One newline is the pane's own wrap; two is a paragraph break.
function bridge(segs) {
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const last = out[out.length - 1];
    const next = segs[i + 1];
    if (last && next && blank(s.text) && (s.text.match(/\n/g) || []).length <= 1
      && same(last, next) && (last.bold || last.code)) {
      last.text += s.text + next.text;
      i++;
      continue;
    }
    if (last && same(last, s)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

// The marks go around the words, never around the space beside them: Markdown reads
// `** foo**` as two asterisks and a word.
function emit(segs) {
  let out = '';
  for (const s of segs) {
    if ((!s.bold && !s.code) || blank(s.text)) { out += s.text; continue; }
    const [, head, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text);
    let body = core;
    if (s.code) body = `\`${body}\``;
    if (s.bold) body = `**${body}**`;
    out += head + body + tail;
  }
  return out;
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
