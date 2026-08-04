// Which keyboard the page asks the app for. Run with: make test-ui
//
// What this CANNOT test, and no browser test can: whether the keyboard then
// comes up, and whether Gboard still keeps a composing region. There is no IME
// and no on-screen keyboard in desktop Chromium, and `window.PockNative` only
// exists inside the owner's Android app. App 2.1 answered `ok:true` to
// `raw` and then showed no keyboard at all — the stand would have called that
// a pass. Anything about the keyboard itself is confirmed on the device.
//
// What is testable here is the half that lives in the page: the argument it
// sends across the bridge for a given URL, and that asking does not break the
// page. Both have already failed in ways the device could not diagnose — the
// input simplification took `keepsTerminalFocus()` out with its neighbour and
// the page died on load with a ReferenceError, which reached the phone as an
// empty session list.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from './stand.mjs';

// The bridge the app injects, reduced to the one method under test: every call
// site in the page guards with `typeof … === 'function'`, so the clipboard,
// notifications and appVersion keep their browser fallbacks.
const FAKE_BRIDGE = () => {
  window.__imeCalls = [];
  window.PockNative = {
    setImeMode(mode) {
      window.__imeCalls.push(mode);
      return true;
    },
  };
};

describe('the keyboard the page asks for', () => {
  let stand;
  before(async () => {
    stand = await startStand();
    await stand.page.addInitScript(FAKE_BRIDGE);
  });
  after(async () => { await stand.stop(); });

  // The page asks once on load and again on every switch in or out of the
  // composer, so the assertions read the LAST call rather than the only one.
  const lastAsked = () => stand.page.evaluate(() => window.__imeCalls.at(-1));
  const allAsked = () => stand.page.evaluate(() => window.__imeCalls);

  // Which bar the page opens on is remembered in localStorage, so a test that
  // switched bars decides what the next one starts with. Say it out loud
  // instead: the terminal's keyboard is only asked for while the key bar is up.
  const openWithBar = async (bar, path = '/') => {
    await stand.open(path);
    await stand.page.evaluate((b) => localStorage.setItem('pt-bar', b), bar);
    await stand.open(path);
  };

  test('with nothing chosen the terminal asks for raw', async () => {
    // The default since it was measured on the device: raw is where a
    // backspace arrives as a deletion instead of a composition rewriting the
    // whole word.
    await stand.page.evaluate(() => localStorage.removeItem('pt-ime')).catch(() => {});
    await stand.open();
    await stand.page.evaluate(() => localStorage.removeItem('pt-ime'));
    await stand.open();
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'raw');
  });

  test('a stored text is a decision the default does not override', async () => {
    await stand.open('/?ime=text');
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'text');

    // Same page again, no parameter: whoever switched back keeps it.
    await stand.open();
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'text');
  });

  test('?ime=raw asks for the gentle variant, ?ime=raw-strict for the other', async () => {
    await stand.open('/?ime=raw');
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'raw');

    await stand.open('/?ime=raw-strict');
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'raw-strict');
  });

  test('an unknown value is the ordinary keyboard, not an unknown mode', async () => {
    // The app maps everything it does not know onto its own default, and its
    // default is raw. A typo in the URL must not hand the phone a keyboard
    // nobody asked for.
    await stand.open('/?ime=nonsense');
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'text');
  });

  test('the choice survives a reload, because that is how it is tested', async () => {
    await stand.open('/?ime=raw');
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'raw');

    // Same origin, no parameter: sessionStorage carries it. An orientation
    // change reloads the page, and losing the mode mid-test would look like
    // the mode failing.
    await stand.open();
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'raw');

    // And it is switchable back without closing anything.
    await stand.open('/?ime=text');
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'text');
  });

  test('the composer always gets the ordinary keyboard, whatever the terminal asked', async () => {
    await stand.open('/?ime=raw');
    await stand.attach();
    const { page } = stand;

    await page.click('#mode');
    await page.waitForFunction(() => window.__imeCalls.at(-1) === 'text');

    // Back out of the composer and the terminal's choice returns: suggestions
    // and dictation are the point in the composer and meaningless in a stream
    // of keystrokes.
    await page.click('#mode');
    await page.waitForFunction(() => window.__imeCalls.at(-1) === 'raw');

    const asked = await allAsked();
    assert.ok(asked.length >= 3, `asked ${asked.length} times: ${asked.join(', ')}`);
  });

  test('the mode is switchable from the page, because the app has no address bar', async () => {
    // `?ime=` was meant to make the next attempt cost a reload instead of an
    // APK release — but inside the owner's Android client the URL is fixed
    // (POCKTERM_URL in MainActivity), so there was nowhere to type it. The
    // button in the drawer's settings is that missing address bar.
    await openWithBar('keys', '/?ime=text');
    await stand.attach();
    const { page } = stand;

    await stand.openSettings();
    await page.click('#ime');
    assert.match(await page.textContent('#ime'), /raw$/);
    await page.waitForFunction(() => window.__imeCalls.at(-1) === 'raw');

    await page.click('#ime');
    await page.waitForFunction(() => window.__imeCalls.at(-1) === 'raw-strict');

    // Round trip: three taps come back to where they started, so nobody is
    // stuck in a mode that took their keyboard away.
    await page.click('#ime');
    await page.waitForFunction(() => window.__imeCalls.at(-1) === 'text');
    assert.match(await page.textContent('#ime'), /text$/);
  });

  test('switching the mode in the composer does not disturb the composer', async () => {
    // Its keyboard is the ordinary one on purpose — suggestions and dictation
    // are the whole reason the composer exists.
    await openWithBar('composer', '/?ime=text');
    await stand.attach();
    const { page } = stand;

    await stand.openSettings();
    await page.click('#ime');
    assert.match(await page.textContent('#ime'), /raw$/);
    assert.equal(await lastAsked(), 'text');
  });

  test('a mode chosen from the menu survives a reload', async () => {
    await openWithBar('keys', '/?ime=text');
    await stand.attach();
    const { page } = stand;

    await stand.openSettings();
    await page.click('#ime');
    assert.match(await page.textContent('#ime'), /raw$/);

    // Same reason the URL parameter is remembered: an orientation change
    // reloads the page, and losing the mode mid-test reads as the mode failing.
    await stand.open();
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'raw');
    assert.match(await stand.page.textContent('#ime'), /raw$/);
  });

  test('the mode outlives the app restarting its activity', async () => {
    // sessionStorage does not: the app recreates its activity on a rotation or
    // on coming back from the launcher, and the journal showed `raw` chosen at
    // 16:04 and `text` again on the next load. A mode nobody can keep is a
    // mode nobody can evaluate.
    await openWithBar('keys', '/?ime=raw');
    await stand.page.waitForFunction(() => window.__imeCalls.at(-1) === 'raw');

    await stand.page.evaluate(() => sessionStorage.clear());
    await stand.open();
    await stand.page.waitForFunction(() => window.__imeCalls.length > 0);
    assert.equal(await lastAsked(), 'raw');
  });

  test('asking does not break the page', async () => {
    // The trap this guards: a page that throws on load never renders the
    // session list, and on the phone that is indistinguishable from a machine
    // with no tmux sessions. The stand sees the exception; the device does not.
    //
    // Uncaught exceptions only. Console output also carries the browser's own
    // 404 for /favicon.ico, which the binary does not embed — asserting on it
    // would tie this test to something it is not about.
    await stand.open('/?ime=raw');
    await stand.attach();
    assert.deepEqual(stand.pageErrors, []);
  });
});
