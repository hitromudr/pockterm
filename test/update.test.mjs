// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleNotice, startsReload, TAKE_HOLD } from '../web/js/update.js';

test('the same version says nothing', () => {
  // The config frame arrives on every connect, and the socket reconnects on
  // every tunnel hiccup. A notice on each of those would be noise, and noise
  // is what gets ignored on the evening it matters.
  assert.equal(staleNotice('v75', 'v75'), null);
});

test('a different version on the server is worth a notice', () => {
  const n = staleNotice('v76', 'v75');
  assert.ok(n, 'a new build on the server said nothing');
  assert.match(n.text, /v76/);
  assert.match(n.text, /v75/, 'the page does not say what it is running');
  assert.equal(n.tag, 'pockterm-update');
});

test('a notice replaces the one before it', () => {
  // Two deploys in an evening are two notifications of the same kind, and the
  // second is the only one worth reading.
  assert.equal(staleNotice('v76', 'v75').tag, staleNotice('v77', 'v75').tag);
});

test('a server that does not name a version is not a reason to reload', () => {
  // The field is new: a binary from before it says nothing, and "nothing"
  // must not read as "different". Rolling back to such a build would
  // otherwise ask for a reload on every reconnect, forever.
  assert.equal(staleNotice('', 'v75'), null);
  assert.equal(staleNotice(undefined, 'v75'), null);
  assert.equal(staleNotice(null, 'v75'), null);
});

test('a second press does not start the load over', () => {
  // Every reload() cancels the one before it, so a press while the page is
  // already loading is a press that pushes the new page further away: twelve
  // of them on the phone on 2026-10-30, and the page arrived once they stopped.
  const t = 1_000_000;
  assert.equal(startsReload(0, t), true, 'the first press did nothing');
  assert.equal(startsReload(t, t + 2000), false, 'a press two seconds later reloads again');
  assert.equal(startsReload(t, t + TAKE_HOLD - 1), false);
});

test('a load nothing came of can be asked for again', () => {
  // The browser can drop a navigation without a word — no network, a dead
  // connection — and the page is then still here with the bar on it. The
  // button must not stay dead for the rest of its life.
  const t = 1_000_000;
  assert.equal(startsReload(t, t + TAKE_HOLD), true);
});
