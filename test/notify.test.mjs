// Run with: node --test test/*.test.mjs
//
// The rules these used to cover moved to the server (internal/watch), where
// the pane is read directly instead of guessed at from the socket. What is
// left on this side is the shaping of a frame that has already been decided.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeFrom, deliver } from '../web/js/notify.js';

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

// --- which path actually raises it ----------------------------------------
//
// The browser path was one line — `new Notification(...)` — and on the phone
// this serves that line throws: Android Chrome refuses the constructor and
// wants the service worker's registration instead. Found in the journal on
// 2026-08-04, three times in twenty minutes, as an uncaught TypeError from
// app.js. No notification had been shown in a browser since the switch existed.

const notice = noticeFrom(done);

function fakeReg() {
  const calls = [];
  return { calls, showNotification: (title, opts) => { calls.push({ title, opts }); return Promise.resolve(); } };
}

test('the service worker registration is what raises it when there is one', () => {
  const reg = fakeReg();
  let built = 0;
  const via = deliver(notice, { registration: reg, Notifier: function () { built++; } });
  assert.equal(via, 'sw');
  assert.equal(built, 0, 'the constructor must not be tried when the registration answered');
  assert.equal(reg.calls[0].title, notice.title);
  assert.equal(reg.calls[0].opts.body, notice.body);
  assert.equal(reg.calls[0].opts.tag, notice.tag, 'the tag still replaces a notice of the same kind');
  assert.equal(reg.calls[0].opts.data.session, 'claude-1', 'the tap is served from the worker, so the session goes with it');
});

test('a constructor that throws leaves the page standing', () => {
  // Exactly what Android Chrome does: the API is present, the constructor is
  // illegal. The throw used to escape show() and kill the frame handler.
  const via = deliver(notice, {
    Notifier: function () { throw new TypeError("Failed to construct 'Notification': Illegal constructor."); },
  });
  assert.equal(via, 'none');
});

test('without a registration the constructor is used, and the tap is wired to it', () => {
  const made = [];
  let closed = false;
  function Notifier(title, opts) {
    made.push({ title, opts, self: this });
    this.close = () => { closed = true; };
  }
  let clicked = null;
  const via = deliver(notice, { Notifier, onClick: (n, handle) => { clicked = n.session; handle.close(); } });
  assert.equal(via, 'window');
  assert.equal(made[0].title, notice.title);
  assert.equal(made[0].opts.tag, notice.tag);
  assert.equal(clicked, null, 'nothing is acted on until the browser says so');
  // The browser calls onclick on the notification itself; deliver has to have
  // set it, because a notice that opens the wrong session is worse than none.
  made[0].self.onclick();
  assert.equal(clicked, 'claude-1');
  assert.ok(closed, 'a notice that has been acted on goes away');
});

test('a registration that refuses is reported rather than swallowed', async () => {
  let err = null;
  const reg = { showNotification: () => Promise.reject(new Error('permission revoked')) };
  const via = deliver(notice, { registration: reg, onError: (e) => { err = e; } });
  assert.equal(via, 'sw', 'the call was made; whether it landed is known a tick later');
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(err, 'the journal has to say a notice was lost');
});

test('nothing to show, nothing to raise', () => {
  assert.equal(deliver(null, { registration: fakeReg() }), 'none');
  assert.equal(deliver(notice, {}), 'none', 'no registration and no constructor is a browser that cannot');
});
