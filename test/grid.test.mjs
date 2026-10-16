// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridShape, gridPick, gridKeep, storedGrid, GRID_MAX } from '../web/js/grid.js';

const shape = (n, w, h) => {
  const { cols, rows } = gridShape(n, w, h);
  return `${cols}x${rows}`;
};

test('six are 3x2 on a wide screen and 2x3 on a tall one', () => {
  assert.equal(shape(6, 1920, 900), '3x2'); // laptop
  assert.equal(shape(6, 1366, 600), '3x2'); // a short laptop
  assert.equal(shape(6, 3440, 1300), '3x2'); // a long monitor
  assert.equal(shape(6, 900, 380), '3x2'); // a long phone on its side
  assert.equal(shape(6, 400, 750), '2x3'); // a phone upright
  assert.equal(shape(6, 1080, 1800), '2x3'); // a monitor on its end
});

test('fewer cells take fewer columns, by the same measure', () => {
  assert.equal(shape(1, 400, 750), '1x1');
  assert.equal(shape(2, 1920, 900), '2x1');
  assert.equal(shape(2, 400, 750), '1x2');
  assert.equal(shape(3, 1920, 900), '3x1');
  assert.equal(shape(3, 400, 750), '1x3');
  assert.equal(shape(4, 1920, 900), '2x2');
  assert.equal(shape(4, 400, 750), '2x2');
});

test('five leave one slot, and the last cell spans it', () => {
  assert.deepEqual(gridShape(5, 1920, 900), { cols: 3, rows: 2, span: 2 });
  assert.deepEqual(gridShape(5, 400, 750), { cols: 2, rows: 3, span: 2 });
  assert.equal(gridShape(6, 1920, 900).span, 1);
});

test('never more than three along a side, whatever the box', () => {
  for (const [w, h] of [[5000, 200], [200, 5000], [1, 1], [0, 0]]) {
    for (let n = 1; n <= GRID_MAX; n++) {
      const { cols, rows } = gridShape(n, w, h);
      assert.ok(cols <= 3 && rows <= 3 && cols * rows >= n && cols * rows <= GRID_MAX, `${n} in ${w}x${h}: ${cols}x${rows}`);
    }
  }
  // Asked for more than there can be: as many as there can be.
  assert.ok(['3x2', '2x3'].includes(shape(9, 800, 600)));
});

test('a tap adds, makes active, or says the grid is full', () => {
  assert.equal(gridPick(['a', 'b'], 'a'), 'activate');
  assert.equal(gridPick(['a', 'b'], 'c'), 'add');
  assert.equal(gridPick(['a', 'b', 'c', 'd', 'e', 'f'], 'g'), 'full');
  assert.equal(gridPick(['a', 'b', 'c', 'd', 'e', 'f'], 'f'), 'activate');
});

test('a closed session leaves the grid, order kept', () => {
  assert.deepEqual(gridKeep(['a', 'b', 'c'], new Set(['c', 'a'])), ['a', 'c']);
  assert.deepEqual(gridKeep(['a', 'a', '', 7, 'b'], new Set(['a', 'b'])), ['a', 'b']);
});

test('storage gives back a grid or nothing', () => {
  assert.deepEqual(storedGrid(null), { on: false, names: [] });
  assert.deepEqual(storedGrid('{bad'), { on: false, names: [] });
  assert.deepEqual(storedGrid('{"on":true,"names":[]}'), { on: false, names: [] });
  assert.deepEqual(storedGrid('{"on":true,"names":["a",3,"b"]}'), { on: true, names: ['a', 'b'] });
  assert.equal(storedGrid('{"on":true,"names":["a","b","c","d","e","f","g"]}').names.length, GRID_MAX);
});
