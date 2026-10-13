// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFiles, chosenFiles, carriesFiles, firstImage } from '../web/js/paste.js';

const png = { type: 'image/png', name: 'screenshot.png' };
const two = { type: 'image/png', name: 'second.png' };
const doc = { type: 'application/pdf', name: 'spec.pdf' };

test('a pasted screenshot is found among the files', () => {
  assert.deepEqual(pickFiles({ files: [png] }), [png]);
});

test('a screenshot offered only as an item is found too', () => {
  const data = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }] };
  assert.deepEqual(pickFiles(data), [png]);
});

test('a selection comes back whole, in the order it was carried', () => {
  assert.deepEqual(pickFiles({ files: [png, two] }), [png, two]);
});

test('a file carried in both lists is attached once, not twice', () => {
  // A drop exposes the same file through `files` and through `items`; collecting
  // from each in turn would upload it twice and type its path twice.
  const data = {
    files: [png],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
  };
  assert.deepEqual(pickFiles(data), [png]);
});

test('a plain text paste is left alone', () => {
  const data = {
    files: [],
    items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
  };
  assert.deepEqual(pickFiles(data), []);
});

test('a document is attached the same way a picture is', () => {
  // The whole point: a spec, a log or a patch reaches an agent as a path just
  // like a screenshot does, and for a while the page was the only thing
  // refusing to carry them.
  assert.deepEqual(pickFiles({ files: [doc] }), [doc]);
  assert.deepEqual(
    pickFiles({ items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => doc }] }),
    [doc],
  );
});

test('a mixed drop keeps both the picture and the document', () => {
  assert.deepEqual(pickFiles({ files: [doc, png] }), [doc, png]);
});

test('an item that refuses to yield a file does not crash the paste', () => {
  const data = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] };
  assert.deepEqual(pickFiles(data), []);
});

test('nothing at all is nothing to attach', () => {
  assert.deepEqual(pickFiles(null), []);
  assert.deepEqual(pickFiles({}), []);
});

test("the file chooser's own answer comes back as a list, unfiltered", () => {
  // The input carries no `accept` any more: one button takes a screenshot and
  // a spec alike, and what the picker offered is what was meant.
  assert.deepEqual(chosenFiles([png, { type: 'text/plain', name: 'notes.txt' }, two]),
    [png, { type: 'text/plain', name: 'notes.txt' }, two]);
  assert.deepEqual(chosenFiles(null), []);
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
