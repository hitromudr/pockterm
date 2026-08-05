import test from 'node:test';
import assert from 'node:assert/strict';
import { kindMark, kindName, customMark, labelBody, customId, shortAge, CUSTOM_MARK, builtinId, presetOf, markOf, MARKS } from '../web/js/kinds.js';

const buttons = [
  { id: 'b1', label: 'qwen', cmd: 'qwen' },
  { id: 'b2', label: '🐍 python', cmd: 'python3 -i' },
];

test('a built-in preset is marked with the same glyph as its button', () => {
  assert.equal(kindMark('shell', buttons), '▸');
  // ❄ since the owner asked for it: Claude is cold, and the four are the first
  // row of the grid a custom button picks from.
  assert.equal(kindMark('claude', buttons), '❄');
  assert.equal(kindMark('yolo', buttons), '⚡');
  assert.equal(kindMark('continue', buttons), '↻');
  assert.equal(kindName('yolo', buttons), 'Claude (yolo)');
});

test('a session nobody stamped is not given a type', () => {
  // The same rule as an unknown activity: a tab paints itself neutral rather
  // than claiming something nothing has said.
  assert.equal(kindMark('', buttons), '');
  assert.equal(kindMark(undefined, buttons), '');
  assert.equal(kindName('', buttons), '');
  // A kind from a newer server this page does not know about is nothing to draw
  // either — better a plain tab than a glyph standing for a guess.
  assert.equal(kindMark('sonnet', buttons), '');
  assert.equal(kindName('sonnet', buttons), '');
});

test('a custom button is named by its label and marked by its own lead', () => {
  assert.equal(kindName('custom:b1', buttons), 'qwen');
  assert.equal(kindMark('custom:b1', buttons), CUSTOM_MARK);
  // A label that leads with a symbol carries its own mark, which is how two
  // custom buttons are told apart on a strip of tabs.
  assert.equal(kindMark('custom:b2', buttons), '🐍');
  assert.equal(kindName('custom:b2', buttons), 'python');
});

test('a button since removed keeps the shared mark and gets no name', () => {
  // The session is still running; which button started it is no longer known.
  assert.equal(kindMark('custom:b9', buttons), CUSTOM_MARK);
  assert.equal(kindName('custom:b9', buttons), '');
  // And with no list at all — the drawer draws tabs before /api/presets answers.
  assert.equal(kindMark('custom:b1', []), CUSTOM_MARK);
  assert.equal(kindMark('custom:b1', undefined), CUSTOM_MARK);
});

test('the mark is split off the label by code point, not by code unit', () => {
  // A leading emoji is two code units, so slicing by one would leave half of it
  // in the name — which renders as a replacement glyph, not as nothing.
  assert.equal(labelBody('🐍 python'), 'python');
  assert.equal(labelBody('qwen'), 'qwen');
  assert.equal(customMark('qwen'), CUSTOM_MARK);
  assert.equal(customMark('▶ run'), '▶');
  // A label in another script is a name, not a mark.
  assert.equal(customMark('квен'), CUSTOM_MARK);
  assert.equal(labelBody('квен'), 'квен');
});

test('customId reads the button out of a kind', () => {
  assert.equal(customId('custom:b2'), 'b2');
  assert.equal(customId('yolo'), '');
  assert.equal(customId(''), '');
});

test('how long a session has been up, in one coarse unit', () => {
  // It replaced "1 window", which never said anything: the Makefile makes one
  // window and the page cannot reach a second. The clock is the caller's.
  const now = 1_800_000_000_000;
  const at = (secondsAgo) => shortAge(now / 1000 - secondsAgo, now);
  assert.equal(at(0), 'только что');
  assert.equal(at(59), 'только что');
  assert.equal(at(60), '1м');
  assert.equal(at(59 * 60), '59м');
  assert.equal(at(60 * 60), '1ч');
  assert.equal(at(17 * 3600), '17ч');
  assert.equal(at(23 * 3600 + 3599), '23ч');
  assert.equal(at(24 * 3600), '1д');
  assert.equal(at(9 * 24 * 3600), '9д');
  // A session created "in the future" is a clock disagreeing with the host's, and
  // a negative age would be a row saying something impossible.
  assert.equal(at(-500), 'только что');
  // Nothing to go on: no claim.
  assert.equal(shortAge(0, now), '');
  assert.equal(shortAge(undefined, now), '');
});

test('a renamed default is called what it was renamed to', () => {
  // The four are entries in the host's list now, so the label to show comes from
  // there. The stock name is a fallback for a tab whose button has been removed.
  const buttons = [{ id: 'yolo', label: '⚡ Ярость', cmd: 'echo hi' }];
  assert.equal(kindName('yolo', buttons), 'Ярость');
  assert.equal(kindMark('yolo', buttons), '⚡', 'a label may carry its own mark, the same as a custom one');
  assert.equal(kindName('yolo', []), 'Claude (yolo)', 'a removed default still says what it was');
  assert.equal(kindMark('yolo', []), '⚡');
});

test('a default without a mark of its own keeps the stock one', () => {
  const buttons = [{ id: 'claude', label: 'Клод', cmd: '' }];
  // ❄ since the owner asked for it: Claude is cold, and the four are the first
  // row of the grid a custom button picks from.
  assert.equal(kindMark('claude', buttons), '❄');
  assert.equal(kindName('claude', buttons), 'Клод');
});

test('what the page sends to start a button', () => {
  // A default is asked for by its own name — its id is a make target — and the
  // owner's own travel behind the prefix. Which is which decides both.
  assert.equal(builtinId('yolo'), true);
  assert.equal(builtinId('b1'), false);
  assert.equal(presetOf({ id: 'yolo', label: 'Claude (yolo)' }), 'yolo');
  assert.equal(presetOf({ id: 'b1', label: 'Qwen' }), 'custom:b1');
  assert.equal(markOf({ id: 'shell', label: 'Shell' }), '▸');
  assert.equal(markOf({ id: 'b1', label: 'Qwen' }), CUSTOM_MARK);
  assert.equal(markOf({ id: 'b1', label: '🐍 Python' }), '🐍');
});

test('a picked mark wins, and a name is the last guess', () => {
  // In order: the grid, then a mark the label leads with (which is how this worked
  // before the grid existed), then what the id or the name is known for.
  assert.equal(markOf({ id: 'b1', label: 'Codex', mark: '🚀' }), '🚀');
  assert.equal(markOf({ id: 'b1', label: '🐍 Python', mark: '' }), '🐍');
  // Two agents are what this serves, so two names are guessed at: Claude is cold,
  // Codex is sol. One tap in the grid overrules either.
  assert.equal(markOf({ id: 'b1', label: 'Codex-cont', cmd: 'codex resume' }), '☀');
  assert.equal(markOf({ id: 'b2', label: 'Claude Cont (yolo)' }), '❄');
  assert.equal(markOf({ id: 'b3', label: 'Qwen' }), CUSTOM_MARK);
  // A default keeps its own glyph unless something says otherwise.
  assert.equal(markOf({ id: 'yolo', label: 'Claude (yolo)' }), '⚡');
  assert.equal(markOf({ id: 'yolo', label: 'Claude (yolo)', mark: '☾' }), '☾');
});

test('a tab is marked by the button as it stands now', () => {
  // One rule for the menu and the strip: a tab carries the mark of the button that
  // made it, and two rules would drift into two answers about one glyph.
  const buttons = [
    { id: 'b1', label: 'Codex', mark: '🚀' },
    { id: 'claude', label: 'Claude', mark: '☾' },
  ];
  assert.equal(kindMark('custom:b1', buttons), '🚀');
  assert.equal(kindMark('claude', buttons), '☾');
  // A button since removed: the shared mark for one of the owner's own, the stock
  // glyph for a default.
  assert.equal(kindMark('custom:b9', buttons), CUSTOM_MARK);
  assert.equal(kindMark('yolo', buttons), '⚡');
});

test('the grid is a set of single glyphs', () => {
  // What is read at 13px on a phone. Duplicates would be two taps for one answer.
  assert.equal(new Set(MARKS).size, MARKS.length);
  for (const m of MARKS) {
    assert.ok([...m].length <= 2, `${m} is more than a glyph`);
    assert.doesNotMatch(m, /\s/);
  }
});
