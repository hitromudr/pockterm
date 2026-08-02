// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotText } from '../web/js/select.js';

test('rows become lines', () => {
  assert.equal(snapshotText(['one', 'two']), 'one\ntwo');
});

test('the padding every row carries is dropped', () => {
  assert.equal(snapshotText(['ls -la      ', 'total 8   ']), 'ls -la\ntotal 8');
});

test('the empty screen below the last line is not part of the copy', () => {
  assert.equal(snapshotText(['$ echo hi', 'hi', '', '   ', '']), '$ echo hi\nhi');
});

test('blank rows inside the screen stay — they are part of the output', () => {
  assert.equal(snapshotText(['first', '', 'third']), 'first\n\nthird');
});

test('an empty screen gives empty text, not a pile of newlines', () => {
  assert.equal(snapshotText(['', '', '']), '');
  assert.equal(snapshotText([]), '');
  assert.equal(snapshotText(null), '');
});

test('a row that is missing does not break the snapshot', () => {
  assert.equal(snapshotText(['ok', null, 'still ok']), 'ok\n\nstill ok');
});
