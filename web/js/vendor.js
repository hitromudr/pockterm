// The two classic scripts the page cannot draw without, fetched again when they
// did not arrive.
//
// vendor/xterm.js and vendor/addon-fit.js are plain <script> tags ahead of the
// module, and one that failed leaves no trace: the journal's error listener is
// installed by the module, after they have run. On 2026-10-16 the door said 502
// for xterm.js while the tunnel behind it blinked, the page ran that as a script,
// and the screen stayed blank until a reload. Here the missing one is fetched
// once more and run as inline text — a second <script src> could be answered
// from the browser's memory with the same bad body.
export const VENDOR = [
  ['vendor/xterm.js', 'Terminal'],
  ['vendor/addon-fit.js', 'FitAddon'],
];

// `win` names the globals, `get` fetches, `run` executes text as a script and
// `wait` paces the tries; all four are here so a test can stand in for them.
// Returns one line per file that was missing, for the journal.
export async function bringBack({ win, get, run, wait, tries = 3 }) {
  const lines = [];
  for (const [src, name] of VENDOR) {
    if (win[name]) continue;
    const line = { file: src, ok: false, tries: 0, status: 0 };
    for (let n = 1; n <= tries && !win[name]; n++) {
      line.tries = n;
      try {
        const res = await get(src);
        line.status = res.status;
        if (res.ok) run(await res.text());
      } catch (e) {
        line.error = String((e && e.message) || e);
      }
      if (!win[name] && n < tries) await wait(n * 1000);
    }
    line.ok = !!win[name];
    lines.push(line);
  }
  return lines;
}
