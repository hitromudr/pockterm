import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropIndex } from '../web/js/carry.js';

// Three tabs of 100px, the second one being the carried tab left out: the boxes
// here are the others', in the order the row has them.
const rects = [{ left: 0, width: 100 }, { left: 100, width: 100 }, { left: 200, width: 100 }];

test('past the middle of a tab means after it', () => {
  assert.equal(dropIndex(rects, 10), 0, 'before the first');
  assert.equal(dropIndex(rects, 49), 0, 'still before the first');
  assert.equal(dropIndex(rects, 51), 1, 'past the first');
  assert.equal(dropIndex(rects, 151), 2);
  assert.equal(dropIndex(rects, 290), 3, 'after the last');
});

test('an empty row has one place in it', () => {
  assert.equal(dropIndex([], 120), 0);
});

test('the answer never moves backwards along the row', () => {
  // The rule has to be the same in both directions, or a finger resting on a
  // boundary would swap the tab back and forth.
  let last = -1;
  for (let x = -50; x < 350; x += 7) {
    const at = dropIndex(rects, x);
    assert.ok(at >= last, `x=${x} answered ${at} after ${last}`);
    last = at;
  }
});

test('only the x is read, because the strip is 34px tall', () => {
  // The whole defect this file exists for: the first version asked
  // elementFromPoint, which reads the y as well, and a thumb crossing a strip at
  // the top edge of the screen leaves it. There is no y to pass here.
  assert.equal(dropIndex.length, 2);
});
