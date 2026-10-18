// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osc52Text } from '../web/js/osc52.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('what tmux sends on a mouse copy is the text it took', () => {
  // tmux 3.5a writes `Ms` with an empty target.
  assert.equal(osc52Text(`;${b64('git status')}`), 'git status');
  assert.equal(osc52Text(`c;${b64('a\nb')}`), 'a\nb');
  assert.equal(osc52Text(`p;${b64('x')}`), 'x');
});

test('the text is UTF-8, Cyrillic and marks included', () => {
  assert.equal(osc52Text(`c;${b64('выделение ● ⎿')}`), 'выделение ● ⎿');
});

test('a read request is refused: the pane never gets the clipboard back', () => {
  assert.equal(osc52Text('c;?'), null);
  assert.equal(osc52Text(';?'), null);
});

test('what is not a write of text is nothing', () => {
  assert.equal(osc52Text(''), null);
  assert.equal(osc52Text('c'), null);
  assert.equal(osc52Text('c;'), null);
  assert.equal(osc52Text('c;не base64!'), null);
  // Valid base64 of bytes that are not UTF-8.
  assert.equal(osc52Text(`c;${Buffer.from([0xff, 0xfe, 0x00]).toString('base64')}`), null);
});
