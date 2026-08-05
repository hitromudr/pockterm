// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkAction, PING_AFTER, PONG_WAIT } from '../web/js/link.js';

const base = { open: true, visible: true, now: 100000, lastRx: 100000, pingSent: 0 };

test('a busy socket is never asked anything', () => {
  // Any traffic is an answer: output arriving proves the connection as well as a
  // pong does, and a session under load must not be pinged for nothing.
  assert.equal(linkAction(base), 'idle');
  assert.equal(linkAction({ ...base, lastRx: base.now - PING_AFTER + 1 }), 'idle');
});

test('silence is a question, and it is asked once', () => {
  const quiet = { ...base, lastRx: base.now - PING_AFTER };
  assert.equal(linkAction(quiet), 'ping');
  // With a ping outstanding there is nothing to do but wait for it.
  assert.equal(linkAction({ ...quiet, pingSent: base.now }), 'idle');
});

test('an unanswered ping is a dead socket', () => {
  // The whole point: readyState stays OPEN on a connection a phone has handed
  // between Wi-Fi and cellular, and sends on it look like they succeed.
  const asked = { ...base, lastRx: base.now - PING_AFTER, pingSent: base.now - PONG_WAIT };
  assert.equal(linkAction(asked), 'dead');
  assert.equal(linkAction({ ...asked, pingSent: base.now - PONG_WAIT + 1 }), 'idle');
});

test('anything arriving after the ping settles it', () => {
  // Not only a pong — a byte of output is as good an answer, and the page cannot
  // tell them apart at this level anyway.
  const answered = { ...base, pingSent: base.now - 1000, lastRx: base.now - 500 };
  assert.equal(linkAction(answered), 'idle');
});

test('a backgrounded page asks nothing', () => {
  // Its timers fire about once a minute, so every measurement it takes is late by
  // construction — and tearing down a socket because Android slowed the clock is
  // worse than the freeze this exists to fix.
  const quiet = { ...base, visible: false, lastRx: base.now - 10 * PING_AFTER };
  assert.equal(linkAction(quiet), 'idle');
  assert.equal(linkAction({ ...quiet, pingSent: base.now - 10 * PONG_WAIT }), 'idle');
});

test('a socket that is not open is not this function\'s business', () => {
  // onclose owns that path: it reconnects with a backoff.
  assert.equal(linkAction({ ...base, open: false, lastRx: 0 }), 'idle');
});

test('the worst case is seconds rather than the minute it was', () => {
  assert.ok(PING_AFTER + PONG_WAIT <= 20000, `${PING_AFTER}+${PONG_WAIT}ms is not an answer to a freeze`);
});
