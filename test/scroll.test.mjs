// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scroller, movedWholeScreen } from '../web/js/scroll.js';

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

// The same clock and frame stand-in, plus the pixel shift the page applies to
// the drawn screen. `step` is a whole notch: two lines of tmux on the device.
//
// The page's part of the accounting is modelled too, because it is half the
// rule: notches go out as one message per animation frame (`batched`), and each
// message is answered by one repaint of the screen (`drew`).
function tracking({ step = 30 } = {}) {
  const shifts = [];
  let pending = [];
  const s = new Scroller({
    notch: () => {},
    onTrack: (px) => shifts.push(px),
    raf: (fn) => pending.push(fn),
  });
  s.setStep(step);
  return {
    s, shifts,
    get last() { return shifts[shifts.length - 1]; },
    // What the page does on the next frame after a notch: one message out.
    send(at) { s.batched(at); },
    // And what comes back: tmux repainted the pane, so a batch has landed.
    drew(at) { s.drew(at); },
    // Let frames pass without the finger moving. Nothing lands by itself now —
    // this is what proves it.
    idleTo(at) {
      for (let i = 0; i < 20 && pending.length; i++) {
        const fns = pending; pending = [];
        for (const fn of fns) fn(at);
      }
    },
  };
}

test('the screen follows the finger between two whole lines', () => {
  // The reported defect: dragging slowly, the scroll stands still for a couple
  // of lines and then jumps. tmux cannot draw less than a line, so the page
  // shifts what it has — and the shift must equal the travel exactly, or the
  // finger is still leading the picture.
  const h = tracking({ step: 30 });
  h.s.start(0);
  h.s.move(10, 16);
  assert.equal(h.last, 10, 'a third of a step of travel showed nothing');
  h.s.move(10, 32);
  assert.equal(h.last, 20);
  // Here a notch goes out: the shift stays where the finger is, because the
  // content has not moved yet. Giving it back now is what produced the jump
  // back and forth.
  h.s.move(10, 48);
  h.send(48);
  assert.equal(h.last, 30, 'the picture jumped back when the notch went out');
  h.s.move(10, 64);
  assert.equal(h.last, 40, 'the shift stopped following the finger');
});

test('the shift is handed back by what was drawn, not by a clock', () => {
  // The first version predicted this from the measured round trip, and the
  // device settled it: the trip averages 40-50ms and peaks at 130, so a swipe
  // of twenty notches mispredicted several of them and every miss was a step
  // back and then forward. Nothing lands here until the screen is seen to move.
  const h = tracking({ step: 30 });
  h.s.start(0);
  for (const at of [16, 32, 48, 64]) h.s.move(10, at);
  h.send(64);
  assert.equal(h.last, 40, 'the finger was not followed');

  // Time alone changes nothing now.
  h.idleTo(300);
  assert.equal(h.last, 40, 'a clock handed the shift back on its own');

  // The screen moves: one message, one repaint. What is left owed is the
  // fraction of a line the finger is into — 10 of a 30px step — and the content
  // moving one step while the shift drops one step is a picture that moves once.
  h.drew(320);
  assert.equal(h.last, 10, `40px travelled, 30 drawn, ${h.last} left owed`);
});

test('a batch nobody answers lets go by itself', () => {
  // At the top of the history there is no scroll for tmux to make and no
  // repaint to count, and a shift held for good would be a band of background
  // parked at the edge of the screen.
  const h = tracking({ step: 30 });
  h.s.start(0);
  for (const at of [16, 32, 48]) h.s.move(10, at);
  h.send(48);
  assert.equal(h.last, 30);
  h.idleTo(48 + 401);
  assert.equal(h.last, 0, `the unanswered batch is still owed: ${h.last}`);
});

test('the shift is bounded, so a fast drag shows a line of background at most', () => {
  // The shift covers for what has not arrived, and a drag fast enough to keep
  // several messages in the air would displace the screen further than it should
  // ever be: what appears at the edge is background, and a screenful of it would
  // be worse than the jump it cures.
  const h = tracking({ step: 30 });
  h.s.start(0);
  for (let i = 1; i <= 12; i++) { h.s.move(40, i * 16); h.send(i * 16); } // nothing answered
  assert.ok(Math.abs(h.last) <= 90, `shifted by ${h.last}, more than three steps`);
});

test('letting go hands the picture back to tmux', () => {
  // A screen left parked a fraction of a line off its grid would misplace every
  // tap after the gesture, so the shift is returned when the gesture is over —
  // whichever way it ends.
  const parked = tracking({ step: 30 });
  parked.s.start(0);
  parked.s.move(10, 16);
  parked.send(16);
  assert.equal(parked.last, 10);
  parked.s.end(16 + 300); // rested before lifting: no glide to wait for
  assert.equal(parked.last, 0, 'the shift outlived the gesture');

  // Thrown, with messages still in the air. The lift must change nothing about
  // the shift: it stands for content that has not arrived, and handing it back
  // there was reported as the screen flying backwards to the finger the moment
  // it let go — six rows of it, with the cap at three steps.
  const thrown = tracking({ step: 30 });
  thrown.s.start(0);
  for (let i = 1; i <= 5; i++) { thrown.s.move(20, i * 16); thrown.send(i * 16); }
  const beforeLift = thrown.last;
  assert.notEqual(beforeLift, 0, 'the finger was not followed');
  thrown.s.end(80);
  assert.equal(thrown.last, beforeLift, 'the picture flew back when the finger left');

  // It goes back as the content lands, which is the same movement forwards —
  // and by the end of the glide, when nothing is owed, the residue settles.
  // The page's half is modelled per frame, because that is what it does: the
  // glide's notches go out with the next message and are answered by the next
  // repaint.
  let at = 80;
  for (let i = 0; i < 300; i++) {
    at += 16;
    thrown.idleTo(at);
    thrown.send(at);
    thrown.drew(at);
  }
  assert.equal(thrown.last, 0, 'the shift outlived the glide');
});

test('nothing is owed, so the residue settles by itself', () => {
  // A drag that ends with everything drawn: what is left is the fraction of a
  // line the finger travelled past the last whole one, and tmux cannot draw
  // that. It is the one thing the shift gives back without content arriving.
  const h = tracking({ step: 30 });
  h.s.start(0);
  h.s.move(10, 16);
  h.send(16);
  assert.equal(h.last, 10, 'the finger was not followed');
  h.s.end(16 + 300); // rested, so no glide
  assert.equal(h.last, 0, `the residue was left on screen: ${h.last}`);
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

test('a scroll is told from ordinary output by how much was repainted', () => {
  // What makes a wheel batch count as drawn. Both mistakes are silent: too
  // eager hands the shift back while the content has not moved, too strict
  // holds it until the backstop lets go. The numbers come from the stand — a
  // character echoed into a 36-row screen renders [34,34], a scroll renders
  // [0,34].
  assert.equal(movedWholeScreen(0, 34, 36), true, 'a scroll was not recognised');
  assert.equal(movedWholeScreen(0, 35, 36), true);
  assert.equal(movedWholeScreen(34, 34, 36), false, 'one printed row counted as a scroll');
  assert.equal(movedWholeScreen(0, 1, 36), false, 'two rows counted as a scroll');
  // A screen small enough that a couple of rows are most of it: the slack must
  // not swallow it whole.
  assert.equal(movedWholeScreen(0, 2, 4), false, 'three rows of four is not the screen moving');
  assert.equal(movedWholeScreen(0, 3, 4), true);
  // Nothing is known about a terminal with no rows yet.
  assert.equal(movedWholeScreen(0, 0, 0), false);
});

test('notches thrown away with the queue stop being owed', () => {
  // Leaving the history drops whatever is queued for the next message — those
  // notches never go out, so the shift must not go on covering them. Only a
  // message that was sent can expire on the backstop, which is why this needs
  // saying out loud: without it the screen would sit shifted until the next
  // gesture reset it.
  const h = tracking({ step: 30 });
  h.s.start(0);
  h.s.move(70, 16); // two whole notches and a remainder, none of it sent yet
  assert.equal(h.last, 70, 'the finger was not followed');
  h.s.dropped();
  h.s.track(32);
  assert.equal(h.last, 10, `the dropped notches are still owed: ${h.last}`);
});

test('the residue settles once the last unanswered batch expires', () => {
  // The order inside track() is the whole of this case: what is owed has to be
  // read — which is also what expires a batch nobody answered — before asking
  // whether anything is left. Asking first left the sub-line residue on screen
  // for good, a few pixels off the grid, which the browser test caught as a
  // shift that never came back.
  const h = tracking({ step: 30 });
  h.s.start(0);
  h.s.move(34, 16); // one whole notch and 4px over
  h.send(16);
  assert.equal(h.last, 34);
  h.s.end(16 + 300); // rested before lifting, so there is no glide in the way
  h.idleTo(16 + 300 + 401); // the batch nobody answered expires here
  assert.equal(h.last, 0, `the residue stayed on screen: ${h.last}`);
});
