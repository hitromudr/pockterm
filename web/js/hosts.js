// Several hosts on one page. Each host runs a pockterm of its own, and the page
// lists the sessions of all of them in one strip, attaches to each at its own
// host and starts a new one where it is told to.
//
// The page does the federating, not a server: a page served by one host asks
// the others itself (their addresses come from /api/peers). Forwarding through
// the host that served the page was turned down — a host switched off or under
// load would take the other one's sessions off the phone with it, and taking
// load off that host is why there are two.
//
// This host's sessions keep their bare names, everywhere — in the strip, in
// storage, on the wire — so a page with one host is exactly the page it was.
// Another host's session is `name@host` inside the page and plain `name` on its
// own host's wire: tmux and every handler there know it by the bare name, and
// the page needs one string per session that cannot collide across hosts. A host
// name keeps to the session alphabet (POCKTERM_HOST_NAME), so it never holds the
// separator, and a suffix is read as a host only when it names a known one.

import { builtinId } from './kinds.js';

export const SEP = '@';

// How long another host is waited for. The strip is polled every few seconds
// and a host that is off answers nothing at all, so its absence has to cost less
// than a poll.
export const PEER_WAIT = 2500;

// readPeers(answer) → { self, hosts: [{ name, url, direct }] }, from what
// /api/peers answered. Anything unreadable — an older server, which answers this
// path with the page itself, or no answer at all — is one host, which is what
// that server is.
export function readPeers(answer) {
  const one = { self: '', hosts: [] };
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.hosts)) return one;
  const self = typeof answer.self === 'string' ? answer.self : '';
  const hosts = [];
  const seen = new Set();
  for (const h of answer.hosts) {
    if (!h || typeof h.name !== 'string' || !h.name || h.name.includes(SEP) || seen.has(h.name)) continue;
    seen.add(h.name);
    hosts.push({
      name: h.name,
      url: typeof h.url === 'string' ? h.url.replace(/\/+$/, '') : '',
      direct: typeof h.direct === 'string' ? h.direct : '',
    });
  }
  if (!self || !seen.has(self)) return one;
  return { self, hosts };
}

// multi(p) says whether there is anybody besides this host.
export function multi(p) {
  return !!p && p.hosts.length > 1;
}

// others(p) → the names of the hosts besides this one, in the listed order.
export function others(p) {
  return multi(p) ? p.hosts.filter((h) => h.name !== p.self).map((h) => h.name) : [];
}

// qualify(name, host) → the page's name for a session: bare for this host
// (host ''), `name@host` for another.
export function qualify(name, host) {
  return host ? `${name}${SEP}${host}` : name;
}

// splitName(q, p) → { name, host }: the session's name on its own host and that
// host, '' being this one. A suffix that names no other host is part of the name.
export function splitName(q, p) {
  const s = String(q == null ? '' : q);
  const at = s.lastIndexOf(SEP);
  if (at > 0 && multi(p)) {
    const host = s.slice(at + 1);
    if (host !== p.self && p.hosts.some((h) => h.name === host)) return { name: s.slice(0, at), host };
  }
  return { name: s, host: '' };
}

// hostLabel(host, p) → what to call a host out loud: '' is this one.
export function hostLabel(host, p) {
  return host || (p && p.self) || '';
}

// baseOf(host, p) → where that host's API lives: '' for this one (the page's
// own origin, relative paths as always), the configured URL for another, null
// for a host the page does not know — which must never fall back to this one,
// or a session of the same name here would answer for it.
export function baseOf(host, p) {
  if (!host) return '';
  const h = p && p.hosts.find((x) => x.name === host);
  return h && h.url ? h.url : null;
}

// apiURL(base, path, qs) → the address of one of a host's endpoints.
export function apiURL(base, path, qs) {
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

// socketURL(base, loc, qs) → the terminal socket of a host, by the same way the
// page reaches its API there.
export function socketURL(base, loc, qs) {
  if (!base) {
    const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${loc.host}/ws?${qs}`;
  }
  return `${base.replace(/^http/, 'ws')}/ws?${qs}`;
}

// isCross(base, loc) says whether that host is another origin than the page.
// A host put under a path of the page's own door is not: nothing below applies
// to it, and that is the arrangement that needs nothing from the browser.
export function isCross(base, loc) {
  if (!base) return false;
  try { return new URL(base).origin !== loc.origin; } catch (_) { return true; }
}

// requestInit(init, cross) → what fetch is handed for that host.
//
// Across origins the request carries credentials — the door's client
// certificate is one, and a browser offers it to a foreign origin only for a
// credentialed request — and it is kept *simple*: no header but a text/plain
// content type, so no preflight is sent. A preflight goes without credentials,
// and a door that asks for a certificate refuses it before the host can say
// yes. The host decodes its body whatever the content type, and finds the file
// type of an upload from its bytes.
export function requestInit(init, cross) {
  const base = init || {};
  if (!cross) return base;
  const out = { ...base, mode: 'cors', credentials: 'include' };
  delete out.headers;
  if (base.body !== undefined && base.body !== null) out.headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
  return out;
}

// mergeLists(p, answers) → { sessions, down, error } — one list out of every
// host's answer, in the listed order of the hosts.
//
// answers maps a host ('' for this one) to { sessions } or { error }. Another
// host's sessions are renamed `name@host` and carry `host`; this host's are
// passed as they came. `down` is the hosts that did not answer, with why, in
// order — the page draws them grey rather than dropping them, since a host
// that has simply vanished from the list reads as a host with no sessions.
// `error` is set only when nobody answered, and it is this host's: that is the
// one-host page's message, and with one host it is the only answer there is.
export function mergeLists(p, answers) {
  const order = multi(p) ? p.hosts.map((h) => (h.name === p.self ? '' : h.name)) : [''];
  const sessions = [];
  const down = [];
  let answered = 0;
  for (const host of order) {
    const a = answers.get(host);
    if (!a || a.error) {
      down.push({ host, why: (a && a.error) || 'no answer' });
      continue;
    }
    answered++;
    for (const s of a.sessions || []) {
      if (!host) { sessions.push(s); continue; }
      const out = { ...s, name: qualify(s.name, host), host };
      if (s.kind) out.kind = qualifyKind(s.kind, host);
      sessions.push(out);
    }
  }
  if (!answered) {
    const mine = answers.get('');
    return { sessions: [], down, error: (mine && mine.error) || 'no connection to the server' };
  }
  return { sessions, down, error: '' };
}

// byHost(names, p) → Map host → bare names, each host in the order its names
// came: what a strip dragged across hosts saves, one host at a time.
export function byHost(names, p) {
  const out = new Map();
  for (const q of names) {
    const { name, host } = splitName(q, p);
    if (!out.has(host)) out.set(host, []);
    out.get(host).push(name);
  }
  return out;
}

// A custom button's id means something on its own host only: ser8's b1 and this
// host's b1 are two different buttons, and a tab opened on ser8 drew the mark of
// the one here (2026-11-04, Codex's ☀️ on a Claude session). So another host's
// custom kind carries its host — `custom:b1@ser8` — and that host's buttons are
// listed under the same qualified ids (hostButtons). The four built-in kinds are
// left as they are: their marks are this page's vocabulary on every host.
const CUSTOM = 'custom:';

export function qualifyKind(kind, host) {
  if (!host || !kind || !kind.startsWith(CUSTOM)) return kind;
  return `${kind}${SEP}${host}`;
}

// hostButtons(host, buttons) → another host's custom buttons, with ids qualified
// the way qualifyKind qualifies its sessions' kinds. For drawing marks and names
// only: they are never offered in this host's menu or editor.
export function hostButtons(host, buttons) {
  return (buttons || [])
    .filter((b) => b && b.id && !builtinId(b.id))
    .map((b) => ({ ...b, id: `${b.id}${SEP}${host}` }));
}

// The buttons are one list for every host (owner's word, 2026-11-04: «кнопки
// общие»). The "+" menu draws this host's list whichever host the new session is
// for, and a session's kind names a button by id — so two lists would mean a
// button that starts one thing here and another there, and a tab drawn with a
// mark it was not started by.
//
// shareButtons(list, hosts, post) → the hosts that did not take it. Called after
// this host has saved the list, with the other hosts that are up; `post(host,
// body)` resolves to a fetch Response. Every host is asked, a refusal from one
// does not stop the rest, and the page says which ones are behind.
export async function shareButtons(list, hosts, post) {
  const body = JSON.stringify({ buttons: list });
  const answers = await Promise.all(hosts.map(async (h) => {
    try {
      const res = await post(h, body);
      return res && res.ok ? '' : h;
    } catch (_) {
      return h;
    }
  }));
  return answers.filter(Boolean);
}
