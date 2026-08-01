// Detect an interactive numbered menu (e.g. a Claude Code permission
// prompt) in the terminal's visible lines. Pure and unit-tested: the
// heuristics are brittle by nature (they read a TUI), so they live in one
// place with tests, not scattered across the UI.

// A menu option line: optional pointer/box glyphs, a number, a separator,
// then a label. Matches "❯ 1. Yes", "  2) No", "│ 3. …", etc.
const OPTION = /^[\s│>❯›*-]*(\d{1,2})[.):]\s+(\S.*?)\s*$/;

function stripAnsi(s) {
  // xterm's translateToString already yields plain text; strip escapes
  // anyway so the parser also works on raw captures.
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

// detectQuestion(lines) → { prompt, options: [{key,label}] } | null.
// options is the leading run numbered 1,2,3,…; key is the digit to send.
export function detectQuestion(lines) {
  const opts = [];
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION.exec(stripAnsi(lines[i]));
    if (!m) continue;
    const expected = String(opts.length + 1);
    if (m[1] !== expected) {
      // Not the next number in sequence: reset unless we haven't started.
      if (opts.length) continue;
      if (m[1] !== '1') continue;
    }
    if (opts.length === 0) firstIdx = i;
    opts.push({ key: m[1], label: m[2].trim() });
  }
  if (opts.length < 2) return null;

  // Prompt: nearest non-empty line just above the first option.
  let prompt = '';
  for (let i = firstIdx - 1; i >= 0 && i > firstIdx - 6; i--) {
    const t = stripAnsi(lines[i]).replace(/[│╭╮╰╯─]/g, '').trim();
    if (t) { prompt = t; break; }
  }
  return { prompt, options: opts };
}
