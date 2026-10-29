// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directBase, tryDirect, warmAddress, worthTrying, viaMark, DIRECT_WAIT, MISS_HOLD } from '../web/js/direct.js';

const page = { host: 'cc.example', protocol: 'https:' };

test('the door is a socket root, and only one this page can open', () => {
  assert.equal(directBase('https://lan.example:8135', page), 'wss://lan.example:8135');
  // None configured, or this page came through the door already.
  assert.equal(directBase('', page), '');
  assert.equal(directBase('https://cc.example', page), '');
  assert.equal(directBase('https://lan.example:8135', { host: 'lan.example:8135', protocol: 'https:' }), '');
  // A secure page cannot open ws: at all — the browser refuses it outright.
  assert.equal(directBase('http://192.168.1.222:8130', page), '');
  assert.equal(directBase('http://192.168.1.222:8130', { host: 'localhost:8130', protocol: 'http:' }), 'ws://192.168.1.222:8130');
  assert.equal(directBase('not a url', page), '');
});

// A WebSocket and a clock the test drives by hand.
function stand() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
    close() { this.closed = true; }
  }
  let t = 0;
  const timers = [];
  const clock = {
    setTimeout(fn, ms) { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout(h) { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      t += ms;
      for (const h of timers.filter((h) => h.at <= t)) { clock.clearTimeout(h); h.fn(); }
    },
  };
  const calls = [];
  const opts = { WS: FakeWS, timers: clock, now: () => t };
  const done = (sock, why, ms) => calls.push({ sock, why, ms });
  return { sockets, clock, calls, opts, done };
}

test('a door that opens is handed over open, with nothing of the attempt left on it', () => {
  const s = stand();
  tryDirect('wss://lan.example:8135/ws?session=a', s.opts, s.done);
  assert.equal(s.sockets.length, 1);
  assert.equal(s.sockets[0].binaryType, 'arraybuffer');
  s.clock.advance(40);
  s.sockets[0].onopen();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].sock, s.sockets[0]);
  assert.equal(s.calls[0].why, 'open');
  assert.equal(s.calls[0].ms, 40);
  assert.equal(s.sockets[0].closed, false);
  // Whoever takes it installs its own; a stale onclose here would answer a
  // later drop as a miss.
  assert.equal(s.sockets[0].onopen, null);
  assert.equal(s.sockets[0].onclose, null);
  // And the timeout is gone with the attempt.
  s.clock.advance(DIRECT_WAIT * 2);
  assert.equal(s.calls.length, 1);
});

test('a door that is not there is closed after DIRECT_WAIT and reported once', () => {
  const s = stand();
  tryDirect('wss://lan.example:8135/ws', s.opts, s.done);
  s.clock.advance(DIRECT_WAIT - 1);
  assert.equal(s.calls.length, 0);
  s.clock.advance(1);
  assert.deepEqual(s.calls.map((c) => [c.sock, c.why]), [[null, 'timeout']]);
  assert.equal(s.sockets[0].closed, true);
  // Opening late changes nothing: it was given its time.
  if (s.sockets[0].onopen) s.sockets[0].onopen();
  assert.equal(s.calls.length, 1);
});

test('a door that refuses is a miss at once, not after the wait', () => {
  const s = stand();
  tryDirect('wss://lan.example:8135/ws', s.opts, s.done);
  s.clock.advance(5);
  s.sockets[0].onclose();
  assert.deepEqual(s.calls.map((c) => [c.sock, c.why, c.ms]), [[null, 'closed', 5]]);
});

test('a cancelled attempt closes its socket and is never answered', () => {
  const s = stand();
  const cancel = tryDirect('wss://lan.example:8135/ws', s.opts, s.done);
  cancel();
  assert.equal(s.sockets[0].closed, true);
  assert.equal(s.sockets[0].onopen, null);
  s.clock.advance(DIRECT_WAIT);
  assert.equal(s.calls.length, 0);
});

test('an address the constructor throws on is a miss, answered once', () => {
  const s = stand();
  s.opts.WS = class { constructor() { throw new SyntaxError('bad url'); } };
  tryDirect('wss://', s.opts, s.done);
  assert.equal(s.calls.length, 0);
  s.clock.advance(0);
  assert.deepEqual(s.calls.map((c) => [c.sock, c.why]), [[null, 'closed']]);
});

// A fetch the test answers by hand, recording what it was asked.
function door() {
  const asked = [];
  const fetch = (url, init) => new Promise((resolve, reject) => {
    const req = { url, init, resolve, reject, aborted: false };
    if (init.signal) init.signal.addEventListener('abort', () => { req.aborted = true; });
    asked.push(req);
  });
  return { asked, fetch };
}

const settledPromises = () => new Promise((r) => setImmediate(r));

test('a warm attempt asks the door over HTTP first, and opens the socket only after its answer', async () => {
  // 2026-10-29: Chrome cancels a socket that is the first thing sent to a door
  // wanting a client certificate; one ordinary request before it and it opens.
  const s = stand();
  const d = door();
  tryDirect('wss://lan.example:8135/ws?session=a', { ...s.opts, warm: true, fetch: d.fetch }, s.done);
  assert.equal(d.asked.length, 1);
  assert.equal(d.asked[0].url, 'https://lan.example:8135/');
  assert.equal(d.asked[0].init.mode, 'no-cors');
  // Without credentials the browser sends no client certificate either.
  assert.equal(d.asked[0].init.credentials, 'include');
  assert.equal(s.sockets.length, 0, 'the socket went before the door had answered');
  s.clock.advance(30);
  d.asked[0].resolve({ type: 'opaque' });
  await settledPromises();
  assert.equal(s.sockets.length, 1);
  assert.equal(s.sockets[0].url, 'wss://lan.example:8135/ws?session=a');
  s.clock.advance(10);
  s.sockets[0].onopen();
  assert.deepEqual(s.calls.map((c) => [c.sock, c.why, c.ms]), [[s.sockets[0], 'open', 40]]);
});

test('a warm that fails is no verdict: the socket still decides', async () => {
  const s = stand();
  const d = door();
  tryDirect('wss://lan.example:8135/ws', { ...s.opts, warm: true, fetch: d.fetch }, s.done);
  d.asked[0].reject(new TypeError('Failed to fetch'));
  await settledPromises();
  assert.equal(s.sockets.length, 1);
  s.sockets[0].onopen();
  assert.equal(s.calls[0].why, 'open');
});

test('the warm and the socket share one DIRECT_WAIT', async () => {
  const s = stand();
  const d = door();
  tryDirect('wss://lan.example:8135/ws', { ...s.opts, warm: true, fetch: d.fetch }, s.done);
  s.clock.advance(DIRECT_WAIT);
  assert.deepEqual(s.calls.map((c) => [c.sock, c.why]), [[null, 'timeout']]);
  assert.equal(d.asked[0].aborted, true, 'the request outlived the attempt');
  // An answer after the wait opens nothing.
  d.asked[0].resolve({});
  await settledPromises();
  assert.equal(s.sockets.length, 0);
  assert.equal(s.calls.length, 1);
});

test('an attempt cancelled during its warm never opens a socket', async () => {
  const s = stand();
  const d = door();
  const cancel = tryDirect('wss://lan.example:8135/ws', { ...s.opts, warm: true, fetch: d.fetch }, s.done);
  cancel();
  assert.equal(d.asked[0].aborted, true);
  d.asked[0].resolve({});
  await settledPromises();
  assert.equal(s.sockets.length, 0);
  s.clock.advance(DIRECT_WAIT);
  assert.equal(s.calls.length, 0);
});

test('without a warm the socket is the only thing sent', () => {
  const s = stand();
  const d = door();
  tryDirect('wss://lan.example:8135/ws', { ...s.opts, fetch: d.fetch }, s.done);
  assert.equal(d.asked.length, 0);
  assert.equal(s.sockets.length, 1);
});

test('the warm goes to the door\'s own root, over the scheme its socket uses', () => {
  assert.equal(warmAddress('wss://lan.example:8135/ws?token=x&session=a'), 'https://lan.example:8135/');
  assert.equal(warmAddress('ws://192.168.1.222:8130/ws'), 'http://192.168.1.222:8130/');
  assert.equal(warmAddress('wss://'), '');
  assert.equal(warmAddress('https://lan.example/'), '');
});

test('a miss is believed for MISS_HOLD, then the door is asked again', () => {
  assert.equal(worthTrying(0, 1000), true);
  assert.equal(worthTrying(1000, 1000 + MISS_HOLD - 1), false);
  assert.equal(worthTrying(1000, 1000 + MISS_HOLD), true);
});

test('the header says which way the socket goes, and only where there are two ways', () => {
  const door = 'https://lan.example:8135';
  assert.equal(viaMark(door, page, 'direct'), 'direct');
  assert.equal(viaMark(door, page, 'host'), 'long');
  // No socket in hand: nothing to report, rather than the last answer.
  assert.equal(viaMark(door, page, ''), '');
  // A host with no door has one way, and saying "the long way" would be noise.
  assert.equal(viaMark('', page, 'host'), '');
  // A page opened through the door itself goes direct, whatever its socket says.
  assert.equal(viaMark(door, { host: 'lan.example:8135', protocol: 'https:' }, 'host'), 'direct');
});
