// The scrollbar's arithmetic. Run: node --test test/bar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumb, backAt, MIN_THUMB } from '../web/js/bar.js';

test('no history is no bar', () => {
  // A pane with nothing behind it has nowhere to go, and a full-height thumb
  // would be a control that says "drag me" and cannot move.
  assert.equal(thumb({ hist: 0, rows: 40, back: 0, track: 300 }), null);
  // And the same for a bar with no room to be drawn in — the terminal is
  // measured, and before the first fit it measures nothing.
  assert.equal(thumb({ hist: 800, rows: 40, back: 0, track: 0 }), null);
});

test('the thumb covers the screen\'s share of the whole output', () => {
  // 40 rows on screen, 360 behind: the screen is a tenth of the 400 lines that
  // exist, so the thumb is a tenth of the track.
  const t = thumb({ hist: 360, rows: 40, back: 0, track: 300 });
  assert.equal(t.height, 30);
  // At the live end it sits at the bottom of its travel.
  assert.equal(t.top, t.span);
});

test('the top of the track is the oldest line kept', () => {
  const t = thumb({ hist: 360, rows: 40, back: 360, track: 300 });
  assert.equal(t.top, 0);
  // Half way back is half way up.
  const half = thumb({ hist: 360, rows: 40, back: 180, track: 300 });
  assert.equal(half.top, Math.round(half.span / 2));
});

test('a thumb stays big enough to be a target', () => {
  // Thousands of lines of history against a phone screen: the honest share is
  // a couple of pixels, and a couple of pixels cannot be dragged with a thumb.
  const t = thumb({ hist: 20000, rows: 40, back: 0, track: 300 });
  assert.equal(t.height, MIN_THUMB);
  // Which the position has to answer to as well: the travel is the track less
  // the thumb, so the bottom is still the bottom.
  assert.equal(t.top, 300 - MIN_THUMB);
});

test('a position past either end is the end', () => {
  const over = thumb({ hist: 360, rows: 40, back: 1000, track: 300 });
  assert.equal(over.top, 0);
  const under = thumb({ hist: 360, rows: 40, back: -5, track: 300 });
  assert.equal(under.top, under.span);
});

test('dragging asks for the place the thumb was put', () => {
  const t = thumb({ hist: 400, rows: 40, back: 0, track: 300 });
  // Dropped at the top: the oldest line kept.
  assert.equal(backAt({ top: 0, span: t.span, hist: 400 }), 400);
  // Dropped at the bottom: the live end, which is what leaves copy-mode.
  assert.equal(backAt({ top: t.span, span: t.span, hist: 400 }), 0);
  // And in the middle, half the history.
  assert.equal(backAt({ top: t.span / 2, span: t.span, hist: 400 }), 200);
});

test('a drag past the track is the end of it', () => {
  // The finger leaves the bar — vertically it is still a drag, and dropping it
  // above the track means the top rather than nothing.
  assert.equal(backAt({ top: -80, span: 260, hist: 400 }), 400);
  assert.equal(backAt({ top: 900, span: 260, hist: 400 }), 0);
});

test('a bar with no travel asks for nothing', () => {
  // Thumb as tall as the track: everything is on screen, and a drag has no
  // meaning to give. Not a division by zero either, which is what the guard is.
  assert.equal(backAt({ top: 10, span: 0, hist: 400 }), 0);
  assert.equal(backAt({ top: 10, span: 260, hist: 0 }), 0);
});

test('the round trip is stable', () => {
  // What the bar draws for a position must ask for that same position back, or
  // a drag that ends where it started would move the pane.
  for (const back of [0, 1, 137, 399, 400]) {
    const t = thumb({ hist: 400, rows: 40, back, track: 300 });
    const asked = backAt({ top: t.top, span: t.span, hist: 400 });
    assert.ok(Math.abs(asked - back) <= 2, `${back} came back as ${asked}`);
  }
});
