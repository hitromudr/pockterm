// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotText, chunks, pickedText } from '../web/js/select.js';

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

test('a paragraph is a run of lines with no blank line in it', () => {
  const cut = chunks('one\ntwo\n\nthree');
  assert.deepEqual(cut.map((c) => c.para), [true, false, true]);
  assert.deepEqual(cut.map((c) => c.text), ['one\ntwo\n', '\n', 'three']);
});

test('the chunks put back together are the text they came from', () => {
  // The copy window is laid out from these, so a selection dragged across it
  // reads as it looks only while this holds.
  for (const text of [
    'one\ntwo\n\nthree',
    '\n\nleading blanks\n',
    'trailing blank\n\n',
    'no blanks at all',
    '   \nspaces are blank\n \n',
  ]) assert.equal(chunks(text).map((c) => c.text).join(''), text);
});

test('a line of spaces is blank, and belongs to no paragraph', () => {
  const cut = chunks('above\n   \nbelow');
  assert.deepEqual(cut.map((c) => c.para), [true, false, true]);
});

test('nothing on screen offers nothing to pick', () => {
  assert.deepEqual(chunks(''), []);
  assert.deepEqual(chunks(null), []);
});

test('picked paragraphs come out separated by the blank line that separated them', () => {
  assert.equal(pickedText(['one\ntwo\n', 'four\n']), 'one\ntwo\n\nfour');
});

test('one paragraph comes out without a trailing newline', () => {
  // It is pasted into a shell as often as into a message, and a newline there
  // is a command nobody typed.
  assert.equal(pickedText(['make check\n']), 'make check');
});

test('nothing picked is empty text, not a blank line', () => {
  assert.equal(pickedText([]), '');
  assert.equal(pickedText(null), '');
  assert.equal(pickedText(['\n', '  \n']), '');
});
