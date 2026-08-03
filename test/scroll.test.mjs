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

test('a fingertip resting on the screen does not scroll it', () => {
  // A tap and a hold both jitter by a pixel or two, and every one of those
  // used to move the history. The gesture only starts once the finger has
  // clearly travelled.
  // The step is small here on purpose: with a large one the carry hides the
  // jitter, and the test would pass without the threshold existing.
  const h = harness({ step: 3 });
  h.s.start(0);
  h.s.move(2, 16);
  h.s.move(-1, 32);
  h.s.move(2, 48);
  assert.equal(h.notches.length, 0, 'jitter scrolled the screen');
  // And once it does travel, nothing of the movement is lost: 2-1+2+20 = 23px
  // is seven whole steps of three.
  h.s.move(20, 64);
  assert.equal(h.notches.length, 7, 'the travel before the threshold was dropped');
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

test('a gesture reports what it sent, because the feel is not visible from here', () => {
  // Every notch is a message to tmux and a redraw coming back over the
  // network, so "the swipe feels wrong" is only answerable with numbers from
  // the device: how many notches went out, how many of them after the finger
  // left, and how fast it was thrown.
  const seen = [];
  let pending = [];
  const s = new Scroller({
    notch: () => {},
    onGesture: (g) => seen.push(g),
    raf: (fn) => pending.push(fn),
  });
  s.setStep(50);

  s.start(0);
  for (let i = 1; i <= 5; i++) s.move(60, i * 16);
  s.end(80);
  for (let i = 0; i < 200 && pending.length; i++) {
    const fns = pending; pending = [];
    for (const fn of fns) fn(96 + i * 16);
  }

  assert.equal(seen.length, 1, 'one gesture, one report');
  const g = seen[0];
  assert.ok(g.notches > 0, 'nothing was sent');
  assert.ok(g.glided > 0, 'the glide is not accounted for');
  assert.ok(g.speed > 0, 'the throw speed is missing');
  assert.ok(g.ms >= 80, `the gesture lasted ${g.ms}ms`);
});

// A whole swipe played out at a chosen pace, returning the one gesture report
// it produced. Speeds here are stated as px/ms so the assertions can be read
// against what the journal prints.
function play(moves, { step = 10, lift = 16 } = {}) {
  const seen = [];
  let pending = [];
  const s = new Scroller({
    notch: () => {},
    onGesture: (g) => seen.push(g),
    raf: (fn) => pending.push(fn),
  });
  s.setStep(step);
  let at = 0;
  s.start(at);
  for (const m of moves) { at += m.dt; s.move(m.dy, at); }
  at += lift;
  s.end(at);
  for (let i = 0; i < 500 && pending.length; i++) {
    const fns = pending; pending = [];
    at += 16;
    for (const fn of fns) fn(at);
  }
  return seen[0];
}

// 16px every 16ms is exactly 1 px/ms, for as long as the caller wants.
function steadyMoves(n, dy = 16, dt = 16) {
  return Array.from({ length: n }, () => ({ dy, dt }));
}

test('the throw is the speed the finger actually had, not a fraction more', () => {
  // The arithmetic that reads fast: summing a window of travel and dividing by
  // the gap between its first and last timestamps leaves out the first
  // sample's own interval — 96px over 80ms instead of over 96ms, a fifth too
  // much on every gesture. Inertia tuned against that number is tuned against
  // a bias, so it is pinned here rather than left to feel.
  const g = play(steadyMoves(20));
  assert.ok(g.speed >= 0.9 && g.speed <= 1.1, `1 px/ms was read as ${g.speed}`);
});

test('what the tail of the swipe did decides the throw', () => {
  // A swipe that runs fast and then eases off before lifting is a swipe being
  // placed, not thrown. A running average keeps a residue of the fast part and
  // throws it anyway; the last fraction of a second is what a flick means.
  const steady = play(steadyMoves(16));
  const easing = play([...steadyMoves(10), ...steadyMoves(6, 2)]);
  assert.ok(steady.speed > 0.9, `the steady swipe reported ${steady.speed}`);
  assert.ok(easing.speed < steady.speed / 4, `the fast start was still in the throw: ${easing.speed}`);
  assert.ok(easing.glided < steady.glided, 'the eased swipe glided as far as the steady one');
});

test('a lift that arrives late does not cancel the throw', () => {
  // Two questions with two answers: how fast the finger was going, and whether
  // it had stopped. Measuring the travel against the lift instead of against
  // the samples answers the first with the second, so a WebView that reports
  // touchend a frame or two after the last touchmove loses the inertia — which
  // is the complaint, not a cure for it. Beyond PARK the finger did rest, and
  // then the screen stays put.
  const prompt = play(steadyMoves(10), { lift: 16 });
  const late = play(steadyMoves(10), { lift: 100 });
  const parked = play(steadyMoves(10), { lift: 300 });
  assert.ok(late.speed > 0.9, `a 100ms lift dropped the throw to ${late.speed}`);
  assert.equal(late.speed, prompt.speed, 'the lift latency changed the measured speed');
  assert.equal(parked.speed, 0, 'a parked finger still threw the screen');
  assert.equal(parked.glided, 0);
});

test('the gesture reports how long the finger had stopped before lifting', () => {
  // Whether PARK is set anywhere near right is a property of the device, and
  // this is the only number that says so: if it is routinely above PARK, no
  // choice of estimator leaves any inertia on that phone.
  assert.equal(play(steadyMoves(10), { lift: 48 }).idle, 48);
  assert.equal(play(steadyMoves(10), { lift: 0 }).idle, 0);
});

test('a gesture that never glides still reports', () => {
  const seen = [];
  const s = new Scroller({ notch: () => {}, onGesture: (g) => seen.push(g), raf: () => {} });
  s.setStep(50);
  s.start(0);
  s.move(20, 200);
  s.end(400); // held still: no glide
  assert.equal(seen.length, 1);
  assert.equal(seen[0].glided, 0);
});
