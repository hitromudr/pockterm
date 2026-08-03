// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, fieldState } from '../web/js/inputdiag.js';

test('shapes, not text, at the first level', () => {
  const e = { type: 'compositionupdate', data: 'привет' };
  const s = summarise(e, 'on');
  assert.equal(s.kind, 'compositionupdate');
  assert.equal(s.len, 6);
  // The whole point of the level: what was typed does not reach the journal.
  assert.equal(s.data, undefined);
});

test('the second level records the text, because "which word came back" needs it', () => {
  const s = summarise({ type: 'compositionend', data: 'привет' }, 'chars');
  assert.equal(s.data, 'привет');
});

test('an edit is recorded by intent', () => {
  const s = summarise({ type: 'beforeinput', inputType: 'deleteContentBackward' }, 'on');
  assert.equal(s.inputType, 'deleteContentBackward');
});

test('a printable key is not spelled out unless text is on', () => {
  assert.equal(summarise({ type: 'keydown', key: 'a' }, 'on').key, 'char');
  assert.equal(summarise({ type: 'keydown', key: 'a' }, 'chars').key, 'a');
  // Named keys are the interesting ones and are never secret.
  assert.equal(summarise({ type: 'keydown', key: 'Backspace' }, 'on').key, 'Backspace');
});

test('the field state says how much the IME is holding', () => {
  const el = { value: 'приве', selectionStart: 5, selectionEnd: 5 };
  const s = fieldState(el, 'on');
  assert.equal(s.value, 5);
  assert.equal(s.start, 5);
  assert.equal(s.text, undefined);
  assert.equal(fieldState(el, 'chars').text, 'приве');
});
