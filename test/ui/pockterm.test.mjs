// Browser tests against a real pockterm. Run with: make test-ui
//
// Every case here is a bug that was found on the phone instead of in CI.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { startStand, FAKE_IME } from './stand.mjs';
import { readFileSync } from 'node:fs';

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

describe('the size a client attaches at', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo'] }); });
  after(async () => { await stand.stop(); });

  test('the window is never resized to a default nobody asked for', async () => {
    // Sessions here are grouped — one window, several clients — and tmux gives the
    // shared window the newest client's size. A client attached at 80x24 while it
    // waits to be told better therefore redraws the pane at 80 columns under every
    // other client on that session: the laptop, and this phone's other tabs. What
    // it looked like was halves of two lines in one row and a cursor in the wrong
    // place, and it cleared itself as soon as the page's resize arrived — which is
    // exactly why measuring after an ordinary attach proves nothing. So the resize
    // message is dropped on the way out, leaving only what the attach itself asked
    // for: the size in the socket's own address.
    await stand.open();
    const { page } = stand;
    await page.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes('"resize"')) return;
        return send.call(this, data);
      };
    });

    await stand.attach('demo');
    // The page publishes its own size on #term (see fitNow), which is also what
    // makes a screenshot of a broken redraw answerable.
    await page.waitForFunction(() => document.getElementById('term').dataset.size);
    const cols = Number((await page.getAttribute('#term', 'data-size')).split('x')[0]);
    const width = () => Number(stand.tmux(['display-message', '-p', '-t', 'demo', '#{window_width}']).trim());
    assert.equal(width(), cols,
      `tmux drew ${width()} columns for a page showing ${cols} — the attach used a size of its own`);

    // And it holds across a switch, which is what made this recur: every tab is a
    // new client, so every switch was another chance to resize the window under
    // whoever else was looking.
    await stand.attach('demo');
    assert.equal(width(), cols, 'a second attach moved the window');
  });
});

describe('a socket that has stopped delivering', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo'] }); });
  after(async () => { await stand.stop(); });

  test('the page notices and reconnects instead of sitting frozen', async () => {
    // Reported from the phone as the screen freezing: a message typed on it had
    // plainly been sent — the laptop showed the agent answering it — while the
    // phone stayed on the same frame and caught up about a minute later. That
    // minute is TCP giving up on a connection the phone handed between Wi-Fi and
    // cellular; `readyState` stays OPEN and sends look like they succeed.
    //
    // A black hole has to be both ways, and getting that wrong is how an earlier
    // version of this test proved nothing: it swallowed only the page's own sends,
    // the stand's far end kept talking, and the watchdog was right to stay quiet.
    // So the socket is born mute and deaf — sends go nowhere and the page's
    // onmessage is never wired to anything.
    const { page } = stand;
    await stand.open();
    await page.evaluate(() => {
      const proto = WebSocket.prototype;
      const send = proto.send;
      const onmessage = Object.getOwnPropertyDescriptor(proto, 'onmessage');
      proto.send = function () { window.__muted = (window.__muted || 0) + 1; };
      Object.defineProperty(proto, 'onmessage', {
        configurable: true,
        get: onmessage.get,
        set(fn) { onmessage.set.call(this, () => {}); },
      });
      window.__restore = () => {
        proto.send = send;
        Object.defineProperty(proto, 'onmessage', onmessage);
      };
    });
    await stand.attach('demo');

    // The journal is the signal, not the status bar: a socket born deaf still fires
    // onopen, so the bar hides again on a reconnect that cannot hear either. What
    // says the watchdog fired is the page's own line — and it is what turns "иногда
    // зависает" into a fact with a count.
    //
    // PING_AFTER + PONG_WAIT is 15s and the watchdog ticks every 2.5s on top; the
    // wait is far longer because `node --test test/ui/` runs the files in parallel
    // and a browser timer on a loaded four-core box is late by seconds.
    for (let i = 0; i < 120 && !/socket-stalled/.test(stand.serverLog()); i++) {
      await page.waitForTimeout(500);
    }
    assert.match(stand.serverLog(), /socket-stalled/, 'the page never said the socket had stalled');
    assert.ok(await page.evaluate(() => window.__muted > 0), 'the page never asked anything of the socket');

    // With the hole closed the next reconnect can hear, and tmux behind it was
    // untouched — the proof being that typing arrives and comes back.
    await page.evaluate(() => window.__restore());
    await page.click('#term');
    for (let i = 0; i < 60; i++) {
      await page.keyboard.type('.');
      if (await page.evaluate(() => (document.querySelector('.xterm-rows')?.textContent || '').includes('.'))) break;
      await page.waitForTimeout(500);
    }
    await page.keyboard.type('alive again');
    await page.waitForFunction(
      () => document.querySelector('.xterm-rows')?.textContent?.includes('alive again'),
      null, { timeout: 20000 });

    // One socket, not two. Discarding the stalled one fires its own onclose, which
    // schedules a reconnect of its own — so the first version of this left the page
    // with two sockets on the session and then four, each writing every frame into
    // the same terminal. Reported from the phone as the terminal tripling.
    const clients = await page.evaluate(async () => {
      const res = await fetch('/api/presence');
      return res.ok ? (await res.json()).clients : -1;
    });
    assert.equal(clients, 1, 'the page left more than one socket attached');
  });

  test('a reconnect armed by a close does not open a socket beside the one in hand', async () => {
    // Reported from the phone after two deploys in an evening as everything on
    // screen being drawn twice — output lines, the agent's own prompt, tmux's
    // status bar — which reads as the message having been sent again.
    //
    // Nothing was sent twice. A restart drops every socket at once, onclose arms
    // a reconnect, and anything that opens a socket before that timer fires — a
    // tab tapped, the watchdog — leaves it to open a second one on top. The page
    // then writes keystrokes to the newest and reads frames from **both**, so
    // what doubles is the picture.
    //
    // The race is made rather than waited for: the page's own socket is closed
    // from here (which is what a restart looks like from in there), and the tab is
    // tapped inside the second the backoff is armed for.
    const { page } = stand;
    await page.addInitScript(() => {
      // Every socket the page opens, kept so the test can close one the way the
      // network does and count what is left open afterwards.
      window.__sockets = [];
      const Real = window.WebSocket;
      const Spy = function (...args) {
        const s = new Real(...args);
        window.__sockets.push(s);
        return s;
      };
      Spy.prototype = Real.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
      window.WebSocket = Spy;
    });
    await stand.open();
    await stand.attach('demo');
    await page.waitForFunction(() => window.__sockets?.some((s) => s.readyState === WebSocket.OPEN));

    // The drop. `retry` is 1000ms at this point (a socket that opened resets it),
    // so what follows has to happen inside that second.
    await page.evaluate(() => {
      for (const s of window.__sockets) if (s.readyState === WebSocket.OPEN) s.close();
    });
    await stand.attach('demo');

    // Long enough for the armed reconnect to have fired, and for a socket it
    // opened to have reached the server.
    await page.waitForTimeout(2500);

    const open = await page.evaluate(() => window.__sockets.filter((s) => s.readyState === WebSocket.OPEN).length);
    assert.equal(open, 1, `the page holds ${open} open sockets`);
    // And the server's own count, because a socket the page has forgotten is
    // still a client tmux is drawing for.
    const clients = await page.evaluate(async () => {
      const res = await fetch('/api/presence');
      return res.ok ? (await res.json()).clients : -1;
    });
    assert.equal(clients, 1, `the server sees ${clients} clients for one page`);

    // And it still works: one socket that carries typing is the point of having
    // exactly one.
    await page.click('#term');
    await page.keyboard.type('one socket');
    await page.waitForFunction(
      () => document.querySelector('.xterm-rows')?.textContent?.includes('one socket'),
      null, { timeout: 20000 });
  });
});

describe('the order of the tabs', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['alpha', 'beta', 'gamma'] }); });
  after(async () => { await stand.stop(); });

  const strip = () => stand.page.evaluate(
    () => [...document.querySelectorAll('#tabs button[data-session]')].map((b) => b.dataset.session));

  test('a held tab can be carried to another place, and stays there', async () => {
    // tmux sorts its sessions by name, which is the one order nobody chose: the
    // strip is read left to right dozens of times a day and the session you keep
    // coming back to is not the one whose name sorts first.
    //
    // The gesture is the press that already existed for asking what a tab's mark
    // means: a hold picks it up, travel then carries it, and a hold that does not
    // travel is still just the question. Driven through the browser's own touch
    // input, because a hold is a duration and synthetic events have no clock.
    await stand.open();
    await stand.attach('alpha');
    const { page } = stand;
    await page.waitForFunction(
      () => document.querySelectorAll('#tabs button[data-session]').length === 3, null, { timeout: 8000 });
    assert.deepEqual(await strip(), ['alpha', 'beta', 'gamma'], 'tmux orders by name to begin with');

    const cdp = await page.context().newCDPSession(page);
    const box = async (name) => page.locator(`#tabs button[data-session="${name}"]`).boundingBox();
    const from = await box('gamma');
    const to = await box('alpha');
    let x = Math.round(from.x + from.width / 2);
    const y = Math.round(from.y + from.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    // The hold is 400ms (HELP_HOLD_MS); the wait is longer because a loaded box
    // fires a timer late, and a tap that was not held is a different gesture.
    await page.waitForTimeout(700);
    const target = Math.round(to.x + 4);
    // The finger leaves the strip on the way, which is what a thumb does: the row
    // is 34px tall at the very top edge of the screen and a sideways travel arcs
    // out of it within a centimetre. The carry reads the x and nothing else, so
    // this must rearrange the row exactly as a travel along the strip does — it
    // did not, and that is what was reported as the carrying stopping.
    let below = y;
    while (x > target) {
      x = Math.max(target, x - 20);
      below = Math.min(below + 25, y + 200);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: below }] });
      await page.waitForTimeout(30);
    }
    // And the finger covers the tab it is holding, so what is in hand is said on a
    // plate below it — the row rearranging under a thumb is otherwise unreadable.
    const plate = await page.evaluate(() => {
      const el = document.getElementById('kind-help');
      if (!el || el.hidden) return null;
      return { text: el.textContent, carrying: el.classList.contains('carrying'), top: el.getBoundingClientRect().top };
    });
    assert.ok(plate, 'nothing says which tab is being carried');
    assert.ok(plate.carrying && plate.text.includes('gamma'), `the plate says ${plate?.text}`);
    assert.ok(plate.top > from.y + from.height + 20, 'the plate sits under the thumb holding the tab');

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await page.evaluate(() => document.getElementById('kind-help').hidden), true,
      'the plate outlived the finger that was carrying the tab');

    await page.waitForFunction(
      () => document.querySelector('#tabs button[data-session]').dataset.session === 'gamma',
      null, { timeout: 5000 });
    assert.deepEqual(await strip(), ['gamma', 'alpha', 'beta']);

    // The carrying must not have switched session — that is what the click the
    // press ends in would do.
    assert.equal(await page.evaluate(
      () => document.querySelector('#tabs button.active')?.dataset.session), 'alpha');

    // The order is kept in tmux, on the sessions themselves, so it survives this
    // binary's restarts (CI installs one several times a working day) and a second
    // phone sees the same row.
    assert.equal(stand.tmux(['show-options', '-v', '-t', 'gamma', '@pockterm-order']).trim(), '1');
    await page.goto(stand.base);
    await page.waitForFunction(
      () => document.querySelectorAll('#tabs button[data-session]').length === 3, null, { timeout: 10000 });
    assert.deepEqual(await strip(), ['gamma', 'alpha', 'beta'], 'the order did not survive a reload');
  });

  test('a session started later lands at the end, not in the middle', async () => {
    // A placed row is somebody's arrangement; a new session has no place in it yet
    // and must not be inserted into one by its name.
    const { page } = stand;
    await stand.openDrawer();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');
    await page.waitForFunction(
      () => document.querySelectorAll('#tabs button[data-session]').length === 4, null, { timeout: 8000 });
    const names = await strip();
    assert.deepEqual(names.slice(0, 3), ['gamma', 'alpha', 'beta'], 'the new session moved the placed ones');
  });

  test('a mouse carries a tab by a plain drag, with no hold', async () => {
    // The page is opened on a laptop as well, and there the row could not be
    // rearranged at all: every listener was for touches. No hold with a mouse —
    // the hold on a phone buys the gesture back from the strip's own sideways
    // scroll, and a mouse scrolls it with a wheel instead of by pushing it.
    const { page } = stand;
    await stand.shutDrawer();
    const before = await strip();
    const last = before[before.length - 1];
    const from = await page.locator(`#tabs button[data-session="${last}"]`).boundingBox();
    const head = await page.locator(`#tabs button[data-session="${before[0]}"]`).boundingBox();
    const y = Math.round(from.y + from.height / 2);
    await page.mouse.move(Math.round(from.x + from.width / 2), y);
    await page.mouse.down();
    let x = Math.round(from.x + from.width / 2);
    const target = Math.round(head.x + 4);
    while (x > target) {
      x = Math.max(target, x - 20);
      await page.mouse.move(x, y);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();

    await page.waitForFunction(
      (name) => document.querySelector('#tabs button[data-session]').dataset.session === name,
      last, { timeout: 5000 });
    assert.deepEqual(await strip(), [last, ...before.slice(0, -1)]);
    // The release ends in a click, and that click must not switch session.
    assert.equal(await page.evaluate(
      () => document.querySelector('#tabs button.active')?.dataset.session), 'alpha');
    assert.equal(stand.tmux(['show-options', '-v', '-t', last, '@pockterm-order']).trim(), '1',
      'the mouse-carried order did not reach tmux');
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

    await stand.tapMenu();
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
    await stand.tapMenu();
    // Exactly 0, not "within a pixel". This assertion compares rounded boxes, and
    // the drawer slides in on a transform: caught mid-animation at x = -0.6 the
    // chevron measures 9.4 and rounds to 9 against the hamburger's 10 — the test
    // failing about one run in three, with a one-pixel diff and nothing wrong.
    await page.waitForFunction(
      () => document.getElementById('screen-sessions').getBoundingClientRect().x === 0,
      null, { timeout: 3000 });
    const chevron = await box('drawer-close');
    assert.deepEqual(chevron, hamburger, 'the way out is not where the way in was');
  });

  test('a tap outside closes it, and a session in it switches', async () => {
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;

    await stand.tapMenu();
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 },
    );
    // Outside the drawer, which is 86% of a 390px screen at most 360.
    await page.mouse.click(380, 400);
    await page.waitForFunction(() => !document.getElementById('screen-sessions').classList.contains('open'));

    await stand.tapMenu();
    await page.click('button.session:has-text("other")');
    await page.waitForFunction(() => !document.getElementById('screen-sessions').classList.contains('open'));
    // The strip follows the switch.
    await page.waitForFunction(() => {
      const active = document.querySelector('#tabs button.active');
      return active && active.textContent === 'other';
    }, null, { timeout: 5000 });
  });

  test('a swipe to the left puts it away, a drag down does not', async () => {
    // The panel closes by sliding off the left edge, so the gesture that sends it
    // there is the one the hand already expects. The list scrolls up and down
    // under the same finger, which is why a mostly-vertical drag has to be left
    // alone — a drawer that closed on a scroll would be unusable.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    const cdp = await page.context().newCDPSession(page);
    const open = () => page.waitForFunction(
      () => document.getElementById('screen-sessions').getBoundingClientRect().x === 0,
      null, { timeout: 3000 });
    const drag = async (dx, dy) => {
      let [x, y] = [250, 420];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 0; i < 8; i++) {
        x += dx / 8;
        y += dy / 8;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };

    await stand.tapMenu();
    await open();
    await drag(0, 160);
    await page.waitForTimeout(400);
    assert.equal(
      await page.evaluate(() => document.getElementById('screen-sessions').classList.contains('open')),
      true, 'scrolling the list closed the drawer');

    await drag(-160, 0);
    await page.waitForFunction(
      () => !document.getElementById('screen-sessions').classList.contains('open'),
      null, { timeout: 3000 });
  });

  test('a swipe to the right over the terminal brings it back', async () => {
    // The mirror of the swipe that puts it away, and it has to share a finger
    // with the terminal's own gesture: ☰ is at the top edge of a phone and the
    // thumb is at the bottom, which is the whole reason for the gesture. The
    // scroll is vertical, so the drawer may only take a swipe that is
    // unmistakably sideways — a downward drag is the terminal's and stays that
    // way.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    const cdp = await page.context().newCDPSession(page);
    const drag = async (dx, dy) => {
      let [x, y] = [100, 300];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 0; i < 8; i++) {
        x += dx / 8;
        y += dy / 8;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };

    await drag(0, 160);
    await page.waitForTimeout(400);
    assert.equal(
      await page.evaluate(() => document.getElementById('screen-sessions').classList.contains('open')),
      false, 'scrolling the terminal opened the drawer');
    // That drag scrolled the pane back into its history; the pane is shared, so
    // leaving it there would be the next test's problem.
    try { stand.tmux(['send-keys', '-t', 'demo', '-X', 'cancel']); } catch (_) { /* no mode */ }

    await drag(160, 0);
    await page.waitForFunction(
      () => document.getElementById('screen-sessions').getBoundingClientRect().x === 0,
      null, { timeout: 3000 });
    await page.click('#drawer-close');
  });

  test('closing the tab you are in steps back to the one you came from', async () => {
    // Reported as the interface sticking: closing the session you were in landed
    // on the drawer with other sessions running, and the spot where its tab had
    // been was no longer anything to tap. The page remembers the order tabs were
    // visited in and goes back one.
    await stand.open();
    const { page } = stand;
    await stand.attach('demo');
    await stand.attach('other');

    await stand.tapMenu();
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 });
    const row = page.locator('#session-list li:has-text("other")');
    await row.locator('button.close').click();
    await row.locator('button.close').click();

    await page.waitForFunction(() => {
      const active = document.querySelector('#tabs button.active');
      return active && active.textContent === 'demo';
    }, null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => document.getElementById('screen-term').hidden), false,
      'the terminal was put away though a session was left to show');
  });

  test('with nothing attached the drawer is where the page starts', async () => {
    const { page } = stand;
    await page.evaluate(() => sessionStorage.removeItem('pt-session'));
    await page.goto(stand.base);
    await page.waitForFunction(() => document.getElementById('screen-sessions').classList.contains('open'));
    const d = await drawer();
    assert.equal(d.termHidden, true, 'an empty terminal is sitting under the drawer');
  });

  test('a pull down inside the settings closes them', async () => {
    // The panel opens upward from the row at the bottom of the drawer, so pulling
    // it back down is the same statement as tapping that row — and on a phone it is
    // the gesture the hand tries first. It must not take the panel's own scrolling
    // away, which is why it only counts from the top of it.
    const { page } = stand;
    await stand.open();
    await stand.attach('demo');
    await stand.openSettings();
    const cdp = await page.context().newCDPSession(page);
    const box = await page.locator('#settings').boundingBox();
    let x = Math.round(box.x + box.width / 2);
    let y = Math.round(box.y + 20);
    await page.evaluate(() => { document.getElementById('settings').scrollTop = 0; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 0; i < 8; i++) {
      y += 12;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await page.waitForFunction(() => document.getElementById('settings').hidden, null, { timeout: 3000 });
    // The drawer itself stays: this closed a panel, not the list.
    assert.equal(
      await page.evaluate(() => document.getElementById('screen-sessions').classList.contains('open')),
      true, 'the pull-down took the drawer with it');
    // And it is an answer, not the collapsing a closing drawer does: the panel
    // stays closed on the next visit.
    assert.equal(await page.evaluate(() => localStorage.getItem('pt-settings-open')), '0');
  });

  test('a pull up anywhere in the drawer opens the settings', async () => {
    // The panel slides up out of the row at the bottom, so a pull up says the
    // same thing as tapping it — and it counted only from that row, which is one
    // target at the very bottom of a tall screen. The gesture is wanted from
    // wherever the thumb is, so the bound is the scroll rather than the place:
    // here the list is two sessions and has nowhere to go, which is the case that
    // reads as "anywhere".
    const { page } = stand;
    await stand.open();
    await stand.attach('demo');
    await stand.openDrawer();
    // From closed, by state: the toggle toggles.
    if (await page.evaluate(() => !document.getElementById('settings').hidden)) {
      await page.click('#settings-toggle');
    }
    await page.waitForFunction(() => document.getElementById('settings').hidden, null, { timeout: 5000 });
    const before = await page.evaluate(() => {
      const b = document.querySelector('#tabs button.active');
      return b ? b.textContent : null;
    });

    // Over the session list, nowhere near the row the panel opens from.
    const cdp = await page.context().newCDPSession(page);
    const box = await page.locator('#session-list').boundingBox();
    const x = Math.round(box.x + box.width / 2);
    let y = Math.round(box.y + 40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 0; i < 8; i++) {
      y -= 12;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await page.waitForSelector('#settings:not([hidden])', { timeout: 5000 });
    // And the click the gesture ends in is not a tap: over the list it lands on a
    // session, and switching session on the way into the settings is the defect
    // this swallow exists for.
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.getElementById('settings').hidden), false,
      'the click at the end of the swipe closed what the swipe opened');
    assert.equal(
      await page.evaluate(() => {
        const b = document.querySelector('#tabs button.active');
        return b ? b.textContent : null;
      }),
      before, 'the pull up switched session on its way into the settings');
    // It is the owner's answer, so it is remembered as one.
    assert.equal(await page.evaluate(() => localStorage.getItem('pt-settings-open')), '1');
  });

  test('the settings panel comes back the way it was left', async () => {
    // Closing the drawer collapses it, and that used to be the same act as
    // answering "closed": whoever keeps the text size and the keyboard mode
    // within reach reopened the panel on every visit.
    const { page } = stand;
    await stand.open();
    await stand.attach('demo');
    await stand.openSettings();
    await page.click('#drawer-close');
    // On the property, not the selector: Playwright's waitForSelector waits for
    // an element to become visible, and this one never will.
    const collapsed = () => page.waitForFunction(
      () => document.getElementById('settings').hidden, null, { timeout: 5000 });
    await collapsed();

    await stand.openDrawer();
    await page.waitForSelector('#settings:not([hidden])');
    assert.equal(await page.evaluate(() => localStorage.getItem('pt-settings-open')), '1',
      'closing the drawer overwrote the answer it was not asked');

    // And a reload is the same question: the preference is the browser's.
    await page.goto(stand.base);
    await stand.openDrawer();
    await page.waitForSelector('#settings:not([hidden])');

    // Closed on purpose stays closed, which is the other half of remembering.
    await page.click('#settings-toggle');
    await collapsed();
    await page.goto(stand.base);
    await stand.openDrawer();
    assert.equal(await page.evaluate(() => document.getElementById('settings').hidden), true);
  });
});

describe("the owner's own session buttons", () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo'] }); });
  after(async () => { await stand.stop(); });

  test('a button added in the settings starts a session with its command', async () => {
    // The four presets are make targets, and a fifth agent used to mean editing a
    // Makefile that on the host this serves is written by ansible. A custom button
    // is the same launcher with the command passed to it.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    await page.fill('#custom-label', 'Квен');
    await page.fill('#custom-cmd', 'qwen --yolo');
    await page.click('#custom-add');
    await page.waitForSelector('#custom-list li:has-text("Квен")');
    // The fields are cleared only on a save that went through, so a refusal
    // leaves what was typed where it can be corrected.
    assert.equal(await page.inputValue('#custom-cmd'), '');

    // It joins the presets under +, in both menus, because they are one list.
    await page.click('#settings-toggle');
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset^="custom:"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });

    // What arrived at the other end is the command the owner typed. The stand's
    // `custom` target echoes it instead of running it — `qwen` is not installed
    // on a runner, and what is being tested is the trip, not the agent.
    const name = (await page.locator('#session-list li').last().locator('.name').textContent()).trim();
    let pane = '';
    for (let i = 0; i < 20 && !pane.includes('ran:'); i++) {
      pane = stand.tmux(['capture-pane', '-p', '-t', name]);
      if (!pane.includes('ran:')) await page.waitForTimeout(200);
    }
    assert.match(pane, /ran: qwen --yolo/, `the command did not reach the session: ${pane}`);
  });

  test('the session it starts does not inherit make\'s own variables', async () => {
    // A variable given on a make command line is exported to the recipe and rides
    // in MAKEFLAGS, so without clearing it the session carries PREFIX, DIR, KIND and
    // CMD — and a `make` typed by hand inside that session inherits them. Measured
    // on the author's host: `make custom CMD=qwen` in such a session came out named
    // after the folder of the session it was run from, and stamped with the button
    // that had started that one.
    //
    // Read off the pane's own process rather than from tmux, because the question is
    // what the shell in there actually has.
    await stand.open();
    const { page } = stand;
    await stand.openDrawer();
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });
    const name = (await page.locator('#session-list li').last().locator('.name').textContent()).trim();

    const pid = stand.tmux(['list-panes', '-t', name, '-F', '#{pane_pid}']).trim().split('\n')[0];
    const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
    for (const v of ['PREFIX', 'DIR', 'KIND', 'CMD', 'MAKEFLAGS', 'MAKELEVEL']) {
      const found = env.find((e) => e.startsWith(`${v}=`));
      assert.equal(found, undefined, `the session inherited ${found} from make`);
    }
  });

  test('a tab carries the mark of the button that started it', async () => {
    // The whole trip, because every link in it is somewhere else: the page sends a
    // preset, the server passes KIND= to make, make stamps a tmux option on the
    // session it names, and the page reads it back with the session list. A break
    // anywhere shows on the phone as a tab with no mark and nothing saying why.
    await stand.open();
    const { page } = stand;
    await stand.openDrawer();
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="claude"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });

    // tmux is where the fact is kept — not a register of the server's that a
    // rename or a restart could put out of step.
    const row = page.locator('#session-list li').last();
    const name = (await row.locator('.name').textContent()).trim();
    assert.equal(
      stand.tmux(['show-options', '-v', '-t', name, '@pockterm-kind']).trim(),
      'claude',
      'the button never reached the session',
    );
    // The drawer names it in the meta line, where the name cannot: the session is
    // named after its folder, so two buttons in one project read alike. Beside it,
    // where the pane actually is and how long it has been up — the line used to
    // carry "1 window", which is what the Makefile always makes and the page can
    // never reach a second of.
    const meta = await row.locator('.meta').textContent();
    assert.match(meta, /Claude/, `the button is missing from the row: ${meta}`);
    assert.doesNotMatch(meta, /window/, `the window count is back: ${meta}`);
    assert.match(meta, /только что|\d+[мчд]/, `no age in the row: ${meta}`);
    // The stand's projects root is the temp dir the presets run in, so a session
    // started there reads as that folder's own name.
    assert.ok(meta.split(' · ').length >= 3, `the row lost a field: ${meta}`);

    // Attach to the other session, so the strip has two tabs and the one under
    // test is not the one being looked at.
    await page.click('#session-list li:has-text("demo") button.session');
    await page.waitForSelector('#screen-term:not([hidden])');

    // The tab carries the "+" menu's own glyph, so the strip needs no legend. The
    // mark lives in a span of its own, never in the label — rewriting the label
    // rebuilds the button, and a WebView answers that by raising the keyboard.
    await page.waitForFunction((n) => {
      const b = [...document.querySelectorAll('#tabs button')].find((x) => x.dataset.session === n);
      // ❄ since the owner asked for it — Claude is cold — and the four defaults are
      // the first row of the grid a custom button picks its mark from.
      return b && b.querySelector('.kind') && b.querySelector('.kind').textContent === '❄️';
    }, name, { timeout: 8000 });

    // A long press asks what the mark means. Through the browser's own touch
    // input, not a synthetic event: what has to be proved is that the press does
    // not switch session as well, and only a real one produces the click that
    // would.
    const tab = page.locator(`#tabs button[data-session="${name}"]`);
    // The strip scrolls sideways and these names are long, so the tab under test
    // can be off the right edge — a touch at its layout position would land on
    // whatever is there instead, and on nothing at all past the viewport.
    await tab.scrollIntoViewIfNeeded();
    const box = await tab.boundingBox();
    const at = [{ x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
    await page.waitForSelector('#kind-help:not([hidden])', { timeout: 3000 });
    assert.match(await page.textContent('#kind-help'), /❄️ Claude/);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => document.querySelector('#tabs button.active')?.dataset.session),
      'demo',
      'asking what a tab is switched to it',
    );
  });

  test('a command that could reach a shell is refused, and says why', async () => {
    // The command becomes CMD= on a make command line and make hands it to a
    // shell. On a phone there is no log to open, so the reason has to be on
    // screen — and what was typed has to stay there to be fixed.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    const before = await page.locator('#custom-list li').count();
    await page.fill('#custom-label', 'Плохо');
    await page.fill('#custom-cmd', 'qwen; rm -rf /');
    await page.click('#custom-add');
    await page.waitForSelector('#custom-note:not([hidden])');
    assert.match(await page.textContent('#custom-note'), /quotes|;|&/);
    assert.equal(await page.locator('#custom-list li').count(), before, 'the refused button was added');
    assert.equal(await page.inputValue('#custom-cmd'), 'qwen; rm -rf /', 'what was typed was thrown away');
  });

  test('a button can be changed, and stays the same button', async () => {
    // Retyping it as a new one would work and cost the id, and the id is what the
    // tabs it opened are marked with: every session it had started would be marked
    // by a button that no longer exists. So the edit keeps it.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    const id = await page.getAttribute('#new-menu button[data-preset^="custom:"]', 'data-preset');

    await page.click('#custom-list li:has-text("Квен") button.rename');
    // The fields carry what is there now — an edit is a correction, not a retype —
    // and the row says which button they are about, since the two are far apart
    // once the keyboard is up.
    assert.equal(await page.inputValue('#custom-label'), 'Квен');
    assert.equal(await page.inputValue('#custom-cmd'), 'qwen --yolo');
    assert.equal(await page.locator('#custom-list li.editing').count(), 1);
    assert.match(await page.textContent('#custom-add'), /Сохранить/);

    const rows = await page.locator('#custom-list li').count();
    await page.fill('#custom-cmd', 'qwen --yolo --verbose');
    await page.click('#custom-add');
    await page.waitForSelector('#custom-list li:has-text("qwen --yolo --verbose")');
    assert.equal(await page.locator('#custom-list li').count(), rows, 'the edit added a second button');
    assert.equal(
      await page.getAttribute('#new-menu button[data-preset^="custom:"]', 'data-preset'), id,
      'the button that was edited is not the button that came back',
    );
    // Nothing is left half-edited: the next tap on Добавить must add, not save.
    assert.equal(await page.locator('#custom-list li.editing').count(), 0);
    assert.match(await page.textContent('#custom-add'), /Добавить/);
    assert.equal(await page.inputValue('#custom-cmd'), '');

    // The same tap that opened the editing closes it, leaving the button alone —
    // there is no room on a phone for a Cancel of its own.
    await page.click('#custom-list li:has-text("Квен") button.rename');
    assert.equal(await page.locator('#custom-list li.editing').count(), 1);
    await page.click('#custom-list li:has-text("Квен") button.rename');
    assert.equal(await page.locator('#custom-list li.editing').count(), 0);
    assert.equal(await page.inputValue('#custom-label'), '');

    // Put the command back: the tests after this one are about the same button.
    await page.click('#custom-list li:has-text("Квен") button.rename');
    await page.fill('#custom-cmd', 'qwen --yolo');
    await page.click('#custom-add');
    await page.waitForSelector('#custom-list li:has-text("qwen --yolo")');
  });

  test('a default can be given a command, and keeps its mark', async () => {
    // The four were a menu written into the page and a map in Go. Editable means
    // they are entries in the same list as the owner's own — so this is the whole
    // chain: the label and the command are the host's, the glyph is the page's, and
    // what actually runs is the Makefile's `custom` target with CMD= now that the
    // button carries a command of its own.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    await page.click('#custom-list li:has-text("Claude (yolo)") button.rename');
    // A default's command field is empty because its id is the make target, and the
    // placeholder is the only place a phone can be told that empty is an answer.
    assert.equal(await page.inputValue('#custom-cmd'), '');
    assert.match(await page.getAttribute('#custom-cmd', 'placeholder'), /make yolo/);

    await page.fill('#custom-label', '⚡ Ярость');
    await page.fill('#custom-cmd', 'echo edited-yolo');
    await page.click('#custom-add');
    await page.waitForSelector('#custom-list li:has-text("Ярость")');

    // Still asked for by its own name — the id is what the tabs it opened carry.
    const b = page.locator('#new-menu button[data-preset="yolo"]');
    assert.equal(await b.count(), 1, 'an edited default stopped being itself');
    // The gap between the mark and the label is a margin on the mark's own cell
    // now, not a space in the text: the cell is what asks for the colour form.
    assert.match(await b.textContent(), /⚡\s?Ярость/);

    // And the command reaches the session: the stand's custom target echoes it.
    await stand.shutDrawer();
    await stand.openDrawer();
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="yolo"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });
    const name = (await page.locator('#session-list li').last().locator('.name').textContent()).trim();
    let pane = '';
    for (let i = 0; i < 20 && !pane.includes('ran:'); i++) {
      pane = stand.tmux(['capture-pane', '-p', '-t', name]);
      if (!pane.includes('ran:')) await page.waitForTimeout(200);
    }
    assert.match(pane, /ran: echo edited-yolo/, `the edited command did not reach the session: ${pane}`);
    // The stamp is still the button's id, so the tab draws ⚡ rather than nothing.
    assert.equal(stand.tmux(['show-options', '-v', '-t', name, '@pockterm-kind']).trim(), 'yolo');
  });

  test('a button can name a make target instead of carrying a command', async () => {
    // A Makefile has targets the four do not cover — the author's own has
    // `cont-yolo` — and reaching one from a phone meant typing `make cont-yolo` as
    // a command. That runs make *inside* the session the button just made: a second
    // session appears beside it and the first one dies. So the same words mean the
    // target now, which is also what the rows already show for the defaults.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    await page.fill('#custom-label', 'Cont yolo');
    await page.fill('#custom-cmd', 'make cont-yolo');
    await page.click('#custom-add');
    await page.waitForSelector('#custom-list li:has-text("Cont yolo")');
    const row = page.locator('#custom-list li:has-text("Cont yolo")');
    assert.match(await row.textContent(), /make cont-yolo/, 'the row does not say what it runs');

    // It starts through that target, with no CMD in sight.
    await stand.shutDrawer();
    await stand.openDrawer();
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset^="custom:"]:has-text("Cont yolo")');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });
    const name = (await page.locator('#session-list li').last().locator('.name').textContent()).trim();
    let pane = '';
    for (let i = 0; i < 20 && !pane.includes('ran:'); i++) {
      pane = stand.tmux(['capture-pane', '-p', '-t', name]);
      if (!pane.includes('ran:')) await page.waitForTimeout(200);
    }
    assert.match(pane, /ran: the cont-yolo target/, `the target did not run: ${pane}`);

    // And editing puts back what was typed, or renaming the button would leave one
    // that runs nothing.
    await stand.openSettings();
    await page.click('#custom-list li:has-text("Cont yolo") button.rename');
    assert.equal(await page.inputValue('#custom-cmd'), 'make cont-yolo');
    await page.click('#custom-list li:has-text("Cont yolo") button.rename');
  });

  test('a mark is picked from a grid, and the tabs it opens carry it', async () => {
    // The way to give a button a glyph was to type an emoji at the front of its
    // label — a trick you had to know, and a character out of a name that has 24.
    // Three custom buttons therefore all drew the same star, which is the row the
    // owner was looking at when he asked for a grid.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    await page.click('#custom-mark');
    await page.waitForSelector('#mark-grid:not([hidden])');
    await page.click('#mark-grid button:has-text("🚀")');
    // The picker closes on the pick and shows it, so the form says what will be
    // saved before anything is.
    assert.equal(await page.evaluate(() => document.getElementById('mark-grid').hidden), true);
    assert.match(await page.textContent('#custom-mark'), /🚀/);

    await page.fill('#custom-label', 'Ракета');
    await page.fill('#custom-cmd', 'qwen');
    await page.click('#custom-add');
    await page.waitForSelector('#custom-list li:has-text("Ракета")');
    assert.match(await page.textContent('#custom-list li:has-text("Ракета")'), /🚀/);
    assert.match(await page.textContent('#new-menu button[data-preset^="custom:"]:has-text("Ракета")'), /🚀/);

    // And the tab the button opens carries the same glyph: one vocabulary for the
    // menu, the strip and the drawer.
    await stand.shutDrawer();
    await stand.openDrawer();
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset^="custom:"]:has-text("Ракета")');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });
    const name = (await page.locator('#session-list li').last().locator('.name').textContent()).trim();
    await page.waitForFunction(
      (n) => [...document.querySelectorAll('#tabs button')].some(
        (b) => b.dataset.session === n && (b.textContent || '').includes('🚀')),
      name, { timeout: 8000 });

    // Every surface draws it in a cell of its own, and that cell asks for the
    // colour form. The page's font stack is the system UI font, which has a text
    // glyph for ❄ and ☀ — so the mark came out the colour of the label beside it,
    // reported as the icons being colourless on the tabs and in the menu while the
    // drawer's heavier rows happened to reach the colour font.
    const cells = await page.evaluate((n) => {
      const row = [...document.querySelectorAll('#custom-list li')]
        .find((li) => (li.textContent || '').includes('Ракета'));
      const where = {
        list: row && row.querySelector('.name .kind'),
        menu: ([...document.querySelectorAll('#new-menu button[data-preset^="custom:"]')]
          .find((b) => (b.textContent || '').includes('Ракета')) || {}).querySelector?.('.kind'),
        tab: document.querySelector(`#tabs button[data-session="${n}"] .kind`),
      };
      const out = {};
      for (const [what, el] of Object.entries(where)) {
        out[what] = el ? { text: el.textContent, font: getComputedStyle(el).fontFamily } : null;
      }
      return out;
    }, name);
    for (const [what, cell] of Object.entries(cells)) {
      assert.ok(cell, `${what} draws the mark outside a cell of its own`);
      assert.match(cell.text, /🚀/, `${what} has no mark in its cell: ${cell.text}`);
      assert.match(cell.font, /Noto Color Emoji/,
        `${what} does not ask for the colour form: ${cell.font}`);
    }

    // Editing loads the mark back, and the same glyph again clears it — one tap in,
    // one tap out, rather than a button of its own for "no mark".
    await stand.openSettings();
    await page.click('#custom-list li:has-text("Ракета") button.rename');
    assert.match(await page.textContent('#custom-mark'), /🚀/);
    await page.click('#custom-mark');
    await page.click('#mark-grid button:has-text("🚀")');
    assert.match(await page.textContent('#custom-mark'), /⭐/);
    await page.click('#custom-add');
    // Waited for properly: `li:has-text(…)` is Playwright's own selector engine
    // and not CSS, so inside the browser it threw — the wait rejected at once,
    // the catch swallowed it, and the assertion raced the save. It passed while
    // the box was idle and failed twice in a row once it was busy.
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('#custom-list li')]
        .find((e) => (e.textContent || '').includes('Ракета'));
      return row && !(row.textContent || '').includes('🚀');
    }, null, { timeout: 15000 });
    assert.match(await page.textContent('#custom-list li:has-text("Ракета")'), /⭐/);
  });

  test('the grid opens under the button that opens it', async () => {
    // Reported from the phone: it was drawn at the end of the panel, a screen away
    // from the 44px button it belongs to — and that button had been styled as a
    // full-width bar by `#buttons-box .add button`, which an id selector loses to.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    await page.click('#custom-mark');
    await page.waitForSelector('#mark-grid:not([hidden])');
    // Both measured with the grid open: opening it scrolls the panel, so a box taken
    // before the tap describes a layout that has since moved.
    const markBox = await page.locator('#custom-mark').boundingBox();
    const gridBox = await page.locator('#mark-grid').boundingBox();
    assert.ok(markBox.width < 120, `the mark button is a bar, not a button: ${markBox.width}px`);
    assert.ok(gridBox.y >= markBox.y, 'the grid is above the button that opens it');
    assert.ok(gridBox.y - (markBox.y + markBox.height) < 120,
      `the grid is ${Math.round(gridBox.y - markBox.y - markBox.height)}px away from its button`);
    await page.click('#custom-mark');

    // And the mark shares its line with the name, which is the pair a button is
    // named by. Every input in this form takes a line of its own, and that basis
    // wrapped the name to the next row — leaving the mark above it, a control
    // belonging to nothing on screen.
    // Both taken with the grid closed, for the same reason the pair above was taken
    // with it open: closing it moves everything under it.
    await page.waitForFunction(() => document.getElementById('mark-grid').hidden);
    const barBox = await page.locator('#custom-mark').boundingBox();
    const nameBox = await page.locator('#custom-label').boundingBox();
    assert.ok(nameBox.x > barBox.x + barBox.width - 2,
      `the name is not to the right of the mark: ${JSON.stringify({ barBox, nameBox })}`);
    const share = Math.min(nameBox.y + nameBox.height, barBox.y + barBox.height)
      - Math.max(nameBox.y, barBox.y);
    assert.ok(share > nameBox.height / 2,
      `the mark and the name are not on one line: they share ${Math.round(share)}px`);
    assert.equal(await page.getAttribute('#custom-label', 'placeholder'), 'название');
  });

  test('the form shows the glyph the button will be drawn with', async () => {
    // Reported from the phone: "сейчас там звезда всегда". Nothing picked is the
    // common case — every button of the owner's had no mark of its own — and a ⭐ on
    // the form while the row above shows ❄️ describes the form's own state instead
    // of what is being edited.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    await page.click('#custom-list li:has-text("Claude") >> nth=0 >> button.rename');
    assert.match(await page.textContent('#custom-mark'), /❄️/, 'the form does not show the default\'s glyph');
    await page.click('#custom-list li:has-text("Claude") >> nth=0 >> button.rename');

    // And it follows the label as it is typed, because that is one of the things the
    // glyph is read from.
    await page.fill('#custom-label', 'Codex что-то');
    assert.match(await page.textContent('#custom-mark'), /☀️/);
    await page.fill('#custom-label', 'Ничего знакомого');
    assert.match(await page.textContent('#custom-mark'), /⭐/);
    await page.fill('#custom-label', '');
  });

  test('a default keeps the glyph its button has, and Claude is cold', async () => {
    // The owner's own vocabulary: Claude is cold, Codex is sol. It applies to a
    // button with no mark of its own, so one tap in the grid overrules it — and the
    // four defaults have their own glyphs, which the grid's first row is made of.
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    assert.match(await page.textContent('#custom-list li:has-text("Claude") >> nth=0'), /❄️/);
    await page.fill('#custom-label', 'Codex-cont');
    await page.fill('#custom-cmd', 'codex resume');
    await page.click('#custom-add');
    await page.waitForSelector('#custom-list li:has-text("Codex-cont")');
    assert.match(await page.textContent('#custom-list li:has-text("Codex-cont")'), /☀️/);
  });

  test('a default can be removed, and the reset brings it back alone', async () => {
    await stand.open();
    const { page } = stand;
    await stand.openSettings();
    const del = page.locator('#custom-list li:has-text("Shell") button.close');
    await del.click();
    await del.click();
    await page.waitForFunction(
      () => !document.querySelector('#new-menu button[data-preset="shell"]'), null, { timeout: 5000 });
    // Removed means removed: the server refuses to start it, or hiding a button
    // would have been all this did.
    const refused = await page.evaluate(async () => {
      const res = await fetch(`/api/sessions/new${location.search ? location.search : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: 'shell' }),
      });
      return { status: res.status, body: (await res.text()).trim() };
    });
    assert.equal(refused.status, 400, `a removed button still started a session: ${JSON.stringify(refused)}`);

    // The reset restores the four and leaves the owner's own where they are —
    // `qwen` typed on a phone is not a default, and losing it to a mistap would be
    // worse than the mess being cleaned up. Two taps, like every removal here.
    await page.click('#custom-reset');
    assert.match(await page.textContent('#custom-reset'), /Сбросить\?/);
    await page.click('#custom-reset');
    await page.waitForSelector('#custom-list li:has-text("Shell")');
    assert.equal(await page.locator('#new-menu button[data-preset="shell"]').count(), 1);
    // The edit from the previous test is undone too: a default is stock again.
    await page.waitForSelector('#custom-list li:has-text("Claude (yolo)")');
    assert.equal(await page.locator('#custom-list li:has-text("Ярость")').count(), 0);
  });

  test('the buttons are the host\'s, so a reload finds them', async () => {
    // Not localStorage: what they start happens on the host, a second phone must
    // find the same buttons, and CI restarts the binary several times a day.
    const { page } = stand;
    await page.goto(stand.base);
    await page.waitForFunction(() => {
      const term = document.getElementById('screen-term');
      const drawer = document.getElementById('screen-sessions');
      return !term.hidden || drawer.classList.contains('open');
    }, null, { timeout: 10000 });
    await stand.openSettings();
    await page.waitForSelector('#custom-list li:has-text("Квен")');
    // Its entry under +, by the button rather than by the count: the owner's own
    // buttons are however many were added by the tests before this one.
    assert.equal(await page.locator('#new-menu button[data-preset^="custom:"]:has-text("Квен")').count(), 1);

    // Removing takes two taps, the same as closing a session: one tap was enough
    // for a while, and a stray touch took a button away with nothing asked. The
    // first tap only arms.
    const del = page.locator('#custom-list li:has-text("Квен") button.close');
    const rows = await page.locator('#custom-list li').count();
    await del.click();
    assert.equal(await page.locator('#custom-list li').count(), rows, 'the first tap removed it');
    assert.match(await del.textContent(), /\?/, 'the armed button does not say it is armed');
    assert.ok(await del.evaluate((b) => b.classList.contains('armed')));

    // And the second one takes it out of the menu as well, because it is one list.
    // Only that one: removing a button of the owner's own is not a reset, and the
    // defaults are not touched either.
    await del.click();
    await page.waitForFunction(
      (n) => document.querySelectorAll('#custom-list li').length === n - 1, rows, { timeout: 5000 });
    assert.equal(await page.locator('#new-menu button[data-preset^="custom:"]:has-text("Квен")').count(), 0);
    assert.equal(await page.locator('#new-menu button[data-preset="claude"]').count(), 1);
  });
});

// Its own stand with one session, because that is the whole case: the modal
// drawer is what is left when nothing is running, and with anything else alive
// the page steps back to a tab instead.
describe('closing the last session there is', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['only'] }); });
  after(async () => { await stand.stop(); });

  test('closing the session you are in does not leave a black page', async () => {
    // Reported as the window hanging empty after closing the very session being
    // used. With nothing attached the terminal screen is hidden and ☰ lives in
    // its header, so a drawer that could still be dismissed left a black page
    // with nothing to tap and no way back but a reload.
    await stand.open();
    const { page } = stand;
    await stand.attach('only');
    await stand.tapMenu();
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 });

    const row = page.locator('#session-list li:has-text("only")');
    await row.locator('button.close').click();
    await row.locator('button.close').click();
    await page.waitForFunction(() => document.getElementById('screen-term').hidden, null, { timeout: 8000 });

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

    // Starting one brings the way out back.
    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');
    await page.waitForFunction(
      () => document.querySelectorAll('#session-list li').length > 0, null, { timeout: 8000 });
    const name = (await page.locator('#session-list li').last().locator('.name').textContent()).trim();
    await page.click(`button.session:has-text("${name}")`);
    await page.waitForSelector('#screen-term:not([hidden])');
    await stand.tapMenu();
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 3000 });
    assert.equal(await page.locator('#drawer-close').isVisible(), true, 'no way back with a session behind it');
    await page.click('#drawer-close');
    await page.waitForFunction(() => !document.getElementById('screen-sessions').classList.contains('open'));
  });
});

describe('selection and the clipboard', () => {
  let stand;
  before(async () => { stand = await startStand(); });
  after(async () => { await stand.stop(); });

  test('the frozen copy holds more than the screen, and scrolls through it', async () => {
    // Reported from the phone as the copy window not scrolling, which is exactly
    // what it did: the frozen copy was the visible screen and nothing else, so it
    // was as tall as its own box — measured on the stand, `scrollHeight` equal to
    // `clientHeight` — and the mode could only ever copy what was already in front
    // of you. It holds what this page has drawn now, ending at the screen it was
    // entered from.
    await stand.open();
    await stand.attach();
    const { page } = stand;

    await page.click('#term');
    for (let i = 1; i <= 80; i++) await page.keyboard.type(`line ${i} of the output\n`);
    await page.waitForFunction(
      () => document.querySelector('.xterm-rows')?.textContent?.includes('line 80 of the output'));
    // The first lines are off the top of the screen, which is the whole point:
    // they are what the old copy window could not reach.
    assert.equal(
      await page.evaluate(() => document.querySelector('.xterm-rows').textContent.includes('line 2 of the output')),
      false, 'the screen still holds the early lines, so this proves nothing');

    await page.click('#select');
    await page.waitForSelector('#snapshot:not([hidden])');
    // The screen is frozen at once and the history behind it arrives a round trip
    // later — the mode opening only after that would read as a button that does
    // nothing. So the wait is for the answer, not for the mode.
    await page.waitForFunction(() => {
      const s = document.getElementById('snapshot');
      return s.scrollHeight > s.clientHeight;
    }, null, { timeout: 5000 });
    const pre = await page.evaluate(() => {
      const s = document.getElementById('snapshot');
      return {
        over: s.scrollHeight > s.clientHeight,
        atEnd: s.scrollHeight - s.clientHeight - s.scrollTop < 2,
        early: s.textContent.includes('line 2 of the output'),
        last: s.textContent.includes('line 80 of the output'),
      };
    });
    assert.equal(pre.over, true, 'the copy window is still exactly as tall as its own box');
    assert.equal(pre.early, true, 'what scrolled off the screen is not in the copy');
    assert.equal(pre.last, true, 'the screen it was entered from is not in the copy');
    // Opened at the end, where the mode was entered from: what is wanted is
    // usually in front of you, and everything before it is a drag away.
    assert.equal(pre.atEnd, true, 'the copy window opened somewhere in the middle of the history');

    // And nothing floats over it: both would take drags from the one gesture this
    // mode has — the stack in the corner, the rail down the right edge.
    assert.equal(await page.locator('#pager').isHidden(), true, 'the pager stayed over the frozen copy');
    assert.equal(await page.locator('#scrollbar').isHidden(), true, 'the rail stayed over the frozen copy');
    await page.click('#sel-done');
    await page.waitForSelector('#snapshot', { state: 'hidden' });
  });

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
  // Chromium has no IME to reproduce that with. What is checked here is that the
  // plain path is sound — if typing duplicated text, the keyboard would not be
  // the only suspect.
  //
  // The bar's own backspace was the other half of this and is gone: the
  // on-screen keyboard has one of its own, and the key went to the Ctrl latch,
  // which no on-screen keyboard offers. What that latch puts on the wire is
  // test/ui/bytes.test.mjs.
  const line = () => document.querySelector('.xterm-rows')?.textContent || '';

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

    await stand.tapMenu();
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

  test('the bar is laid out as asked: cross in the middle, pairs in columns', async () => {
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
    const unfold = await at('[data-key="ctrl-o"]');
    const ctrl = await at('[data-mod="ctrl"]');
    const altEnter = await at('[data-key="alt-enter"]');
    const enter = await at('[data-key="enter"]');
    // Prompt mode has its own Accept; this is about the key bar's.
    const accept = await at('#keybar [data-macro="accept"]');
    const hide = await at('#hide');

    const sameColumn = (a, b, what) => {
      assert.ok(Math.abs(a.x - b.x) < 2, `${what} are not in one column`);
      assert.ok(a.y < b.y, `${what} are in the wrong order`);
    };

    // Escape holds the top-left corner, ^O sits under it, ^C beside it.
    assert.ok(esc.x < stop.x && esc.y < unfold.y, 'escape is not the top-left key');
    sameColumn(esc, unfold, 'escape and ^O');
    assert.ok(Math.abs(esc.y - stop.y) < 2, '^C is not beside escape');

    // The arrows keep their cross, a column to the right of those two.
    sameColumn(up, down, 'up and down');
    assert.ok(left.x < down.x, 'left is not to the left of down');
    assert.ok(right.x > down.x, 'right is not to the right of down');
    assert.ok(stop.x < up.x && unfold.x < left.x, 'the arrows are not right of Esc and ^C');

    // The pairs, each asked for by name: Ctrl over the arrow that ends the
    // cross — it took the backspace's place, the keyboard having one of its own
    // and no ^R at all — the two enters, and accept over the hide toggle.
    sameColumn(ctrl, right, 'Ctrl and the right arrow');
    sameColumn(altEnter, enter, 'alt+enter and enter');
    sameColumn(accept, hide, 'accept and hide');

    // The forward delete gave its key to ^O, and the backspace gave its own to
    // Ctrl: neither is a key this bar carries any more.
    assert.equal(await page.locator('#keybar [data-key="delete"]').count(), 0);
    assert.equal(await page.locator('#keybar [data-key="backspace"]').count(), 0);
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
    // A finger on the pane, because the stack fades a few seconds after the last
    // scrolling and this test scrolled nothing — it puts the button up by hand.
    await page.click('#term');
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

describe('what the composer remembers', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['one'] }); });
  after(async () => { await stand.stop(); });

  // Open on the composer rather than the key bar: inside the app it is the
  // default, and this whole block is about that field.
  const openComposer = async () => {
    await stand.page.addInitScript(() => { window.PockNative = { copy: () => true }; });
    // Keep hold of the sockets the page opens: taking one away is the only way
    // from out here to put the page in the state this block is about. Offline
    // emulation does not do it — loopback traffic is not what it governs.
    await stand.page.addInitScript(() => {
      window.__sockets = [];
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args) {
          const s = new target(...args);
          window.__sockets.push(s);
          return s;
        },
      });
    });
    await stand.open();
    await stand.attach('one');
    await stand.page.waitForSelector('#composer:not([hidden])');
  };

  test('a message that could not be sent stays in the field', async () => {
    // Reported from the phone: the send does not go through and the text is
    // gone. `send()` dropped whatever it was given while the socket was not
    // open — right for a keystroke, which has nowhere to go — and the composer
    // cleared the field in the same tick, on the assumption that it had.
    await openComposer();
    const { page } = stand;
    assert.equal(await page.locator('#history').isVisible(), false,
      'nothing has been sent from this install yet');
    await page.fill('#prompt', 'сообщение в никуда');
    // The socket is taken away and the form submitted in the same task. Both
    // halves matter: `close()` leaves OPEN synchronously, so the state the
    // handler reads is certain, and the page starts reconnecting on a timer of
    // its own — anything slower than this would be racing its recovery.
    await page.evaluate(() => {
      window.__sockets[window.__sockets.length - 1].close();
      document.getElementById('composer').requestSubmit();
    });
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('#prompt'), 'сообщение в никуда',
      'the text was thrown away with the send');
    assert.match(await page.textContent('#toast'), /not sent/,
      'nothing said that it had not gone');
    // Nothing went out, so there is nothing to remember: the history is what
    // was sent, and the field is where what was not sent stays.
    assert.equal(await page.locator('#history').isVisible(), false);
  });

  test('what was sent can be found again, and a draft outlives a reload', async () => {
    await openComposer();
    const { page } = stand;
    // Still nothing offered: the send that failed above is in the field, not in
    // the history — what is remembered here is what went out.
    assert.equal(await page.locator('#history').isVisible(), false);

    await page.fill('#prompt', 'первое сообщение');
    await page.click('#send');
    await page.waitForFunction(() => document.getElementById('prompt').value === '',
      null, { timeout: 5000 });
    assert.equal(await page.locator('#history').isVisible(), true,
      'nothing offers what was sent before');

    await page.click('#history');
    await page.waitForSelector('#history-list:not([hidden])');
    assert.equal(await page.locator('#history-list button').count(), 1);
    await page.click('#history-list button');
    assert.equal(await page.inputValue('#prompt'), 'первое сообщение',
      'the recalled message did not land in the field');
    // Into the field and not down the socket: it is usually recalled because
    // something went wrong with it the first time.
    assert.equal(await page.locator('#history-list').isVisible(), false);

    // And what is half-written survives the reload the page itself asks for
    // after a deploy.
    await page.fill('#prompt', 'недописанное');
    await page.waitForTimeout(500); // the draft is written on a short timer
    await stand.open();
    await stand.attach('one');
    await page.waitForSelector('#composer:not([hidden])');
    assert.equal(await page.inputValue('#prompt'), 'недописанное',
      'the draft did not survive the reload');
    // The history outlives it too — it is the same storage and the same install.
    assert.equal(await page.locator('#history').isVisible(), true);
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

describe('the folders of the projects root', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo'], projects: ['alpha', 'beta'] }); });
  after(async () => { await stand.stop(); });

  test('the drawer lists the folders, and nothing that is not one', async () => {
    await stand.open();
    const { page } = stand;
    await page.click('#folders');
    await page.waitForSelector('#folder-list:not([hidden]) button.folder');
    const names = await page.locator('#folder-list button.folder .name').allTextContents();
    // The root comes first and by its own name: a session in the projects root
    // is ordinary, and "the root" as a label hides which directory that is.
    assert.match(names[0], /^pockterm-ui-/, `first row is ${JSON.stringify(names[0])}`);
    assert.ok(names.includes('alpha') && names.includes('beta'), names.join(','));
    // A dotted directory is not a project, and the list is one to tap.
    assert.ok(!names.includes('.git'), 'a dotted directory is offered as a project');
    // One list at a time: two scrolling lists leave neither room for a thumb.
    assert.equal(await page.locator('#session-list').isHidden(), true);
  });

  test('a folder starts a session there, named after it', async () => {
    await stand.open();
    const { page } = stand;
    await page.click('#folders');
    await page.click('#folder-list button.folder:has-text("alpha")');
    // Tapping a folder does not start anything by itself — which preset is still
    // an open question, and the answer is the menu that was always there.
    await page.waitForSelector('#new-menu:not([hidden])');
    assert.match(await page.locator('#new-where').textContent(), /alpha/,
      'the presets do not say where they will start');
    await page.click('#new-menu button[data-preset="shell"]');

    // The list is what was asked for, so the drawer goes back to it.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('#session-list .name')).some((e) => e.textContent === 'alpha'),
      null, { timeout: 8000 });
    // And tmux agrees about where it opened: the page can show a name without
    // the session being anywhere near that directory.
    // list-panes rather than display-message: with no client attached the
    // latter has no target to render a format against and answers with nothing,
    // which would read here as "the session is in the wrong place".
    const where = stand.tmux(['list-panes', '-t', '=alpha', '-F', '#{pane_current_path}']).trim();
    assert.match(where, /\/alpha$/, `the session opened in ${where}`);
  });

  test('the second session in a folder is numbered, not refused', async () => {
    await stand.open();
    const { page } = stand;
    for (const _ of [1, 2]) {
      await page.click('#folders');
      await page.click('#folder-list button.folder:has-text("beta")');
      await page.click('#new-menu button[data-preset="shell"]');
      await page.waitForTimeout(1200);
    }
    const names = await page.locator('#session-list .name').allTextContents();
    assert.ok(names.includes('beta'), names.join(','));
    assert.ok(names.some((n) => /^beta-\d+$/.test(n)), `no numbered second session in ${names.join(',')}`);
  });

  test('the plain + still means the root', async () => {
    await stand.open();
    const { page } = stand;
    // Opening the folder view and leaving it must not leave the + pointing at a
    // folder: the caption is the only thing that would have said so.
    await page.click('#folders');
    await page.click('#folder-list button.folder:has-text("alpha")');
    await page.click('#new');
    assert.equal(await page.locator('#new-where').isHidden(), true,
      'the + still claims a folder');
  });
});

describe('a tab says what its session is doing', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo'] }); });
  after(async () => { await stand.stop(); });

  test('the attached tab is framed, not filled', async () => {
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    const style = await page.evaluate(() => {
      const b = document.querySelector('#tabs button.active');
      const s = getComputedStyle(b);
      return { border: s.borderTopColor, background: s.backgroundColor };
    });
    // The fill is spoken for — it says what the session is doing — so being here
    // is a frame. A filled tab would have left the session you are in as the one
    // that cannot tell you whether its agent is still running.
    assert.notEqual(style.border, 'rgba(0, 0, 0, 0)', 'the attached tab has no frame');
    // The accent is the frame's colour now, not the fill's.
    assert.ok(!/^rgb\(122, 162, 247\)/.test(style.background),
      `the attached tab is still filled with the accent: ${style.background}`);
  });

  test('purple while output arrives, green once it has gone quiet', async () => {
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    // The stand's session runs `cat`, so a keystroke comes back as output and the
    // pane changes — which is exactly what the watcher reads.
    // Plain "demo", not "=demo": the exact-match prefix is for session targets
    // and send-keys wants a pane — tmux answers "can't find pane: =demo".
    //
    // Printed until the strip agrees, not once: the watcher's first reading of a
    // pane is deliberately not activity — it is whatever was already on screen —
    // so a single line typed before it has looked is invisible, and nothing else
    // moves a pane running `cat`. One line, one tick, and the race is decided by
    // whichever went first; this settles it by outlasting the tick.
    const typing = setInterval(() => {
      try { stand.tmux(['send-keys', '-t', 'demo', 'working now', 'Enter']); } catch (_) {}
    }, 700);
    try {
      await page.waitForFunction(
        () => !!document.querySelector('#tabs button.working'), null, { timeout: 20000 });
    } finally {
      clearInterval(typing);
    }
    // POCKTERM_IDLE is 2s in the stand, and the watcher reads the pane every 2s.
    await page.waitForFunction(
      () => !!document.querySelector('#tabs button.done'), null, { timeout: 20000 });
    // Both states at once would be a tab claiming two things; the classes are
    // exclusive because the state is one value, not two flags.
    assert.equal(await page.locator('#tabs button.working.done').count(), 0);
  });

  test('a waiting agent turns its tab blue, with the mark over its top edge', async () => {
    // The state the answer buttons are drawn from, said on the strip as well: the
    // buttons only exist for the session you are looking at, and the question you
    // want to know about is usually in the one you are not.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    // A menu, through the pane rather than into the page: this is the watcher's
    // reading of a real screen, which is where the state comes from.
    stand.tmux(['send-keys', '-t', 'demo', 'Apply this change?', 'Enter']);
    stand.tmux(['send-keys', '-t', 'demo', '❯ 1. Yes', 'Enter']);
    stand.tmux(['send-keys', '-t', 'demo', '  2. No', 'Enter']);
    await page.waitForFunction(
      () => !!document.querySelector('#tabs button[data-session="demo"].asking'),
      null, { timeout: 20000 });

    const mark = await page.evaluate(() => {
      const b = document.querySelector('#tabs button.asking');
      const s = getComputedStyle(b, '::before');
      const t = getComputedStyle(b);
      return {
        content: s.content,
        colour: s.color,
        position: s.position,
        duration: t.animationDuration,
        direction: t.animationDirection,
        blue: t.backgroundImage.includes('59, 125, 255'),
      };
    });
    assert.ok(/!/.test(mark.content), `no mark on the tab: ${mark.content}`);
    assert.equal(mark.colour, 'rgb(255, 210, 63)', `the mark is ${mark.colour}`);
    assert.equal(mark.position, 'absolute', 'the mark is in the text flow, not over the edge');
    assert.ok(mark.blue, 'the tab is not blue while an answer is wanted');
    // The same sweep as working: same speed, same phase mechanism.
    assert.equal(mark.duration, '4.2s');
    assert.equal(mark.direction, 'alternate');

    // The strip clips both axes because it scrolls sideways, so the mark's upper
    // half lives in padding of the strip's own — without it the mark is cut off.
    const room = await page.evaluate(() => {
      const strip = document.getElementById('tabs');
      const b = strip.querySelector('button');
      return {
        pad: parseFloat(getComputedStyle(strip).paddingTop),
        gap: b.getBoundingClientRect().top - strip.getBoundingClientRect().top,
      };
    });
    assert.ok(room.pad >= 6 && room.gap >= 6, `no room over the tabs: ${JSON.stringify(room)}`);
  });

  test('a badge says what is still running while the session is quiet', async () => {
    // The colour goes green the moment the agent stops speaking, and the shells
    // and monitors it left behind do not stop with it. The watcher reads their
    // count off the agent's own footer; the stand's session runs `cat`, so
    // sending that footer through it puts the real thing on the pane.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    stand.tmux(['send-keys', '-t', 'demo', 'bypass permissions on · 1 shell, 2 monitors ·', 'Enter']);
    // Two plates, and their counts are the footer's two numbers rather than the
    // sum of them: "3" said that something was running and not what.
    await page.waitForFunction(
      () => {
        const box = document.querySelector('#tabs button[data-session="demo"] .bg');
        return box?.dataset.sh === '1' && box?.dataset.mon === '2';
      },
      null, { timeout: 20000 });

    // In the tab's own corner, not spliced into the name: the row scrolls
    // sideways and the names are what is read along it. And in two colours, so
    // which kind is which survives a glance at 9px.
    const plates = await page.evaluate(() => {
      const b = document.querySelector('#tabs button[data-session="demo"]');
      const box = b.querySelector('.bg');
      const of = (which) => {
        const s = getComputedStyle(box, which);
        return { content: s.content, background: s.backgroundColor, clip: s.clipPath };
      };
      const s = getComputedStyle(box);
      const bg = box.getBoundingClientRect();
      const tab = b.getBoundingClientRect();
      return {
        position: s.position,
        offText: Math.abs(bg.right - (tab.right - parseFloat(getComputedStyle(b).paddingRight))),
        below: bg.bottom - tab.bottom,
        height: bg.height,
        shell: of('::before'),
        monitor: of('::after'),
      };
    });
    assert.equal(plates.position, 'absolute', 'the badges are in the text flow');
    // Flush with the right edge of the name — the tab's own content box — and
    // hanging half of themselves under the bottom border. Not in the corner
    // itself: a plate there either ate the width the name is read in or hung
    // over the tab beside it.
    assert.ok(plates.offText <= 1.5,
      `the badges do not end where the name does: ${JSON.stringify(plates)}`);
    assert.ok(plates.below >= plates.height * 0.4 && plates.below <= plates.height * 0.6,
      `the badges do not hang half under the edge: ${JSON.stringify(plates)}`);
    // Each says its own count and nothing else: at this size a glyph in front of
    // the number was the smudge the single plate used to be defended with.
    assert.match(plates.shell.content, /^"?1"?$/, `the shell plate says ${plates.shell.content}`);
    assert.match(plates.monitor.content, /^"?2"?$/, `the monitor plate says ${plates.monitor.content}`);
    // So which kind is which is the shape and the colour, and both have to differ.
    assert.notEqual(plates.shell.clip, plates.monitor.clip,
      'both kinds are drawn in the same shape');
    assert.equal(plates.monitor.background, 'rgb(127, 220, 164)',
      `the monitor plate is ${plates.monitor.background}`);
    assert.notEqual(plates.monitor.background, plates.shell.background,
      'both kinds are drawn in the same colour');
    // Shields, and the point at the bottom is what makes them ones.
    assert.ok(/^polygon\(/.test(plates.shell.clip), `not a shield: ${plates.shell.clip}`);
    assert.ok(/^polygon\(/.test(plates.monitor.clip), `not a shield: ${plates.monitor.clip}`);

    // The subagents are the other edge of the same tab: one head each, no number,
    // and the agent's own list is what they are counted from. Two facts about a
    // session, two edges — what it left running below, who is running for it
    // above.
    stand.tmux(['send-keys', '-t', 'demo', '● main', 'Enter']);
    stand.tmux(['send-keys', '-t', 'demo', '◯ general-purpose  Разбор  14s', 'Enter']);
    await page.waitForFunction(
      () => (document.querySelector('#tabs button[data-session="demo"] .agents')?.textContent || '').length > 0,
      null, { timeout: 20000 });
    const heads = await page.evaluate(() => {
      const b = document.querySelector('#tabs button[data-session="demo"]');
      const el = b.querySelector('.agents');
      const r = el.getBoundingClientRect();
      const tab = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        text: el.textContent,
        font: getComputedStyle(el).fontFamily,
        above: tab.top - r.top,
        height: r.height,
        offText: Math.abs(r.right - (tab.right - parseFloat(cs.paddingRight))),
        plates: b.querySelector('.bg').dataset.mon,
      };
    });
    // The pane echoes every line twice, so the block lists the agent twice —
    // which is the point of counting rather than parsing: two lines, two heads.
    // Counted in code points: a head is a surrogate pair, and `/^🤖+$/` without
    // the u flag repeats half of one.
    const drawn = [...heads.text];
    assert.ok(drawn.length > 0 && drawn.every((c) => c === '🤖'),
      `the heads are ${JSON.stringify(heads.text)}`);
    assert.equal(drawn.length, 2, `one head per listed agent: ${heads.text}`);
    assert.match(heads.font, /Noto Color Emoji/, `the head is drawn in ${heads.font}`);
    // Hung on the top edge the way the plates hang on the bottom one, and ending
    // where the name ends, so the tab has one right margin rather than two.
    assert.ok(heads.above > 2 && heads.above < heads.height, `not on the edge: ${JSON.stringify(heads)}`);
    assert.ok(heads.offText <= 1.5, `not aligned with the name: ${JSON.stringify(heads)}`);
    // And the block does not cost the plates their line: it sits below the one
    // that says what is running, and counting it against the footer's window is
    // what made them disappear.
    assert.equal(heads.plates, '2', 'the agents block pushed the plates out of the footer');

    // And it goes away when the bottom of the pane stops claiming it: a badge
    // that only ever appeared would say "something is running" about every
    // session that was ever busy.
    //
    // Two lines, not one, and the reason is the stand rather than the page: a
    // real TUI redraws its footer over itself, while `cat` on an echoing pty
    // leaves a transcript — every line appears twice, once from the terminal's
    // echo and once from cat. So the claim is pushed out of the pane's last few
    // lines here instead of being overwritten.
    stand.tmux(['send-keys', '-t', 'demo', 'bypass permissions on', 'Enter']);
    stand.tmux(['send-keys', '-t', 'demo', 'bypass permissions on', 'Enter']);
    await page.waitForFunction(
      () => !document.querySelector('#tabs button[data-session="demo"]')?.dataset.bg,
      null, { timeout: 20000 });
  });

  test('the drawer says it too, in the same colours as the strip', async () => {
    // The drawer is what you open to see what else is running, and it was the one
    // surface that could not say what any of it was doing: the state was on the
    // tabs only. Same three colours, same keyframes, same phase mechanism —
    // a row and a tab describing one session differently is worse than either of
    // them saying nothing.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    const typing = setInterval(() => {
      try { stand.tmux(['send-keys', '-t', 'demo', 'still going', 'Enter']); } catch (_) {}
    }, 700);
    try {
      await stand.openDrawer();
      // The row is painted by the same poll as the strip, so it goes on answering
      // while the drawer is open rather than being a snapshot of when it opened.
      await page.waitForFunction(
        () => !!document.querySelector('#session-list button.session[data-session="demo"].working'),
        null, { timeout: 20000 });
    } finally {
      clearInterval(typing);
    }
    const both = await page.evaluate(() => {
      const row = document.querySelector('#session-list button.session[data-session="demo"]');
      const tab = document.querySelector('#tabs button[data-session="demo"]');
      const of = (el) => {
        const s = getComputedStyle(el);
        return {
          duration: s.animationDuration,
          direction: s.animationDirection,
          delay: s.animationDelay,
          purple: s.backgroundImage.includes('125, 92, 255'),
        };
      };
      return { row: of(row), tab: of(tab) };
    });
    assert.ok(both.row.purple, 'the row is not sweeping purple while output arrives');
    assert.equal(both.row.duration, both.tab.duration, 'the row and the tab sweep at different speeds');
    assert.equal(both.row.direction, both.tab.direction);
    // The same phase for one session, because both come from its name.
    assert.equal(both.row.delay, both.tab.delay, 'the row and the tab are out of phase');

    // And the row carries the mark of the button that started the session, which
    // its meta line already names in words.
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });
    const marks = await page.evaluate(() => [...document.querySelectorAll('#session-list .line .kind')]
      .map((el) => el.textContent).filter(Boolean));
    assert.ok(marks.includes('▸'), `no shell mark among the rows: ${JSON.stringify(marks)}`);
  });

  test('the working sweep is slow, goes both ways, and is not in step across tabs', async () => {
    // A fast one-way sweep with every tab in phase was a strip of decoration
    // flickering at the corner of the eye. The phase comes from the session name
    // so it survives a rebuild of the row instead of jumping.
    await stand.open();
    const { page } = stand;
    const before = await page.locator('#session-list li').count();
    await page.click('#new');
    await page.click('#new-menu button[data-preset="shell"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#session-list li').length > n, before, { timeout: 8000 });
    await stand.attach('demo');
    await page.waitForFunction(() => document.querySelectorAll('#tabs button').length >= 2,
      null, { timeout: 8000 });

    const seen = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('#tabs button')];
      // The class is added by the state and taken away again; this asks the
      // stylesheet what it draws, which is what the report was about.
      tabs.forEach((b) => b.classList.add('working'));
      const out = tabs.map((b) => {
        const s = getComputedStyle(b);
        return { duration: s.animationDuration, direction: s.animationDirection, delay: s.animationDelay };
      });
      tabs.forEach((b) => b.classList.remove('working'));
      return out;
    });
    for (const s of seen) {
      assert.equal(s.duration, '4.2s', `the sweep is ${s.duration}`);
      assert.equal(s.direction, 'alternate', `the sweep runs ${s.direction}`);
    }
    assert.notEqual(seen[0].delay, seen[1].delay, 'every tab starts the sweep at the same instant');
  });
});

describe('the answer buttons and the pane they are read from', () => {
  let stand;
  before(async () => {
    stand = await startStand({ sessions: ['demo'] });
    // For the one case below that needs a keyboard that composes. Desktop
    // Chromium never does; the events are dispatched at xterm's own field.
    await stand.page.addInitScript(FAKE_IME);
  });
  after(async () => { await stand.stop(); });

  test('showing them takes no rows away from the pane', async () => {
    // Reported from the phone as the buttons blinking. The row sat in the terminal
    // screen's own column, so drawing it shrank the terminal: measured here, nine
    // rows of thirty-five. tmux redrew the pane that much shorter and the top of
    // the menu scrolled out of the grid — so the row removed the reason for its own
    // existence, went away, let the pane grow back, and round again. A row whose
    // presence decides whether it should be there cannot be in the flow.
    //
    // The same shrinking is why a waiting session read as finished on the strip:
    // the watcher reads the very same pane.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    const height = () => Number(stand.tmux(['display-message', '-p', '-t', 'demo', '#{pane_height}']).trim());
    const before = height();
    assert.ok(before > 12, `the pane is ${before} rows, too short to tell anything`);

    for (const l of ['Куда положить файл?', '❯ 1. в корень', '  2. в docs/']) {
      stand.tmux(['send-keys', '-t', 'demo', l, 'Enter']);
    }
    await page.waitForFunction(
      () => document.querySelectorAll('#answers button').length >= 2, null, { timeout: 15000 });

    assert.equal(height(), before, 'the row took rows from the pane it is detected from');
    // Over the terminal, not beside it — the geometry says which.
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('answers')).position),
      'absolute', 'the row is back in the flow');
    // And it stays put across several scans, which is what blinking was.
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(400);
      assert.ok(await page.locator('#answers button').count() >= 2, `the row blinked out on scan ${i}`);
      assert.equal(height(), before, `the pane changed height on scan ${i}`);
    }
  });

  // What the row puts on the wire, which is where this defect lived: an
  // arrow-driven menu is answered by walking to the option and pressing Enter,
  // and sent as one write the Enter is applied against the position the menu had
  // *before* the arrows. Measured on a real AskUserQuestion at 51 columns — three
  // arrows alone move the pointer to the fourth option, the same three with the
  // Enter attached answer the first, and so does a single ↓ with one. Every
  // button but the first was quietly answering the first, which is this defect's
  // second visit: it was the digits the first time.
  //
  // The frames are read from the page rather than from the pty because the stand's
  // pane runs `cat` — it echoes what it is sent and moves no pointer, which is
  // exactly what makes the waiting half testable: the menu only "moves" when the
  // test redraws it.
  // Once per page, however many tests ask for it: init scripts accumulate on the
  // context, so a second wrapper would sit on top of the first and record every
  // frame twice — which read as an extra arrow on the wire and cost an hour.
  const recordFrames = () => stand.page.addInitScript(() => {
    if (window.__sentHooked) return;
    window.__sentHooked = true;
    window.__sent = [];
    const native = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      // Keystrokes are binary; resize and visible are JSON strings.
      if (typeof data !== 'string') window.__sent.push(new TextDecoder().decode(data));
      return native.call(this, data);
    };
  });
  // Two options and no more: the stand's pane echoes every line twice — once from
  // the terminal, once from `cat` — so a third would land after a repeated "1."
  // and break the run. Two is all the rule needs.
  const drawMenu = (on) => {
    for (const l of [
      'Что делать?',
      `${on === 0 ? '❯' : ' '} 1. Раз`,
      `${on === 1 ? '❯' : ' '} 2. Два`,
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]) stand.tmux(['send-keys', '-t', 'demo', l, 'Enter']);
  };
  // The row and the footer that says how the menu is answered: a menu is painted
  // a line at a time, and a row drawn before `↑/↓ to navigate` arrived is a row
  // that thinks digits will do. The page re-reads the screen when a button is
  // pressed for exactly that reason; here the test waits so it is measuring the
  // arrow path rather than that race.
  const answersUp = async () => {
    await stand.page.waitForFunction(
      () => document.querySelectorAll('#answers button:not(.esc)').length >= 2,
      null, { timeout: 20000 });
    await stand.page.waitForFunction(
      () => (document.querySelector('.xterm-rows')?.textContent || '').includes('to navigate'),
      null, { timeout: 20000 });
    await stand.page.waitForTimeout(300);
  };
  const sent = () => stand.page.evaluate(() => window.__sent.join(''));
  // The same drawing, with the numbers given rather than assumed: a menu that has
  // scrolled its own list shows a run that does not begin at 1.
  const drawRun = (opts, on) => {
    for (const l of [
      'Что делать?',
      ...opts.map((o, i) => `${on === i ? '❯' : ' '} ${o}`),
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]) stand.tmux(['send-keys', '-t', 'demo', l, 'Enter']);
  };

  test('an answer walks to the option and presses only once the pointer is there', async () => {
    await recordFrames();
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    drawMenu(0);
    await answersUp();

    await page.evaluate(() => { window.__sent.length = 0; });
    await page.locator('#answers button:not(.esc)').nth(1).click();
    await page.waitForTimeout(250);
    assert.equal(await sent(), '\x1b[B', `the walk was not sent alone: ${JSON.stringify(await sent())}`);

    // The pane answers as a real menu would: the pointer one row further down.
    drawMenu(1);
    await page.waitForFunction(() => window.__sent.join('').includes('\r'), null, { timeout: 5000 });
    assert.equal(await sent(), '\x1b[B\r', `the Enter is not a write of its own: ${JSON.stringify(await sent())}`);
  });

  test('a pointer that never arrives is never answered', async () => {
    await recordFrames();
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    drawMenu(0);
    await answersUp();

    await page.evaluate(() => { window.__sent.length = 0; });
    await page.locator('#answers button:not(.esc)').nth(1).click();
    // Nothing redraws the menu, so the pointer stays where it was. The page gives
    // up rather than pressing Enter on whatever is highlighted: a wrong answer is
    // indistinguishable from the right one until you read what it did.
    await page.waitForTimeout(1600);
    assert.equal(await sent(), '\x1b[B', `an Enter went out blind: ${JSON.stringify(await sent())}`);
    assert.match(await page.textContent('#toast'), /did not move/,
      'nothing said that the answer had not gone');
  });

  test('a menu that has scrolled past its own first options is still answered', async () => {
    // AskUserQuestion keeps its pointer in view by scrolling its list, so walking
    // down a long menu on a phone-width pane pushes the options above the target
    // off the top of it. Both halves of a press used to read an option by its
    // place: a run had to begin at "1." to be a menu at all, and the wait after
    // the walk compared the cursor's index with the index the button was drawn
    // with. Neither survives the list moving, and together they were reported
    // from the phone as the two options at the bottom of a long menu doing
    // nothing — the row went away as it was tapped, and the press then had
    // nothing to verify against and refused. The real screen is in the shared
    // fixtures; this is the other half, that the press still lands.
    await recordFrames();
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    drawRun(['2. Два', '3. Три'], 0);
    await answersUp();

    await page.evaluate(() => { window.__sent.length = 0; });
    await page.locator('#answers button:not(.esc)').nth(1).click();
    await page.waitForTimeout(250);
    assert.equal(await sent(), '\x1b[B', `the walk was not sent alone: ${JSON.stringify(await sent())}`);

    // And the list scrolls under the walk: what was the second option is now the
    // first, and the only thing about it that did not change is its number. That
    // is what the page watches, which is why the Enter goes out at all.
    drawRun(['3. Три', '4. Четыре'], 0);
    await page.waitForFunction(() => window.__sent.join('').includes('\r'), null, { timeout: 5000 });
    assert.equal(await sent(), '\x1b[B\r', `the Enter never went: ${JSON.stringify(await sent())}`);
  });

  test("the menu's own text field is walked to and never pressed", async () => {
    // Reported from the phone 2026-08-17: the "Type something." button came back
    // as "User declined to answer questions". The line is not an option at all —
    // it is the placeholder of a text input the widget draws in its list — and an
    // Enter over the empty field submits nothing, which the agent is told is a
    // refusal. So the press walks the pointer onto the field and stops there, and
    // what answers the question is what gets typed next.
    //
    // Read off the wire like the rest of this block, because the defect is one
    // byte: the `\r` that must not follow the walk.
    await recordFrames();
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    drawRun(['1. Раз', '2. Type something.'], 0);
    await answersUp();
    assert.equal(await page.locator('#answers button.typing').count(), 1,
      'the field is drawn as an answer like the others');

    await page.evaluate(() => { window.__sent.length = 0; });
    await page.locator('#answers button:not(.esc)').nth(1).click();
    await page.waitForTimeout(250);
    assert.equal(await sent(), '\x1b[B', `the walk was not sent alone: ${JSON.stringify(await sent())}`);

    // The pane answers as a real menu would: the pointer on the field. That is
    // exactly the moment an answer would have its Enter sent, and this one must
    // not — the wait is longer than POINTER_WAIT, so a press that never comes is
    // a press that will not come.
    drawRun(['1. Раз', '2. Type something.'], 1);
    await page.waitForTimeout(1600);
    assert.equal(await sent(), '\x1b[B',
      `an Enter went out over the empty field: ${JSON.stringify(await sent())}`);
    // And it says what to do instead, there being nothing on screen that would
    // otherwise distinguish "the field is ready" from "the tap did nothing".
    assert.match(await page.textContent('#toast'), /type the answer/,
      'nothing said the field was open');
  });

  test('only the menu\'s field asks for a keyboard; the answers leave it alone', async () => {
    // Reported from the phone: a tap on any button of the row brought the keyboard
    // up over the menu it was answering. Two paths did it and each was enough on
    // its own — the handler called term.focus() after every press, and the row is
    // drawn inside #term, whose own click handler hands the focus back to the
    // terminal for anything that is not named as a control drawn over it.
    //
    // The stand has no soft keyboard, so what is asserted is the lever: whether
    // the terminal's field ends up holding the focus. That is the same measurement
    // the ⇩ and the tab strip are covered by.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    drawRun(['1. Раз', '2. Type something.'], 0);
    await answersUp();
    const focused = () => page.evaluate(() => document.activeElement && document.activeElement.tagName);

    // Nobody is typing: an answer must leave it that way.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.locator('#answers button:not(.esc):not(.typing)').first().click();
    await page.waitForTimeout(300);
    assert.notEqual(await focused(), 'TEXTAREA', 'an answer grabbed focus and would raise the keyboard');

    // And the one option that is answered by typing does open it — from inside the
    // tap, because a focus taken after the walk is out of the gesture and raises
    // nothing on the device this is for.
    await page.evaluate(() => {
      window.__ptFocus = 0;
      document.querySelector('.xterm-helper-textarea')
        .addEventListener('focus', () => { window.__ptFocus += 1; });
    });
    const asked = () => page.evaluate(() => window.__ptFocus | 0);
    await page.locator('#answers button.typing').click();
    await page.waitForTimeout(300);
    assert.equal(await focused(), 'TEXTAREA', 'the field button opened nothing to type into');
    assert.equal(await asked(), 1, 'the field was never focused');

    // Asked again with the field already holding the focus, which is the ordinary
    // state on a phone: it keeps the focus from whenever it was last typed into.
    // A focus that is already there raises no keyboard on Android, so the button
    // has to give it up and take it again inside the same touch.
    await page.locator('#answers button.typing').click();
    await page.waitForTimeout(300);
    assert.equal(await asked(), 2, 'the second tap asked for a keyboard that was already focused');

    // Esc is not an answer either, and it was the other button calling focus().
    // A real tap, which is also what proves it is reachable at all — the pager's
    // ⇞ is a 44px circle in the very corner this button aligns itself to, and
    // until it was lifted this click timed out on the circle intercepting it.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.locator('#answers button.esc').click();
    await page.waitForTimeout(300);
    assert.notEqual(await focused(), 'TEXTAREA', 'Esc grabbed focus and would raise the keyboard');
  });

  test('answering gives the focus up, it is not enough to leave it alone', async () => {
    // Reported from the phone against the release that stopped the row *taking*
    // the focus, which was only half of it. On Android the terminal's field keeps
    // the focus from whenever it was last typed into — dismissing a keyboard does
    // not take it away — and the system raises one for whatever holds the focus as
    // soon as the layout moves under it. Answering a menu moves it by definition.
    // The same answer the ⇩ and a session switch already give.
    //
    // The keyboard is played by the viewport, because that is how the page
    // measures one, and it is waited for on the page's own `data-kb`: the viewport
    // reads short the instant it is resized, while the page learns of it when the
    // event arrives, and a page that never saw a keyboard is outside this rule.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    drawRun(['1. Раз', '2. Два'], 0);
    await answersUp();

    const holdsFocus = () => page.evaluate(
      () => document.activeElement === document.querySelector('.xterm-helper-textarea'));
    await page.click('#term');
    await page.setViewportSize({ width: 390, height: 420 });
    await page.waitForFunction(() => document.documentElement.dataset.kb === '1', null, { timeout: 5000 });
    await page.setViewportSize({ width: 390, height: 780 });
    await page.waitForFunction(() => document.documentElement.dataset.kb === '0', null, { timeout: 5000 });
    await page.waitForFunction(
      () => document.querySelectorAll('#answers button:not(.esc)').length >= 2, null, { timeout: 15000 });
    assert.equal(await holdsFocus(), true,
      'the field had already lost the focus, so this proves nothing');

    await page.locator('#answers button:not(.esc):not(.typing)').first().click();
    await page.waitForTimeout(300);
    assert.equal(await holdsFocus(), false,
      'the terminal kept the focus, which on Android is the keyboard coming back');
  });

  test('a question that takes several answers is drawn as the boxes it toggles', async () => {
    // Reported from the phone 2026-08-17 as the buttons having disappeared, and
    // the pane behind it was this: an AskUserQuestion with several answers draws
    // a checkbox after every number and sets its descriptions at the very column
    // the numbers sit in — captured off a real one, and in the shared fixtures.
    // The indentation rule then broke the run at the first option, so there was no
    // menu at all: no buttons, no blue tab, no notification.
    //
    // Here through the real page rather than the parser, because the page reads
    // its lines out of xterm and a terminal that folded those columns differently
    // would leave the fix true in the unit tests and absent on the phone.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    for (const l of [
      'Что делаем?',
      '❯ 1. [ ] Раз',
      '  Описание первого пункта, у той же колонки.',
      '  2. [✔] Два',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]) stand.tmux(['send-keys', '-t', 'demo', l, 'Enter']);
    await answersUp();

    // And the box is on the button, because pressing it toggles rather than
    // answers: measured on a real menu, Enter turns `[ ]` into `[✔]` and the list
    // stays up. A row of buttons that all looked like answers would say the tap
    // had answered the question.
    assert.deepEqual(
      await page.locator('#answers button:not(.esc)').allTextContents(),
      ['1 · ☐ Раз', '2 · ☑ Два'],
    );
  });

  test('the pager stands clear of the row instead of sitting on it', async () => {
    // Both live inside #term — the pager so that it stays above the bars whatever
    // the bars are doing, the row so that drawing it takes no rows from the pane —
    // and they were given the same corner. The row's Esc aligns itself to the
    // right edge and ⇞ is a 44px circle 10px above the bottom, so the circle sat
    // on it: a button nothing can reach, which is the defect three earlier tests
    // in this file were written for.
    //
    // The geometry is the assertion rather than the offset, because the row is as
    // tall as the menu it was drawn from and a fixed number is the guess that put
    // the pager on the key bar's ▾ once already.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    drawRun(['1. Раз', '2. Два'], 0);
    await answersUp();
    const row = await page.locator('#answers').boundingBox();
    const up = await page.locator('#page-up').boundingBox();
    assert.ok(up.y + up.height <= row.y + 1,
      `⇞ overlaps the answer row: ${JSON.stringify({ pager: up, row })}`);
  });

  test('the row steps out from under the word being typed', async () => {
    // Reported from the phone 2026-08-17, typing into the field the button above
    // opens: the word came out over three of the buttons. xterm draws what is
    // being composed at the cursor, inside the pane — and when a menu's own text
    // field has the keyboard, the cursor is in the rows the answer row covers.
    //
    // So the row is off screen while a word is being written there, and back when
    // it is over. Both halves are asserted, because a row that never came back
    // would read from the phone as the buttons having gone away for good.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    drawRun(['1. Раз', '2. Два'], 0);
    await page.waitForFunction(
      () => document.querySelectorAll('#answers button').length >= 2, null, { timeout: 15000 });
    assert.equal(await page.locator('#answers').isVisible(), true, 'the row was not there to begin with');

    const was = await page.evaluate(() => window.__compose('получится'));
    assert.equal(was, '', `the field held ${JSON.stringify(was)} before the word`);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#answers').isVisible(), false,
      'the buttons stayed under the word being composed');

    // The word ends the way a browser ends one — the focus moving — and the row
    // is a row of answers to a question still on screen.
    await page.evaluate(() => document.querySelector('.xterm-helper-textarea').blur());
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#answers').isVisible(), true,
      'the row did not come back when the word was over');
  });

  test('a list being typed into the input box draws no answer buttons', async () => {
    // Reported from the phone with the message still in the box: a reply that
    // began "1. …" newline "2. …" grew two answer buttons, and pressing one would
    // have sent the half-written message with a digit on the end.
    //
    // The input box carries the same ❯ a menu points with; what separates them is
    // the non-breaking space the box draws after it. This test is here rather than
    // only in the shared fixtures because the page reads its lines out of xterm,
    // and a terminal that folded that space into an ordinary one would leave the
    // fix true in the unit tests and absent on the phone.
    await stand.open();
    await stand.attach('demo');
    const { page } = stand;
    // The stand is shared and the test above leaves a real menu on the pane. The
    // detector answers with the lowest run on screen, so without this what gets
    // measured is that menu's row — the first version of this test failed for
    // exactly that reason, which is the good failure: the row is drawn from what
    // is on the pane, not from what was typed last.
    for (let i = 0; i < 50; i++) stand.tmux(['send-keys', '-t', 'demo', 'Enter']);
    await page.waitForFunction(
      () => document.querySelectorAll('#answers button').length === 0, null, { timeout: 15000 });

    const box = [
      '❯\u00a01. Надо разнести иконки изображения шела и',
      '  монитора на табах  и в меню.',
      '  2. Сейчас я пишу а таб поктерма мигает',
    ];
    for (const l of box) stand.tmux(['send-keys', '-t', 'demo', l, 'Enter']);
    // Several scans, because the row is drawn on a throttled timer: one look
    // straight after the last line would pass against the defect.
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#answers button').count(), 0,
        `the input box was read as a menu on scan ${i}`);
    }
    // And the same shape with an ordinary space is a menu, which is what keeps
    // the check above from passing for the wrong reason — a page that had stopped
    // detecting anything would satisfy it too.
    stand.tmux(['send-keys', '-t', 'demo', '❯ 1. Yes', 'Enter']);
    stand.tmux(['send-keys', '-t', 'demo', '  2. No', 'Enter']);
    await page.waitForFunction(
      () => document.querySelectorAll('#answers button').length >= 2, null, { timeout: 15000 });
  });
});
