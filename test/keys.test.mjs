// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyBytes, applyCtrl } from '../web/js/keys.js';

test('named keys map to escape sequences', () => {
  assert.equal(keyBytes('esc'), '\x1b');
  assert.equal(keyBytes('tab'), '\t');
  assert.equal(keyBytes('shift-tab'), '\x1b[Z');
  assert.equal(keyBytes('up'), '\x1b[A');
  assert.equal(keyBytes('down'), '\x1b[B');
  assert.equal(keyBytes('right'), '\x1b[C');
  assert.equal(keyBytes('left'), '\x1b[D');
  assert.equal(keyBytes('enter'), '\r');
  assert.equal(keyBytes('ctrl-c'), '\x03');
  // The bar's backspace is gone since 2026-08-12: erasing is what every
  // on-screen keyboard already does, and its key went to the Ctrl latch, which
  // no keyboard offers. An unknown name answers with nothing rather than
  // guessing — the same as `delete` below, which left earlier for ^O.
  assert.equal(keyBytes('backspace'), '');
  // ^O: unfold the collapsed output. It replaced the forward delete on the bar,
  // then ✓ (accept) on 2026-08-19, handing its own cell to Tab — which has a
  // button again for the first time since the bar was laid out.
  assert.equal(keyBytes('ctrl-o'), '\x0f');
  assert.equal(keyBytes('delete'), '');
  // Answers to a numbered menu, typed without the on-screen keyboard.
  assert.equal(keyBytes('1'), '1');
  assert.equal(keyBytes('2'), '2');
  assert.equal(keyBytes('3'), '3');
  // ESC + CR: a newline in the message, not a send.
  assert.equal(keyBytes('alt-enter'), '\x1b\r');
});

test('unknown key maps to empty string', () => {
  assert.equal(keyBytes('bogus'), '');
});

test('ctrl latch maps letters to control codes', () => {
  assert.equal(applyCtrl('a'), '\x01');
  assert.equal(applyCtrl('C'), '\x03');
  assert.equal(applyCtrl('z'), '\x1a');
});

test('ctrl latch reads a Cyrillic letter by the key it sits on', () => {
  // The owner's keyboard is Russian, and a page can switch neither the layout nor
  // the language — so the letter arrives Cyrillic and this is where it becomes a
  // control code. By position, which is what a terminal on a laptop does with the
  // same layout: `^R` is on `к` there too.
  assert.equal(applyCtrl('к'), '\x12', 'к sits on r');
  assert.equal(applyCtrl('я'), '\x1a', 'я sits on z');
  assert.equal(applyCtrl('в'), '\x04', 'в sits on d');
  assert.equal(applyCtrl('д'), '\x0c', 'д sits on l');
  assert.equal(applyCtrl('С'), '\x03', 'и в верхнем регистре тоже');
  // Every key the pad offers has a Cyrillic letter that reaches it, or the latch
  // would be a lever that does less than the buttons beside it.
  const pad = ['a', 'e', 'k', 'u', 'w', 'r', 'l', 'd', 'z', 'p'];
  const cyr = ['ф', 'у', 'л', 'г', 'ц', 'к', 'д', 'в', 'я', 'з'];
  for (let i = 0; i < pad.length; i++) {
    assert.equal(applyCtrl(cyr[i]), applyCtrl(pad[i]), `${cyr[i]} is not on ${pad[i]}`);
  }
});

test('ctrl latch passes other characters through', () => {
  assert.equal(applyCtrl('1'), '1');
  // `ж` sits on `;` and `ё` on a backtick — punctuation is not a control code
  // here, so they go through untouched rather than being swallowed.
  assert.equal(applyCtrl('ж'), 'ж');
  assert.equal(applyCtrl('ё'), 'ё');
});
