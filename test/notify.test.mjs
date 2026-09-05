// Run with: node --test test/*.test.mjs
//
// The rules these used to cover moved to the server (internal/watch), where
// the pane is read directly instead of guessed at from the socket. What is
// left on this side is the shaping of a frame that has already been decided.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeFrom, deliver, nextMode, modeLabel, shouldAskPermission, testNotice } from '../web/js/notify.js';

const done = { type: 'notify', kind: 'done', session: 'claude-1', title: '✅ claude-1 закончил', body: 'ok  github.com/x/y' };

test('a done frame becomes a notice', () => {
  const n = noticeFrom(done);
  assert.equal(n.title, '✅ claude-1 закончил');
  assert.equal(n.body, 'ok  github.com/x/y');
  assert.equal(n.tag, 'pockterm-done:claude-1');
});

test('a question frame gets its own tag, so the two do not replace each other', () => {
  const q = noticeFrom({ ...done, kind: 'question', title: '❓ claude-1 просит ответ', body: 'Apply?\n1. Yes' });
  assert.equal(q.tag, 'pockterm-question:claude-1');
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

// --- the switch has three states ------------------------------------------
//
// One switch for both channels: the page while it is open, and Telegram when
// nothing is. Two separate controls would let the owner silence half of what
// arrives and wonder about the other half — and the page has no business
// deciding about Telegram at all, which is why the state itself lives on the
// server and this only orders the states.

test('the cycle is pwa, then pwa+tg, then off', () => {
  assert.equal(nextMode('pwa', true), 'pwa+tg');
  assert.equal(nextMode('pwa+tg', true), 'off');
  assert.equal(nextMode('off', true), 'pwa');
});

test('with no bot configured the middle state is skipped, not offered dead', () => {
  // A state that looks like more delivery and produces none is worse than a
  // shorter cycle: the owner would read the label as a promise.
  assert.equal(nextMode('pwa', false), 'off');
  assert.equal(nextMode('off', false), 'pwa');
  // A mode stored while a token was configured must still lead somewhere.
  assert.equal(nextMode('pwa+tg', false), 'off');
});

test('an unknown mode leads to a known one', () => {
  // The mode arrives from the server, and a page can be older than it.
  assert.equal(nextMode('', true), 'pwa');
  assert.equal(nextMode('everything', true), 'pwa');
});

test('the label says which channels are live', () => {
  assert.equal(modeLabel('off').on, false);
  assert.equal(modeLabel('pwa').on, true);
  assert.equal(modeLabel('pwa+tg').on, true);
  // The three are distinguishable at a glance on a phone — the same bell with
  // the same word would make two of them look like one.
  const seen = new Set(['off', 'pwa', 'pwa+tg'].map((m) => modeLabel(m).text));
  assert.equal(seen.size, 3);
  assert.match(modeLabel('pwa+tg').text, /TG/i);
});

test('a mode that notifies and a browser never asked means asking', () => {
  // The host's default notifies, so this is the state a fresh install loads in.
  assert.equal(shouldAskPermission({ mode: 'pwa+tg', permission: 'default' }), true);
  assert.equal(shouldAskPermission({ mode: 'pwa', permission: 'default' }), true);
});

test('nothing to notify, nothing to ask', () => {
  assert.equal(shouldAskPermission({ mode: 'off', permission: 'default' }), false);
  assert.equal(shouldAskPermission({ mode: '', permission: 'default' }), false);
  assert.equal(shouldAskPermission({}), false);
});

test('an answered browser is not asked again', () => {
  // Granted needs nothing; denied is sticky, and asking again cannot lift it.
  assert.equal(shouldAskPermission({ mode: 'pwa', permission: 'granted' }), false);
  assert.equal(shouldAskPermission({ mode: 'pwa', permission: 'denied' }), false);
  // No Notification API at all — the page says so elsewhere; there is no prompt.
  assert.equal(shouldAskPermission({ mode: 'pwa', permission: 'unsupported' }), false);
});

test('a dismissed prompt is asked once, not on every load', () => {
  // Dismissing leaves `default` behind, so the state alone cannot tell "never
  // asked" from "asked and ignored" — and a page that keeps asking is a page the
  // browser stops letting ask.
  assert.equal(shouldAskPermission({ mode: 'pwa', permission: 'default', asked: true }), false);
});

test('the native notifier needs no permission from the browser', () => {
  // Inside the Android client the notice is raised by the app itself.
  assert.equal(shouldAskPermission({ mode: 'pwa+tg', permission: 'default', native: true }), false);
});

test('every notice names its own icon, on both paths', () => {
  // Unset, Chrome draws a generic bell — and did so on the owner's phone for one
  // notice while the one under it carried the app's mark, from this same page.
  // Which of the two you get is not ours to predict, so it is not left to chance.
  const reg = fakeReg();
  deliver(notice, { registration: reg });
  const opts = reg.calls[0].opts;
  assert.match(opts.icon, /icon-192-notify\.png$/);
  assert.equal(opts.badge, opts.icon, 'one file for both slots, so they cannot drift');

  const made = [];
  deliver(notice, { Notifier: function (title, o) { made.push(o); } });
  assert.equal(made[0].icon, opts.icon, 'the fallback path draws the same icon');
  assert.equal(made[0].badge, opts.icon);
});

// --- one line in the shade per session, not per kind ------------------------
//
// The tag was the kind and nothing else, so every session shared one notice.
// Measured on the owner's phone rather than reasoned about: on 2026-09-04 the
// journal has `done xnt-lr` at 18:53:08 and `done xnt-mk` at 18:53:20, both
// raised with `pockterm-done`, both reported `ok:true`. The second replaced the
// first — and a replacement without `renotify` makes no sound, raises no
// banner and leaves one line where two finishes happened.

test('a tag names its session, so two sessions do not share one line', () => {
  const a = noticeFrom({ ...done, session: 'xnt-lr' });
  const b = noticeFrom({ ...done, session: 'xnt-mk' });
  assert.equal(a.tag, 'pockterm-done:xnt-lr');
  assert.notEqual(a.tag, b.tag, 'one finish must not erase another');
});

test('the same session and kind still collapse into one', () => {
  // The reason the tag exists at all: five "asks for an answer" about one
  // session is noise, not information.
  const first = noticeFrom({ ...done, session: 'a' });
  const again = noticeFrom({ ...done, session: 'a', title: '✅ a закончил снова' });
  assert.equal(first.tag, again.tag);
});

test('a question does not replace a finish about the same session', () => {
  const d = noticeFrom({ ...done, session: 'a' });
  const q = noticeFrom({ ...done, kind: 'question', session: 'a' });
  assert.notEqual(d.tag, q.tag);
});

test('a frame with no session falls back to the kind alone', () => {
  // An older server sends none, and one shared line beats no notice at all.
  assert.equal(noticeFrom({ ...done, session: '' }).tag, 'pockterm-done');
  assert.equal(noticeFrom({ ...done, session: undefined }).tag, 'pockterm-done');
});

// --- the alert, and whether anything actually arrived -----------------------

function shadeReg(holding = null) {
  const reg = fakeReg();
  reg.asked = [];
  if (holding !== null) {
    reg.getNotifications = (filter) => { reg.asked.push(filter); return Promise.resolve(holding); };
  }
  return reg;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a notice replacing one that still stands re-alerts', () => {
  // Without this the replacement is silent — no sound, no vibration, no
  // banner — which on a phone in a pocket is the same as no notice.
  const reg = fakeReg();
  deliver(notice, { registration: reg });
  assert.equal(reg.calls[0].opts.renotify, true);
  assert.ok(reg.calls[0].opts.tag, 'renotify without a tag is a TypeError');
});

test('the fallback path re-alerts too — one rule, not one per browser', () => {
  const made = [];
  deliver(notice, { Notifier: function (title, o) { made.push(o); } });
  assert.equal(made[0].renotify, true);
});

test('what the shade holds is read back rather than assumed', async () => {
  const reg = shadeReg([{ tag: notice.tag }]);
  let live = null;
  deliver(notice, { registration: reg, onShown: (n) => { live = n; } });
  await tick();
  assert.equal(live, 1);
  assert.deepEqual(reg.asked, [{ tag: notice.tag }], 'asked about this notice, not about every one');
});

test('a call that succeeded and a shade that is empty is the case worth reporting', async () => {
  // `showNotification` resolving means the browser took it, not that the phone
  // drew it: a disabled system channel looks exactly like success from here,
  // and the journal said `ok:true` for a phone showing nothing all day.
  const reg = shadeReg([]);
  let live = -1;
  deliver(notice, { registration: reg, onShown: (n) => { live = n; } });
  await tick();
  assert.equal(live, 0);
});

test('a browser that cannot say what it is showing says nothing rather than guessing', async () => {
  const reg = fakeReg(); // no getNotifications
  let called = false;
  deliver(notice, { registration: reg, onShown: () => { called = true; } });
  await tick();
  await tick();
  assert.equal(called, false);
});

test('the probe is a notice of its own, replacing neither of the two', () => {
  const t = testNotice();
  assert.ok(t.title, 'a notice without a title is not shown at all');
  assert.notEqual(t.tag, noticeFrom(done).tag);
  assert.notEqual(t.tag, noticeFrom({ ...done, kind: 'question' }).tag);
});
