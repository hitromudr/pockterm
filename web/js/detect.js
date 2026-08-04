// Detect an interactive numbered menu (e.g. a Claude Code permission
// prompt) in the terminal's visible lines. Pure and unit-tested: the
// heuristics are brittle by nature (they read a TUI), so they live in one
// place with tests, not scattered across the UI.

// A menu option line: optional pointer/box glyphs, a number, a separator,
// then a label. Matches "❯ 1. Yes", "  2) No", "│ 3. …", etc.
const OPTION = /^([\s│>❯›*-]*)(\d{1,2})[.):]\s+(\S.*?)\s*$/;

// TUI chrome: the pointer at the highlighted option, or the box the prompt
// is drawn in. A numbered list in prose (Claude writes one in almost every
// answer) has neither, and that list is the false positive worth killing —
// buttons for it send stray digits to whatever is actually running.
const CHROME = /[>❯›│]/;
const RIGHT_BORDER = /│\s*$/;

function stripAnsi(s) {
  // xterm's translateToString already yields plain text; strip escapes
  // anyway so the parser also works on raw captures.
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

// Labels of boxed prompts carry the right border and its padding.
function label(text) {
  return text.replace(RIGHT_BORDER, '').trim();
}

function boxGlyphs(s) {
  return s.replace(/[│╭╮╰╯─]/g, '').trim();
}

// Where a line's own text starts, past the chrome drawn down the left edge —
// the box's border and the pointer at the highlighted option. In columns, not
// in code units: it is compared across lines written in any language.
function indentOf(line) {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ' || ch === '\t' || ch === '│' || ch === '>' || ch === '❯' || ch === '›') col++;
    else return col;
  }
  return col;
}

// Whether every line between two options belongs to the first one — a
// description wrapped under it, a blank, or a rule drawn across the menu.
//
// Indentation is what tells a description from a paragraph, and it is the whole
// defence against reading prose as a menu: an option's continuation is set past
// the column its number sits in, while a numbered list in prose has its text
// back at the margin.
function continues(between, indent) {
  for (const line of between) {
    // A rule or an empty box row is chrome, not content.
    if (!boxGlyphs(line)) continue;
    if (OPTION.test(line)) return false;
    if (indentOf(line) <= indent) return false;
  }
  return true;
}

// detectQuestion(lines) → { prompt, options: [{key,label}] } | null.
// A menu is a run of lines numbered 1,2,3,… in order that carries TUI chrome,
// with nothing between them but each option's own continuation. The lowest such
// run on screen wins: when a real prompt follows earlier output, the prompt is
// the live one.
//
// The options used to have to be adjacent, which found nothing at all in a
// question with a description under each answer — the menu the buttons matter
// most for. See internal/detect/detect.go for what that cost.
export function detectQuestion(lines) {
  const plain = lines.map(stripAnsi);
  let best = null;
  let run = null; // { start, last, indent, opts, chrome }

  const close = () => {
    if (run && run.opts.length >= 2 && run.chrome) best = run;
    run = null;
  };
  for (let i = 0; i < plain.length; i++) {
    const m = OPTION.exec(plain[i]);
    // Not a numbered line: it may still belong to the option above, so the run
    // is left open and the next number is what decides.
    if (!m) continue;
    const chrome = CHROME.test(m[1]) || RIGHT_BORDER.test(plain[i]);
    // Continues the run if this line carries the next number and everything
    // between it and the previous option belongs to that option.
    if (run && m[2] === String(run.opts.length + 1)
        && continues(plain.slice(run.last + 1, i), run.indent)) {
      run.opts.push({ key: m[2], label: label(m[3]) });
      run.chrome = run.chrome || chrome;
      run.last = i;
      continue;
    }
    // A number out of turn ends the current run; a "1." starts a new one.
    close();
    if (m[2] === '1') {
      run = { start: i, last: i, indent: indentOf(plain[i]), opts: [{ key: '1', label: label(m[3]) }], chrome };
    }
  }
  close();
  if (!best) return null;

  // Prompt: nearest non-empty line just above the first option.
  let prompt = '';
  for (let i = best.start - 1; i >= 0 && i > best.start - 6; i--) {
    const t = boxGlyphs(plain[i]);
    if (t) { prompt = t; break; }
  }
  return { prompt, options: best.opts };
}
