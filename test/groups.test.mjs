import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectOf, groupSessions, groupState, groupBackground, stripSignature } from '../web/js/groups.js';

test('the project is the first segment of where the pane is', () => {
  assert.equal(projectOf({ dir: 'pockterm' }), 'pockterm');
  assert.equal(projectOf({ dir: 'pockterm/web/js' }), 'pockterm');
  assert.equal(projectOf({ dir: '~/notes/x' }), '~/notes');
  assert.equal(projectOf({ dir: '~' }), '~');
  // Absolute is kept whole: a first segment would make one group of all of /tmp.
  assert.equal(projectOf({ dir: '/tmp/a' }), '/tmp/a');
  assert.equal(projectOf({ dir: '' }), '');
  assert.equal(projectOf({}), '');
});

// The owner's own strip on 2026-10-29: the names do not say which project, the
// directories do.
const strip = [
  { name: 'exante', dir: 'exante' },
  { name: 'anabasis', dir: 'anabasis' },
  { name: 'xnt-lr-845', dir: 'exante' },
  { name: 'pockterm', dir: 'pockterm' },
  { name: 'anabasis-t-dozer', dir: 'anabasis/src' },
  { name: 'xnt-lr-tdebt-527', dir: 'exante' },
  { name: 'loose' },
];

test('sessions of one project fold into the place of the first of them', () => {
  const items = groupSessions(strip);
  assert.deepEqual(items.map((it) => [it.key, it.group, it.sessions.map((s) => s.name)]), [
    ['exante', true, ['exante', 'xnt-lr-845', 'xnt-lr-tdebt-527']],
    ['anabasis', true, ['anabasis', 'anabasis-t-dozer']],
    ['pockterm', false, ['pockterm']],
    ['', false, ['loose']],
  ]);
});

test('sessions with no directory never fold together', () => {
  const items = groupSessions([{ name: 'a' }, { name: 'b' }]);
  assert.equal(items.length, 2);
  assert.ok(items.every((it) => !it.group));
});

test('a group says the most urgent state of its tabs', () => {
  assert.equal(groupState([{ state: 'done' }, { state: 'asking' }, { state: 'working' }]), 'asking');
  assert.equal(groupState([{ state: 'done' }, { state: 'working' }]), 'working');
  assert.equal(groupState([{ state: 'done' }, {}]), 'done');
  assert.equal(groupState([{}, { state: '' }]), '');
});

test('a group carries the sum of what runs in its tabs', () => {
  assert.deepEqual(groupBackground([
    { shells: 1, monitors: 2 },
    { shells: 2, agents: 3, workflows: 1 },
    {},
  ]), { shells: 3, monitors: 2, agents: 3, workflows: 1 });
});

test('a session moving into a project changes the signature only when folded', () => {
  const before = [{ name: 'a', dir: 'x' }, { name: 'b', dir: 'y' }];
  const after = [{ name: 'a', dir: 'x' }, { name: 'b', dir: 'x/sub' }];
  assert.equal(stripSignature(before, false), stripSignature(after, false));
  assert.notEqual(stripSignature(before, true), stripSignature(after, true));
  // A cd inside one project is not a new row.
  const inside = [{ name: 'a', dir: 'x' }, { name: 'b', dir: 'x/other' }];
  assert.equal(stripSignature(after, true), stripSignature(inside, true));
});
