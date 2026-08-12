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
  // ^O: unfold the collapsed output. It replaced the forward delete on the bar.
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

test('ctrl latch passes other characters through', () => {
  assert.equal(applyCtrl('1'), '1');
  assert.equal(applyCtrl('щ'), 'щ');
});
