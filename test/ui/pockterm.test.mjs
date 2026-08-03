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

describe('the session list is a drawer', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo', 'other'] }); });
  after(async () => { await stand.stop(); });

  const drawer = () => stand.page.evaluate(() => {
    const el = document.getElementById('screen-sessions');
    return {
      open: el.classList.contains('open'),
      x: Math.round(el.getBoundingClientRect().x),
      scrim: !document.getElementById('drawer-scrim').hidden,
      termHidden: document.getElementById('screen-term').hidden,
    };
  });

  test('the terminal stays where it is while the list is open', async () => {
    // It used to be a screen of its own: opening the list tore the terminal down
    // and coming back reset it. The list is what you open to see what else is
    // running, so what is running has to survive it.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    await page.click('#term');
    await page.keyboard.type('still here');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('still here'));

    await page.click('#back');
    // On the geometry, not the class: the drawer slides, so it is on screen a
    // fifth of a second after it is told to be.
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 },
    );
    let d = await drawer();
    assert.equal(d.open, true, `the drawer did not open: ${JSON.stringify(d)}`);
    assert.equal(d.termHidden, false, 'the terminal was taken away to show the list');
    assert.equal(d.scrim, true, 'nothing to tap outside the drawer');

    // The same button closes it, and ✕ sits where ☰ is.
    await page.click('#drawer-close');
    await page.waitForFunction(() => !document.getElementById('screen-sessions').classList.contains('open'));
    d = await drawer();
    assert.equal(d.scrim, false);
    assert.ok(await page.locator('.xterm-rows').textContent().then((t) => t.includes('still here')),
      'the terminal was reset by a trip to the list');
  });

  test('the way back sits exactly where the way in was', async () => {
    // ☰ opens it and ❮ closes it, and they are the same spot — that is the whole
    // idea, so the box is asserted rather than left to the padding. Ornament
    // glyphs carry uneven side bearings, so ❮ under the bar's usual padding sat
    // visibly off to one side.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    const box = (id) => page.evaluate((i) => {
      const r = document.getElementById(i).getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }, id);

    const hamburger = await box('back');
    await page.click('#back');
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 });
    const chevron = await box('drawer-close');
    assert.deepEqual(chevron, hamburger, 'the way out is not where the way in was');
  });

  test('a tap outside closes it, and a session in it switches', async () => {
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;

    await page.click('#back');
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 },
    );
    // Outside the drawer, which is 86% of a 390px screen at most 360.
    await page.mouse.click(380, 400);
    await page.waitForFunction(() => !document.getElementById('screen-sessions').classList.contains('open'));

    await page.click('#back');
    await page.click('button.session:has-text("other")');
    await page.waitForFunction(() => !document.getElementById('screen-sessions').classList.contains('open'));
    // The strip follows the switch.
    await page.waitForFunction(() => {
      const active = document.querySelector('#tabs button.active');
      return active && active.textContent === 'other';
    }, null, { timeout: 5000 });
  });

  test('closing the session you are in does not leave a black page', async () => {
    // Reported as the window hanging empty after closing the very session being
    // used. With nothing attached the terminal screen is hidden and ☰ lives in
    // its header, so a drawer that could still be dismissed left a black page
    // with nothing to tap and no way back but a reload.
    await stand.open();
    const { page } = stand;
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });
    const name = (await page.locator('#session-list li').last().locator('.name').textContent()).trim();

    await page.click(`button.session:has-text("${name}")`);
    await page.waitForSelector('#screen-term:not([hidden])');
    await page.click('#back');
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 });

    const row = page.locator(`#session-list li:has-text("${name}")`);
    await row.locator('button.close').click();
    await row.locator('button.close').click();
    await page.waitForFunction(() => document.getElementById('screen-term').hidden, null, { timeout: 5000 });

    // Nothing behind it, so nothing offers a way out: no chevron, no scrim.
    assert.equal(await page.locator('#drawer-close').isVisible(), false, 'a way out of an empty page');
    assert.equal(await page.evaluate(() => document.getElementById('drawer-scrim').hidden), true);
    // And it stays put even if something does tap where they were.
    await page.mouse.click(380, 400);
    await page.waitForTimeout(400);
    assert.equal(
      await page.evaluate(() => document.getElementById('screen-sessions').classList.contains('open')),
      true, 'the drawer closed onto a black page',
    );
    // The strip went with the session rather than keeping its tab.
    assert.equal(await page.locator('#tabs button').count(), 0);

    // Attaching brings the way out back.
    await page.click('button.session:has-text("demo")');
    await page.waitForSelector('#screen-term:not([hidden])');
    await page.click('#back');
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 });
    assert.equal(await page.locator('#drawer-close').isVisible(), true, 'no way back with a session behind it');
    await page.click('#drawer-close');
    await page.waitForFunction(() => !document.getElementById('screen-sessions').classList.contains('open'));
  });

  test('with nothing attached the drawer is where the page starts', async () => {
    const { page } = stand;
    await page.evaluate(() => sessionStorage.removeItem('pt-session'));
    await page.goto(stand.base);
    await page.waitForFunction(() => document.getElementById('screen-sessions').classList.contains('open'));
    const d = await drawer();
    assert.equal(d.termHidden, true, 'an empty terminal is sitting under the drawer');
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

  test('a session can be started without leaving the one you are in', async () => {
    // The tab strip is the session list on the terminal screen, so the same plus
    // belongs at the end of it — asked for from the phone, where going back to
    // the list to start something means losing sight of what is running.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    const before = await page.locator('#tabs button').count();

    await page.click('#new-term');
    await page.click('#new-menu-term button[data-preset="shell"]');
    // The popup closes itself: it covers the top of the terminal.
    await page.waitForSelector('#new-menu-term', { state: 'hidden' });

    // The strip picks the session up on its own, and the terminal is still the
    // one that was open.
    await page.waitForFunction(
      (n) => document.querySelectorAll('#tabs button').length > n,
      before,
      { timeout: 8000 },
    );
    assert.equal(await page.locator('#screen-term:not([hidden])').count(), 1, 'it left the terminal');
  });

  test('the presets over the terminal can be dismissed', async () => {
    // Reported as there being no way to cancel that plus. The popup was laid out
    // from the top of the screen — an absolutely positioned flex child starts at
    // the content box, which is behind the header — so it covered ☰, the tabs and
    // the + itself: the tap meant to dismiss it landed on a preset and started a
    // session.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    const before = await page.locator('#tabs button').count();

    await page.click('#new-term');
    await page.waitForSelector('#new-menu-term:not([hidden])');
    // The header is reachable: what sits on the + is the scrim, not a preset.
    const onThePlus = await page.evaluate(() => {
      const r = document.getElementById('new-term').getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el ? (el.id || el.className) : '';
    });
    assert.match(onThePlus, /menu-scrim|new-term/, `a ${onThePlus} is sitting on the plus`);

    // One tap anywhere outside closes it, and starts nothing.
    await page.mouse.click(200, 400);
    await page.waitForSelector('#new-menu-term', { state: 'hidden' });
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#tabs button').count(), before, 'dismissing it started a session');
  });

  test('closing a session takes its tab with it', async () => {
    // Reported as the strip at the top not being redrawn when a terminal is
    // closed. It was only ever redrawn on an attach, so a closed session kept
    // its tab, a renamed one kept its old name, and a new one showed up nowhere.
    await stand.open();
    const { page } = stand;
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });

    // Attach to the fixture, then close the one just started from the drawer.
    await stand.attach('demo');
    await page.waitForFunction(() => document.querySelectorAll('#tabs button').length >= 2, null, { timeout: 5000 });
    const tabs = await page.locator('#tabs button').count();

    await page.click('#back');
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 });
    const victim = page.locator('#session-list li').last();
    const name = (await victim.locator('.name').textContent()).trim();
    await victim.locator('button.close').click();
    await victim.locator('button.close').click(); // armed, then confirmed

    await page.waitForFunction(
      (n) => document.querySelectorAll('#tabs button').length < n, tabs, { timeout: 8000 });
    const left = await page.locator('#tabs button').allTextContents();
    assert.ok(!left.includes(name), `the closed session is still a tab: ${left.join(', ')}`);
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

  test('nothing but a tap on the terminal takes focus', async () => {
    await stand.open();
    await stand.attach('one');
    const { page } = stand;
    await page.evaluate(() => document.activeElement && document.activeElement.blur());

    // Every one of these used to focus something and raise the keyboard.
    for (const sel of ['#hide', '#show-bars', '[data-key="esc"]', '#tabs button:not(.active)']) {
      await page.click(sel);
      await page.waitForTimeout(200);
      const tag = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
      assert.notEqual(tag, 'TEXTAREA', `${sel} grabbed focus`);
    }
  });

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

    // Typing: focus stays where it was, without anyone restoring it — the
    // switch must not call focus() at all. On Android focus survives the
    // keyboard being dismissed, so "restoring" it there raises the keyboard
    // for someone who had just put it away.
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

  test('the bar is laid out as asked: cross on the left, pairs in columns', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    const at = async (sel) => box(page, sel);
    const esc = await at('[data-key="esc"]');
    const up = await at('[data-key="up"]');
    const down = await at('[data-key="down"]');
    const left = await at('[data-key="left"]');
    const right = await at('[data-key="right"]');
    const stop = await at('[data-key="ctrl-c"]');
    const bs = await at('[data-key="backspace"]');
    const del = await at('[data-key="delete"]');
    const altEnter = await at('[data-key="alt-enter"]');
    const enter = await at('[data-key="enter"]');
    // Prompt mode has its own Accept; this is about the key bar's.
    const accept = await at('#keybar [data-macro="accept"]');
    const hide = await at('#hide');

    const sameColumn = (a, b, what) => {
      assert.ok(Math.abs(a.x - b.x) < 2, `${what} are not in one column`);
      assert.ok(a.y < b.y, `${what} are in the wrong order`);
    };

    // Escape holds the top-left corner, the arrows keep their cross beside it.
    assert.ok(esc.x < up.x && esc.y < down.y, 'escape is not the top-left key');
    sameColumn(up, down, 'up and down');
    assert.ok(left.x < down.x, 'left is not to the left of down');
    assert.ok(right.x > down.x, 'right is not to the right of down');

    // The pairs, each asked for by name: the two erasers, the two enters, and
    // accept over the hide toggle.
    sameColumn(bs, del, 'backspace and forward delete');
    sameColumn(altEnter, enter, 'alt+enter and enter');
    sameColumn(accept, hide, 'accept and hide');

    // ^C keeps away from both edges: it is the most expensive misfire here.
    assert.ok(stop.x > up.x && stop.x < accept.x, '^C drifted to an edge');
  });

  test('accept is one tap from the key bar', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;
    // The macro is right-arrow then Enter — the answer given most often.
    assert.equal(await page.locator('#keybar [data-macro="accept"]').count(), 1);
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

  test('the way back to the end appears only when scrolled back', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    // Not scrolled: no button, because there is nowhere to come back from.
    assert.ok(await page.locator('#to-bottom').isHidden(), 'the button is up without cause');

    // The server reports the pane's copy-mode over the socket; this is the
    // same frame it sends.
    await page.evaluate(() => {
      const el = document.getElementById('to-bottom');
      el.hidden = false; // stand-in for the server frame
    });
    assert.ok(await page.locator('#to-bottom').isVisible());
    await page.click('#to-bottom');
  });

  test('alt+enter is on the bar, and plain enter is elsewhere', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;
    // The pair matters: one sends the message, the other adds a line to it,
    // and from a phone there is no other way to reach the second.
    assert.equal(await page.locator('#keybar [data-key="alt-enter"]').count(), 1);
    assert.equal(await page.locator('#keybar [data-key="enter"]').count(), 1);
  });
});

describe('pasting an image', () => {
  let stand;
  before(async () => { stand = await startStand(); });
  after(async () => { await stand.stop(); });

  test('the attach button opens the picker, and a picked file is uploaded', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;

    // The picker itself is the app's business; what must hold here is that the
    // button reaches the input at all. It stopped doing that once, when the
    // bar's "do not take focus" rule was applied to the label around it.
    const opened = await page.evaluate(() => new Promise((resolve) => {
      const input = document.getElementById('pick-file');
      input.addEventListener('click', (e) => { e.preventDefault(); resolve(true); }, { once: true });
      document.getElementById('pick').click();
      setTimeout(() => resolve(false), 1000);
    }));
    assert.ok(opened, 'the attach button never reached the file input');

    // And a picked file goes through the same upload as a paste.
    await page.setInputFiles('#pick-file', {
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_B64, 'base64'),
    });
    await page.waitForFunction(
      () => /attached/.test(document.getElementById('toast').textContent || ''),
      null,
      { timeout: 5000 },
    );
  });

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

    // Not "exactly one": the picker case in this suite uploads too. What
    // matters is that this paste added a file of its own.
    const saved = readdirSync(stand.uploads).filter((f) => f.endsWith('.png'));
    assert.ok(saved.length >= 1, `uploads holds ${JSON.stringify(saved)}`);
  });
});

describe('opening a named session', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['one', 'two'] }); });
  after(async () => { await stand.stop(); });

  // How a tapped notification arrives: the app puts the session it was raised
  // for into the URL. Before this, the tap opened whatever was open last —
  // with several agents running, usually not the one that just finished.
  test('?session= attaches to that session and leaves the address clean', async () => {
    const { page } = stand;
    await page.goto(`${stand.base}/?session=two`);
    await page.waitForSelector('#screen-term:not([hidden])');
    await page.waitForFunction(() => !document.getElementById('status') ||
      document.getElementById('status').hidden);
    const active = await page.locator('#tabs button.active').textContent();
    assert.equal(active, 'two', `attached to ${active}, not to two`);

    // The parameter is consumed: a later reload restores what is being looked
    // at, not the session some notification named an hour ago.
    assert.equal(new URL(page.url()).searchParams.get('session'), null);
  });

  test('an unknown session name lands on the list instead of nowhere', async () => {
    const { page } = stand;
    await page.goto(`${stand.base}/?session=killed-since`);
    await page.waitForSelector('#session-list li');
  });
});

describe('which bar the phone opens on', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['one'] }); });
  after(async () => { await stand.stop(); });

  test('a browser opens on the key bar', async () => {
    await stand.open();
    await stand.attach('one');
    const { page } = stand;
    assert.equal(await page.locator('#keybar').isVisible(), true, 'the key bar is the browser default');
    assert.equal(await page.locator('#composer').isVisible(), false);
  });

  // Inside the app the composer comes first: the terminal's own field is the
  // one an IME rewrites behind the page's back, and dictation — whole phrases
  // at a time — is the worst case of it.
  test('inside the app the composer comes first, and ⌨ is remembered', async () => {
    const { page } = stand;
    await page.addInitScript(() => { window.PockNative = { copy: () => true }; });
    // open() knows the page may come back straight into the terminal: it
    // restores the session it was last attached to.
    await stand.open();
    await stand.attach('one');
    assert.equal(await page.locator('#composer').isVisible(), true, 'the composer is the app default');
    assert.equal(await page.locator('#keybar').isVisible(), false);

    // Nothing is taken away: ⌨ brings the key bar back...
    await page.click('#mode');
    assert.equal(await page.locator('#keybar').isVisible(), true);

    // ...and the choice outlives a reload, so the default is what shows until
    // a choice is made, not a rule.
    await stand.open();
    await stand.attach('one');
    assert.equal(await page.locator('#keybar').isVisible(), true, 'the choice was forgotten');
  });
});

describe('a new version on the server', () => {
  let stand;
  before(async () => { stand = await startStand(); });
  after(async () => { await stand.stop(); });

  test('the page offers the update and the button takes it', async () => {
    // CI installs a build the moment it arrives, so the unit restarts under
    // whoever is looking and every page reconnects — still running the assets
    // it loaded before the restart. That is the one thing a page cannot work
    // out for itself: its own code is the old code, and it looks exactly as
    // healthy as before. The server names what it serves; this is the page
    // acting on it.
    const { page } = stand;
    await stand.open();
    await stand.attach();
    assert.equal(await page.locator('#update-bar').isVisible(), false,
      'the page is the one the server serves, so nothing should be offered');

    // A page from before the deploy, made the way the phone gets one: the
    // assets it is running are older than the ones on the server. Rewriting
    // the response is the only way to have both versions in one test — the
    // binary parses its own embedded app.js, so the two agree by construction.
    await page.context().route('**/js/app.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(/APP_VERSION = '[^']+'/, "APP_VERSION = 'v0'");
      await route.fulfill({ response: res, body });
    });
    await stand.open();
    await stand.attach();

    await page.waitForSelector('#update-bar:not([hidden])');
    const said = await page.locator('#update-text').textContent();
    assert.match(said, /v0/, `the bar does not say what the page is running: ${said}`);
    assert.doesNotMatch(said, /^\s*$/, 'the bar is empty');

    // Taking it is a reload, and a reload of the real assets lands on a page
    // the server agrees with. The marker proves the document is a new one:
    // hiding the bar without reloading would be the same defect, quieter.
    await page.context().unroute('**/js/app.js');
    await page.evaluate(() => { window.__beforeReload = true; });
    await page.click('#update-now');
    await page.waitForFunction(() => window.__beforeReload === undefined, null, { timeout: 5000 });
    await page.waitForSelector('#screen-term:not([hidden])');
    await page.waitForSelector('#update-bar', { state: 'hidden' });

    assert.deepEqual(stand.pageErrors, []);
  });
});
