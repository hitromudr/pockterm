import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectOf, groupSessions, groupState, groupBackground, stripSignature, groupRows, groupMember } from '../web/js/groups.js';

test('the project is the first segment of where the pane is', () => {
  assert.equal(projectOf({ dir: 'pockterm' }), 'pockterm');
  assert.equal(projectOf({ dir: 'pockterm/web/js' }), 'pockterm');
  // Sibling worktree directories (<project>-wt/<branch>) belong to <project>,
  // and any other git worktree carries the repository's own project from the
  // server (`yarr-any-order` → `yarr`, `ana-wt/belt` → `anabasis`).
  assert.equal(projectOf({ dir: 'contellect-wt/layers' }), 'contellect');
  assert.equal(projectOf({ dir: '~/contellect-wt/repo-layers' }), '~/contellect');
  assert.equal(projectOf({ dir: 'yarr-any-order', project: 'yarr' }), 'yarr');
  assert.equal(projectOf({ dir: 'ana-wt/belt', project: 'anabasis' }), 'anabasis');
  assert.equal(projectOf({ dir: 'yarr-any-order', project: 'yarr', host: 'ser8' }), 'yarr@ser8');
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
  assert.equal(groupState([{ state: 'done' }, { state: 'asking' }, { state: 'error' }, { state: 'working' }]), 'asking');
  assert.equal(groupState([{ state: 'done' }, { state: 'error' }, { state: 'working' }]), 'error');
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

const shown = (rows) => rows.map((r) => {
  if (r.head) return `[${r.head}]`;
  if (r.parent) return `[${r.s.name}]`;
  return r.child ? `  ${r.s.name}` : r.s.name;
});

test('the drawer folds a project into the session named after it', () => {
  // "лишняя сущность": a head named exante with a row exante under it is one
  // thing twice, so the session is the head.
  const rows = groupRows(strip);
  assert.deepEqual(shown(rows), [
    '[exante]', '  xnt-lr-845', '  xnt-lr-tdebt-527',
    '[anabasis]', '  anabasis-t-dozer',
    'pockterm',
    'loose',
  ]);
  assert.equal(rows[0].parent, 'exante');
  assert.equal(rows[0].s.name, 'exante');
  assert.deepEqual(rows[0].members, ['exante', 'xnt-lr-845', 'xnt-lr-tdebt-527']);
});

test('a project with no session named after it gets a head that is not a session', () => {
  const rows = groupRows([
    { name: 'one', dir: 'x' }, { name: 'other', dir: 'y' }, { name: 'two', dir: 'x/a' },
  ]);
  assert.deepEqual(shown(rows), ['[x]', '  one', '  two', 'other']);
  assert.equal(rows[0].s, undefined);
  assert.deepEqual(rows[0].members, ['one', 'two']);
  // The session named after it leads its rows even when it is not first.
  assert.deepEqual(shown(groupRows([{ name: 'x-1', dir: 'x' }, { name: 'x', dir: 'x' }])), ['[x]', '  x-1']);
});

test('a group wears the mark of its chosen tab, its project tab (numbered included), or its first tab', () => {
  const members = ['con-audit@s8', 'con-bench@s8', 'con-clean@s8', 'con-split@s8', 'contellect-2@s8'];
  // Nothing visited yet, and contellect was closed leaving contellect-2@s8 beside
  // the con-* workers: contellect-2@s8 is the project's own session.
  assert.equal(groupMember(members, 'contellect@s8', ''), 'contellect-2@s8');
  assert.equal(groupMember(members, 'contellect@s8', 'con-bench@s8'), 'con-bench@s8');
  assert.equal(groupMember(['alpha-2', 'alpha', 'xnt-1'], 'alpha', ''), 'alpha');
  assert.equal(groupMember(['xnt-1', 'xnt-2'], 'exante', ''), 'xnt-1');
});
