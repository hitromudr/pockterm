// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, questionNotice, noteActivity, doneNotice } from '../web/js/notify.js';

const menu = { prompt: 'Apply this change?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] };
const IDLE = 30_000;

test('a prompt in a background tab is announced once', () => {
  const s = newState();
  const first = questionNotice(s, menu, true);
  assert.ok(first);
  assert.match(first.body, /Apply this change\?/);
  assert.match(first.body, /1\. Yes/);
  // Same menu still on screen: no second notification.
  assert.equal(questionNotice(s, menu, true), null);
});

test('a different prompt is announced again', () => {
  const s = newState();
  questionNotice(s, menu, true);
  const other = { prompt: 'Delete the file?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] };
  assert.ok(questionNotice(s, other, true));
});

test('nothing is announced while the page is visible', () => {
  const s = newState();
  // You are looking at the terminal: the buttons are right there.
  assert.equal(questionNotice(s, menu, false), null);
});

test('a prompt seen while visible is not replayed when you look away', () => {
  const s = newState();
  questionNotice(s, menu, false);
  // Switching tabs must not resurface a prompt you have already seen.
  assert.equal(questionNotice(s, menu, true), null);
});

test('silence after activity is announced once', () => {
  const s = newState();
  noteActivity(s, 1000);
  assert.equal(doneNotice(s, 1000 + IDLE - 1, IDLE, true), null, 'too early');
  const done = doneNotice(s, 1000 + IDLE, IDLE, true);
  assert.ok(done);
  assert.equal(doneNotice(s, 1000 + IDLE * 5, IDLE, true), null, 'only once');
});

test('a session that never did anything stays quiet', () => {
  const s = newState();
  // Attached to an idle shell: nothing finished, so nothing to announce.
  assert.equal(doneNotice(s, 10 * IDLE, IDLE, true), null);
});

test('new output re-arms the finished notice', () => {
  const s = newState();
  noteActivity(s, 0);
  assert.ok(doneNotice(s, IDLE, IDLE, true));
  noteActivity(s, IDLE + 1);
  assert.ok(doneNotice(s, IDLE * 2 + 1, IDLE, true));
});

test('finishing while visible is not replayed later', () => {
  const s = newState();
  noteActivity(s, 0);
  assert.equal(doneNotice(s, IDLE, IDLE, false), null);
  // The quiet period was already accounted for; looking away does not
  // resurrect it.
  assert.equal(doneNotice(s, IDLE * 3, IDLE, true), null);
});

test('the tail of the output is used as the body', () => {
  const s = newState();
  s.tail = 'ok  github.com/x/y';
  noteActivity(s, 0);
  assert.match(doneNotice(s, IDLE, IDLE, true).body, /github\.com\/x\/y/);
});
