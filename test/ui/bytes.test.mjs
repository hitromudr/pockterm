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
import { startStand, FAKE_IME } from './stand.mjs';

// How `cat -v` renders what the bar sends.
const WIRE = {
  esc: '^[',
  up: '^[[A',
  down: '^[[B',
  right: '^[[C',
  left: '^[[D',
  'ctrl-c': '^C',
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

    // The shape of what was reported as mush: a key, a move, the same key
    // again, another move, and the key once more.
    const order = ['ctrl-o', 'left', 'ctrl-o', 'up', 'ctrl-o'];
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
    await page.click('#keybar [data-key="ctrl-o"]');
    await page.keyboard.type('d');
    await page.click('#keybar [data-key="enter"]');
    await page.waitForTimeout(500);
    const added = (await transcript(page)).slice(before.length);

    // Exactly what was pressed: no word reappearing, no key lost.
    assert.equal(added.replace(/\r?\n/g, ''), 'abc^Od^M', `the wire holds ${JSON.stringify(added)}`);
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

// The same word, on the client the owner actually has: a browser with no
// bridge, where the only way to end a composition is to move the focus.
//
// That path lost the word outright. xterm wipes its own textarea in its blur
// handler and reads it a task later, from the timeout `compositionend`
// schedules — so ending the composition by blurring emptied the field before
// the read, and nothing reached the pty. On the phone: `ender asked:true
// composing:true len:4`, then silence.
//
// Desktop Chromium has no IME, so the stand plays one — but only the part that
// is not being tested. `FAKE_IME` in stand.mjs dispatches the composition at the
// field and fires `compositionend` from a capture-phase blur listener, which is
// what puts it ahead of the listeners on the element itself, exactly where Chrome
// fires it. Everything after that is the page and xterm, unfaked.

describe('a word still being composed goes out with the Enter', () => {
  let stand;
  before(async () => {
    // No PockNative here on purpose: this is the browser path, which is what
    // the owner's phone has been since 2026-08-05.
    stand = await startStand({ sessions: ['wire'], raw: true });
    await stand.page.addInitScript(FAKE_IME);
  });
  after(async () => { await stand.stop(); });

  const transcript = (page) =>
    page.evaluate(() => (document.querySelector('.xterm-rows')?.textContent || '').replace(/\s+$/, ''));

  test('the word reaches the pty, and before the newline', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;
    await page.click('#term');
    await page.waitForTimeout(500);

    const before = await transcript(page);
    // The field has to start empty, because xterm takes the composition's
    // start from its length — a residue here would make this measure the field
    // rule instead (see js/imefield.js).
    const was = await page.evaluate(() => window.__compose('ab'));
    assert.equal(was, '', `the field held ${JSON.stringify(was)} before the word`);
    await page.waitForTimeout(50);

    await page.click('#keybar [data-key="enter"]');
    await page.waitForTimeout(700);
    const added = (await transcript(page)).slice(before.length).replace(/\r?\n/g, '');
    assert.equal(added, 'ab^M', `the word did not go out whole: ${JSON.stringify(added)}`);
  });

  test('Ctrl with a word being composed: the letter is ended and goes as a code', async () => {
    // The pad of control keys was written because a modifier had nothing to modify:
    // Gboard composes, so xterm is handed a whole word when the composition closes,
    // and the letter is never an event of its own. This is the other answer to the
    // same fact — arm Ctrl and the page ends the composition itself, with the lever
    // the held Enter already uses, so the single letter arrives alone and becomes
    // `^R`. Without it the letter sits in the field until the keyboard decides the
    // word is over, and the wire stays empty.
    const { page } = stand;
    await page.click('#term');
    await page.waitForTimeout(200);
    const before = await transcript(page);
    await page.click('#keybar [data-mod="ctrl"]');
    const was = await page.evaluate(() => window.__compose('к'));
    assert.equal(was, '', `the field held ${JSON.stringify(was)} before the letter`);
    await page.waitForTimeout(700);
    const added = (await transcript(page)).slice(before.length).replace(/\r?\n/g, '');
    assert.equal(added, '^R', `the wire holds ${JSON.stringify(added)}`);
  });

  test('and the keyboard is left with a field to type into', async () => {
    // The blur is how the composition ends; the focus goes straight back, or
    // the keyboard closes under whoever was typing.
    const { page } = stand;
    const focused = await page.evaluate(() =>
      document.activeElement === document.querySelector('.xterm-helper-textarea'));
    assert.equal(focused, true, 'the terminal lost the focus to its own Enter');
  });
});


// Ctrl as a latch, which is what the bar has instead of a backspace.
//
// The on-screen keyboard has a backspace of its own; what it does not have at
// all is ^R, ^D, ^Z or ^L. So the key that erased gave its place to a modifier:
// one tap arms it, the next character typed goes as a control code, and the arm
// is spent. `applyCtrl` in js/keys.js was written for this and sat unused.
describe('the Ctrl latch', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['wire'], raw: true }); });
  after(async () => { await stand.stop(); });

  const transcript = (page) =>
    page.evaluate(() => (document.querySelector('.xterm-rows')?.textContent || '').replace(/\s+$/, ''));

  async function typedAfter(page, steps) {
    const before = await transcript(page);
    for (const s of steps) {
      if (s.click) await page.click(s.click);
      if (s.type) await page.keyboard.type(s.type);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(400);
    return (await transcript(page)).slice(before.length).replace(/\r?\n/g, '');
  }

  test('the next character typed becomes a control code', async () => {
    await stand.open();
    await stand.attach('wire');
    const { page } = stand;
    await page.click('#term');
    await page.waitForTimeout(400);

    // ^R rather than ^D: a control code that closes nothing if the session's
    // stty ever stops being raw, so a failure here is a wrong byte and not a
    // dead pane.
    const added = await typedAfter(page, [{ click: '#keybar [data-mod="ctrl"]' }, { type: 'r' }]);
    assert.equal(added, '^R', `the wire holds ${JSON.stringify(added)}`);
  });

  test('a Cyrillic letter is read by the key it sits on', async () => {
    // The owner's keyboard is Russian, and a page can switch neither its layout nor
    // its language — there is no API for either, the keyboard decides. So `Ctrl` and
    // `к` has to be `^R` here, the way it is in a terminal on a laptop, where Ctrl
    // is applied to the keycode rather than to the letter the layout produced.
    // Without the map the byte on the wire is the letter itself.
    const { page } = stand;
    const added = await typedAfter(page, [{ click: '#keybar [data-mod="ctrl"]' }, { type: 'к' }]);
    assert.equal(added, '^R', `the wire holds ${JSON.stringify(added)}`);
  });

  test('and only that one: the arm is spent', async () => {
    // A latch that stayed on would turn a sentence into control codes, which is
    // the failure worth guarding — it is invisible until something reacts.
    const { page } = stand;
    const added = await typedAfter(page, [{ click: '#keybar [data-mod="ctrl"]' }, { type: 'rr' }]);
    assert.equal(added, '^Rr', `the wire holds ${JSON.stringify(added)}`);
  });

  test('a second tap disarms it', async () => {
    const { page } = stand;
    const added = await typedAfter(page, [
      { click: '#keybar [data-mod="ctrl"]' },
      { click: '#keybar [data-mod="ctrl"]' },
      { type: 'r' },
    ]);
    assert.equal(added, 'r', `the wire holds ${JSON.stringify(added)}`);
  });

  test('the pad is what a phone actually uses', async () => {
    // The latch above modifies a character as it is typed, and on this phone
    // there is no such moment: Gboard composes, so xterm is handed a whole word
    // when the composition closes — measured 2026-08-12, `compositionend` with
    // len 3, 5, 7, 8, 9 and only twice len 1. A modifier cannot modify a
    // keystroke that is not an event. So Ctrl also opens a pad of the control
    // keys themselves, where the keyboard plays no part.
    const { page } = stand;
    await page.click('#term');
    await page.waitForTimeout(300);

    const before = await transcript(page);
    await page.click('#keybar [data-mod="ctrl"]');
    await page.waitForSelector('#ctrlpad', { state: 'visible' });
    await page.click('#ctrlpad [data-ctrl="r"]');
    await page.waitForTimeout(400);
    const added = (await transcript(page)).slice(before.length).replace(/\r?\n/g, '');
    assert.equal(added, '^R', `the wire holds ${JSON.stringify(added)}`);

    // And it closes on use: a pad left open covers the output it was opened over.
    await page.waitForSelector('#ctrlpad', { state: 'hidden' });
  });

  test('a second tap on Ctrl closes the pad and sends nothing', async () => {
    const { page } = stand;
    const before = await transcript(page);
    await page.click('#keybar [data-mod="ctrl"]');
    await page.waitForSelector('#ctrlpad', { state: 'visible' });
    await page.click('#keybar [data-mod="ctrl"]');
    await page.waitForSelector('#ctrlpad', { state: 'hidden' });
    await page.waitForTimeout(300);
    const added = (await transcript(page)).slice(before.length).replace(/\r?\n/g, '');
    assert.equal(added, '', `the wire holds ${JSON.stringify(added)}`);
  });

  test('showing the pad does not shorten the pane', async () => {
    // The same rule the answer row learned the hard way: a panel in the flow
    // shrinks the terminal, tmux redraws to the new height, and what the page
    // reads changes under it. Absolute, over the last rows.
    const { page } = stand;
    const rows = () => page.evaluate(() => document.querySelectorAll('.xterm-rows > div').length);
    const was = await rows();
    await page.click('#keybar [data-mod="ctrl"]');
    await page.waitForSelector('#ctrlpad', { state: 'visible' });
    await page.waitForTimeout(400);
    assert.equal(await rows(), was, 'the pad changed the terminal height');
    await page.click('#keybar [data-mod="ctrl"]');
  });

  test('the arm shows, so nobody types into a mode they forgot', async () => {
    const { page } = stand;
    const armed = () => page.evaluate(() =>
      document.querySelector('#keybar [data-mod="ctrl"]').classList.contains('on'));
    await page.click('#keybar [data-mod="ctrl"]');
    assert.equal(await armed(), true);
    await page.keyboard.type('r');
    await page.waitForTimeout(200);
    assert.equal(await armed(), false, 'the button still looks armed after being spent');
  });

  test('another bar key spends it rather than being modified', async () => {
    // The latch is for characters. Esc has its own sequence, and a Ctrl+Esc
    // that sent something else would be a key nobody asked for — so the arm is
    // dropped and Esc goes as itself.
    const { page } = stand;
    const added = await typedAfter(page, [
      { click: '#keybar [data-mod="ctrl"]' },
      { click: '#keybar [data-key="esc"]' },
      { type: 'r' },
    ]);
    assert.equal(added, '^[r', `the wire holds ${JSON.stringify(added)}`);
  });

  // Last in this block, because it moves the viewport the others measure in.
  test('with a keyboard on screen the pad stays away and the letter still works', async () => {
    // The pad is ten buttons, and it was the whole of the answer while a modifier
    // could not work at all. With a real keyboard up it is a second keyboard for
    // keys the first one already has, over the output it covers — reported from the
    // phone with both on screen at once.
    //
    // The keyboard is played by the viewport, because that is how the page measures
    // one: a short viewport is a keyboard up. Its own measurement is asserted rather
    // than assumed — a viewport that did not shrink enough would look exactly like a
    // fix that does nothing.
    const { page } = stand;
    await page.setViewportSize({ width: 390, height: 420 });
    // Waited for on the page's own state (`data-kb`), not on the viewport number:
    // the number is short the instant the viewport is resized, and the page only
    // knows about it when the event arrives.
    await page.waitForFunction(() => document.documentElement.dataset.kb === '1', null, { timeout: 5000 });

    const added = await typedAfter(page, [{ click: '#keybar [data-mod="ctrl"]' }, { type: 'к' }]);
    assert.equal(await page.locator('#ctrlpad').isVisible(), false,
      'the pad opened over the output with a keyboard already on screen');
    assert.equal(added, '^R', `the wire holds ${JSON.stringify(added)}`);

    await page.setViewportSize({ width: 390, height: 780 });
    await page.waitForFunction(() => document.documentElement.dataset.kb === '0', null, { timeout: 5000 });
  });
});
