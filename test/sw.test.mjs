import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');

// The worker in a box: its listeners, a cache store keyed by URL, and a fetch
// the test answers.
function worker(answer) {
  const listeners = {};
  const store = new Map();
  const cache = {
    put: async (req, res) => { store.set(typeof req === 'string' ? req : req.url, res); },
    addAll: async () => {},
    keys: async () => [],
    delete: async () => true,
  };
  const ctx = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      registration: {},
      clients: {},
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
      match: async (req) => store.get(typeof req === 'string' ? req : req.url),
    },
    fetch: async (req) => answer(req),
    location: { origin: 'https://pt.test' },
    URL,
    Response,
  };
  vm.runInNewContext(SRC, ctx);
  const get = (path) => {
    let answered = null;
    listeners.fetch({
      request: { url: `https://pt.test${path}`, method: 'GET' },
      respondWith: (p) => { answered = p; },
    });
    return answered;
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { get, store, settle };
}

const ok = (body) => new Response(body, { status: 200 });

test('a 502 from the door is answered from the cache, not run as the script', async () => {
  // 2026-10-16: the tunnel behind the door blinked, the door said 502 in HTML
  // for vendor/xterm.js, the page ran that as a script and stayed blank.
  let status = 200;
  const w = worker(() => (status === 200 ? ok('var Terminal = 1;') : new Response('<html>502</html>', { status })));
  await (await w.get('/vendor/xterm.js')).text();
  await w.settle();
  status = 502;
  const res = await w.get('/vendor/xterm.js');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'var Terminal = 1;');
});

test('a gateway error never replaces the copy in the cache', async () => {
  let status = 200;
  const w = worker(() => (status === 200 ? ok('good') : new Response('bad', { status })));
  await w.get('/js/app.js');
  await w.settle();
  status = 504;
  await w.get('/js/app.js');
  await w.settle();
  assert.equal(await w.store.get('https://pt.test/js/app.js').clone().text(), 'good');
});

test('with nothing cached the error itself is what the page gets', async () => {
  const w = worker(() => new Response('bad gateway', { status: 502 }));
  const res = await w.get('/vendor/xterm.js');
  assert.equal(res.status, 502);
});

test('an answer the app gave, error or not, is passed through', async () => {
  let status = 200;
  const w = worker(() => (status === 200 ? ok('old') : new Response('gone', { status })));
  await w.get('/api/thing');
  await w.settle();
  status = 404;
  const res = await w.get('/api/thing');
  assert.equal(res.status, 404);
});

test('every page module is precached', () => {
  // A module missing here fails the whole import graph offline: app.js never
  // runs, and the screen stays blank with nothing in the journal.
  const mods = readdirSync(new URL('../web/js/', import.meta.url)).filter((f) => f.endsWith('.js'));
  const missing = mods.filter((f) => !SRC.includes(`'/js/${f}'`));
  assert.deepEqual(missing, []);
});
