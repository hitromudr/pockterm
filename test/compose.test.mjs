// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushHistory, previewOf, HISTORY_MAX } from '../web/js/compose.js';

test('the newest message is at the front', () => {
  let h = [];
  h = pushHistory(h, 'first');
  h = pushHistory(h, 'second');
  assert.deepEqual(h, ['second', 'first']);
});

test('a repeat is moved rather than added', () => {
  // Sending the same line twice is what a retry after a lost send looks like,
  // and two identical rows say nothing the one does not.
  let h = pushHistory(pushHistory(pushHistory([], 'a'), 'b'), 'c');
  h = pushHistory(h, 'a');
  assert.deepEqual(h, ['a', 'c', 'b']);
});

test('nothing is kept for an empty message', () => {
  assert.deepEqual(pushHistory(['a'], ''), ['a']);
  assert.deepEqual(pushHistory(['a'], '   \n '), ['a']);
});

test('the list is capped, oldest first out', () => {
  let h = [];
  for (let i = 0; i < HISTORY_MAX + 5; i++) h = pushHistory(h, `m${i}`);
  assert.equal(h.length, HISTORY_MAX);
  assert.equal(h[0], `m${HISTORY_MAX + 4}`);
  assert.ok(!h.includes('m0'), 'the oldest survived the cap');
});

test('a stored list from another version is not trusted', () => {
  // It comes out of localStorage, where anything can be.
  assert.deepEqual(pushHistory(null, 'a'), ['a']);
  assert.deepEqual(pushHistory([1, null, 'b'], 'a'), ['a', 'b']);
});

test('a preview is one line, and long text ends in an ellipsis', () => {
  assert.equal(previewOf('  раз\nдва   три '), 'раз два три');
  const long = 'x'.repeat(200);
  const p = previewOf(long);
  assert.equal(p.length, 90);
  assert.ok(p.endsWith('…'));
});
