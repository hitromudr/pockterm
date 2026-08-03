// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endingKeys } from '../web/js/ender.js';

// A clock that only moves when the test says so: the whole rule is about which
// of two things goes first, and a real timer would test the machine's mood.
function clock() {
  let at = 0;
  let next = 1;
  const jobs = new Map();
  return {
    setTimer(fn, ms) { const id = next++; jobs.set(id, { fn, due: at + ms }); return id; },
    clearTimer(id) { jobs.delete(id); },
    tick(ms) {
      at += ms;
      for (const [id, j] of [...jobs].sort((a, b) => a[1].due - b[1].due)) {
        if (j.due <= at) { jobs.delete(id); j.fn(); }
      }
    },
  };
}

function harness({ hasBridge = true } = {}) {
  const sent = [];
  const commits = [];
  const c = clock();
  const keys = endingKeys({
    send: (b) => sent.push(b),
    commit: () => { commits.push(true); return hasBridge; },
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { keys, sent, commits, tick: c.tick };
}

test('the word goes before the newline', () => {
  // The defect: commitInput() ends the composition and the committed text
  // arrives in a later task, so an Enter sent in the same tick overtook it and
  // the line went without its last word.
  const h = harness();
  h.keys.press('\r');
  assert.deepEqual(h.commits, [true], 'the keyboard was not asked to hand over the word');
  assert.deepEqual(h.sent, [], 'the newline went before the word had a chance');

  // The keyboard delivers; the terminal reports it as input.
  h.keys.sawData();
  h.tick(24);
  assert.deepEqual(h.sent, ['\r'], 'the newline never followed the word');
});

test('a word arriving in two chunks keeps the newline behind both', () => {
  // A commit is not guaranteed to be one event, and a newline landing between
  // two halves of a word is the same defect with a different shape.
  const h = harness();
  h.keys.press('\r');
  h.keys.sawData();
  h.tick(16);
  assert.deepEqual(h.sent, [], 'the newline went between two chunks of the word');
  h.keys.sawData();
  h.tick(16);
  assert.deepEqual(h.sent, [], 'still within the gap after the second chunk');
  h.tick(8);
  assert.deepEqual(h.sent, ['\r']);
});

test('a key whose word never comes still goes', () => {
  // Nothing was being composed — most Enters, in fact. The wait has to end by
  // itself, because an Enter that sometimes does nothing is worse than the
  // defect being fixed.
  const h = harness();
  h.keys.press('\r');
  h.tick(89);
  assert.deepEqual(h.sent, [], 'released before the wait was over');
  h.tick(1);
  assert.deepEqual(h.sent, ['\r'], 'the key was swallowed');
});

test('without the bridge the key goes at once', () => {
  // In a browser there is no composition anybody can end, so waiting would be
  // latency for nothing.
  const h = harness({ hasBridge: false });
  h.keys.press('\r');
  assert.deepEqual(h.sent, ['\r']);
  assert.equal(h.keys.waiting, false);
});

test('two keys in a row keep their order', () => {
  // Two taps inside the wait: the first must not be dropped, and the second
  // must not overtake it.
  const h = harness();
  h.keys.press('\x1b[C\r'); // accept: right arrow, then Enter
  h.keys.press('\r');
  assert.deepEqual(h.sent, ['\x1b[C\r'], 'the first key was dropped');
  h.tick(90);
  assert.deepEqual(h.sent, ['\x1b[C\r', '\r']);
});

test('data with no key waiting changes nothing', () => {
  // Typing is data too, and most of it arrives with nothing held back.
  const h = harness();
  h.keys.sawData();
  h.tick(1000);
  assert.deepEqual(h.sent, []);
});
