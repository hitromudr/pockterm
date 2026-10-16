// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUrls, openable, linksOnRows, logicalLine } from '../web/js/urls.js';

const urls = (s) => findUrls(s).map((m) => m.url);

test('a URL in a line is found where it is', () => {
  assert.deepEqual(findUrls('see https://x.org/a?b=1#c now'),
    [{ start: 4, end: 25, url: 'https://x.org/a?b=1#c' }]);
  assert.deepEqual(urls('http://127.0.0.1:3030/x and https://y.ru'), ['http://127.0.0.1:3030/x', 'https://y.ru']);
});

test('what ends the sentence is not part of the link', () => {
  assert.deepEqual(urls('see https://x.org/a.'), ['https://x.org/a']);
  assert.deepEqual(urls('https://x.org/a, https://y.org/b;'), ['https://x.org/a', 'https://y.org/b']);
  assert.deepEqual(urls('done: https://x.org/a…'), ['https://x.org/a']);
});

test('a bracket closes the link only when the link did not open it', () => {
  assert.deepEqual(urls('(https://x.org/a)'), ['https://x.org/a']);
  assert.deepEqual(urls('https://en.wikipedia.org/wiki/Go_(language)'), ['https://en.wikipedia.org/wiki/Go_(language)']);
  // Markdown, as the agent writes it when it is not drawing the link itself.
  assert.deepEqual(urls('[docs](https://x.org/d).'), ['https://x.org/d']);
});

test('quotes and markup end a link', () => {
  assert.deepEqual(urls('"https://x.org/q" <https://y.org/a>'), ['https://x.org/q', 'https://y.org/a']);
  assert.deepEqual(urls('`https://x.org/c`'), ['https://x.org/c']);
});

test('a bare scheme is no link', () => {
  assert.deepEqual(urls('https:// and http://'), []);
  assert.deepEqual(urls('https:///path'), []);
});

test('only the web is opened', () => {
  assert.equal(openable('https://x.org/a'), true);
  assert.equal(openable('http://127.0.0.1:3030/'), true);
  // Claude Code links file paths too; they name a file on the host.
  assert.equal(openable('file:///home/dms/work/x.go'), false);
  assert.equal(openable('javascript:alert(1)'), false);
  assert.equal(openable('not a url'), false);
});

const row = (s) => ({ cells: [...s].map((chars) => ({ chars, width: 1 })) });

test('a link wrapped over rows is one link, with the cells it covers', () => {
  const rows = [row('go https://x.or'), row('g/long/path ok')];
  assert.deepEqual(linksOnRows(rows), [{
    url: 'https://x.org/long/path',
    start: { row: 0, col: 3 },
    end: { row: 1, col: 10 },
  }]);
});

test('a wide character before a link does not move it a cell left', () => {
  // 日 is one character in two cells; xterm gives the second cell no characters
  // and a width of zero.
  const rows = [{
    cells: [
      { chars: '日', width: 2 }, { chars: '', width: 0 },
      ...[...' https://x.org'].map((chars) => ({ chars, width: 1 })),
    ],
  }];
  assert.equal(logicalLine(rows).text, '日 https://x.org');
  const [link] = linksOnRows(rows);
  assert.deepEqual([link.start, link.end], [{ row: 0, col: 3 }, { row: 0, col: 15 }]);
});

test('an empty cell is a space and ends a link', () => {
  const rows = [{ cells: [...'https://x.org'].map((chars) => ({ chars, width: 1 })).concat([{ chars: '', width: 1 }, { chars: 'z', width: 1 }]) }];
  assert.deepEqual(linksOnRows(rows).map((l) => l.url), ['https://x.org']);
});
