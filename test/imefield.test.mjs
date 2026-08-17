import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldHygiene, keepEmpty } from '../web/js/imefield.js';

// A field that records what was done to it, and a clock that does not run until
// it is told to. Between them they are the whole environment this rule needs —
// which is the point: the events it reacts to cannot be produced by any browser
// the stand can drive.
function stand(initial = '') {
  const s = {
    value: initial,
    cleared: 0,
    queue: [],
    composed: [],
    run() { const q = s.queue; s.queue = []; for (const fn of q) fn(); },
  };
  s.rule = fieldHygiene({
    empty: () => !s.value,
    clear: () => { s.value = ''; s.cleared++; },
    defer: (fn) => s.queue.push(fn),
    onCompose: (open) => s.composed.push(open),
  });
  return s;
}

test('the word left behind after a composition is taken away', () => {
  // The measured defect: `порт` stays in the field after compositionend, the
  // keyboard finds it there and re-opens a composition over it, and the word
  // reaches the pty a second time.
  const s = stand('порт');
  s.rule.on('compositionstart');
  s.rule.on('input');
  s.rule.on('compositionend');
  s.run();
  assert.equal(s.value, '');
  assert.equal(s.cleared, 1);
});

test('a composition opening and closing is told to whoever asked', () => {
  // One listener answers this for the whole page: what is being composed is drawn
  // by xterm at the cursor, and the answer row is drawn over the pane's own last
  // rows — so the row steps aside while a word is being written there. A second
  // listener on these events would be a second answer to the question this rule
  // already tracks.
  const s = stand();
  s.rule.on('compositionstart');
  s.rule.on('input');
  assert.deepEqual(s.composed, [true], 'an edit inside a composition is not a composition starting');
  s.rule.on('compositionend');
  assert.deepEqual(s.composed, [true, false]);
  // And an edit with nothing being composed says nothing at all.
  s.rule.on('input');
  assert.deepEqual(s.composed, [true, false]);
});

test('nothing is taken while a composition is open', () => {
  // What is in the field then is being written. This is the bound that keeps
  // the rule from being one more author in the buffer.
  const s = stand('пор');
  s.rule.on('compositionstart');
  s.rule.on('input');
  s.run();
  assert.equal(s.value, 'пор');
  assert.equal(s.cleared, 0);
});

test('a composition reopened before the clear runs keeps its text', () => {
  // The wait is a real gap: a suggestion tapped in it opens a composition over
  // the very text the clear was scheduled for. Emptying the field then would
  // take away the word being written.
  const s = stand('порт');
  s.rule.on('compositionend');
  s.rule.on('compositionstart');
  s.run();
  assert.equal(s.value, 'порт');
  assert.equal(s.cleared, 0);
});

test('the space that no composition ever claimed is taken too', () => {
  // The phone's other mood: no composition at all, the letters arrive as key
  // events and never reach the field, and every space lands in it and stays.
  // Sixteen of them in half a minute of typing, in the same recording.
  const s = stand(' ');
  s.rule.on('input');
  s.run();
  assert.equal(s.value, '');
  assert.equal(s.cleared, 1);
});

test('the clear happens in a later task, never in the event itself', () => {
  // xterm reads the field on a timeout scheduled from compositionend: cleared
  // in the same task, the composed word would be sent as an empty string.
  // Sending nothing is worse than sending twice.
  const s = stand('порт');
  s.rule.on('compositionend');
  assert.equal(s.value, 'порт', 'the field was emptied before xterm could read it');
  s.run();
  assert.equal(s.value, '');
});

test('an empty field is left alone', () => {
  // Writing to the field is itself something the keyboard can react to, so it
  // is not done when there is nothing to take away.
  const s = stand('');
  s.rule.on('input');
  s.run();
  assert.equal(s.cleared, 0);
});

test('what was taken away is answerable from outside', () => {
  // A rule that was never wired and a rule that fires and takes nothing look
  // the same from a phone, and both look like the defect still being there.
  // The length is what tells them apart.
  const taken = [];
  const s = stand('порт');
  s.rule = fieldHygiene({
    empty: () => !s.value,
    clear: () => { taken.push(s.value.length); s.value = ''; },
    defer: (fn) => s.queue.push(fn),
  });
  s.rule.on('compositionend');
  s.run();
  assert.deepEqual(taken, [4]);
});

test('a burst of edits costs one clear', () => {
  // Every keystroke of a word raises an input event. One deferred clear for the
  // lot of them, or the field is rewritten under the keyboard mid-word.
  const s = stand('порт');
  s.rule.on('input');
  s.rule.on('input');
  s.rule.on('input');
  assert.equal(s.queue.length, 1);
  s.run();
  assert.equal(s.cleared, 1);
});

// keepEmpty hands back the answer the key bar needs, because the alternative is
// a second listener on the same events — two answers to "is a word being
// composed", and the one the Enter reads would be the one that drifted.
test('the wiring reports whether a word is being composed, and how much is held', () => {
  const listeners = {};
  const el = {
    value: '',
    addEventListener(k, fn) { (listeners[k] ||= []).push(fn); },
    removeEventListener(k, fn) { listeners[k] = (listeners[k] || []).filter((f) => f !== fn); },
  };
  const fire = (type) => { for (const fn of listeners[type] || []) fn({ type }); };

  const off = keepEmpty(el, { defer: () => {} });
  assert.equal(off.isComposing(), false);
  fire('compositionstart');
  assert.equal(off.isComposing(), true, 'an open composition was not seen');
  el.value = 'порт';
  assert.equal(off.held(), 4);
  fire('compositionend');
  assert.equal(off.isComposing(), false);
  off();
});

test('a field that was never there answers rather than throwing', () => {
  // xterm can create its textarea after this call, and the key bar asks on
  // every Enter: a guard that threw there would take the Enter with it.
  const off = keepEmpty(null);
  assert.equal(off.isComposing(), false);
  assert.equal(off.held(), 0);
  off();
});
