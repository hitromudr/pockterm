// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDecision, installText, isIOS } from '../web/js/install.js';

const base = { native: false, standalone: false, prompt: false, ios: false, dismissed: false };

test('a browser that offers an install gets a bar', () => {
  // The case that was missing: the offer existed only as a button at the bottom
  // of the drawer, and a first visit closed the page without seeing it.
  assert.equal(installDecision({ ...base, prompt: true }), 'prompt');
  assert.ok(installText('prompt').action);
});

test('an app embedding this page is offered nothing', () => {
  // The owner's Android client has no PWA install; an offer there leads nowhere.
  assert.equal(installDecision({ ...base, native: true, prompt: true }), 'hidden');
});

test('an installed app is not asked to install again', () => {
  assert.equal(installDecision({ ...base, standalone: true, prompt: true }), 'hidden');
  assert.equal(installDecision({ ...base, standalone: true, ios: true }), 'hidden');
});

test('iOS is told where the button it has actually got is', () => {
  // Safari fires no event and a page cannot open the share sheet, so the only
  // thing left is to name the route.
  assert.equal(installDecision({ ...base, ios: true }), 'ios');
  const text = installText('ios');
  assert.match(text.body, /Домой/);
  assert.equal(text.action, '', 'nothing to press: the sheet is the browser\'s');
});

test('"later" is answered before anything is offered again', () => {
  // Both kinds, and the prompt is the one that matters: the ✕ is pressed in the
  // session where the browser is holding a prompt, so a rule that let the
  // prompt win left the bar on screen after it was closed. The way to install
  // later is the button in the drawer.
  assert.equal(installDecision({ ...base, ios: true, dismissed: true }), 'hidden');
  assert.equal(installDecision({ ...base, prompt: true, dismissed: true }), 'hidden');
});

test('a browser with neither an event nor a manual route is left alone', () => {
  assert.equal(installDecision(base), 'hidden');
  assert.equal(installText('hidden'), null);
});

test('an iPad that calls itself a Mac is still an iPad', () => {
  assert.ok(isIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'));
  assert.ok(isIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5));
  assert.ok(!isIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0));
  assert.ok(!isIOS('Mozilla/5.0 (Linux; Android 14; Pixel 8)'));
});
