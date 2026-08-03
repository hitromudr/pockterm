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

  test('without the parameter the ordinary keyboard is asked for', async () => {
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
