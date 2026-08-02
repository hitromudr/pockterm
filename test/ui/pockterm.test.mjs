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
    await last.locator('button').click({ trial: true });
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

    await page.click('#select');
    await page.waitForSelector('#snapshot:not([hidden])');
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('snapshot'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Android's own selection menu offers Copy; it fires the same DOM event
    // as Ctrl+C, and pockterm's button is never involved.
    await page.keyboard.press('Control+c');

    await page.waitForSelector('#snapshot[hidden]', { timeout: 2000 });
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
