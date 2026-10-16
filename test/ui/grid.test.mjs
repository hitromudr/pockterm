// Several sessions on one screen. Run with: make test-ui
//
// 2026-10-16: up to six tabs at once, 3x2 or 2x3 by the shape of the screen.
// Each cell is the page itself in an iframe (`?cell=`), so what is checked here
// is the seam between the two: which pane a key from the bar lands in, that the
// page around the cells holds no client of its own, and that each cell's client
// is attached at the cell's size.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from './stand.mjs';

// What reached a pane, read off tmux: the sessions run `cat -vT`, so an Esc is ^[.
function paneText(stand, name) {
  return stand.tmux(['capture-pane', '-pJ', '-t', `=${name}:`]).replace(/\s+$/, '');
}

// The clients tmux has, by session group. The stand's sessions are plain ones,
// and a page attaches to its own `<name>-client-N` grouped with it.
function clients(stand) {
  return stand.tmux(['list-clients', '-F', '#{session_group} #{client_width}x#{client_height}'])
    .split('\n').filter(Boolean);
}

async function cellReady(page, name) {
  const frame = page.frameLocator(`#grid .cell[data-session="${name}"] iframe`);
  await frame.locator('#term .xterm').waitFor({ timeout: 10000 });
  await page.waitForFunction((n) => {
    const f = document.querySelector(`#grid .cell[data-session="${n}"] iframe`);
    const w = f && f.contentWindow;
    return !!(w && w.ptCell && w.document.getElementById('status').hidden
      && w.document.getElementById('term').dataset.size);
  }, name, { timeout: 10000 });
  return frame;
}

describe('the grid on a laptop', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['a', 'b', 'c'], raw: true, desktop: true }); });
  after(async () => { await stand.stop(); });

  test('⊞ puts the open tab into a grid, and a tapped tab joins it', async () => {
    const { page } = stand;
    await stand.open();
    await stand.attach('a');
    await page.click('#grid-toggle');
    await page.waitForSelector('#grid:not([hidden]) .cell[data-session="a"]');
    assert.equal(await page.getAttribute('#grid', 'data-shape'), '1x1');
    await cellReady(page, 'a');

    await page.click('#tabs button[data-session="b"]');
    await cellReady(page, 'b');
    // 1280x800: two side by side, not one over the other.
    assert.equal(await page.getAttribute('#grid', 'data-shape'), '2x1');
    assert.ok(await page.locator('#grid .cell.active[data-session="b"]').count() === 1, 'the tapped tab is the active cell');
    assert.ok(await page.locator('#tabs button.in-grid').count() === 2);

    // Two clients, one per cell: the page around them let its own socket go.
    const deadline = Date.now() + 5000;
    let list = clients(stand);
    while (list.length !== 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      list = clients(stand);
    }
    assert.equal(list.length, 2, list.join('; '));
    assert.deepEqual(stand.pageErrors, []);
  });

  test("each cell's window is the cell's size", async () => {
    const { page } = stand;
    for (const n of ['a', 'b']) {
      const size = await page.frameLocator(`#grid .cell[data-session="${n}"] iframe`)
        .locator('#term').getAttribute('data-size');
      const win = stand.tmux(['display-message', '-p', '-t', `=${n}:`, '#{window_width}x#{window_height}']).trim();
      assert.equal(win, size, `${n}: window ${win}, cell ${size}`);
    }
  });

  test('a key from the bar lands in the active cell and nowhere else', async () => {
    const { page } = stand;
    await page.click('#keybar [data-key="esc"]');
    const until = Date.now() + 3000;
    while (!paneText(stand, 'b').includes('^[') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.ok(paneText(stand, 'b').includes('^['), `b: ${paneText(stand, 'b')}`);
    assert.ok(!paneText(stand, 'a').includes('^['), `a: ${paneText(stand, 'a')}`);

    // Choosing the other cell by its head moves the keys with it.
    await page.click('#grid .cell[data-session="a"] .cell-name');
    await page.waitForSelector('#grid .cell.active[data-session="a"]');
    await page.click('#keybar [data-key="tab"]');
    const until2 = Date.now() + 3000;
    while (!paneText(stand, 'a').includes('^I') && Date.now() < until2) await new Promise((r) => setTimeout(r, 100));
    assert.ok(paneText(stand, 'a').includes('^I'), `a: ${paneText(stand, 'a')}`);
    assert.ok(!paneText(stand, 'b').includes('^I'), `b: ${paneText(stand, 'b')}`);
  });

  test('the composer writes into the active cell', async () => {
    const { page } = stand;
    await page.click('#mode');
    await page.fill('#prompt', 'hello-grid');
    await page.click('#send');
    const until = Date.now() + 3000;
    while (!paneText(stand, 'a').includes('hello-grid') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.ok(paneText(stand, 'a').includes('hello-grid'), `a: ${paneText(stand, 'a')}`);
    assert.ok(!paneText(stand, 'b').includes('hello-grid'));
    await page.click('#mode');
  });

  test('typing inside a cell chooses it', async () => {
    const { page } = stand;
    const frame = page.frameLocator('#grid .cell[data-session="b"] iframe');
    await frame.locator('#term').click();
    await page.waitForSelector('#grid .cell.active[data-session="b"]');
    await page.keyboard.type('xyz');
    const until = Date.now() + 3000;
    while (!paneText(stand, 'b').includes('xyz') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.ok(paneText(stand, 'b').includes('xyz'), `b: ${paneText(stand, 'b')}`);
  });

  test('the grid comes back on reload', async () => {
    const { page } = stand;
    await page.reload();
    await page.waitForSelector('#grid:not([hidden]) .cell[data-session="b"]');
    await cellReady(page, 'a');
    await cellReady(page, 'b');
    assert.equal(await page.locator('#grid .cell').count(), 2);
  });

  test('✕ takes a cell out, ⤢ goes back to one pane', async () => {
    const { page } = stand;
    await page.click('#grid .cell[data-session="b"] .cell-drop');
    await page.waitForFunction(() => document.querySelectorAll('#grid .cell').length === 1);
    assert.equal(await page.getAttribute('#grid', 'data-shape'), '1x1');
    await page.click('#grid .cell[data-session="a"] .cell-full');
    await page.waitForSelector('#grid', { state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('status').hidden);
    assert.ok(await page.locator('#tabs button.active[data-session="a"]').count() === 1);
    // One client again, the page's own, at the page's size.
    const size = await page.getAttribute('#term', 'data-size');
    const deadline = Date.now() + 5000;
    let list = clients(stand);
    while (!(list.length === 1 && list[0].endsWith(size)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      list = clients(stand);
    }
    assert.deepEqual(list.map((l) => l.split(' ')[1]), [size]);
    // The one pane types again.
    const before = (paneText(stand, 'a').match(/\^\[/g) || []).length;
    await page.click('#keybar [data-key="esc"]');
    const until = Date.now() + 3000;
    let now = before;
    while (now === before && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      now = (paneText(stand, 'a').match(/\^\[/g) || []).length;
    }
    assert.ok(now > before, `the single pane took no key after the grid: ${paneText(stand, 'a')}`);
    assert.deepEqual(stand.pageErrors, []);
  });
});

describe('the grid on a phone', () => {
  let stand;
  const six = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
  before(async () => { stand = await startStand({ sessions: six, raw: true }); });
  after(async () => { await stand.stop(); });

  test('six upright are 2x3, and a seventh is refused', async () => {
    const { page } = stand;
    await stand.open();
    await stand.attach('s1');
    // From the drawer: a phone's strip is ☰ and the tabs alone (2026-10-17).
    await stand.openDrawer();
    await page.click('#grid-drawer');
    await page.waitForSelector('#grid:not([hidden])');
    for (const n of six.slice(1, 6)) {
      await page.locator(`#tabs button[data-session="${n}"]`).scrollIntoViewIfNeeded();
      await page.click(`#tabs button[data-session="${n}"]`);
      await page.waitForSelector(`#grid .cell[data-session="${n}"]`);
    }
    assert.equal(await page.getAttribute('#grid', 'data-shape'), '2x3');
    for (const n of six.slice(0, 6)) await cellReady(page, n);

    // Every pane fits its cell. A cell made shorter at the same width — which
    // adding a row of cells does — read as a keyboard coming up, and the pane
    // kept its rows: the status line went under the bottom of the cell.
    await page.waitForTimeout(500);
    for (const n of six.slice(0, 6)) {
      const fit = await page.evaluate((name) => {
        const d = document.querySelector(`#grid .cell[data-session="${name}"] iframe`).contentDocument;
        const box = d.getElementById('term');
        const screen = d.querySelector('#term .xterm-screen');
        return { box: box.clientHeight, screen: screen.offsetHeight, kb: d.documentElement.dataset.kb };
      }, n);
      assert.ok(fit.screen <= fit.box, `${n}: pane ${fit.screen}px in a cell of ${fit.box}px (kb ${fit.kb})`);
    }

    await page.locator('#tabs button[data-session="s7"]').scrollIntoViewIfNeeded();
    await page.click('#tabs button[data-session="s7"]');
    await page.waitForSelector('#toast:not([hidden])');
    assert.equal(await page.locator('#grid .cell').count(), 6);
    // Nothing of a cell's own chrome is drawn inside it.
    const frame = page.frameLocator('#grid .cell[data-session="s1"] iframe');
    assert.equal(await frame.locator('#keybar').isVisible(), false);
    assert.equal(await frame.locator('header.bar').first().isVisible(), false);
    assert.deepEqual(stand.pageErrors, []);
  });
});
