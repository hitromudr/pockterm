// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endingKeys, commitComposition, endEditByBlur } from '../web/js/ender.js';

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

// commitComposition: which of the two ways to make the keyboard hand over its
// word, and whether there is anything to hand over at all.
//
// It cannot be tested in the browser — desktop Chromium has no IME, which is
// what js/inputdiag.js says in its own header — so the field is injected here
// and the phone is the judge of the rest.
test('the bridge is preferred, and nothing else is touched when it answers', () => {
  let ended = 0;
  const asked = commitComposition({
    bridge: () => true,
    composing: () => { throw new Error('the field was consulted over the app'); },
    endEdit: () => { ended++; },
  });
  assert.equal(asked, true);
  assert.equal(ended, 0, 'the focus was moved though the app had already been asked');
});

test('with no bridge and a composition open, the field is what ends it', () => {
  let ended = 0;
  const asked = commitComposition({
    bridge: () => false,
    composing: () => true,
    endEdit: () => { ended++; },
  });
  // True is what makes the ender wait: the word arrives in a later task.
  assert.equal(asked, true, 'the Enter would have overtaken the word again');
  assert.equal(ended, 1);
});

test('with nothing being composed the key goes at once', () => {
  // The right answer rather than a missing one: what was typed has already
  // gone as key events, and an Enter that waited for a word nobody is holding
  // would read as lag on every press.
  let ended = 0;
  const asked = commitComposition({
    bridge: () => false,
    composing: () => false,
    endEdit: () => { ended++; },
  });
  assert.equal(asked, false);
  assert.equal(ended, 0, 'the focus was moved with no composition to end');
});

test('a browser that composes is no longer treated as one that cannot', () => {
  // The defect itself: the bridge-less path answered false whatever the field
  // was doing, so the ender sent the key immediately and the last word stayed
  // in the textarea. Reported dictating by voice, which holds one long
  // composition — the word is always still there when Enter is pressed.
  const sent = [];
  let composing = true;
  const keys = endingKeys({
    send: (b) => sent.push(b),
    commit: () => commitComposition({
      bridge: () => false,
      composing: () => composing,
      endEdit: () => { composing = false; },
    }),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  keys.press('\r');
  assert.deepEqual(sent, [], 'the Enter went out over the word being dictated');
  keys.sawData();          // the composition ended and its text arrived
  assert.equal(keys.waiting, true, 'the key stopped waiting before the gap');
});

// A field that behaves like xterm's: the blur handler wipes it (that is
// `_handleTextAreaBlur`, literally `this.textarea.value = ""`), and the read
// that sends the word to the pty happens a task later, from the timeout
// `compositionend` schedules.
function xtermField(value, { wipesOnBlur = true } = {}) {
  return {
    value,
    focused: true,
    blurs: 0,
    focuses: 0,
    blur() { this.blurs++; this.focused = false; if (wipesOnBlur) this.value = ''; },
    focus() { this.focuses++; this.focused = true; },
  };
}

test('the word survives the blur that ends the composition', () => {
  // The defect measured on the phone: ending the composition by moving the
  // focus is the only lever a browser has, and it runs xterm's own wipe before
  // xterm's own read — so the word was not sent late, it was not sent at all.
  const el = xtermField('край');
  const restored = endEditByBlur(el);
  assert.equal(el.value, 'край', 'the field xterm reads a task later was empty');
  assert.equal(restored, 4, 'the journal would not say the word had been put back');
  assert.equal(el.blurs, 1, 'the composition was never ended');
  assert.equal(el.focused, true, 'the keyboard was left without a field to type into');
});

test('a field nobody wiped is not written to', () => {
  // The write exists to undo one that happened inside this very call. A browser
  // or an xterm that keeps the value gets no write at all — the buffer has one
  // owner, and this is the exception rather than a second author.
  const el = xtermField('край', { wipesOnBlur: false });
  let writes = 0;
  const watched = {
    get value() { return el.value; },
    set value(v) { writes++; el.value = v; },
    blur: () => el.blur(),
    focus: () => el.focus(),
  };
  const restored = endEditByBlur(watched);
  assert.equal(restored, 0);
  assert.equal(writes, 0, 'the field was rewritten with what it already held');
  assert.equal(el.focuses, 1);
});

test('no field is not an error', () => {
  // xterm creates its textarea when it opens, and an Enter that threw here
  // would take the whole key bar with it.
  assert.equal(endEditByBlur(null), 0);
});
