// Links in the pane: what a tap on the terminal opens.
//
// Two kinds reach the page. A program that knows it is printing a link says so
// with OSC 8 (Claude Code does, for every URL in its output) and xterm keeps the
// target with the cells — tmux passes the sequence on only to a client that
// declares `hyperlinks`, which is why the attach line carries `-T hyperlinks`.
// Everything else — a shell, a log, `git push` printing where the pull request
// lives — is plain text, and that is found here, by looking.
//
// Only http and https are ever opened. Claude Code marks file paths as
// `file://` links too, and those name a file on the host, not anything the
// phone could open; a scheme the page does not know is no link at all.

// A URL as people print it: a scheme, then everything up to a space or a
// character no URL carries unescaped. Quotes and angle brackets end it because
// that is how a URL is quoted in prose and in markup.
const URL_RE = /https?:\/\/[^\s"'<>`\\{}|^\u0000-\u001f\u007f]+/g;

// What ends a sentence is not part of the link it ends: "see https://x.org/a."
// links to /a. Closing brackets count only when unbalanced, since
// `https://en.wikipedia.org/wiki/Go_(language)` is one link and
// `(https://x.org/a)` is a link in brackets.
const TRAILING = /[.,;:!?…]$/;
const PAIRS = { ')': '(', ']': '[' };

function trimUrl(url) {
  for (;;) {
    const last = url[url.length - 1];
    if (TRAILING.test(last)) { url = url.slice(0, -1); continue; }
    const open = PAIRS[last];
    if (open) {
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) { url = url.slice(0, -1); continue; }
    }
    return url;
  }
}

// findUrls returns every URL in a string as { start, end, url }, end exclusive.
// A bare scheme ("https://") is not a link.
export function findUrls(text) {
  const out = [];
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    const url = trimUrl(m[0]);
    if (!/^https?:\/\/[^/?#]/.test(url)) continue;
    out.push({ start: m.index, end: m.index + url.length, url });
  }
  return out;
}

// openable says whether a link target may be opened at all: http(s) with a host.
export function openable(uri) {
  try {
    const u = new URL(uri);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host;
  } catch (_) {
    return false;
  }
}

// One logical line of the buffer, as text plus where each character sits.
//
// A long URL wraps, and tmux marks the continuation as wrapped, so the line a
// link is looked for on is the whole run of wrapped rows. The text is built cell
// by cell rather than with translateToString because a wide character (CJK, an
// emoji) is one character in two cells: an offset into the string is then not a
// column, and a link after one would be drawn a cell to the left of itself.
//
//   rows   [{ cells: [{ chars, width }] }], the first row of the run first
//
// Returns { text, pos } with pos[i] = { row, col } of character i, row counted
// from the start of the run.
export function logicalLine(rows) {
  let text = '';
  const pos = [];
  rows.forEach((r, row) => {
    r.cells.forEach((c, col) => {
      if (c.width === 0) return;
      const ch = c.chars || ' ';
      // Per UTF-16 unit, since that is what a match's index counts in.
      for (let i = 0; i < ch.length; i++) pos.push({ row, col });
      text += ch;
    });
  });
  return { text, pos };
}

// linksOnRows finds the plain URLs of a run of wrapped rows, each with the
// cell range it covers: { url, start: { row, col }, end: { row, col } }, end
// inclusive, rows relative to the run.
export function linksOnRows(rows) {
  const { text, pos } = logicalLine(rows);
  return findUrls(text).map(({ start, end, url }) => ({
    url,
    start: pos[start],
    end: pos[end - 1],
  }));
}
