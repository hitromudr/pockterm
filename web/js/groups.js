// Tabs of one project, folded into one tab (a setting, #tab-groups).
//
// The project is read off where the pane is, not off the name. Names were the
// first guess and the owner's own strip refutes it: `xnt-lr-845` and
// `xnt-lr-tdebt-527` are sessions in ~/work/exante beside one called `exante`,
// and nothing in their names says so. The server already hands the directory
// over (`dir`, shortened against the projects root by `session.ShortDir`), so
// the project is its first segment.

// projectOf answers which project a session is in, or '' for one the server
// gave no directory for — that one stands alone, since a guess here would put a
// tab where nobody would look for it.
//
// `dir` comes in three shapes (see ShortDir): relative to the projects root
// (`pockterm/web` → `pockterm`; the root itself arrives as its own base name),
// under home (`~/notes/x` → `~/notes`), or absolute, which is kept whole — a
// first segment of `/` would put every such session in one group called `tmp`.
export function projectOf(s) {
  const dir = (s && s.dir) || '';
  if (!dir) return '';
  if (dir.startsWith('/')) return dir;
  if (dir === '~') return dir;
  if (dir.startsWith('~/')) return '~/' + dir.slice(2).split('/')[0];
  return dir.split('/')[0];
}

// groupSessions lays the strip out: one item per tab, in the order the sessions
// came in. A group stands where its first member stood, which is the owner's
// order — a carried tab is saved as a run of names, so the run stays together.
// A project with one session is a plain tab: a group of one is a tap that opens a
// list with the tab already in it.
export function groupSessions(sessions) {
  const items = [];
  const at = new Map();
  for (const s of sessions) {
    const key = projectOf(s);
    if (key && at.has(key)) {
      at.get(key).sessions.push(s);
      continue;
    }
    const item = { key, sessions: [s] };
    if (key) at.set(key, item);
    items.push(item);
  }
  for (const it of items) it.group = it.sessions.length > 1;
  return items;
}

// What a tab answers about a session, which a group has to answer for all of
// its members at once: the state as one value, the background as sums.
//
// The state is the most urgent of the members', in the order a person would want
// to be told: a question first (it is waiting for somebody), then work going on,
// then a finish. A group that is green while one of its tabs asks would hide the
// one thing the strip exists to show.
const URGENCY = ['asking', 'working', 'done'];

export function groupState(sessions) {
  for (const st of URGENCY) {
    if (sessions.some((s) => s.state === st)) return st;
  }
  return '';
}

// Summed rather than collected: the plates and the heads already read a number,
// so the group's tab draws exactly what one tab with all of that running would.
const SUMMED = ['shells', 'monitors', 'agents', 'workflows'];

export function groupBackground(sessions) {
  const sum = {};
  for (const f of SUMMED) sum[f] = sessions.reduce((n, s) => n + (s[f] || 0), 0);
  return sum;
}

// The strip's signature: what, if it changed, means the row has to be rebuilt
// rather than repainted. Names alone while the tabs stand apart, and the groups
// as well when they are folded — a session moving into a project is a tab that
// disappears.
export function stripSignature(sessions, grouped) {
  const names = sessions.map((s) => s.name).join('\u0000');
  if (!grouped) return names;
  const shape = groupSessions(sessions)
    .map((it) => (it.group ? `${it.key}\u0002${it.sessions.length}` : ''))
    .join('\u0003');
  return `${names}\u0001${shape}`;
}
