// The swipe, driven as a finger drives it. Run with: make test-ui
//
// The arithmetic of the gesture has unit tests; what they cannot see is
// whether the page moves anything. Between two whole lines tmux has nothing to
// draw, so the screen follows the finger only if the page shifts the rows it
// already has — a transform on an element xterm owns and rebuilds on every
// write, which is not a thing to take on trust.
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from './stand.mjs';

const X = 195; // middle of a 390px viewport

// The finger and the shift have to be read at the same instant, and only the
// page can do that: the shift is handed back on a clock of its own, so a
// reading taken from here a few milliseconds later belongs to a different
// moment and compares two unrelated numbers — which is how this test first
// reported a defect that was its own. Both are recorded inside a touchmove
// handler, which runs after the page's.
async function recordGesture(page) {
  await page.evaluate(() => {
    window.__gesture = { n: 0, seen: [] };
    // On the same element as the page's own handler, and registered after it, so
    // this reads the shift the page has just applied. On #term it read the one
    // before: the page listens on the screen, the event bubbles up from the rows,
    // and a listener on the way there runs first — which showed up as every
    // sample being one move behind.
    document.getElementById('screen-term').addEventListener('touchmove', (e) => {
      if (!e.touches.length) return;
      const el = document.querySelector('.xterm-screen');
      const t = el && getComputedStyle(el).transform;
      window.__gesture.n += 1;
      window.__gesture.seen.push({
        y: e.touches[0].clientY,
        px: !t || t === 'none' ? 0 : new DOMMatrixReadOnly(t).f,
      });
    }, { passive: true });
  });
}

// Chromium's own touch input, not synthetic DOM events: the page times the
// whole gesture off e.timeStamp, so events with a hand-made clock would prove
// nothing about the real one.
//
// It also delivers at most one touchmove per frame and merges the rest into
// it, so a dispatch is not a delivery and the positions in between never
// exist — every move waits to be received before the next is sent.
async function move(page, cdp, y) {
  const before = await page.evaluate(() => window.__gesture.n);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: X, y }] });
  await page.waitForFunction((n) => window.__gesture.n > n, before, { timeout: 3000 });
}

describe('a swipe follows the finger', () => {
  let stand;
  let cdp;
  before(async () => {
    stand = await startStand();
    cdp = await stand.page.context().newCDPSession(stand.page);
  });
  after(async () => { await stand.stop(); });

  // Every case here starts from the live end of the output. The pane is shared
  // and a drag that ended scrolled back leaves it that way, so without this the
  // case after it inherits a scrolled-back pane — which showed up as the ⇩ being
  // on screen "before anything was scrolled", failing about once in three runs
  // depending on where the previous drag happened to stop.
  beforeEach(() => {
    try { stand.tmux(['send-keys', '-t', 'demo', '-X', 'cancel']); } catch (_) { /* not in a mode */ }
  });

  test('the rows move with a slow drag, not in jumps of whole lines', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;
    await recordGesture(page);

    const row = await page.evaluate(() => {
      const el = document.querySelector('.xterm-rows > div');
      return el ? el.getBoundingClientRect().height : 0;
    });
    assert.ok(row > 4, `a row measures nothing sensible: ${row}`);

    // History to scroll through. Without it the pane cannot move at all: the
    // first notch enters copy-mode and everything after it is a message tmux has
    // nothing to answer with, so the shift piles up to its cap and the invariant
    // below reads like a defect. Measured that way once already.
    await page.click('#term');
    for (let i = 1; i <= 40; i++) await page.keyboard.type(`line ${i}\n`);
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('line 40'));

    const start = 300;
    let y = start;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: X, y }] });
    // Chromium holds touchmoves back until it has decided the touch is a
    // gesture — some 15 CSS pixels, well above the page's own 6px threshold —
    // so the first move clears its slop, not the page's.
    y += 24;
    await move(page, cdp, y);
    // Six pixels at a time: the slow drag the report was about.
    for (let i = 0; i < 22; i++) {
      y += 6;
      await move(page, cdp, y);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    const seen = await page.evaluate(() => window.__gesture.seen);
    assert.ok(seen.length >= 8, `only ${seen.length} moves were delivered`);

    // The invariant, and it needs no step to state: the picture stands where
    // the finger is, less the whole lines tmux has drawn. So the gap between
    // the two is a whole number of steps — never a fraction of one, which is
    // the screen lagging behind the finger, and never less than it was, which
    // is a drawn line being taken back.
    //
    // The size of a step is not assumed: the binding is tmux's to choose (five
    // lines on a stock server, two on the owner's) and the page is told what it
    // is. What a step has to be is the same every time, so it is measured off
    // the first line drawn and the rest are held against it.
    const gaps = seen.map((s) => s.y - start - s.px);
    // Something was shifted at some point: without this the invariant below
    // holds trivially for a page that never follows the finger at all.
    assert.ok(seen.some((s) => s.px > 1), `the rows never moved: ${seen.map((v) => v.px.toFixed(1))}`);
    // The step comes from tmux, the same way the page is told it: a row times the
    // lines its binding scrolls. Deriving it from the gaps was the first attempt
    // and it read the wrong number whenever the first sample already had two
    // lines drawn — the stand reads the same ~/.tmux.conf as the host, so the
    // binding has changed under these tests once already.
    const binding = stand.tmux(['list-keys', '-T', 'copy-mode'])
      .split('\n').find((l) => l.includes('WheelUpPane')) || '';
    const lines = Number(/-N (\d+)/.exec(binding)?.[1] || 5);
    const step = row * lines;
    assert.ok(step > 4, `a step measures nothing sensible: ${step} (${binding})`);
    // One exception, and it is a decision rather than a slip: the shift is
    // capped (MAX_TRACK), because it is content that has not arrived and shows
    // as a band of background. While it is at the cap the picture cannot follow
    // the finger, so the gap grows by whatever the finger does. A test driven
    // over a real tunnel does reach it — the moves here are faster than the
    // repaints coming back.
    const cap = 3 * step;
    let drawn = 0;
    for (const [i, gap] of gaps.entries()) {
      if (Math.abs(seen[i].px - cap) < 1.5) continue; // pinned at the cap
      const lines = gap / step;
      assert.ok(
        Math.abs(lines - Math.round(lines)) < 0.08,
        `after ${(seen[i].y - start).toFixed(1)}px the rows sit ${seen[i].px.toFixed(1)}px along, ` +
        `which is ${lines.toFixed(2)} steps behind the finger`,
      );
      assert.ok(Math.round(lines) >= drawn, `a drawn line was taken back: ${gaps.map((g) => g.toFixed(1))}`);
      drawn = Math.round(lines);
    }
    assert.ok(drawn >= 1, 'the drag never crossed a step boundary');

    // The gesture is over once the glide has settled: a screen left parked off
    // its grid would misplace every tap after it.
    await page.waitForFunction(() => {
      const el = document.querySelector('.xterm-screen');
      const t = el && getComputedStyle(el).transform;
      return !t || t === 'none' || Math.abs(new DOMMatrixReadOnly(t).f) < 0.5;
    }, null, { timeout: 4000 });

    assert.deepEqual(stand.pageErrors, []);
  });

  test('the way back to the end is offered only when there is one', async () => {
    // Reported as the round ⇩ button often staying at the bottom with nothing
    // behind it. It followed tmux's copy-mode, and that is a different state
    // from being scrolled back: a pane can sit in copy-mode showing the live
    // end — its own glide, a second client on the shared pane, or a mode
    // entered by hand all land there — and then the button offers a way back
    // from where the screen already is.
    //
    // The states are made with tmux rather than with a finger on purpose. A
    // swipe on this stand ends with tmux leaving copy-mode by itself, so it
    // cannot tell the old behaviour from the new one; copy-mode at position
    // zero is exactly the case that could not be told apart, so it is the case
    // asserted.
    await stand.open();
    await stand.attach();
    const { page } = stand;

    // The page attaches through its own grouped session, and that is the one
    // whose pane state the server reports.
    const client = stand.tmux(['list-sessions', '-F', '#{session_name}'])
      .split('\n').find((n) => n.startsWith('pockterm-'));
    assert.ok(client, 'the page did not attach through a client session');

    // History to scroll through: the session runs cat, so what is typed comes
    // back as output.
    await page.click('#term');
    for (let i = 1; i <= 40; i++) await page.keyboard.type(`line ${i}\n`);
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('line 40'));
    assert.ok(await page.locator('#to-bottom').isHidden(), 'the button is up before anything was scrolled');

    // In copy-mode, at the live end. The button must stay down: this is the
    // reported defect, and the page cannot see the difference without the
    // position that now travels with the mode frame.
    stand.tmux(['copy-mode', '-t', client]);
    // A poll interval and a half: the state travels to the page on a 400ms
    // clock, and what is being asserted is that nothing appears, so the wait has
    // to be long enough for it to have appeared.
    await page.waitForTimeout(700);
    const atEnd = stand.tmux(['display-message', '-p', '-t', client, '#{pane_in_mode} #{scroll_position}']).trim();
    assert.match(atEnd, /^1 0?$/, `the state under test was not reached: ${atEnd}`);
    assert.ok(await page.locator('#to-bottom').isHidden(),
      'copy-mode at the live end still offers a way back from it');

    // Scrolled back: now there is somewhere to go.
    stand.tmux(['send-keys', '-t', client, '-X', '-N', '5', 'scroll-up']);
    await page.waitForSelector('#to-bottom:not([hidden])', { timeout: 5000 });

    // And out again.
    stand.tmux(['send-keys', '-t', client, '-X', 'cancel']);
    await page.waitForSelector('#to-bottom', { state: 'hidden', timeout: 5000 });
    assert.deepEqual(stand.pageErrors, []);
  });

  test('a swipe into history offers the way back', async () => {
    // The same button through the real path: a finger, the page's own notches,
    // and whatever tmux makes of them.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    await recordGesture(page);
    await page.click('#term');
    for (let i = 1; i <= 40; i++) await page.keyboard.type(`line ${i}\n`);
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('line 40'));

    let y = 200;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: X, y }] });
    for (let i = 0; i < 12; i++) { y += 30; await move(page, cdp, y); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await page.waitForSelector('#to-bottom:not([hidden])', { timeout: 5000 });
    // Tapped while the glide is still running, on purpose: inertia goes on
    // sending notches after the finger has left, and those used to arrive
    // behind the q and put the pane back into history — the button looked like
    // it had done nothing. The tap cancels the glide first.
    await page.click('#to-bottom');
    await page.waitForSelector('#to-bottom', { state: 'hidden', timeout: 5000 });
    const after = stand.tmux(['display-message', '-p', '-t', 'demo', '#{pane_in_mode} #{scroll_position}']).trim();
    assert.doesNotMatch(after, /^1 [1-9]/, `still scrolled back after tapping the way out: ${after}`);
  });

  test('a gesture the browser takes away does not leave the screen shifted', async () => {
    // Reported as a long swipe being interrupted. The browser can decide
    // mid-gesture that the swipe is its own and stop delivering moves; the page
    // then never hears an end, and the screen stays shifted where the last move
    // left it. `touch-action: none` asks it not to, and this is the other half —
    // what happens when it does anyway.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    await recordGesture(page);

    let y = 300;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: X, y }] });
    y += 24;
    await move(page, cdp, y);
    for (let i = 0; i < 6; i++) { y += 8; await move(page, cdp, y); }
    const shifted = await page.evaluate(() => {
      const el = document.querySelector('.xterm-screen');
      const t = el && getComputedStyle(el).transform;
      return !t || t === 'none' ? 0 : new DOMMatrixReadOnly(t).f;
    });
    assert.ok(shifted > 4, `the finger was not followed: ${shifted}`);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForFunction(() => {
      const el = document.querySelector('.xterm-screen');
      const t = el && getComputedStyle(el).transform;
      return !t || t === 'none' || Math.abs(new DOMMatrixReadOnly(t).f) < 0.5;
    }, null, { timeout: 4000 });
    assert.deepEqual(stand.pageErrors, []);
  });

  test('the swipe is the page\'s to interpret, not the browser\'s', async () => {
    await stand.open();
    await stand.attach();
    const { page } = stand;
    const styles = await page.evaluate(() => ({
      // The whole screen, not just the box the text is drawn in: a swipe that
      // runs into the bars has to go on scrolling.
      screen: getComputedStyle(document.getElementById('screen-term')).touchAction,
      // Three exceptions that own their gestures: a field a caret is dragged
      // through, the frozen copy a selection is made in, and the tab strip.
      composer: getComputedStyle(document.getElementById('composer')).touchAction,
      snapshot: getComputedStyle(document.getElementById('snapshot')).touchAction,
      header: getComputedStyle(document.querySelector('#screen-term header.bar')).touchAction,
    }));
    assert.equal(styles.screen, 'none');
    assert.equal(styles.composer, 'auto');
    assert.equal(styles.snapshot, 'auto');
    assert.equal(styles.header, 'auto');
  });

  test("tmux's status line does not ride along with the shift", async () => {
    // Reported as the green strip at the bottom rising two lines on an upward
    // swipe. It is not chrome to this page: tmux draws it into the bottom row of
    // the same grid, so a transform on the screen takes it with everything else.
    // The stand's tmux has its status line on, which is what makes this checkable
    // here at all.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    await recordGesture(page);

    // Where the last row sits before anything moves, and what is in it: the
    // status line is tmux's, so it carries the session name.
    const bottom = () => page.evaluate(() => {
      const rows = document.querySelectorAll('.xterm-rows > div');
      const el = rows[rows.length - 1];
      const box = el.getBoundingClientRect();
      return { y: box.y, text: (el.textContent || '').trim() };
    });
    // Painted by tmux a moment after the attach, and it names the client session
    // the page attached through rather than the target.
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('.xterm-rows > div');
      const last = rows[rows.length - 1];
      return last && /pockterm-/.test(last.textContent || '');
    }, null, { timeout: 5000 });
    const before = await bottom();
    assert.match(before.text, /pockterm-/, `the bottom row is not tmux's status line: ${JSON.stringify(before.text)}`);

    let y = 500;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: X, y }] });
    y += 24;
    await move(page, cdp, y);
    for (let i = 0; i < 8; i++) { y += 8; await move(page, cdp, y); }

    const shifted = await page.evaluate(() => {
      const el = document.querySelector('.xterm-screen');
      const t = el && getComputedStyle(el).transform;
      return !t || t === 'none' ? 0 : new DOMMatrixReadOnly(t).f;
    });
    assert.ok(shifted > 4, `the finger was not followed: ${shifted}`);

    const during = await bottom();
    assert.ok(Math.abs(during.y - before.y) < 1.5,
      `the status line moved ${(during.y - before.y).toFixed(1)}px with a shift of ${shifted.toFixed(1)}px`);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => {
      const el = document.querySelector('.xterm-screen');
      const t = el && getComputedStyle(el).transform;
      return !t || t === 'none' || Math.abs(new DOMMatrixReadOnly(t).f) < 0.5;
    }, null, { timeout: 4000 });
    const after = await bottom();
    assert.ok(Math.abs(after.y - before.y) < 1.5, 'the status line did not come back to where it was');
  });

  test('a swipe over the bars scrolls the terminal too', async () => {
    // Reported as the scroll being cut off rather than covering the screen: the
    // bars take a third of a phone, a swipe that started over them did nothing,
    // and a downward one that ran into them had nowhere left to go.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    await page.click('#term');
    for (let i = 1; i <= 40; i++) await page.keyboard.type(`line ${i}\n`);
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('line 40'));

    const bar = await page.locator('#keybar').boundingBox();
    assert.ok(bar, 'no key bar to swipe over');
    // Starting inside the key bar, going up: the terminal must scroll back.
    await page.evaluate(() => { window.__n = 0; document.getElementById('screen-term').addEventListener('touchmove', () => { window.__n++; }, { passive: true }); });
    let y = bar.y + bar.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: X, y }] });
    for (let i = 0; i < 12; i++) {
      y += 30; // finger down the screen is towards history
      const before = await page.evaluate(() => window.__n);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: X, y }] });
      await page.waitForFunction((n) => window.__n > n, before, { timeout: 3000 }).catch(() => {});
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await page.waitForSelector('#to-bottom:not([hidden])', { timeout: 5000 });
    const state = stand.tmux(['display-message', '-p', '-t', 'demo', '#{pane_in_mode} #{scroll_position}']).trim();
    assert.match(state, /^1 [1-9]/, `a swipe from the key bar did not scroll: ${state}`);
    stand.tmux(['send-keys', '-t', 'demo', '-X', 'cancel']);
  });

  test('the lever turns the shift off without touching the scrolling', async () => {
    // Whether holding the picture between whole lines reads better than moving
    // in whole ones is a question about feel, and the phone is the only place it
    // can be answered — so it is a tap, and it is remembered.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    await recordGesture(page);

    await page.click('#more');
    await page.click('#smooth');
    assert.match(await page.locator('#smooth').textContent(), /lines/);
    await page.click('#more');

    let y = 300;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: X, y }] });
    y += 24;
    await move(page, cdp, y);
    for (let i = 0; i < 8; i++) { y += 8; await move(page, cdp, y); }
    const shifted = await page.evaluate(() => {
      const el = document.querySelector('.xterm-screen');
      const t = el && getComputedStyle(el).transform;
      return !t || t === 'none' ? 0 : new DOMMatrixReadOnly(t).f;
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(shifted, 0, `the rows were still shifted with the lever off: ${shifted}`);

    // The scrolling itself is untouched: notches still go to tmux.
    const state = stand.tmux(['display-message', '-p', '-t', 'demo', '#{pane_in_mode} #{scroll_position}']).trim();
    assert.match(state, /^1 [1-9]/, `nothing scrolled with the lever off: ${state}`);
    stand.tmux(['send-keys', '-t', 'demo', '-X', 'cancel']);

    // And the choice survives a reload, because a lever that forgets is a lever
    // pulled twice.
    await stand.open();
    await stand.attach();
    await page.click('#more');
    assert.match(await page.locator('#smooth').textContent(), /lines/);
    await page.click('#smooth'); // back on, so the tests after this see the default
    await page.click('#more');
  });

  test('the shifted rows stay inside the terminal', async () => {
    // The shift is a transform, and a row drawn over the key bar would be a
    // new defect in place of the old one.
    await stand.open();
    await stand.attach();
    const clips = await stand.page.evaluate(() => getComputedStyle(document.getElementById('term')).overflow);
    assert.equal(clips, 'hidden');
  });
});

describe('the laptop is a client too', () => {
  let stand;
  before(async () => { stand = await startStand({ desktop: true }); });
  after(async () => { await stand.stop(); });

  test('the key bar is there on a device with a mouse', async () => {
    // It used to be hidden behind `(hover: hover) and (pointer: fine)`, on the
    // grounds that a real keyboard has the keys. Reported from the laptop as
    // there being no arrow block at all — and the bar carries more than arrows:
    // ✓ (accept) and Alt+Enter are on no keyboard.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    assert.equal(await page.locator('#keybar').isVisible(), true, 'no key bar on a mouse device');
    await page.locator('#keybar [data-key="down"]').click({ trial: true });
  });

  test('the way back to the end appears for a wheel too', async () => {
    // Reported as the ⇩ not appearing there. It does — the journal from the
    // laptop had `mode in:true back:10 shown:true` — so this pins the path that
    // gets it on screen: a wheel over the terminal, not a finger.
    await stand.open();
    await stand.attach();
    const { page } = stand;
    await page.click('#term');
    for (let i = 1; i <= 60; i++) await page.keyboard.type(`line ${i}\n`);
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('line 60'));
    assert.ok(await page.locator('#to-bottom').isHidden(), 'the button is up before anything scrolled');

    await page.mouse.move(600, 300);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(120); }

    await page.waitForSelector('#to-bottom:not([hidden])', { timeout: 5000 });
    const state = stand.tmux(['display-message', '-p', '-t', 'demo', '#{pane_in_mode} #{scroll_position}']).trim();
    assert.match(state, /^1 [1-9]/, `the wheel did not scroll tmux: ${state}`);
    await page.click('#to-bottom');
    await page.waitForSelector('#to-bottom', { state: 'hidden', timeout: 5000 });
  });
});
