// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectQuestion, answerKeys } from '../web/js/detect.js';

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

test('a menu with digits bound is answered by its digit', () => {
  const q = { navigate: 'digits', cursor: 0, options: [{ key: '1' }, { key: '2' }, { key: '3' }] };
  assert.equal(answerKeys(q, 0), '1\r');
  assert.equal(answerKeys(q, 2), '3\r');
});

test('an arrow-driven menu is walked from where its pointer is', () => {
  const q = { navigate: 'arrows', cursor: 0, options: [{ key: '1' }, { key: '2' }, { key: '3' }] };
  // The option already under the pointer needs no movement, only the Enter.
  assert.equal(answerKeys(q, 0), '\r');
  assert.equal(answerKeys(q, 1), DOWN + '\r');
  assert.equal(answerKeys(q, 2), DOWN + DOWN + '\r');
  // Started from the top would have been an assumption: a menu navigated on
  // screen sits somewhere else, and then the count has to go the other way.
  const moved = { navigate: 'arrows', cursor: 2, options: q.options };
  assert.equal(answerKeys(moved, 0), UP + UP + '\r');
  assert.equal(answerKeys(moved, 1), UP + '\r');
  assert.equal(answerKeys(moved, 2), '\r');
  // Never a digit on such a menu: that is the whole defect.
  for (let i = 0; i < 3; i++) assert.ok(!/[123]/.test(answerKeys(q, i)));
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
  assert.equal(answerKeys(q, 2), DOWN + DOWN + '\r', 'the third option is two rows down');
});
