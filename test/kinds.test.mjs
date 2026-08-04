import test from 'node:test';
import assert from 'node:assert/strict';
import { kindMark, kindName, customMark, labelBody, customId, CUSTOM_MARK } from '../web/js/kinds.js';

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
