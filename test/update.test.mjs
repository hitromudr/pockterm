// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('a dismissed version stays quiet on reconnect until a newer one lands', () => {
  // Every tab switch and reconnect brings a fresh config frame with the same
  // served version. Closing the bar for v76 must keep v76 quiet without hiding
  // v77 when the next deploy arrives.
  assert.equal(staleNotice('v76', 'v75', 'v76'), null);
  assert.ok(staleNotice('v77', 'v75', 'v76'), 'a newer version after dismissal was suppressed');
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

test('top-level calls in app.js do not read let/const bindings before their declaration', () => {
  // `node --check` parses app.js without evaluating it, so a function called
  // at module load that reaches a `let` declared lower down throws a
  // ReferenceError on the phone (2026-11-03: `setScrollStep()` reached
  // `scrolledBack` declared 2,500 lines below).
  const src = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const decls = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:let|const)\s+([a-zA-Z0-9_$]+)\b/);
    if (m) decls.set(m[1], i + 1);
  }
  const funcs = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^function\s+([a-zA-Z0-9_$]+)\s*\(/);
    if (!m) continue;
    let body = `${lines[i]}\n`;
    if (!lines[i].includes('}')) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*if\s*\(current === null\)\s*return;/.test(lines[j])) break;
        if (/^\s*(?:.*\.addEventListener\(|setTimeout\(|requestAnimationFrame\()/.test(lines[j])) continue;
        body += `${lines[j]}\n`;
        if (lines[j].startsWith('}')) break;
      }
    }
    funcs.set(m[1], body.replace(/\/\/.*$/gm, ''));
  }
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-zA-Z0-9_$]+)\(/);
    if (!m || !funcs.has(m[1]) || m[1] === 'armTwice') continue;
    const callLine = i + 1;
    const seen = new Set();
    const queue = [m[1]];
    while (queue.length) {
      const fn = queue.shift();
      if (seen.has(fn) || !funcs.has(fn)) continue;
      seen.add(fn);
      const body = funcs.get(fn);
      for (const [v, dLine] of decls) {
        if (dLine > callLine && new RegExp(`\\b${v}\\b`).test(body)) {
          hits.push(`${m[1]}() at L${callLine} (via ${fn}) reads ${v} declared at L${dLine}`);
        }
      }
      for (const [other] of funcs) {
        if (new RegExp(`\\b${other}\\s*\\(`).test(body)) queue.push(other);
      }
    }
  }
  assert.deepEqual(hits, []);
});
