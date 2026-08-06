// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectQuestion, detectOffer, detectPrompt, answerKeys } from '../web/js/detect.js';

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
