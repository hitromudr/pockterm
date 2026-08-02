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

// detectQuestion(lines) → { prompt, options: [{key,label}] } | null.
// A menu is a run of adjacent lines numbered 1,2,3,… (no gaps, nothing in
// between) that carries TUI chrome. The lowest such run on screen wins:
// when a real prompt follows earlier output, the prompt is the live one.
export function detectQuestion(lines) {
  const plain = lines.map(stripAnsi);
  let best = null;
  let run = null; // { start, opts, chrome }

  const close = () => {
    if (run && run.opts.length >= 2 && run.chrome) best = run;
    run = null;
  };
  for (let i = 0; i < plain.length; i++) {
    const m = OPTION.exec(plain[i]);
    const chrome = m ? CHROME.test(m[1]) || RIGHT_BORDER.test(plain[i]) : false;
    // Continues the run only if this line sits right below the previous
    // option and carries the next number.
    if (m && run && i === run.start + run.opts.length && m[2] === String(run.opts.length + 1)) {
      run.opts.push({ key: m[2], label: label(m[3]) });
      run.chrome = run.chrome || chrome;
      continue;
    }
    // Anything else ends the current run; a "1." line starts a new one.
    close();
    if (m && m[2] === '1') run = { start: i, opts: [{ key: '1', label: label(m[3]) }], chrome };
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
