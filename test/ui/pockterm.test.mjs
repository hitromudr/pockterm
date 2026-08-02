// Browser tests against a real pockterm. Run with: make test-ui
//
// Every case here is a bug that was found on the phone instead of in CI.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { startStand } from './stand.mjs';

// A one-pixel PNG, base64 — the smallest thing the server will accept.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('sessions screen', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: Array.from({ length: 12 }, (_, i) => `s${i + 1}`) }); });
  after(async () => { await stand.stop(); });

  test('the last session is reachable on a phone screen', async () => {
    await stand.open();
    const { page } = stand;
    const count = await page.locator('#session-list li').count();
    assert.equal(count, 12);

    const last = page.locator('#session-list li').last();
    await last.scrollIntoViewIfNeeded();
    const box = await last.boundingBox();
    const viewport = page.viewportSize();
    // The bug: the list ran under the gesture bar, so the last row could not
    // be scrolled into view at all.
    assert.ok(box, 'the last session has no box at all');
    assert.ok(
      box.y + box.height <= viewport.height + 1,
      `last session ends at ${box.y + box.height}, viewport is ${viewport.height}`,
    );
    // The row holds two buttons now — the session and its rename handle.
    await last.locator('button.session').click({ trial: true });
    await last.locator('button.rename').click({ trial: true });
  });
});

describe('selection and the clipboard', () => {
  let stand;
  before(async () => { stand = await startStand(); });
  after(async () => { await stand.stop(); });

  test('copy puts the selection in the clipboard and lets go of the screen', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    // Something to select: the test session runs `cat`, so what is typed
    // comes back on the screen.
    await page.click('#term');
    await page.keyboard.type('hello from the terminal');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('hello from the terminal'));
    await page.click('#select');
    await page.waitForSelector('#snapshot:not([hidden])');

    // Select the frozen text the way a finger would: over the <pre>.
    await page.evaluate(() => {
      const pre = document.getElementById('snapshot');
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    await page.click('#copy');

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clip.includes('hello from the terminal'), `clipboard holds ${JSON.stringify(clip)}`);

    // The hang: selection mode stayed on, the frozen screen kept covering the
    // terminal, and no tap could bring the keyboard back.
    assert.ok(await page.locator('#snapshot').isHidden(), 'the frozen screen stayed up after Copy');
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
    assert.equal(focused, 'TEXTAREA', `focus went to ${focused} instead of the terminal`);
  });

  test('the system copy also lets go of the screen', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    // There has to be something on the frozen screen: a copy over an empty
    // selection raises no copy event at all, and the test would be measuring
    // its own emptiness.
    await page.click('#term');
    await page.keyboard.type('something to select');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('something to select'));

    await page.click('#select');
    await page.waitForSelector('#snapshot:not([hidden])');
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('snapshot'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Android's own selection menu offers Copy. It fires the document's copy
    // event and never touches pockterm's button — execCommand is the closest
    // a synthesised test gets to that (a pressed Control+C does not reach the
    // browser's editing command through CDP).
    await page.evaluate(() => document.execCommand('copy'));

    // state:'hidden' matters — the default waits for the element to become
    // visible, which a hidden one never does.
    await page.waitForSelector('#snapshot', { state: 'hidden', timeout: 5000 });
  });
});

describe('typing and deleting', () => {
  let stand;
  before(async () => { stand = await startStand(); });
  after(async () => { await stand.stop(); });

  // The reported bug is Android-only: Gboard keeps a composing region and its
  // Backspace re-commits the word into a terminal that has moved on. A desktop
  // Chromium has no IME to reproduce that with. What these two do check is
  // that the plain paths are sound — if either of them duplicated text, the
  // keyboard would not be the only suspect.
  const line = () => document.querySelector('.xterm-rows')?.textContent || '';

  test('the key bar delete removes exactly one character', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    await page.click('#term');
    await page.keyboard.type('hello');
    await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent || '').includes('hello'));

    await page.click('button[data-key="backspace"]');
    await page.waitForFunction(
      () => {
        const t = document.querySelector('.xterm-rows')?.textContent || '';
        return t.includes('hell') && !t.includes('hello');
      },
      null,
      { timeout: 5000 },
    );

    const seen = await page.evaluate(line);
    assert.equal((seen.match(/hell/g) || []).length, 1, `screen holds ${JSON.stringify(seen.slice(0, 80))}`);
  });

  test('the keyboard delete does not duplicate the word', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    await page.click('#term');
    await page.keyboard.type('word');
    await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent || '').includes('word'));
    await page.keyboard.press('Backspace');
    await page.waitForFunction(
      () => {
        const t = document.querySelector('.xterm-rows')?.textContent || '';
        return t.includes('wor') && !t.includes('word');
      },
      null,
      { timeout: 5000 },
    );

    const seen = await page.evaluate(line);
    assert.equal((seen.match(/wor/g) || []).length, 1, `screen holds ${JSON.stringify(seen.slice(0, 80))}`);
  });
});

describe('starting and renaming sessions', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo'] }); });
  after(async () => { await stand.stop(); });

  test('a session can be started from an empty-handed phone', async () => {
    await stand.open();
    const { page } = stand;
    const before = await page.locator('#session-list li').count();

    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');

    // The list refreshes on its own once tmux has the session.
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n,
      before,
      { timeout: 8000 },
    );
  });

  test('closing takes two taps, and the first one is reversible', async () => {
    await stand.open();
    const { page } = stand;

    // Start one to close, so the test never touches the fixture session.
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });

    const victim = page.locator('#session-list li').last();
    const name = await victim.locator('.name').textContent();

    // One tap only arms it: an agent mid-task must survive a stray touch.
    await victim.locator('button.close').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#session-list li').count(), before + 1, 'one tap closed a session');

    await victim.locator('button.close').click();
    await page.waitForFunction(
      (n) => !Array.from(document.querySelectorAll('#session-list .name')).some((e) => e.textContent === n),
      name,
      { timeout: 8000 },
    );
  });

  test('a session can be renamed, and a bad name is refused out loud', async () => {
    await stand.open();
    const { page } = stand;

    await page.click('#session-list li:first-child button.rename');
    await page.fill('#rename-input', 'bad name');
    await page.click('#rename-save');
    // A refusal has to say why: a silent button reads as broken.
    await page.waitForFunction(
      () => /name must be/i.test(document.getElementById('toast').textContent || ''),
      null,
      { timeout: 5000 },
    );

    await page.fill('#rename-input', 'notes');
    await page.click('#rename-save');
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('#session-list .name')).some((e) => e.textContent === 'notes'),
      null,
      { timeout: 8000 },
    );
  });
});

describe('switching sessions', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['one', 'two'] }); });
  after(async () => { await stand.stop(); });

  test('a switch leaves the keyboard as it found it', async () => {
    await stand.open();
    await stand.attach('one');
    const { page } = stand;

    // Not typing: nothing focused, so nothing should raise the keyboard.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.click('#tabs button:not(.active)');
    await page.waitForTimeout(400);
    let focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
    assert.notEqual(focused, 'TEXTAREA', 'the switch grabbed focus and would raise the keyboard');

    // Typing: focus stays, and so does the keyboard.
    await page.click('#term');
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA');
    await page.click('#tabs button:not(.active)');
    await page.waitForTimeout(400);
    focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
    assert.equal(focused, 'TEXTAREA', 'the switch dropped focus and the keyboard would close');
  });
});

describe('the key bar', () => {
  let stand;
  before(async () => { stand = await startStand(); });
  after(async () => { await stand.stop(); });

  const box = (page, sel) => page.locator(sel).boundingBox();

  test('the arrows form their cross on the left, delete sits above enter', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    const up = await box(page, '[data-key="up"]');
    const down = await box(page, '[data-key="down"]');
    const left = await box(page, '[data-key="left"]');
    const right = await box(page, '[data-key="right"]');
    const del = await box(page, '[data-key="backspace"]');
    const enter = await box(page, '[data-key="enter"]');
    const esc = await box(page, '[data-key="esc"]');

    // The cross: up over down, left beside it on the left, right on the right.
    assert.ok(up.y < down.y, 'up is not above down');
    assert.ok(Math.abs(up.x - down.x) < 2, 'up and down are not in one column');
    assert.ok(left.x < down.x, 'left is not to the left of down');
    assert.ok(right.x > down.x, 'right is not to the right of down');
    assert.ok(Math.abs(left.y - down.y) < 2 && Math.abs(right.y - down.y) < 2,
      'the bottom of the cross is not one row');
    // Delete above enter, also one column, and to the right of everything.
    assert.ok(del.y < enter.y, 'delete is not above enter');
    assert.ok(Math.abs(del.x - enter.x) < 2, 'delete and enter are not in one column');
    // Delete and enter moved off the right edge; the stop and hide keys took
    // that corner instead.
    assert.ok(del.x > esc.x, 'the delete column drifted to the left edge');
    // ^C sits over Ctrl, one column in from the edge: hitting it by accident
    // is the most expensive mistake this bar can cause.
    const stop = await box(page, '[data-key="ctrl-c"]');
    const ctrl = await box(page, '#key-ctrl');
    assert.ok(Math.abs(stop.x - ctrl.x) < 2, 'the stop key is not above Ctrl');
    assert.ok(stop.y < ctrl.y, 'the stop key is not above Ctrl');
    const hide = await box(page, '#hide');
    assert.ok(hide.x > stop.x, 'the stop key still holds the corner');
    // Delete and enter sit to the right of the Ctrl column.
    assert.ok(del.x > stop.x, 'delete is not to the right of ^C');
    // Escape is the top-left corner; the cross sits next to it.
    assert.ok(esc.x < up.x && esc.y < down.y, 'escape is not the top-left key');
    assert.ok(left.x <= esc.x + 2, 'the cross is not against the left edge');
  });

  test('accept is one tap from the key bar', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;
    // The macro is right-arrow then Enter — the answer given most often.
    assert.equal(await page.locator('#keybar button[data-macro="accept"]').count(), 1);
  });

  test('tab and shift-tab are gone', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;
    assert.equal(await page.locator('[data-key="tab"]').count(), 0);
    assert.equal(await page.locator('[data-key="shift-tab"]').count(), 0);
  });

  test('one tap hides every bar, one brings them back', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    await page.click('#hide');
    for (const sel of ['#keybar', '#modebar']) {
      assert.ok(await page.locator(sel).isHidden(), `${sel} stayed on screen`);
    }
    // Something has to bring them back, or the only way out is a reload.
    await page.click('#show-bars');
    assert.ok(await page.locator('#keybar').isVisible(), 'the bars did not come back');
  });

  test('the answer key types a digit into the terminal', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    await page.click('[data-key="1"]');
    await page.waitForFunction(
      () => (document.querySelector('.xterm-rows')?.textContent || '').includes('1'),
      null,
      { timeout: 5000 },
    );
  });
});

describe('pasting an image', () => {
  let stand;
  before(async () => { stand = await startStand(); });
  after(async () => { await stand.stop(); });

  test('a pasted screenshot is saved and its path typed into the terminal', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'shot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG_B64);

    await page.waitForFunction(
      () => document.getElementById('toast') &&
        !document.getElementById('toast').hidden &&
        /attached/.test(document.getElementById('toast').textContent),
      null,
      { timeout: 5000 },
    );

    const saved = readdirSync(stand.uploads);
    assert.equal(saved.length, 1, `uploads holds ${JSON.stringify(saved)}`);
    assert.match(saved[0], /\.png$/);
  });
});
