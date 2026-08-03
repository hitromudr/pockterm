// Run with: node --test test/*.test.mjs
//
// The rules these used to cover moved to the server (internal/watch), where
// the pane is read directly instead of guessed at from the socket. What is
// left on this side is the shaping of a frame that has already been decided.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeFrom } from '../web/js/notify.js';

const done = { type: 'notify', kind: 'done', session: 'claude-1', title: '✅ claude-1 закончил', body: 'ok  github.com/x/y' };

test('a done frame becomes a notice', () => {
  const n = noticeFrom(done);
  assert.equal(n.title, '✅ claude-1 закончил');
  assert.equal(n.body, 'ok  github.com/x/y');
  assert.equal(n.tag, 'pockterm-done');
});

test('a question frame gets its own tag, so the two do not replace each other', () => {
  const q = noticeFrom({ ...done, kind: 'question', title: '❓ claude-1 просит ответ', body: 'Apply?\n1. Yes' });
  assert.equal(q.tag, 'pockterm-question');
  assert.match(q.body, /1\. Yes/);
});

test('anything that is not a notification is ignored', () => {
  // The same socket carries copy-mode state and pongs.
  assert.equal(noticeFrom({ type: 'mode', in: true }), null);
  assert.equal(noticeFrom({ type: 'pong' }), null);
  assert.equal(noticeFrom(null), null);
});

test('an unknown kind is ignored rather than shown untagged', () => {
  assert.equal(noticeFrom({ ...done, kind: 'whatever' }), null);
});

test('a frame without a title is not worth a notification', () => {
  assert.equal(noticeFrom({ ...done, title: '   ' }), null);
});

test('an empty body is allowed — the title alone says what happened', () => {
  const n = noticeFrom({ ...done, body: '' });
  assert.equal(n.body, '');
});

test('a body longer than a notification can show is cut', () => {
  const n = noticeFrom({ ...done, body: 'x'.repeat(1000) });
  assert.ok(n.body.length < 1000);
  assert.ok(n.body.endsWith('…'));
});

test('the session travels with the notice — a tap has to land on it', () => {
  assert.equal(noticeFrom(done).session, 'claude-1');
  // Missing rather than wrong: an old server sends no session, and the tap
  // falls back to whatever was open.
  assert.equal(noticeFrom({ ...done, session: undefined }).session, '');
});
