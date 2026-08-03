// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scroller } from '../web/js/scroll.js';

// A stand-in for the clock and the frame callback, so a flick can be played
// out without waiting for one.
function harness({ step = 100 } = {}) {
  const notches = [];
  let pending = [];
  const s = new Scroller({ notch: (d) => notches.push(d), raf: (fn) => pending.push(fn) });
  s.setStep(step);
  return {
    s, notches,
    // Run the glide forward, one frame at a time.
    frames(n, at, dt = 16) {
      for (let i = 0; i < n && pending.length; i++) {
        const fns = pending; pending = [];
        at += dt;
        for (const fn of fns) fn(at);
      }
      return at;
    },
    get idle() { return pending.length === 0; },
  };
}

test('the screen moves with the finger, not five times faster', () => {
  // One notch per step of travel — the whole defect was one notch per row
  // while tmux moved five lines per notch.
  const h = harness({ step: 100 });
  h.s.start(0);
  h.s.move(250, 16);
  assert.equal(h.notches.length, 2, 'two whole notches in 250px');
  h.s.move(50, 32);
  assert.equal(h.notches.length, 3, 'the leftover 50px carried into the third');
});

test('the leftover is spent, not dropped, when the direction changes', () => {
  const h = harness({ step: 100 });
  h.s.start(0);
  h.s.move(90, 16);
  assert.equal(h.notches.length, 0, '90px is not a step yet');
  // Back past where it started: 90 down then 180 up is 90 up — still short of
  // a step, and a notch here would be movement the finger never made.
  h.s.move(-180, 32);
  assert.equal(h.notches.length, 0);
  h.s.move(-20, 48);
  assert.deepEqual(h.notches, [-1], 'the carried 90 plus 20 makes the step');
});

test('a flick keeps going after the finger leaves, and settles', () => {
  const h = harness({ step: 100 });
  h.s.start(0);
  for (let i = 1; i <= 5; i++) h.s.move(60, i * 16); // ~3.75 px/ms
  const duringSwipe = h.notches.length;
  h.s.end(80);
  const after = h.frames(200, 80);
  assert.ok(h.notches.length > duringSwipe, 'the glide added nothing');
  assert.ok(h.idle, 'the glide never stopped');
  assert.ok(after < 80 + 200 * 16, 'sanity: the clock ran');
});

test('a slow drag ends where it stops', () => {
  const h = harness({ step: 100 });
  h.s.start(0);
  h.s.move(5, 100); // 0.05 px/ms — carrying a line, not throwing it
  const before = h.notches.length;
  h.s.end(120);
  h.frames(50, 120);
  assert.equal(h.notches.length, before, 'a careful drag must not drift');
});

test('holding still before lifting kills the glide', () => {
  const h = harness({ step: 100 });
  h.s.start(0);
  for (let i = 1; i <= 5; i++) h.s.move(60, i * 16);
  const before = h.notches.length;
  h.s.end(80 + 300); // finger rested on the screen for 300ms
  h.frames(50, 400);
  assert.equal(h.notches.length, before, 'a parked finger still threw the screen');
});

test('a new touch catches the glide', () => {
  const h = harness({ step: 100 });
  h.s.start(0);
  for (let i = 1; i <= 5; i++) h.s.move(60, i * 16);
  h.s.end(80);
  h.frames(2, 80);
  const caught = h.notches.length;
  h.s.stop();
  h.frames(50, 200);
  assert.equal(h.notches.length, caught, 'the screen kept moving under the finger');
});
