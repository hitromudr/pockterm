import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bringBack } from '../web/js/vendor.js';

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body });

function stand(answers) {
  const win = {};
  const asked = [];
  const waits = [];
  return {
    win,
    asked,
    waits,
    opts: {
      win,
      get: async (src) => { asked.push(src); const a = answers[src].shift(); if (a instanceof Error) throw a; return a; },
      // The scripts under test define their global the way the real ones do.
      run: (text) => { const m = /^define (\w+)$/.exec(text); if (m) win[m[1]] = {}; },
      wait: async (ms) => { waits.push(ms); },
    },
  };
}

test('nothing is fetched when both scripts arrived', async () => {
  const s = stand({});
  s.win.Terminal = {};
  s.win.FitAddon = {};
  assert.deepEqual(await bringBack(s.opts), []);
  assert.deepEqual(s.asked, []);
});

test('a missing xterm is fetched again until it runs', async () => {
  const s = stand({ 'vendor/xterm.js': [res(502, '<html>'), res(200, 'define Terminal')] });
  s.win.FitAddon = {};
  const lines = await bringBack(s.opts);
  assert.ok(s.win.Terminal);
  assert.deepEqual(lines, [{ file: 'vendor/xterm.js', ok: true, tries: 2, status: 200 }]);
  assert.deepEqual(s.waits, [1000]);
});

test('an error page is never run as the script', async () => {
  let ran = 0;
  const s = stand({ 'vendor/addon-fit.js': [res(502, 'define FitAddon'), res(502, 'x'), res(502, 'x')] });
  s.win.Terminal = {};
  const run = s.opts.run;
  s.opts.run = (t) => { ran++; run(t); };
  const lines = await bringBack(s.opts);
  assert.equal(ran, 0);
  assert.equal(s.win.FitAddon, undefined);
  assert.deepEqual(lines, [{ file: 'vendor/addon-fit.js', ok: false, tries: 3, status: 502 }]);
});

test('a broken fetch is a try, and its reason goes to the journal', async () => {
  const s = stand({ 'vendor/xterm.js': [new Error('network'), res(200, 'define Terminal')], 'vendor/addon-fit.js': [res(200, 'define FitAddon')] });
  const lines = await bringBack(s.opts);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].error, 'network');
  assert.equal(lines[1].tries, 1);
});
