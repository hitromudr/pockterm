// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockFamily, storedLock, rotationLabel, refusalText } from '../web/js/rotation.js';

test('the lock holds the family the screen is in, upside down included', () => {
  assert.equal(lockFamily('portrait-primary'), 'portrait');
  assert.equal(lockFamily('portrait-secondary'), 'portrait');
  assert.equal(lockFamily('landscape-primary'), 'landscape');
  assert.equal(lockFamily('landscape-secondary'), 'landscape');
  // No orientation reported at all: a phone is held upright.
  assert.equal(lockFamily(undefined), 'portrait');
});

test('only a family is read back from storage', () => {
  assert.equal(storedLock('portrait'), 'portrait');
  assert.equal(storedLock('landscape'), 'landscape');
  assert.equal(storedLock(null), null);
  assert.equal(storedLock('portrait-primary'), null);
});

test('the button says what holds now', () => {
  assert.equal(rotationLabel(null), '⟳ Поворот');
  assert.equal(rotationLabel('portrait'), '🔒 Портрет');
  assert.equal(rotationLabel('landscape'), '🔒 Альбом');
});

test('a refusal is said in words, by the step that refused', () => {
  assert.match(refusalText({ name: 'NotSupportedError' }), /здесь поворот не блокируется/);
  // What the owner's phone answered outside fullscreen, installed app and all.
  assert.match(refusalText({ name: 'SecurityError' }), /только в полноэкранном режиме/);
  assert.doesNotMatch(refusalText({ name: 'SecurityError' }), /установленном/);
  assert.match(refusalText({ name: 'AbortError' }), /сбросил/);
  assert.match(refusalText(new TypeError('x')), /не дал заблокировать/);
  assert.match(refusalText(new TypeError('Permissions check failed'), 'fullscreen'), /не дал полный экран/);
});
