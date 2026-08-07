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
  'ctrl-o': '^O',
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

  // Opening the page again re-attaches, and tmux repaints the pane from its
  // buffer — not instantly. Reading the transcript mid-repaint makes the last
  // bytes of the previous case look like the first bytes of this one, so a
  // reading is taken only once two of them in a row agree.
  async function settled(page) {
    let last = await transcript(page);
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(150);
      const now = await transcript(page);
      if (now === last) return now;
      last = now;
    }
    return last;
  }

  async function afterPressing(page, keys) {
    const before = await settled(page);
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

    // The shape of what was reported as mush: erase, a key that is not an
    // erase, erase again, move, erase.
    const order = ['backspace', 'ctrl-o', 'backspace', 'left', 'backspace'];
    const added = await afterPressing(page, order);
    assert.equal(added, order.map((k) => WIRE[k]).join(''), 'the burst did not arrive verbatim');
  });

  test('typed text and bar keys do not duplicate each other', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;

    const before = await settled(page);
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

    const before = await settled(page);
    await page.click('#keybar [data-macro="accept"]');
    await page.waitForTimeout(400);
    const added = (await transcript(page)).slice(before.length);
    assert.equal(added.replace(/\r?\n/g, ''), '^[[C^M', `accept sent ${JSON.stringify(added)}`);
  });
});

// The keyboard's last word, and the newline that must not overtake it.
//
// Gboard holds the word being typed as a composing region; the app's bridge
// ends that with commitInput(), and the committed text then reaches the page in
// a later task. An Enter sent in the same tick as the call goes first — the line
// arrives without its last word and the word turns up after the newline, which
// is what "our Enter does not send the last word" was on the device.
//
// The IME cannot be reproduced here, but the ordering can: the bridge is faked,
// and a real keystroke is delivered right after the tap on Enter, in the window
// where the page is holding it. What reaches the pty says which went first.
describe('an ending key waits for the word', () => {
  let stand;
  before(async () => {
    stand = await startStand({ sessions: ['wire'], raw: true });
    await stand.page.addInitScript(() => {
      // Only commitInput: every other call site guards with typeof, so the
      // clipboard and notifications keep their browser fallbacks.
      window.PockNative = { commitInput() { return true; } };
    });
  });
  after(async () => { await stand.stop(); });

  const transcript = (page) =>
    page.evaluate(() => (document.querySelector('.xterm-rows')?.textContent || '').replace(/\s+$/, ''));

  test('a keystroke arriving after the tap still goes before the newline', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;
    await page.click('#term');
    await page.waitForTimeout(500);

    const before = await transcript(page);
    await page.click('#keybar [data-key="enter"]');
    // Stands in for the committed word: input that arrives after the key was
    // tapped. Some 5-20ms later in practice, well inside the page's wait.
    await page.keyboard.press('Z');
    await page.waitForTimeout(700);
    const added = (await transcript(page)).slice(before.length).replace(/\r?\n/g, '');

    assert.equal(added, 'Z^M', `the newline overtook the word: ${JSON.stringify(added)}`);
  });

  test('an ending key with no word behind it still goes', async () => {
    // Most Enters have nothing in composition, and a key that waits forever for
    // a word that never comes would be worse than the defect being fixed.
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;
    await page.click('#term');
    await page.waitForTimeout(500);

    const before = await transcript(page);
    await page.click('#keybar [data-key="enter"]');
    await page.waitForTimeout(700);
    const added = (await transcript(page)).slice(before.length).replace(/\r?\n/g, '');
    assert.equal(added, '^M', `Enter alone put ${JSON.stringify(added)} on the wire`);
  });

  test('accept waits the same way, and sends both bytes in order', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;
    await page.click('#term');
    await page.waitForTimeout(500);

    const before = await transcript(page);
    await page.click('#keybar [data-macro="accept"]');
    await page.keyboard.press('Z');
    await page.waitForTimeout(700);
    const added = (await transcript(page)).slice(before.length).replace(/\r?\n/g, '');
    // The word first, then the macro whole: a right arrow with a newline behind
    // it, not split around the word.
    assert.equal(added, 'Z^[[C^M', `accept put ${JSON.stringify(added)} on the wire`);
  });
});
