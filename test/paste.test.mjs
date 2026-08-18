// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickImages, imageFiles, carriesFiles, firstImage } from '../web/js/paste.js';

const png = { type: 'image/png', name: 'screenshot.png' };
const two = { type: 'image/png', name: 'second.png' };

test('a pasted screenshot is found among the files', () => {
  assert.deepEqual(pickImages({ files: [png] }), [png]);
});

test('a screenshot offered only as an item is found too', () => {
  const data = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }] };
  assert.deepEqual(pickImages(data), [png]);
});

test('a selection of screenshots comes back whole, in the order it was carried', () => {
  assert.deepEqual(pickImages({ files: [png, two] }), [png, two]);
});

test('a picture carried in both lists is attached once, not twice', () => {
  // A drop exposes the same file through `files` and through `items`; collecting
  // from each in turn would upload it twice and type its path twice.
  const data = {
    files: [png],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
  };
  assert.deepEqual(pickImages(data), [png]);
});

test('a plain text paste is left alone', () => {
  const data = {
    files: [],
    items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
  };
  assert.deepEqual(pickImages(data), []);
});

test('a non-image file is not an image', () => {
  assert.deepEqual(pickImages({ files: [{ type: 'application/pdf', name: 'spec.pdf' }] }), []);
});

test('what is not an image is dropped from a mixed drop, not the whole drop', () => {
  const data = { files: [{ type: 'application/pdf', name: 'spec.pdf' }, png] };
  assert.deepEqual(pickImages(data), [png]);
});

test('an item that refuses to yield a file does not crash the paste', () => {
  const data = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] };
  assert.deepEqual(pickImages(data), []);
});

test('nothing at all is not an image', () => {
  assert.deepEqual(pickImages(null), []);
  assert.deepEqual(pickImages({}), []);
});

test("the file chooser's own answer is filtered too", () => {
  // `accept="image/*"` is a hint to the picker, not a promise from it.
  assert.deepEqual(imageFiles([png, { type: 'text/plain', name: 'notes.txt' }, two]), [png, two]);
  assert.deepEqual(imageFiles(null), []);
});

test('a drag carrying files is accepted before its payload is readable', () => {
  assert.equal(carriesFiles({ types: ['Files'] }), true);
  assert.equal(carriesFiles({ types: ['text/plain'] }), false);
  assert.equal(carriesFiles(null), false);
});

test('the clipboard API path returns the image blob', async () => {
  const blob = { type: 'image/png' };
  const items = [
    { types: ['text/plain'], getType: async () => ({ type: 'text/plain' }) },
    { types: ['image/png'], getType: async (t) => (t === 'image/png' ? blob : null) },
  ];
  assert.equal(await firstImage(items), blob);
});

test('a text-only clipboard yields no image', async () => {
  const items = [{ types: ['text/plain'], getType: async () => ({ type: 'text/plain' }) }];
  assert.equal(await firstImage(items), null);
});
