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

// The menu's own text field, offered as one of the options — and not an answer
// at all. AskUserQuestion puts a text input in the list, and what the pane shows
// on that line is its *placeholder*, so it is shaped exactly like an option:
// `  4. Type something.`, or `Type something` without the dot when the question
// takes several answers. Both are literals in the widget
// (`{type:"input",value:"__other__",placeholder:…}` in Claude Code 2.1.233), which
// is why they are matched as words here — there is no shape to read instead.
//
// Pressing Enter on it submits what has been typed into the field, and at the
// moment a button is tapped the field is empty: an empty `__other__` reaches the
// agent as "User declined to answer questions". Reported from the phone
// 2026-08-17 as the button sending a refusal, and this corrects the earlier
// reading of the same event — that choosing it *means* "I will answer in my own
// words". It does not mean anything; it is a field waiting to be typed into, and
// the page's job is to reach it and hand over the keyboard.
const TYPE_FIELD = /^Type something\.?$/;

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

// One option, read off a matched line: the key it carries, what it says, and
// whether it is the field above rather than an answer.
function option(m) {
  const text = label(m[3]);
  return { key: m[2], label: text, input: TYPE_FIELD.test(text) };
}

// A rule drawn across the menu: horizontal line and nothing else. Deliberately
// blind to the border glyphs — a box's own top, bottom and sides are chrome
// around a list, while this is a line through one. See `continues` for what it
// costs to confuse the two.
const RULE = /^[\s─]*─{3,}[\s─]*$/;

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
    // A rule across the menu ends the list rather than dividing it.
    //
    // It was read as chrome, and that drew a button for the one option the
    // arrows cannot reach. AskUserQuestion puts `Chat about this` below a rule,
    // outside the ring the arrows walk: measured on the owner's phone
    // 2026-08-10 on a five-option menu, tapping the last button sent four downs
    // and the pointer came back to option 1 — a ring of four, `{"want":4,
    // "key":"5","from":0,"on":"1","moved":false}` in the journal, twice. The
    // press then refused, which is the cheap failure and still a button that
    // answers nothing.
    //
    // An empty box row stays chrome: that is a blank line inside a border, and
    // the options above and below it are one list. What ends the run is a rule
    // and nothing else on the line — no border glyphs, so `╭──╮` and `│  │` are
    // not it.
    if (RULE.test(line)) return false;
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
    // between it and the previous option belongs to that option. The next
    // number is counted from the option before it rather than from the length
    // of the run, because a run no longer has to start at 1 — see below.
    if (run && Number(m[2]) === Number(run.opts[run.opts.length - 1].key) + 1
        && continues(plain.slice(run.last + 1, i), run.indent)) {
      run.opts.push(option(m));
      run.pointers.push(POINTER.test(m[1]));
      run.chrome = run.chrome || chrome;
      run.last = i;
      continue;
    }
    // A number out of turn ends the current run, and any number starts a new
    // one — it does not have to be a 1.
    //
    // It had to be, and that lost the menu exactly while it was being used.
    // AskUserQuestion scrolls its own list to keep the pointer in view, so on a
    // phone-width pane a walk down to the fourth answer pushes the first two
    // off the top of the list: what is left on screen is a run beginning at
    // `3.`, which under the old rule was not a menu at all. Captured off a real
    // pane — the row of buttons went away at the moment it was tapped, and the
    // press that followed had nothing to verify against and refused.
    //
    // What keeps prose out was never the leading 1. A numbered list in a
    // sentence carries no pointer and no border, and `chrome` is what a run is
    // kept on; the indentation rule in `continues` is the other half. Both are
    // untouched.
    close();
    run = {
      start: i, last: i, indent: indentOf(plain[i]), chrome,
      opts: [option(m)],
      pointers: [POINTER.test(m[1])],
    };
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

// An offer is not a menu, and until now the page could not tell the difference
// because it refused to look.
//
// A TUI menu is drawn with chrome — a pointer, a box — and that chrome is the
// whole defence against reading a numbered list in prose as something to press:
// a digit sent to a program that has no menu goes into whatever it is doing. But
// an agent that has finished its turn and written "Что делаем? 1. … 2. …" is
// asking a question too, and answering it from the phone meant typing the digit
// by hand into a field the thumb has to find first. Reported as the row of
// buttons not being drawn for exactly that screen.
//
// What makes it safe is not the shape of the list but where it is and what
// happens when it is pressed. Four things have to hold, and each one removes a
// way to be wrong:
//
//   - the agent's own input box is on screen, empty. That is what the digit is
//     typed into — not into a shell, not into a half-written message.
//   - the list is inside the agent's last message (below the last `●`).
//   - that message ends in a question. A list of what was *done* is not an
//     offer, and the question mark is what the two do not share.
//   - the numbers run 1,2,3… in order, at least two of them.
//
// It answers `digits`, because that is literally what it is: the button types
// the number and presses Enter, which is what the owner would have done.
const AGENT_SAID = /^\s*●\s+\S/;
const TURN_SUMMARY = /^\s*[✻✽✳✢✶*]\s+\w+\s+for\s+/;

export function detectOffer(lines) {
  const plain = lines.map(stripAnsi);
  // The input box, and nothing typed into it: the lowest one, since the
  // transcript above can hold the prompts of messages already sent.
  let box = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (!COMPOSER.test(plain[i])) continue;
    if (plain[i].replace(COMPOSER, '').trim() !== '') return null;
    box = i;
    break;
  }
  if (box < 0) return null;

  // The agent's last message: from its ● down to the box.
  let said = -1;
  for (let i = box - 1; i >= 0; i--) {
    if (AGENT_SAID.test(plain[i])) { said = i; break; }
  }
  if (said < 0) return null;
  const block = plain.slice(said, box);

  // It has to end in a question. The turn summary ("✻ Cooked for 19s") and the
  // rule above the box are chrome, not the last word.
  let asked = false;
  for (let i = block.length - 1; i >= 0; i--) {
    const t = boxGlyphs(block[i]);
    if (!t || TURN_SUMMARY.test(block[i])) continue;
    asked = t.endsWith('?');
    break;
  }
  if (!asked) return null;

  // The lowest run of 1,2,3… in it. A line that is not an option continues the
  // one above — in prose a wrapped line sits at the margin, so the indentation
  // rule a real menu is read by has nothing to say here.
  let best = null;
  let run = null;
  for (let i = 0; i < block.length; i++) {
    const m = OPTION.exec(block[i]);
    if (!m) continue;
    if (run && m[2] === String(run.opts.length + 1)) {
      run.opts.push({ key: m[2], label: label(m[3]) });
      continue;
    }
    if (run && run.opts.length >= 2) best = run;
    run = m[2] === '1' ? { start: i, opts: [{ key: '1', label: label(m[3]) }] } : null;
  }
  if (run && run.opts.length >= 2) best = run;
  if (!best) return null;

  const prompt = label(boxGlyphs(block[0]).replace(/^●\s*/, ''));
  return { prompt, options: best.opts, cursor: -1, navigate: 'digits', offer: true };
}

// detectPrompt is the one question the page asks the screen: is there something
// here to answer? A real menu first — it is the stricter reading and the one
// that can be driven with arrows — and an offer only when there is no menu.
export function detectPrompt(lines) {
  return detectQuestion(lines) || detectOffer(lines);
}

// How many arrows reach the option at `want` from where the pointer is, or null
// when there is nothing to count from: a menu with no pointer on screen cannot be
// walked, and a guess gives an answer indistinguishable from the one that was
// meant.
function walkTo(menu, want) {
  const from = menu.cursor;
  if (from < 0) return null;
  const step = want > from ? '\x1b[B' : '\x1b[A';
  return step.repeat(Math.abs(want - from));
}

// answerKeys(menu, want) → { move, commit }: the bytes that walk to the option
// at index `want`, and the bytes that take it. Null when there is no way to pick
// it that can be trusted, and an empty `commit` when the option is not something
// to take at all — the menu's own text field, which is answered by typing.
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
//
// **The field is reached and not pressed**, which is the one option here with no
// commit. An Enter over it is not a wrong answer, it is a refusal: the field is
// empty at the moment a button is tapped, and what the agent gets back is "User
// declined to answer questions" — reported from the phone, and see TYPE_FIELD
// above for why the line looks like an answer in the first place. What answers it
// is what gets typed into it, so the walk is the whole of what a key can do and
// the caller hands the keyboard over.
export function answerKeys(menu, want) {
  if (!menu || !menu.options || want < 0 || want >= menu.options.length) return null;
  if (menu.options[want].input) {
    // Digits are what a menu is answered with when it says nothing about its
    // keys, and a digit cannot put the pointer on the field without taking what
    // is under it. No button then, rather than one that declines the question —
    // and the same silence a menu with no pointer already gets.
    if (menu.navigate !== 'arrows') return null;
    const move = walkTo(menu, want);
    return move === null ? null : { move, commit: '' };
  }
  // A digit-driven menu has nothing to walk: the digit names the option, so the
  // pair goes out together and always has.
  if (menu.navigate !== 'arrows') return { move: '', commit: menu.options[want].key + '\r' };
  const move = walkTo(menu, want);
  return move === null ? null : { move, commit: '\r' };
}
