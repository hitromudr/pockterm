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
  // Two passes, inline then block. The inline one turns attributes into `**`/
  // backticks and runs only when there is an attribute to read; the block one
  // turns box tables into Markdown tables and runs always, an unstyled pane
  // drawing a table with no colour in it at all.
  const inline = src.includes('\x1b') ? convertInline(linksFrom(src)) : src;
  return tablesFrom(inline);
}

// A link is an escape sequence too, and the one the SGR reader was blind to.
// Found by running this converter over the owner's own live panes: 72 escape bytes
// survived a screenful of scrollback, all of them OSC — `\x1b]8;id=…;<uri>\x1b\`
// around the text, `\x1b]8;;\x1b\` after it. Left in, the copy window shows the
// target twice and the sequences raw.
//
// What is done with the target was measured too. In those panes it is almost
// always the visible text itself — a bare URL the terminal made clickable, or a
// `file:///` path an agent printed — and `[STATE.md](file:///home/…/STATE.md)`
// is worse to paste than `STATE.md`. So the wrapper is dropped and the text kept,
// **except** where the target is an http(s) URL that the text is not: that is the
// `[текст](адрес)` an agent actually wrote, and it goes back as one. Not across a
// line break either — the pane wrapped the text there, and reassembling it is a
// guess this does not need to make.
const OSC8 = /\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x1b\\|\x07)([\s\S]*?)\x1b\]8;;(?:\x1b\\|\x07)/g;
// Anything else OSC, and the string terminator a cut-off sequence leaves behind.
const OSC_ANY = /\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)?/g;

function linksFrom(src) {
  if (!src.includes('\x1b]')) return src;
  return src.replace(OSC8, (_, uri, body) => {
    const text = body.replace(/\x1b\[[0-9;]*m/g, ''); // for the comparison only
    const plain = text.trim();
    const http = /^https?:\/\//i.test(uri);
    if (!http || plain === '' || plain === uri.trim() || /\n/.test(body)) return body;
    // A target with a paren or a space in it needs the angle-bracket form, or the
    // first `)` ends the link.
    const target = /[()\s]/.test(uri) ? `<${uri}>` : uri;
    return `[${body}](${target})`;
  }).replace(OSC_ANY, '');
}

function convertInline(src) {
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
    // A code span holding a backtick of its own needs a longer fence and the
    // padding that goes with it, or the span ends at the content's own mark. None
    // of the owner's live panes carried one, and an agent quoting a backtick is
    // exactly the case where a broken span would look like the right answer.
    if (s.code) {
      const runs = core.match(/`+/g);
      if (!runs) body = `\`${body}\``;
      else {
        const fence = '`'.repeat(Math.max(...runs.map((r) => r.length)) + 1);
        body = `${fence} ${body} ${fence}`;
      }
    }
    if (s.bold) body = `**${body}**`;
    out += head + body + tail;
  }
  return out;
}

// A table is drawn too, and a copy of the drawing is a wall of box glyphs.
// tablesFrom finds those boxes and writes the Markdown table they were rendered
// from — the same job as the inline pass, one level up: what the agent wrote as a
// pipe table reached the pane as `┌┬┐ │ ├┼┤ └┴┘`, and this puts the pipes back.
//
// Read by shape, not by vocabulary — the rule this file keeps: the box glyphs are
// the whole signal. A block begins at a **top border that carries a column
// junction** (`┬`/`┳`/`╦`) and ends at a bottom border (`└`/`╰`/`┗`/`╚`); every
// line between is a row (`│…│`) or an inner rule (`├┼┤`). The column junction is
// what tells a table from a box drawn round a note or the agent's own input box —
// those have no `┬`, so they are left exactly as they are.
//
// Measured off a live pane (Claude Code 2.1.x): a three-column table with an inner
// rule between every row and cells that wrap down two physical rows
// (`Советские` / `мультфильмы`). So a logical row is the run of `│…│` lines between
// two rules, and a wrapped cell is its fragments joined by a space. The first
// logical row is the header, which is what Markdown needs and what the box draws
// above its first inner rule.
const H_RULE = '─━═'; // ─ ━ ═
const V_BAR = '│┃║'; // │ ┃ ║
const COL_TEE = '┬┳╦'; // ┬ ┳ ╦ — a top border's column junction
const TOP_CORNER = '┌╭┏╔'; // ┌ ╭ ┏ ╔
const BOT_CORNER = '└╰┗╚'; // └ ╰ ┗ ╚
// A border line is made only of glyphs from the Box Drawing block (U+2500–257F)
// and spaces.
const BORDER_RE = /^[─-╿ ]+$/;

const hasAny = (s, set) => [...s].some((ch) => set.includes(ch));

function borderLine(s) {
  const t = s.trim();
  // All box glyphs, and a horizontal run in it — a lone `│` is a row, not a rule.
  return t !== '' && BORDER_RE.test(t) && hasAny(t, H_RULE);
}
function rowLine(s) {
  const t = s.trim();
  if (!t || !V_BAR.includes(t[0])) return false;
  let n = 0;
  for (const ch of t) if (V_BAR.includes(ch)) n++;
  return n >= 2; // an opening bar and a closing one at the very least
}

// Split a `│ a │ b │` row into its cells, dropping the empty ends the outer bars
// leave behind.
function splitCells(line) {
  const fields = line.trim().split(new RegExp(`[${V_BAR}]`));
  return fields.slice(1, -1);
}

// One logical row out of the physical `│…│` lines it spans: each column is its
// fragments, trimmed, the empty ones dropped, joined by the space a wrap ate.
function collapseRow(physical) {
  const parts = physical.map(splitCells);
  const cols = Math.max(0, ...parts.map((p) => p.length));
  const cells = [];
  for (let k = 0; k < cols; k++) {
    cells.push(parts.map((p) => (p[k] || '').trim()).filter((x) => x !== '').join(' '));
  }
  return cells;
}

// Where the text sits in its cell is the only trace left of `:---:` and `---:`:
// the renderer padded to the column width, so a left cell carries its spaces on
// the right, a right cell on the left, and a centred one splits them.
//
// **Read off the data rows and never off the header.** Claude Code centres a
// header whatever the column is (`│      Приложение      │` over
// `│ Советские            │`), so a header taken as evidence would call every
// column centred. Other renderers align the header with its column, which costs
// this nothing — it only ever has less to read.
//
// **And claimed only when the padding is unambiguous**, `---` otherwise: a cell
// filled to its width has no padding to read, a column of equal-width values says
// nothing about intent, and inventing an alignment nobody wrote is the wrong kind
// of failure here. One space on each side is what a cell gets when it fills the
// column, so it is not evidence of centring either.
function padOf(raw) {
  const left = raw.length - raw.replace(/^ +/, '').length;
  const right = raw.length - raw.replace(/ +$/, '').length;
  return { left, right };
}

function alignOf(groups, cols) {
  const out = [];
  for (let k = 0; k < cols; k++) {
    const pads = [];
    // Data rows only — groups[0] is the header.
    for (let g = 1; g < groups.length; g++) {
      for (const line of groups[g]) {
        const raw = splitCells(line)[k];
        if (raw === undefined || raw.trim() === '') continue;
        pads.push(padOf(raw));
      }
    }
    out.push(decideAlign(pads));
  }
  return out;
}

function decideAlign(pads) {
  if (!pads.length) return null;
  // Centred: the two sides match on every fragment, give or take the odd space
  // an uneven remainder leaves, and at least one of them has room to show it.
  const centred = pads.every((p) => Math.abs(p.left - p.right) <= 1)
    && pads.some((p) => p.left >= 2 && p.right >= 2);
  if (centred) return 'center';
  // Right: the gap after the text is the same on every fragment and the room is
  // all in front of it.
  const right = pads[0].right;
  const flushRight = pads.every((p) => p.right === right) && pads.some((p) => p.left > p.right + 1);
  if (flushRight) return 'right';
  return null; // left, or nothing the padding can honestly say
}

function renderTable(block) {
  const rules = block.filter(borderLine).length;
  // With inner rules, a logical row is what sits between two of them; with only
  // the top and bottom border, each `│…│` line is its own row — there is nothing
  // then to tell a wrap from a new row, and a guess that merged them would be
  // worse than one that does not.
  const groups = [];
  let cur = [];
  for (const line of block) {
    if (borderLine(line)) { if (cur.length) { groups.push(cur); cur = []; } continue; }
    if (!rowLine(line)) continue;
    if (rules > 2) cur.push(line);
    else groups.push([line]);
  }
  if (cur.length) groups.push(cur);
  if (!groups.length) return null;

  const rows = groups.map(collapseRow);
  const cols = Math.max(0, ...rows.map((r) => r.length));
  if (cols < 2) return null; // a single column is a box round prose, not a table

  // A pipe inside a cell would end the cell; a Markdown table escapes it.
  const cell = (r, k) => (r[k] || '').replace(/\|/g, '\\|');
  const line = (r) => `| ${Array.from({ length: cols }, (_, k) => cell(r, k)).join(' | ')} |`;
  const align = alignOf(groups, cols);
  const rule = (a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : '---');
  const out = [line(rows[0]), `| ${align.map(rule).join(' | ')} |`];
  for (let r = 1; r < rows.length; r++) out.push(line(rows[r]));
  return out;
}

export function tablesFrom(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const top = lines[i];
    if (borderLine(top) && hasAny(top, TOP_CORNER) && hasAny(top, COL_TEE)) {
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (borderLine(lines[j]) && hasAny(lines[j], BOT_CORNER)) { closed = true; break; }
        // A line that is neither a row nor a rule means this was not a clean table
        // after all; leave the block untouched rather than guess at it.
        if (!rowLine(lines[j]) && !borderLine(lines[j])) break;
        j++;
      }
      if (closed) {
        const md = renderTable(lines.slice(i, j + 1));
        if (md) { out.push(...md); i = j + 1; continue; }
      }
    }
    out.push(top);
    i++;
  }
  return out.join('\n');
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
