// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readPeers, multi, others, qualify, splitName, hostLabel, baseOf, apiURL, socketURL,
  isCross, requestInit, mergeLists, byHost, SEP,
} from '../web/js/hosts.js';
import { projectOf, groupSessions } from '../web/js/groups.js';

const two = readPeers({
  self: 'rpi5',
  hosts: [
    { name: 'rpi5', url: 'https://cc.example', direct: 'https://lan.example:8135' },
    { name: 'ser8', url: 'https://cc.example:8446/', direct: 'https://lan8.example:8135' },
  ],
});
const page = { host: 'cc.example', origin: 'https://cc.example', protocol: 'https:' };

test('peers are read as listed, and anything else is one host', () => {
  assert.deepEqual(two, {
    self: 'rpi5',
    hosts: [
      { name: 'rpi5', url: 'https://cc.example', direct: 'https://lan.example:8135' },
      { name: 'ser8', url: 'https://cc.example:8446', direct: 'https://lan8.example:8135' },
    ],
  });
  assert.equal(multi(two), true);
  assert.deepEqual(others(two), ['ser8']);
  const one = { self: '', hosts: [] };
  // An older server answers /api/peers with the page itself; no answer at all.
  for (const a of [null, undefined, 'html', {}, { hosts: 'x' }, { self: 'x', hosts: [] },
    { self: 'gone', hosts: [{ name: 'ser8', url: 'https://x' }] }]) {
    assert.deepEqual(readPeers(a), one, JSON.stringify(a));
  }
  // A server with no peers lists itself alone: still one host.
  const alone = readPeers({ self: 'rpi5', hosts: [{ name: 'rpi5' }] });
  assert.deepEqual(alone, { self: 'rpi5', hosts: [{ name: 'rpi5', url: '', direct: '' }] });
  assert.equal(multi(alone), false);
  assert.deepEqual(others(alone), []);
  // A name with the separator, or twice, is dropped rather than half-read.
  assert.deepEqual(readPeers({ self: 'a', hosts: [{ name: 'a' }, { name: 'b@c' }, { name: 'a', url: 'https://x' }] }).hosts,
    [{ name: 'a', url: '', direct: '' }]);
});

test('names: bare here, name@host there, and only a known host is split off', () => {
  assert.equal(SEP, '@');
  assert.equal(qualify('claude-1', ''), 'claude-1');
  assert.equal(qualify('claude-1', 'ser8'), 'claude-1@ser8');
  assert.deepEqual(splitName('claude-1@ser8', two), { name: 'claude-1', host: 'ser8' });
  assert.deepEqual(splitName('claude-1', two), { name: 'claude-1', host: '' });
  // This host's own name, an unknown one, or one host only: part of the name.
  assert.deepEqual(splitName('x@rpi5', two), { name: 'x@rpi5', host: '' });
  assert.deepEqual(splitName('x@nowhere', two), { name: 'x@nowhere', host: '' });
  assert.deepEqual(splitName('x@ser8', readPeers(null)), { name: 'x@ser8', host: '' });
  assert.deepEqual(splitName('@ser8', two), { name: '@ser8', host: '' });
  assert.deepEqual(splitName('a@b@ser8', two), { name: 'a@b', host: 'ser8' });
  assert.equal(hostLabel('', two), 'rpi5');
  assert.equal(hostLabel('ser8', two), 'ser8');
});

test('addresses: this host relative, another by its URL, an unknown one nowhere', () => {
  assert.equal(baseOf('', two), '');
  assert.equal(baseOf('ser8', two), 'https://cc.example:8446');
  assert.equal(baseOf('nowhere', two), null);
  assert.equal(baseOf('rpi5', readPeers({ self: 'ser8', hosts: [{ name: 'ser8' }, { name: 'rpi5' }] })), null);
  assert.equal(apiURL('', '/api/sessions', ''), '/api/sessions');
  assert.equal(apiURL('', '/api/sessions', 'token=t'), '/api/sessions?token=t');
  assert.equal(apiURL('https://cc.example:8446', '/api/sessions/new', 'token=t'), 'https://cc.example:8446/api/sessions/new?token=t');
  assert.equal(apiURL('https://cc.example/@ser8', '/api/dirs', ''), 'https://cc.example/@ser8/api/dirs');
  assert.equal(socketURL('', page, 'session=a'), 'wss://cc.example/ws?session=a');
  assert.equal(socketURL('', { host: 'localhost:8130', protocol: 'http:' }, 'session=a'), 'ws://localhost:8130/ws?session=a');
  assert.equal(socketURL('https://cc.example:8446', page, 'session=a'), 'wss://cc.example:8446/ws?session=a');
  assert.equal(socketURL('https://cc.example/@ser8', page, 'session=a'), 'wss://cc.example/@ser8/ws?session=a');
  assert.equal(socketURL('http://10.0.0.2:8130', page, 'session=a'), 'ws://10.0.0.2:8130/ws?session=a');
});

test('another origin is credentialed and kept simple; the same origin is left alone', () => {
  assert.equal(isCross('', page), false);
  assert.equal(isCross('https://cc.example/@ser8', page), false);
  assert.equal(isCross('https://cc.example:8446', page), true);
  assert.equal(isCross('https://other.example', page), true);

  const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"a"}' };
  assert.equal(requestInit(post, false), post);
  assert.deepEqual(requestInit(undefined, false), {});
  assert.deepEqual(requestInit(post, true), {
    method: 'POST', body: '{"name":"a"}', mode: 'cors', credentials: 'include',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
  });
  // The caller's object is not changed under it.
  assert.deepEqual(post.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(requestInit(undefined, true), { mode: 'cors', credentials: 'include' });
  assert.deepEqual(requestInit({ headers: { 'X-Thing': '1' } }, true), { mode: 'cors', credentials: 'include' });
});

test('one list out of every host, in the listed order, the silent ones grey', () => {
  const ser8First = readPeers({ self: 'rpi5', hosts: [{ name: 'ser8', url: 'https://s' }, { name: 'rpi5' }] });
  const answers = new Map([
    ['', { sessions: [{ name: 'claude-1', dir: 'work' }] }],
    ['ser8', { sessions: [{ name: 'claude-1', dir: 'Vita' }, { name: 'sh', dir: '' }] }],
  ]);
  assert.deepEqual(mergeLists(ser8First, answers), {
    sessions: [
      { name: 'claude-1@ser8', dir: 'Vita', host: 'ser8' },
      { name: 'sh@ser8', dir: '', host: 'ser8' },
      { name: 'claude-1', dir: 'work' },
    ],
    down: [],
    error: '',
  });
  // ser8 off: this host's sessions alone, and ser8 said to be off.
  assert.deepEqual(mergeLists(two, new Map([['', { sessions: [{ name: 'a' }] }], ['ser8', { error: 'no connection' }]])), {
    sessions: [{ name: 'a' }], down: [{ host: 'ser8', why: 'no connection' }], error: '',
  });
  // This host off and ser8 up: ser8's sessions, and this host grey.
  assert.deepEqual(mergeLists(two, new Map([['', { error: 'server said 502' }], ['ser8', { sessions: [{ name: 'b' }] }]])), {
    sessions: [{ name: 'b@ser8', host: 'ser8' }], down: [{ host: '', why: 'server said 502' }], error: '',
  });
  // Nobody: this host's own message, which is the one-host page's.
  assert.deepEqual(mergeLists(two, new Map([['', { error: 'unauthorized' }], ['ser8', { error: 'x' }]])), {
    sessions: [], down: [{ host: '', why: 'unauthorized' }, { host: 'ser8', why: 'x' }], error: 'unauthorized',
  });
  // One host: exactly what that host answered, untouched.
  const mine = [{ name: 'a', dir: 'x' }];
  const one = mergeLists(readPeers(null), new Map([['', { sessions: mine }]]));
  assert.deepEqual(one, { sessions: mine, down: [], error: '' });
  assert.equal(one.sessions[0], mine[0]);
  // And an answer from a host that is not listed is not shown.
  assert.deepEqual(mergeLists(readPeers(null), new Map([['', { sessions: [] }], ['ser8', { sessions: [{ name: 'z' }] }]])).sessions, []);
});

test('a strip dragged across hosts is saved per host, in its own order', () => {
  assert.deepEqual([...byHost(['a@ser8', 'b', 'c@ser8', 'd'], two)], [['ser8', ['a', 'c']], ['', ['b', 'd']]]);
  assert.deepEqual([...byHost(['a', 'b'], readPeers(null))], [['', ['a', 'b']]]);
});

test('a project on another host is a group of its own', () => {
  assert.equal(projectOf({ dir: 'pockterm/web', host: 'ser8' }), 'pockterm@ser8');
  assert.equal(projectOf({ dir: 'pockterm-wt/multi-host', host: 'ser8' }), 'pockterm@ser8');
  assert.equal(projectOf({ dir: 'pockterm/web' }), 'pockterm');
  assert.equal(projectOf({ dir: '', host: 'ser8' }), '');
  const items = groupSessions([
    { name: 'a', dir: 'pockterm' },
    { name: 'b@ser8', dir: 'pockterm', host: 'ser8' },
    { name: 'c', dir: 'pockterm/web' },
  ]);
  assert.deepEqual(items.map((it) => [it.key, it.sessions.map((s) => s.name)]),
    [['pockterm', ['a', 'c']], ['pockterm@ser8', ['b@ser8']]]);
});
