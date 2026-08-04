import test from 'node:test';
import assert from 'node:assert/strict';
import { kindMark, kindName, customMark, labelBody, customId, shortAge, CUSTOM_MARK } from '../web/js/kinds.js';

const buttons = [
  { id: 'b1', label: 'qwen', cmd: 'qwen' },
  { id: 'b2', label: '🐍 python', cmd: 'python3 -i' },
];

test('a built-in preset is marked with the same glyph as its button', () => {
  assert.equal(kindMark('shell', buttons), '▸');
  assert.equal(kindMark('claude', buttons), '✦');
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
