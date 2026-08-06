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

// The agent's own input box, which carries the very same ❯ — and under it,
// whatever is being typed. A numbered list in a half-written message drew answer
// buttons before it had been sent, and one of them would have submitted it with a
// digit on the end.
//
// The space after the glyph is what tells the two apart: the composer draws a
// non-breaking one, a menu pointer an ordinary one. Measured on Claude Code
// v2.1.222 off both panes — see internal/detect/composer.go, which has to agree.
const COMPOSER = /^[ \t]*\u276f\u00a0/;

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
//
// A non-breaking space is a space here. It is what the input box puts after its
// ❯, so a line wrapped in that box came out a column deeper than the line above
// it — the shape of an option with a description under it.
function indentOf(line) {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ' || ch === '\t' || ch === '\u00a0' || ch === '\u202f'
        || ch === '│' || ch === '>' || ch === '❯' || ch === '›') col++;
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

// The pointer at the highlighted option, as opposed to the box drawn around the
// menu. Which option it sits on is where the cursor is, and that is the only
// honest starting point for driving the menu with arrows.
const POINTER = /[>❯›]/;

// A menu that says how it is answered. Claude Code's AskUserQuestion draws this
// under its options, and it is a list of the keys it accepts — digits are not
// among them, which is the whole reason it has to be read.
const NAVIGATION = /(enter to select|to navigate)/i;

// How far below the last option to look for it. The line sits directly under the
// menu, with at most a rule and a blank between.
const FOOTER_REACH = 4;

// detectQuestion(lines) → { prompt, options: [{key,label}], cursor, navigate } | null.
// A menu is a run of lines numbered 1,2,3,… in order that carries TUI chrome,
// with nothing between them but each option's own continuation. The lowest such
// run on screen wins: when a real prompt follows earlier output, the prompt is
// the live one.
//
// The options used to have to be adjacent, which found nothing at all in a
// question with a description under each answer — the menu the buttons matter
// most for. See internal/detect/detect.go for what that cost.
//
// `navigate` is how the menu takes an answer and `cursor` is which option it is
// on now. Both exist because "type the digit" is an assumption and it was wrong:
// see the header of renderAnswers in js/app.js for what it cost. internal/detect
// does not parse either — it renders notifications, and a notification does not
// press anything — so both are absent from the shared fixtures' Go side.
export function detectQuestion(lines) {
  const plain = lines.map(stripAnsi);
  let best = null;
  let run = null; // { start, last, indent, opts, pointers, chrome }

  const close = () => {
    if (run && run.opts.length >= 2 && run.chrome) best = run;
    run = null;
  };
  for (let i = 0; i < plain.length; i++) {
    const m = OPTION.exec(plain[i]);
    // Not a numbered line: it may still belong to the option above, so the run
    // is left open and the next number is what decides.
    if (!m) continue;
    // A line of the input box brings no chrome with it: what is under that ❯ is
    // being typed, not offered.
    const chrome = (CHROME.test(m[1]) || RIGHT_BORDER.test(plain[i]))
      && !COMPOSER.test(plain[i]);
    // Continues the run if this line carries the next number and everything
    // between it and the previous option belongs to that option.
    if (run && m[2] === String(run.opts.length + 1)
        && continues(plain.slice(run.last + 1, i), run.indent)) {
      run.opts.push({ key: m[2], label: label(m[3]) });
      run.pointers.push(POINTER.test(m[1]));
      run.chrome = run.chrome || chrome;
      run.last = i;
      continue;
    }
    // A number out of turn ends the current run; a "1." starts a new one.
    close();
    if (m[2] === '1') {
      run = {
        start: i, last: i, indent: indentOf(plain[i]), chrome,
        opts: [{ key: '1', label: label(m[3]) }],
        pointers: [POINTER.test(m[1])],
      };
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

  // How it is answered: what the menu says under itself, or digits when it says
  // nothing. A prompt that lists its keys is a prompt whose keys those are.
  let navigate = 'digits';
  for (let i = best.last + 1, seen = 0; i < plain.length && seen < FOOTER_REACH; i++) {
    if (!plain[i].trim()) continue;
    seen++;
    if (NAVIGATION.test(plain[i])) { navigate = 'arrows'; break; }
  }
  return { prompt, options: best.opts, cursor: best.pointers.indexOf(true), navigate };
}

// answerKeys(menu, want) → { move, commit }: the bytes that walk to the option
// at index `want`, and the bytes that take it. Null when there is no way to pick
// it that can be trusted.
//
// **Two writes, and that is the whole point of the shape.** They used to be one
// string, and a menu answered with `↓↓↓\r` in a single write answered *option
// one*: the TUI applies the Enter against the position it had before it has
// processed the arrows. Measured on a real AskUserQuestion at 51 columns — three
// arrows alone move the pointer to the fourth option, the same three with the
// Enter attached answer the first, and even a single `↓\r` does. So every button
// but the first has been answering option one, which is this defect's second
// visit: the first time it was the digits (see below), and it looks exactly the
// same from outside — a wrong answer is indistinguishable from the right one
// until you read what it did.
//
// The caller sends `move`, waits until it can see the pointer arrive, and only
// then sends `commit`. Waiting on the screen rather than on a timer is what
// makes it safe: no pointer, no Enter, and nothing is answered by guess.
//
// "Type the digit and press Enter" was the rule, and it was an assumption about
// every menu that looks like one. It holds for a permission prompt, whose digits
// are bound. It is false for the question with a description under each answer:
// that one lists the keys it takes directly underneath — `Enter to select · ↑/↓
// to navigate` — and digits are not among them. The digit fell on the floor, the
// Enter took whatever was highlighted, and so **every button answered option 1**.
// Reported from the laptop as a click on the third one coming back as the first,
// which is the worst shape a defect can have here: a wrong answer looks exactly
// like the right one until you read what it did.
//
// The count of arrow presses starts from where the pointer is, not from the top:
// a menu already navigated on screen sits somewhere else. No pointer, no count —
// and then no button, because a button that guesses gives an answer
// indistinguishable from the one the owner meant.
export function answerKeys(menu, want) {
  if (!menu || !menu.options || want < 0 || want >= menu.options.length) return null;
  // A digit-driven menu has nothing to walk: the digit names the option, so the
  // pair goes out together and always has.
  if (menu.navigate !== 'arrows') return { move: '', commit: menu.options[want].key + '\r' };
  const from = menu.cursor;
  if (from < 0) return null;
  const step = want > from ? '\x1b[B' : '\x1b[A';
  return { move: step.repeat(Math.abs(want - from)), commit: '\r' };
}
