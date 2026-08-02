// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickImage, carriesFiles, firstImage } from '../web/js/paste.js';

const png = { type: 'image/png', name: 'screenshot.png' };

test('a pasted screenshot is found among the files', () => {
  assert.equal(pickImage({ files: [png] }), png);
});

test('a screenshot offered only as an item is found too', () => {
  const data = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }] };
  assert.equal(pickImage(data), png);
});

test('a plain text paste is left alone', () => {
  const data = {
    files: [],
    items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
  };
  assert.equal(pickImage(data), null);
});

test('a non-image file is not an image', () => {
  assert.equal(pickImage({ files: [{ type: 'application/pdf', name: 'spec.pdf' }] }), null);
});

test('an item that refuses to yield a file does not crash the paste', () => {
  const data = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] };
  assert.equal(pickImage(data), null);
});

test('nothing at all is not an image', () => {
  assert.equal(pickImage(null), null);
  assert.equal(pickImage({}), null);
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
