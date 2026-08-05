// The install offer, in a real browser. Run with: make test-ui
//
// The bug this covers was reported from outside: a QR scanned, a page opened, a
// tab closed — "приложение не скачалось". Nothing was broken; the only
// affordance was a button at the bottom of the drawer, and a first visit has no
// reason to go there. So what has to be true is that the offer is on screen
// without opening anything, and that pressing it reaches the browser's own
// prompt.
//
// Chromium in a test does not decide to fire beforeinstallprompt (installability
// depends on engagement heuristics and on not already being installed), so the
// event is dispatched here. What is under test is the page's reaction to it,
// which is the part that was missing.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from './stand.mjs';

describe('the install offer', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo'] }); });
  after(async () => { await stand.stop(); });

  test('nothing is offered to a browser that offers nothing', async () => {
    await stand.open();
    // Desktop Chromium, no event, not iOS: there is no route to offer, and a
    // bar that says so anyway would be noise on every load.
    assert.ok(await stand.page.locator('#install-bar').isHidden());
  });

  test('a browser handing over a prompt gets a bar, and the bar uses it', async () => {
    await stand.open();
    const { page } = stand;

    await page.evaluate(() => {
      window.__prompted = 0;
      const e = new Event('beforeinstallprompt');
      e.prompt = () => { window.__prompted += 1; };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    });

    const bar = page.locator('#install-bar');
    await bar.waitFor({ state: 'visible' });
    // Visible is not the same as on screen, and the difference is the whole
    // complaint: the drawer this bar lives in is a panel translated off the left
    // edge when closed, and a translated element still has a box, so playwright
    // calls it visible. What has to be true is that a first visit *sees* it.
    const box = await bar.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box, 'the bar has no box');
    assert.ok(box.x >= 0, `the bar starts off screen at x=${box.x}`);
    assert.ok(box.y + box.height <= viewport.height, 'the bar is below the fold');
    const button = page.locator('#install-do');
    assert.equal((await button.textContent()).trim(), 'Установить');

    await button.click();
    // The browser's prompt is what installs; the page's job is to reach it.
    assert.equal(await page.evaluate(() => window.__prompted), 1);
    // And then to get out of the way: the offer has been taken.
    await bar.waitFor({ state: 'hidden' });
  });

  test('later means later, and the offer stops asking', async () => {
    await stand.open();
    const { page } = stand;
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt');
      e.prompt = () => {};
      e.userChoice = Promise.resolve({ outcome: 'dismissed' });
      window.dispatchEvent(e);
    });
    await page.locator('#install-bar').waitFor({ state: 'visible' });
    await page.locator('#install-close').click();
    await page.locator('#install-bar').waitFor({ state: 'hidden' });
    // Remembered across loads: a bar that returns on every visit is a bar that
    // gets ignored, and the update bar shares its place on screen.
    assert.equal(
      await page.evaluate(() => localStorage.getItem('pt-install-dismissed')),
      'yes',
    );
  });

  test('the drawer keeps the button, for after the bar was waved away', async () => {
    await stand.open();
    const { page } = stand;
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt');
      e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    });
    await stand.openDrawer();
    await stand.openSettings();
    const inDrawer = page.locator('#install');
    await inDrawer.waitFor({ state: 'visible' });
    await inDrawer.click();
    assert.equal(await page.evaluate(() => window.__prompted), 1);
  });
});
