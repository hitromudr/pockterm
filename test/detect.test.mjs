// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectQuestion, detectPrompt, answerKeys, submitKeys, hasInputBox, hasGeminiBox, scrolledPill, settingsScrollKeys,
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

test("Gemini's menu is answered by the digit alone", () => {
  // Its list takes the digit as the choice and moves on (measured on Gemini CLI
  // 0.66.0); an Enter behind it would answer whatever is drawn next, another
  // tool confirmation included.
  const q = { navigate: 'digit', cursor: 0, options: [{ key: '1' }, { key: '2' }] };
  assert.deepEqual(answerKeys(q, 0), { move: '', commit: '1' });
  assert.deepEqual(answerKeys(q, 1), { move: '', commit: '2' });
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

// --- numbered lists in prose above the free-text input box are not menus ---
//
// All five screens below have the agent's empty composer box (`❯\u00a0`) at the
// bottom and a numbered list inside the last `●` message above it. While the
// bottom of the screen is the free-text input field rather than a TUI menu,
// nothing on screen is a digit choice.
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

test('a numbered list in the agent\'s prose above the free-text input box draws no buttons', () => {
  assert.equal(detectPrompt(OFFER), null);
  assert.equal(detectPrompt(OFFER.filter((l) => l.trim() !== '')), null);
});

test('a real menu below an earlier input box in the transcript is still detected', () => {
  const withMenu = OFFER.concat([
    'Apply this change?',
    '❯ 1. Yes',
    '  2. No',
  ]);
  const q = detectPrompt(withMenu);
  assert.ok(q, 'the menu below the earlier composer box was not seen');
  assert.deepEqual(q.options.map((o) => o.label), ['Yes', 'No']);
});

test('a list with something already typed into the box is not a menu', () => {
  const typing = OFFER.slice(0, -3).concat([
    '❯\u00a0а можно и так',
    '───────────────────────────────────',
    '  ctx 5% | dms@ai:~/work $ | Opus 5',
  ]);
  assert.equal(detectPrompt(typing), null);
});

// Captured off the owner's screen on 2026-09-09, where the page drew three
// buttons over a report of decisions already taken followed by a question.
const REPORT_THEN_QUESTION = [
  '● По CI в yarr — нет, целиком не убирали. Убрали одну джобу и отказались от одного',
  '  варианта размещения. Решения от 09.09 (владельца, коммит 6c5b05f):',
  '',
  '  1. Эмулятор-джоба удалена. Она поднимала эмулятор, ставила APK и дёргала сборщик.',
  '     Причина — дорого и доказывала не то: на живом планшете установку гасит тумблер',
  '     HyperOS, а служба спец.возможностей отваливается при каждом обновлении.',
  '  2. Домашний CI на раннерах хозяйства решено не заводить — приложение всё равно',
  '     ставится с кабеля. Сборка остаётся на приватном GitHub-зеркале.',
  '  3. Сборочная джоба осталась — юнит-тесты парсера + assembleDebug + upload artifact.',
  '',
  '  Отдельно про то, из-за чего это, вероятно, и всплыло — две джобы yarr, висевшие',
  '  10 часов в очереди Forgejo за меткой ubuntu-latest. Это закрыто выключением',
  '  Actions у репозитория, а не удалением workflow.',
  '',
  '  Хочешь — проверю make ci-runners, что очередь yarr в Forgejo сейчас пуста?',
  '✻ Churned for 2m 39s',
  '───────────────────────────────────',
  '❯\u00a0',
  '───────────────────────────────────',
  '  ctx 13% | dms@ai:~/work/devops (develop) $ | Opus 4.8',
];

test('a report with a question about something else draws no buttons', () => {
  assert.equal(detectPrompt(REPORT_THEN_QUESTION), null,
    'nothing on this screen is answerable by a button');
});

// Captured off the owner's phone on 2026-10-18: the agent ended its turn with two
// questions of its own, numbered, and waited for words.
const QUESTIONS_ASKED = [
  '● Сделает её та же вкладка, что потом разобьёт гараж',
  '  (техника / малые машины / транспорт): это одно окно, и',
  '  делить его между двумя вкладками нельзя.',
  '',
  '  Два коротких вопроса, ответ впишу в заявку:',
  '  1. «Не ясно, что разрабатывает, где готовое» я понял',
  '     так: слева то, что вы сейчас собираете, а готовое —',
  '     то, что сохранено кнопкой «ЗАПОМНИТЬ». Верно? Или в',
  '     лабе должно идти изучение со временем, как исследование?',
  '  2. Что значит «транспорт» в гараже, рядом с техникой и',
  '     малыми машинами?',
  '',
  '✻ Cogitated for 49s · done 2:21 PM',
  '───────────────────────────────────',
  '❯\u00a0',
  '───────────────────────────────────',
  '  ctx 30% | dms@ai:~/work/anabasis $ | Opus 5',
];

test('a list of the agent\'s own questions draws no buttons', () => {
  assert.equal(detectPrompt(QUESTIONS_ASKED), null);
});

test('a numbered list with no agent and no box is not a menu', () => {
  assert.equal(detectPrompt([
    'Вот что нужно сделать:',
    '1. Прочитать файл',
    '2. Добавить проверку',
    '3. Покрыть тестом',
  ]), null);
});

// Captured off the owner's phone on 2026-11-10 (the devops session's summary
// at 57 columns): a list of what was done and a question about something else
// under it.
const REPORT_ONE_PARAGRAPH = [
  '● Итоги по всем трём линиям:',
  '  1. ser8 — оживлён сливом swap в RAM; причинам',
  '  отправлено письмо со --ring сборочной сессии.',
  '  2. Обрывы канала — логгер uplink-loss-log',
  '  пишется (root, раз в 5 с, тег в journald).',
  '  3. exante-2 — получил полный разбор со --ring,',
  '  вопрос закрыт с их стороны.',
  '',
  '  Открытый вопрос за тобой: править пробу в',
  '  70-wired-wifi-toggle (ICMP → TCP) сейчас или дать',
  '  логгеру сутки накопить?',
  '',
  '✻ Cooked for 3m 21s · done 12:58 PM',
  '─────────────────────────────────────────────────────',
  '\u276f\u00a0',
  '─────────────────────────────────────────────────────',
];

test('a report with its question in the one paragraph under it draws no buttons', () => {
  assert.equal(detectPrompt(REPORT_ONE_PARAGRAPH), null);
});

// Captured off the yarr session on 2026-11-14: a three-step action plan
// followed by a one-line yes/no question ("Ставить флаг?") directly above the
// empty free-text input box `❯\u00a0`. Visually identical in shape to a
// two-path prose offer with a one-line question ("Что делаем?"), and the
// fourth screen where guessing a digit choice over the free-text input box
// drew wrong buttons.
const PLAN_THEN_QUESTION = [
  '● Собрал картину. Диагноз:',
  '',
  '  Проверить на месте смогу только по факту: игра запускается у Ярослава, я не вижу экран. Поэтому предлагаю так:',
  '',
  '  1. Я добавлю DirectDrawCompat к существующему флагу в реестре (HKCU, правка обратимая, удаляется той же командой с минусом).',
  '  2. Вы попросите Ярослава запустить игру, по alt-tab посмотреть — починилось ли.',
  '  3. Если нет — сниму флаг и попробую следующий вариант (disable fullscreen optimization, от ручного патча игрыmemory проекта прямо говорит — не патчить).',
  '',
  '  Ставить флаг?',
  '',
  '✻ Brewed for 4m 16s · done 4:51 PM',
  '─────────────────────────────────────────────────────',
  '\u276f\u00a0',
  '─────────────────────────────────────────────────────',
  '  ctx 20% | dms@s8:~/work/yarr (master)?1 $ | glm-5.3',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];

test('a numbered action plan with a one-line question above the free-text input box draws no buttons', () => {
  assert.equal(detectPrompt(PLAN_THEN_QUESTION), null,
    'a three-step plan above the free-text input box was offered as digit buttons');
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
  // Gemini CLI's input box: indented by one space between two horizontal rules of
  // equal width (`*` in YOLO, `>` in default, `!` in shell mode).
  assert.equal(hasInputBox([
    '─────────────────────────────────────────────────────────',
    ' *   Жду результата',
    '─────────────────────────────────────────────────────────',
  ]), true, 'Gemini input box was not seen');
  assert.equal(hasInputBox([
    '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
    ' >   Type your message or @path/to/file',
    '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  ]), true, 'Gemini half-line input box was not seen');
});

// Claude Code's full-screen view, off a private stand at 52 columns: scrolled up
// with the wheel, back at the bottom on Ctrl+End, and scrolled up while a turn
// went on printing below.
const fullscreen = JSON.parse(
  readFileSync(new URL('./fixtures/fullscreen.json', import.meta.url), 'utf8'),
);
for (const c of fullscreen.cases) {
  test(`full screen: ${c.name}`, () => {
    assert.equal(scrolledPill(c.rows, fullscreen.cols), c.scrolled);
    // And it is the agent's screen, which is what lets the page trust the answer.
    assert.equal(hasInputBox(c.rows.map((r) => r.text)), true, 'the composer was not seen');
  });
}

test('full screen: a painted user message ending in an arrow is not the pill', () => {
  const cols = 52;
  const text = '❯ scroll down ↓'.padEnd(cols - 1);
  const rows = [{ text, paint: '#'.repeat(cols - 1) + ' ' }];
  assert.equal(scrolledPill(rows, cols), false);
});

// The pill lies over whatever row is there, and on the owner's phone it lay over
// a diff (07.10.2026, two screenshots): the row is painted green from the gutter
// to its right edge, the pill sits on it in a colour of its own. Rebuilt from
// those screenshots at the fixture's width — a gutter of 4 on the left, 10 on the
// right where the diff box ends, and the pill centred on the whole row. `g` is
// the diff's green, `#` the pill.
const overDiff = (after) => {
  const cols = 52;
  const pill = ' Jump to bottom (ctrl+End) ↓ ';
  const at = Math.floor((cols - pill.length) / 2);
  const text = ('     +o' + ' '.repeat(at - 7) + pill + after).padEnd(cols);
  const paint = ('    ' + 'g'.repeat(at - 4) + '#'.repeat(pill.length) + 'g'.repeat(42 - at - pill.length))
    .padEnd(cols);
  return { cols, rows: [{ text, paint }] };
};

test('full screen: the pill over a diff row is still the pill', () => {
  // The green runs on past the pill on both sides, unevenly: read as one run the
  // whole thing stood off centre.
  const { cols, rows } = overDiff('');
  assert.equal(scrolledPill(rows, cols), true);
});

test("full screen: the pill over a diff row with the row's text past it", () => {
  // And here the line goes on after the arrow, so one run did not end in it.
  const { cols, rows } = overDiff('sis:');
  assert.equal(scrolledPill(rows, cols), true);
});

test('full screen: the arrow without a background is not the pill', () => {
  const cols = 52;
  const text = ' '.repeat(12) + ' Jump to bottom (ctrl+End) ↓ ' + ' '.repeat(11);
  assert.equal(scrolledPill([{ text, paint: ' '.repeat(cols) }], cols), false);
});

test('full screen: a pill with the arrow cut off says no', () => {
  const cols = 20;
  const text = '   Jump to bottom   ';
  const paint = '   ' + '#'.repeat(14) + '   ';
  assert.equal(scrolledPill([{ text, paint }], cols), false);
});

test('full screen: Gemini CLI scrollbar says whether the view is off its bottom', () => {
  // Measured on Gemini CLI 0.66.0 at 57x45 (anabasis-gemini on the phone,
  // 2026-11-02): MainContent ends four rows above the StatusRow rule (above
  // CopyModeWarning, ToastDisplay and StatusRow.row1). At the bottom the thumb
  // ends on that row as `█`; scrolled up by one line (`Shift+Up`) that cell is
  // `▀`; scrolled up by a page the thumb ends higher up; a short conversation
  // draws no thumb at all.
  const cols = 57;
  const rule = '─'.repeat(cols);
  const geminiScreen = (thumbAt, glyph = '█') => {
    const lines = [
      '  ✓ ReadFile docs/_tmp_hunter_1.png',
      '  ✓ ReadFile docs/_tmp_hunter_2.png',
      '  ✓ ReadFile docs/_tmp_hunter_3.png',
      '  ✓ ReadFile docs/_tmp_hunter_4.png',
      '',
      '',
      ' ⠏ Thinking... (esc to cancel, 45s)',
      rule,
      ' YOLO Ctrl+Y',
      '',
      rule,
      ' *   Жду результата',
      rule,
      ' 12%   ·   gemini-4-argon   ·    ~/work/anabasis   ·   …',
    ];
    return lines.map((l, i) => {
      const padded = l.padEnd(cols);
      const text = i === thumbAt ? padded.slice(0, cols - 1) + glyph : padded;
      return { text, paint: ' '.repeat(cols) };
    });
  };
  // At the bottom: thumb `█` on row 3 (`rule` is row 7, `7 - 4 = 3`).
  assert.equal(scrolledPill(geminiScreen(3, '█'), cols), false);
  // Scrolled up one line: the bottom cell of MainContent is `▀`.
  assert.equal(scrolledPill(geminiScreen(3, '▀'), cols), true);
  // Scrolled up further: thumb ends above row 3.
  assert.equal(scrolledPill(geminiScreen(1, '█'), cols), true);
  // Short conversation: no thumb at all.
  assert.equal(scrolledPill(geminiScreen(-1), cols), false);
  assert.equal(hasGeminiBox(geminiScreen(-1).map((r) => r.text)), true);
  assert.equal(hasGeminiBox(['───────', '❯\u00a0', '───────']), false);
});

test('Gemini CLI /settings: Apply To commits with Tab and scroll sends arrows', () => {
  const scopeFocused = [
    '╭──────────────────────────────────────────────────────────────────────────╮',
    '│    Settings                                                              │',
    '│    Model Steering                                                  true* │',
    '│  > Apply To                                                              │',
    '│  ● 1. User Settings                                                      │',
    '│    2. Workspace Settings                                                 │',
    '│                                                                          │',
    '│  (Use Enter to select, Ctrl+L to reset, Tab to change focus, Esc to close)│',
    '╰──────────────────────────────────────────────────────────────────────────╯',
  ];
  const q = detectQuestion(scopeFocused);
  assert.equal(q?.navigate, 'scope');
  assert.deepEqual(answerKeys(q, 0), { move: '', commit: '\t' });
  assert.deepEqual(answerKeys(q, 1), { move: '\x1b[B', commit: '\t' });
  // Scrolling while focus is in `> Apply To` sends Tab first to return focus to
  // the settings list and dismiss the answer row.
  assert.equal(settingsScrollKeys(scopeFocused, -1, 1), '\t');
  // Once focus is on `> Settings`, scrolling sends Up/Down arrows.
  const settingsFocused = scopeFocused.map((l) => l.replace('> Apply To', '  Apply To'));
  assert.equal(settingsScrollKeys(settingsFocused, -1, 2), '\x1b[B\x1b[B');
  assert.equal(settingsScrollKeys(settingsFocused, 1, 1), '\x1b[A');
});

// opencode marks its chosen option by colour only; the page passes that in as
// `lines.accent`, and with it the menu has a pointer the buttons can walk from.
test('opencode: the cursor comes from the coloured number', () => {
  const c = fixtures.cases.find((x) => x.name === 'opencode 2.3 question');
  const lines = [...c.lines];
  lines.accent = lines.map((l) => l.includes('3. Type your own answer'));
  const q = detectQuestion(lines);
  assert.equal(q.cursor, 2);
  assert.equal(q.navigate, 'arrows');
  const k = answerKeys(q, 0);
  assert.deepEqual(k, { move: '\x1b[A\x1b[A', commit: '\r' });
  // Two coloured numbers is not a reading: no cursor rather than a guess.
  lines.accent = lines.map((l) => /┃ {2}[13]\./.test(l));
  assert.equal(detectQuestion(lines).cursor, -1);
});
