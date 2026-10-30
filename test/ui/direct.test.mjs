// The socket through the nearer door. Run with: make test-ui
//
// 2026-10-26: a laptop at home reached the terminal the long way — out through
// the public address and back down the host's tunnel — and every blink of the
// home line was a stalled socket. The server now names a door on the same
// network (POCKTERM_DIRECT_URL) and the page tries its socket there; the page
// itself stays where it was opened. Here the door is the same binary's door
// listener under another host name, which is another origin as the browser
// counts it, so what is tested is the real cross-origin socket, the server's
// list of trusted pages and the ticket the door takes instead of a client
// certificate (2026-10-30), not a shortcut around them.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from './stand.mjs';

// Every socket the page opens, by the host it went to, and whether it is still
// open.
function watchSockets(page) {
  const seen = [];
  page.on('websocket', (ws) => {
    const s = { host: new URL(ws.url()).host, open: true };
    ws.on('close', () => { s.open = false; });
    seen.push(s);
  });
  return seen;
}

// What the page sends to a host, in order: 'http' for a request, 'ws' for a
// socket.
function watchHost(page, host) {
  const seen = [];
  page.on('request', (r) => { if (new URL(r.url()).host === host) seen.push('http'); });
  page.on('websocket', (ws) => { if (new URL(ws.url()).host === host) seen.push('ws'); });
  return seen;
}

async function waitFor(cond, what, ms = 10000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function typed(page, text) {
  await page.click('#term');
  await page.keyboard.type(text);
  await page.waitForFunction(
    (t) => document.querySelector('.xterm-rows')?.textContent?.includes(t),
    text, { timeout: 20000 });
}

// The mark in the drawer's header, read with the drawer open. It sits in the
// line POCKTERM_UPLINKS turns on, so the stands below name a way out.
async function mark(stand) {
  await stand.openDrawer();
  await stand.page.waitForFunction(() => !document.getElementById('uplink').hidden, null, { timeout: 5000 });
  const m = await stand.page.evaluate(() => ({
    glyph: document.querySelector('#uplink .via').textContent,
    title: document.getElementById('uplink').title,
  }));
  await stand.shutDrawer();
  return m;
}

async function clients(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/presence');
    return res.ok ? (await res.json()).clients : -1;
  });
}

describe('a door on the same network', () => {
  let stand;
  let sockets;
  before(async () => {
    stand = await startStand({ sessions: ['alpha', 'beta'], door: 'live', uplinks: 'eth0=роутер' });
    sockets = watchSockets(stand.page);
  });
  after(async () => { await stand.stop(); });

  test('the socket moves to the door once the page learns it, and the page stays put', async () => {
    const { page, base } = stand;
    const hostName = new URL(base).host;
    const door = stand.door;
    const toDoor = watchHost(page, door);
    await stand.open();
    await stand.attach('alpha');
    // A fresh page has no ticket for the door: the first socket goes the way
    // it always went, its config frame names the door and hands one over, and
    // the door is tried beside it and takes over.
    await waitFor(() => sockets.some((s) => s.host === door && s.open), 'a socket through the door');
    await waitFor(() => !sockets.some((s) => s.host === hostName && s.open), 'the long-way socket to close');
    assert.equal(sockets[0].host, hostName, 'the first socket was not the page\'s own host');
    assert.equal(new URL(page.url()).host, hostName, 'the page itself moved');
    // A socket and nothing else: no request that would make a browser pick a
    // client certificate.
    assert.deepEqual(toDoor, ['ws'], `what the door saw of the page: ${JSON.stringify(toDoor)}`);
    assert.match(stand.serverLog(), /socket-via.*"via":"direct".*"why":"aside"/);
    assert.equal(await clients(page), 1, 'the swap left a second client attached');
    await typed(page, 'via the door');
    const m = await mark(stand);
    assert.equal(m.glyph, '⌂', `the header does not say the socket is direct: ${JSON.stringify(m)}`);
    assert.match(m.title, /напрямую/);
    assert.deepEqual(stand.pageErrors, []);
  });

  test('the next connect goes to the door first, with nothing the long way', async () => {
    const { page } = stand;
    const door = stand.door;
    const before = sockets.length;
    await stand.attach('beta');
    await waitFor(() => sockets.slice(before).some((s) => s.open), 'a socket for beta');
    // Long enough for a fallback, had there been one, to have opened.
    await page.waitForTimeout(2000);
    assert.deepEqual(sockets.slice(before).map((s) => s.host), [door]);
    assert.equal(await clients(page), 1);
    await typed(page, 'beta at home');
    assert.match(stand.serverLog(), /socket-via.*"via":"direct".*"why":"open"/);
  });

  test('the door refuses a socket that shows no ticket, or a made-up one', async () => {
    const { page } = stand;
    const door = stand.door;
    const outcome = (qs) => page.evaluate((url) => new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { ws.close(); resolve('open'); };
      ws.onclose = () => resolve('closed');
    }), `ws://${door}/ws?session=alpha${qs}`);
    assert.equal(await outcome(''), 'closed');
    assert.equal(await outcome('&ticket=made-up'), 'closed');
    assert.match(stand.serverLog(), /door: socket refused, no live ticket/);
  });
});


describe('a door that is not there', () => {
  let stand;
  let sockets;
  before(async () => {
    stand = await startStand({ sessions: ['alpha', 'beta'], door: 'dead', uplinks: 'eth0=роутер' });
    sockets = watchSockets(stand.page);
  });
  after(async () => { await stand.stop(); });

  test('costs a try and leaves the terminal on its own host', async () => {
    const { page, base } = stand;
    const hostName = new URL(base).host;
    await stand.open();
    await stand.attach('alpha');
    // Let the config frame arrive and the background try have its turn.
    await page.waitForTimeout(4000);
    await stand.attach('beta');
    await typed(page, 'still the long way');
    const m = await mark(stand);
    assert.equal(m.glyph, '↗', `the header does not say the socket goes the long way: ${JSON.stringify(m)}`);
    const open = sockets.filter((s) => s.open);
    assert.deepEqual(open.map((s) => s.host), [hostName]);
    assert.equal(await clients(page), 1);
    // The miss is held: the switch to beta did not wait for the door again.
    assert.ok(sockets.filter((s) => s.host !== hostName).length <= 1,
      `the door was tried ${sockets.filter((s) => s.host !== hostName).length} times`);
    assert.deepEqual(stand.pageErrors, []);
  });
});
