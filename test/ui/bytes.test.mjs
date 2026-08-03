// What the terminal actually receives, byte for byte.
//
// The rest of the suite looks at the screen; this file looks at the wire. The
// session runs `stty raw -echo; cat -v`, so every byte that reaches the pty is
// echoed in a visible form and the screen becomes a transcript. That turns
// "the space went nowhere" and "the delete inserted a line" — both reported
// from the phone — into assertions a machine can make.
//
// What it cannot cover: an IME. Playwright types like a hardware keyboard, and
// Gboard's composing region is what most of the input bugs here came from. The
// value of these cases is the other half — that the bar itself sends exactly
// what it claims, in any order, and nothing extra.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from './stand.mjs';

// How `cat -v` renders what the bar sends.
const WIRE = {
  esc: '^[',
  up: '^[[A',
  down: '^[[B',
  right: '^[[C',
  left: '^[[D',
  'ctrl-c': '^C',
  backspace: '^?',
  delete: '^[[3~',
  enter: '^M',
  'alt-enter': '^[^M',
};

describe('what the key bar puts on the wire', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['wire'], raw: true }); });
  after(async () => { await stand.stop(); });

  // The transcript accumulates across a session, so each case reads only what
  // it added.
  async function transcript(page) {
    return page.evaluate(() => (document.querySelector('.xterm-rows')?.textContent || '').replace(/\s+$/, ''));
  }

  async function afterPressing(page, keys) {
    const before = await transcript(page);
    for (const k of keys) await page.click(`#keybar [data-key="${k}"]`);
    // Give the echo a moment to come back through tmux.
    await page.waitForTimeout(400);
    const now = await transcript(page);
    assert.ok(now.startsWith(before), `the transcript was rewritten:\n${before}\n${now}`);
    return now.slice(before.length);
  }

  test('every key sends exactly its own sequence', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;

    for (const [key, wire] of Object.entries(WIRE)) {
      const added = await afterPressing(page, [key]);
      assert.equal(added, wire, `${key} put ${JSON.stringify(added)} on the wire`);
    }
  });

  test('a burst of keys arrives once each, in order', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;

    // The order that was reported as mush: type, delete, space, delete again.
    const order = ['backspace', 'delete', 'backspace', 'left', 'backspace'];
    const added = await afterPressing(page, order);
    assert.equal(added, order.map((k) => WIRE[k]).join(''), 'the burst did not arrive verbatim');
  });

  test('typed text and bar keys do not duplicate each other', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;

    const before = await transcript(page);
    await page.click('#term');
    await page.keyboard.type('abc');
    await page.click('#keybar [data-key="backspace"]');
    await page.keyboard.type('d');
    await page.click('#keybar [data-key="enter"]');
    await page.waitForTimeout(500);
    const added = (await transcript(page)).slice(before.length);

    // Exactly what was pressed: no word reappearing, no key lost.
    assert.equal(added.replace(/\r?\n/g, ''), 'abc^?d^M', `the wire holds ${JSON.stringify(added)}`);
  });

  test('accept sends right-arrow then return, nothing else', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;

    const before = await transcript(page);
    await page.click('#keybar [data-macro="accept"]');
    await page.waitForTimeout(400);
    const added = (await transcript(page)).slice(before.length);
    assert.equal(added.replace(/\r?\n/g, ''), '^[[C^M', `accept sent ${JSON.stringify(added)}`);
  });
});
