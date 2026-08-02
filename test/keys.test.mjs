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
  // DEL: a terminal reads BS (\x08) as "move left", not "erase".
  assert.equal(keyBytes('backspace'), '\x7f');
  // Answers to a numbered menu, typed without the on-screen keyboard.
  assert.equal(keyBytes('1'), '1');
  assert.equal(keyBytes('2'), '2');
  assert.equal(keyBytes('3'), '3');
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
