// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectQuestion, detectOffer, detectPrompt, answerKeys, submitKeys, hasInputBox,
} from '../web/js/detect.js';

// The cases are shared with the Go detector (internal/detect), which drives
// the Telegram notifications: one screen, one verdict, in both languages.
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/menus.json', import.meta.url), 'utf8'),
);

for (const c of fixtures.cases) {
  test(`fixture: ${c.name}`, () => {
    const got = detectQuestion(c.lines);
    if (c.expect === null) {
      assert.equal(got, null);
      return;
    }
    assert.ok(got, 'expected a menu');
    assert.equal(got.prompt, c.expect.prompt);
    assert.deepEqual(
      got.options.map((o) => ({ key: o.key, label: o.label })),
      c.expect.options,
    );
    // How the menu takes an answer, and where its pointer is. Only this side
    // reads them — the Go detector renders notifications and presses nothing —
    // but they are in the shared file because they are facts about the same
    // screen, and a second file of screens would drift from this one.
    assert.equal(got.navigate, c.expect.navigate, 'how it is answered');
    assert.equal(got.cursor, c.expect.cursor, 'where the pointer is');
    // Which option is the menu's own text field, if any. Read off the same
    // screens as the rest because it is a fact about them: the line is shaped
    // like an answer and is a placeholder waiting to be typed into, and an Enter
    // over it comes back to the agent as a refusal.
    assert.equal(
      got.options.findIndex((o) => o.input),
      c.expect.input === undefined ? -1 : c.expect.input,
      'which option is the text field',
    );
    // And which boxes are ticked, on a question that takes several answers. The
    // key is absent on every other screen here, which is the claim itself: a menu
    // with no checkboxes is answered outright, and one with them is toggled — the
    // page draws the two differently because pressing them does different things.
    assert.deepEqual(
      got.options.map((o) => o.checked),
      c.expect.checked === undefined ? got.options.map(() => undefined) : c.expect.checked,
      'which boxes are ticked',
    );
    // And the row that ends such a question, which is neither an option nor an
    // answer: the buttons above it toggle boxes, and this is the widget's own
    // button. Absent from every other screen here, which is the claim — only the
    // list with checkboxes has one, and a line reading "Submit" anywhere else is
    // not it.
    assert.deepEqual(
      got.submit === undefined ? null : got.submit,
      c.expect.submit === undefined ? null : c.expect.submit,
      'the row that ends a question taking several answers',
    );
  });
}

// Which keys answer a menu. The defect this exists for: on the question with a
// description under each option, every button answered option 1 — the digit is
// not a key that menu takes, and the Enter behind it took the highlighted one.
const DOWN = '\x1b[B';
const UP = '\x1b[A';

test('a menu with digits bound is answered by its digit, in one write', () => {
  // Nothing to walk here: the digit names the option, so there is no pointer to
  // wait for and the pair goes out together.
  const q = { navigate: 'digits', cursor: 0, options: [{ key: '1' }, { key: '2' }, { key: '3' }] };
  assert.deepEqual(answerKeys(q, 0), { move: '', commit: '1\r' });
  assert.deepEqual(answerKeys(q, 2), { move: '', commit: '3\r' });
});

test('an arrow-driven menu is walked from where its pointer is', () => {
  const q = { navigate: 'arrows', cursor: 0, options: [{ key: '1' }, { key: '2' }, { key: '3' }] };
  // The option already under the pointer needs no movement, only the Enter.
  assert.deepEqual(answerKeys(q, 0), { move: '', commit: '\r' });
  assert.deepEqual(answerKeys(q, 1), { move: DOWN, commit: '\r' });
  assert.deepEqual(answerKeys(q, 2), { move: DOWN + DOWN, commit: '\r' });
  // Started from the top would have been an assumption: a menu navigated on
  // screen sits somewhere else, and then the count has to go the other way.
  const moved = { navigate: 'arrows', cursor: 2, options: q.options };
  assert.deepEqual(answerKeys(moved, 0), { move: UP + UP, commit: '\r' });
  assert.deepEqual(answerKeys(moved, 1), { move: UP, commit: '\r' });
  assert.deepEqual(answerKeys(moved, 2), { move: '', commit: '\r' });
  // The walk and the Enter are separate on purpose: sent as one write, the menu
  // applies the Enter against the position it had before the arrows and answers
  // option one. Measured on a real AskUserQuestion — even a single ↓ with the
  // Enter attached came back as "Раз".
  for (let i = 0; i < 3; i++) assert.ok(!answerKeys(q, i).move.includes('\r'));
  // Never a digit on such a menu: that is the whole defect.
  for (let i = 0; i < 3; i++) {
    const k = answerKeys(q, i);
    assert.ok(!/[123]/.test(k.move + k.commit));
  }
});

test('no pointer on an arrow-driven menu means no answer at all', () => {
  // A guess here gives an answer indistinguishable from the one that was meant,
  // so the caller draws no button rather than one that might be wrong.
  const q = { navigate: 'arrows', cursor: -1, options: [{ key: '1' }, { key: '2' }] };
  assert.equal(answerKeys(q, 0), null);
  assert.equal(answerKeys(q, 1), null);
});

test('an option that is not there has no keys', () => {
  const q = { navigate: 'digits', cursor: 0, options: [{ key: '1' }] };
  assert.equal(answerKeys(q, 1), null);
  assert.equal(answerKeys(q, -1), null);
  assert.equal(answerKeys(null, 0), null);
});

test('the real screen that was answered wrongly', () => {
  // The menu as captured off the pane, cut to the lines that matter. Clicking the
  // third button used to send "3\r"; the digit did nothing and the Enter took the
  // first option.
  const lines = [
    'Шаблон Makefile в devops — что с ним делать?',
    '',
    '❯ 1. Правлю и коммичу в devops тоже (рекомендую)',
    '     Добавлю KIND= и set-option в шаблон роли.',
    '  2. Правлю и выкатываю сразу',
    '     То же плюс make deploy-pockterm отсюда.',
    '  3. Только pockterm, devops сам',
    '     Ограничусь репозиторием pockterm.',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ];
  const q = detectQuestion(lines);
  assert.equal(q.navigate, 'arrows');
  assert.equal(q.cursor, 0);
  assert.deepEqual(answerKeys(q, 2), { move: DOWN + DOWN, commit: '\r' },
    'the third option is two rows down, and the Enter is a write of its own');
});

// --- the menu's own text field is not an answer -----------------------------
//
// Reported from the phone 2026-08-17: the "Type something." button came back as
// "User declined to answer questions". That line is not an option, it is the
// placeholder of a text input the widget puts in the list, and an Enter over the
// empty field submits nothing at all — which the agent is told is a refusal. So
// the keys reach it and take nothing, and the page hands the keyboard over.
const FIELD = [
  'Как назвать сессию?',
  '',
  '❯ 1. По папке',
  '  2. Type something.',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
];

test('the text field is read as one, and it is walked to but never taken', () => {
  const q = detectQuestion(FIELD);
  assert.equal(q.options[0].input, false, 'an ordinary answer read as the field');
  assert.equal(q.options[1].input, true, 'the field read as an ordinary answer');
  const keys = answerKeys(q, 1);
  assert.deepEqual(keys, { move: DOWN, commit: '' });
  // The whole of the defect in one assertion: no Enter goes out for this option,
  // from either half of the pair.
  assert.ok(!(keys.move + keys.commit).includes('\r'), 'an Enter over the empty field');
  // The pointer already on it leaves nothing to send at all.
  const on = { navigate: 'arrows', cursor: 1, options: q.options };
  assert.deepEqual(answerKeys(on, 1), { move: '', commit: '' });
  // And the answers beside it are untouched.
  assert.deepEqual(answerKeys(on, 0), { move: UP, commit: '\r' });
});

test('the multiSelect placeholder has no dot, and is the same field', () => {
  // `Type something` when the question takes several answers, `Type something.`
  // when it takes one — both are literals in the widget.
  const q = detectQuestion(FIELD.map((l) => l.replace('Type something.', 'Type something')));
  assert.equal(q.options[1].input, true);
  assert.equal(answerKeys(q, 1).commit, '');
});

test('a menu that has not said how it is answered draws no button for the field', () => {
  // Digits are the assumption made when a menu says nothing about its keys, and a
  // digit cannot put the pointer on the field without taking what is under it. A
  // menu painted a line at a time is read that way for a frame or two, and there
  // the silence is the cheap failure — the loud one is the refusal above.
  const q = detectQuestion(FIELD.filter((l) => !l.includes('to navigate')));
  assert.equal(q.navigate, 'digits');
  assert.equal(answerKeys(q, 1), null);
  assert.deepEqual(answerKeys(q, 0), { move: '', commit: '1\r' }, 'the answers still answer');
});

test('an option that merely mentions the placeholder is still an answer', () => {
  // The label is matched whole: this is a vocabulary rule, and a menu whose
  // answer happens to talk about typing something must not lose its button.
  const q = detectQuestion(FIELD.map((l) => l.replace('Type something.', 'Type something. Or do not.')));
  assert.equal(q.options[1].input, false);
  assert.deepEqual(answerKeys(q, 1), { move: DOWN, commit: '\r' });
});

// --- an offer: the agent's own numbered list, with the box empty under it ---
//
// Captured off the phone: the agent finished its turn with "Что делаем?" over
// two numbered paths, and the row of buttons was not drawn — a list in prose
// carries no chrome, which is the rule that keeps a digit out of a program with
// no menu. Here the digit goes into the agent's own input box, which is what the
// owner would have typed.
const OFFER = [
  '● История на диске цела — потерян только контекст.',
  '',
  '  Два пути:',
  '',
  '  1. claude --resume и выбрать сессию d037ae16 —',
  '  вернётся весь контекст целиком.',
  '  2. Продолжить здесь: я вытащу из транскрипта',
  '  цифры по токенам и посчитаю стоимость круга.',
  '',
  '  Что делаем?',
  '✻ Churned for 1m 6s',
  '───────────────────────────────────',
  '❯\u00a0',
  '───────────────────────────────────',
  '  ctx 5% | dms@ai:~/work $ | Opus 5',
];

test('a numbered offer in the agent\'s answer is answerable', () => {
  const q = detectOffer(OFFER);
  assert.ok(q, 'the offer was not seen');
  assert.equal(q.navigate, 'digits');
  assert.equal(q.options.length, 2);
  assert.equal(q.options[1].key, '2');
  // Typed, not pressed: the digit and the Enter go together, into the box.
  assert.deepEqual(answerKeys(q, 1), { move: '', commit: '2\r' });
});

test('a menu on screen outranks an offer above it', () => {
  // detectPrompt asks the stricter question first: a real menu can be driven
  // with arrows and knows where its pointer is, an offer knows neither.
  const withMenu = OFFER.concat([
    'Apply this change?',
    '❯ 1. Yes',
    '  2. No',
  ]);
  const q = detectPrompt(withMenu);
  assert.equal(q.offer, undefined, 'the offer won over a real menu');
  assert.deepEqual(q.options.map((o) => o.label), ['Yes', 'No']);
});

test('a list with something already typed is not an offer', () => {
  // The digit would be appended to a half-written message and sent with it.
  const typing = OFFER.slice(0, -3).concat([
    '❯\u00a0а можно и так',
    '───────────────────────────────────',
    '  ctx 5% | dms@ai:~/work $ | Opus 5',
  ]);
  assert.equal(detectOffer(typing), null);
});

test('a list that answers nothing is not an offer', () => {
  // What was done is not what could be done: the question mark is the whole
  // difference, and a report of two steps must not grow buttons.
  const report = OFFER.map((l) => (l.trim() === 'Что делаем?' ? '  Готово.' : l));
  assert.equal(detectOffer(report), null);
});

test('a numbered list with no agent and no box is not an offer', () => {
  // A shell printing a list is the case the chrome rule was written for: there
  // is nothing here to type a digit into.
  assert.equal(detectOffer([
    'Вот что нужно сделать:',
    '1. Прочитать файл',
    '2. Добавить проверку',
    '3. Покрыть тестом',
  ]), null);
});

// The row that ends a question taking several answers. The real screens are in the
// shared fixtures above; these are the ways of reading one wrongly.
const CHECKED = (on, focused) => [
  'Что делать?',
  `${on === 0 ? '❯' : ' '} 1. [ ] Раз`,
  `${on === 1 ? '❯' : ' '} 2. [✔] Два`,
  `${focused ? '❯' : ' '}    Submit`,
  '───────────────────────────────',
  '  3. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
];

test('the submit row is read off a list of checkboxes, pointer and all', () => {
  assert.deepEqual(detectQuestion(CHECKED(0, false)).submit, { label: 'Submit', focused: false });
  // With the pointer on it there is nothing to walk and no option carries the
  // pointer — which is the state this button is one tap in.
  const on = detectQuestion(CHECKED(-1, true));
  assert.deepEqual(on.submit, { label: 'Submit', focused: true });
  assert.equal(on.cursor, -1);
  // "Next" is the same row on any question of a set but the last, and it is the
  // widget's own word for it.
  const next = CHECKED(0, false).map((l) => l.replace('Submit', 'Next'));
  assert.deepEqual(detectQuestion(next).submit, { label: 'Next', focused: false });
});

test('a description that says Submit is not the submit row', () => {
  // The guard is the checkbox. A question answered outright indents its
  // descriptions under the label — the very shape the submit row has — so without
  // it a line of prose under the last option would grow a button that ends a
  // question nobody was being asked to end.
  const plain = [
    'Что делать?',
    '❯ 1. Раз',
    '     Что-то одно.',
    '  2. Два',
    '     Submit',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ];
  assert.equal(detectQuestion(plain).submit, undefined);
});

test('nothing below the rule is the submit row', () => {
  // The rule is where the list ends: under it sits `Chat about this`, which the
  // arrows do not reach at all.
  const below = CHECKED(0, false).map((l) => (l.includes('Submit') ? '     ' : l));
  below[5] = '     Submit';
  assert.equal(detectQuestion(below).submit, undefined);
});

test('the submit row is reached one step at a time and pressed only when reached', () => {
  // The page sees a window rather than a list — the widget scrolls its options to
  // keep the pointer in view — so the distance to the end cannot be counted. A
  // batch that fell short would tick a box; one that overshot would land on `Chat
  // about this` under the rule and answer something else entirely.
  const walking = detectQuestion(CHECKED(0, false));
  assert.deepEqual(submitKeys(walking), { move: DOWN, commit: '' });
  const there = detectQuestion(CHECKED(-1, true));
  assert.deepEqual(submitKeys(there), { move: '', commit: '\r' });
  // A single-answer menu has no such row, and a menu that has not said how it is
  // answered gets no button: a digit toggles the box it names, and this row has no
  // digit of its own.
  assert.equal(submitKeys({ navigate: 'arrows', options: [] }), null);
  assert.equal(submitKeys({ navigate: 'digits', submit: { label: 'Submit', focused: true } }), null);
  assert.equal(submitKeys(null), null);
});

// --- is the agent's own box on screen at all ---
//
// Asked by the console pad rather than by the answer row: what it decides is
// whether `clear` typed into this pane runs somewhere or is sent to Claude as a
// message. The reading is detectOffer's own — the ❯ and the non-breaking space
// after it — and it is exported so there is one of it.
test('the agent\'s input box is recognised on its own', () => {
  assert.equal(hasInputBox(OFFER), true, 'the box under the offer was not seen');
  // A menu pointer is the same glyph with an ordinary space, which is the whole
  // rule: a pane driving a menu is not a pane with a box waiting for a message.
  assert.equal(hasInputBox(['❯ 1. Yes', '  2. No']), false, 'a menu pointer read as the box');
  // And a shell is what the pad is for.
  assert.equal(hasInputBox([
    'dms@ai:~/work/pockterm (main) $ ls',
    'Makefile  README.md  web',
    'dms@ai:~/work/pockterm (main) $ ',
  ]), false, 'a shell prompt read as the agent');
  // Something typed into the box does not make it stop being one: the pad has to
  // ask about a half-written message just as much as about an empty box.
  assert.equal(hasInputBox(['❯\u00a0а можно и так']), true);
});
