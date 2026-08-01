// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectQuestion } from '../web/js/detect.js';

test('detects a Claude permission prompt', () => {
  const lines = [
    'Do you want to make this edit to app.js?',
    '❯ 1. Yes',
    '  2. Yes, allow all edits this session',
    '  3. No, and tell Claude what to do (esc)',
    '',
  ];
  const q = detectQuestion(lines);
  assert.ok(q);
  assert.equal(q.options.length, 3);
  assert.deepEqual(q.options.map((o) => o.key), ['1', '2', '3']);
  assert.equal(q.options[0].label, 'Yes');
  assert.match(q.prompt, /Do you want/);
});

test('detects a two-option trust dialog', () => {
  const lines = [
    'Quick safety check: trust this folder?',
    '❯ 1. Yes, I trust this folder',
    '  2. No, exit',
  ];
  const q = detectQuestion(lines);
  assert.ok(q);
  assert.deepEqual(q.options.map((o) => o.key), ['1', '2']);
  assert.equal(q.options[1].label, 'No, exit');
});

test('returns null for ordinary output', () => {
  assert.equal(detectQuestion(['building...', 'done in 2.3s', '$ ']), null);
});

test('returns null for a single numbered line (e.g. a list)', () => {
  assert.equal(detectQuestion(['Results:', '1. only one item', '']), null);
});

test('ignores a numbered list that does not start at 1', () => {
  assert.equal(detectQuestion(['see items', '3. three', '4. four']), null);
});
