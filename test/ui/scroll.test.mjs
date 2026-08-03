// The swipe, driven as a finger drives it. Run with: make test-ui
//
// The arithmetic of the gesture has unit tests; what they cannot see is
// whether the page moves anything. Between two whole lines tmux has nothing to
// draw, so the screen follows the finger only if the page shifts the rows it
// already has — a transform on an element xterm owns and rebuilds on every
// write, which is not a thing to take on trust.
import { test, before, after, describe } from 'node:test';
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
    document.getElementById('term').addEventListener('touchmove', (e) => {
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
    assert.ok(gaps[0] < row,
      `the first ${(seen[0].y - start).toFixed(0)}px of travel moved the rows ${seen[0].px.toFixed(1)}px`);
    const step = gaps.find((g) => g > row / 2);
    assert.ok(step, `no whole line was drawn in ${y - start}px of travel: ${gaps.map((g) => g.toFixed(1))}`);
    let drawn = 0;
    for (const [i, gap] of gaps.entries()) {
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

  test('the shifted rows stay inside the terminal', async () => {
    // The shift is a transform, and a row drawn over the key bar would be a
    // new defect in place of the old one.
    await stand.open();
    await stand.attach();
    const clips = await stand.page.evaluate(() => getComputedStyle(document.getElementById('term')).overflow);
    assert.equal(clips, 'hidden');
  });
});
