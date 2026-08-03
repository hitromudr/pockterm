// A real pockterm, a real browser, a phone-shaped viewport.
//
// The unit tests here cover pure functions, which is why every clipboard and
// layout bug so far was found by the owner on his phone instead of by CI.
// This stand exists to move that boundary: it runs the actual binary against
// its own private tmux server and drives it with Chromium.
//
// Private tmux matters — the box this runs on serves the owner's real
// sessions through the same tmux, and a test must not list, attach to, or
// kill any of them. TMUX_TMPDIR gives the test its own server.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.PT_UI_CHROME || '/usr/bin/chromium';

// A port per stand, not per suite. `node --test test/ui/` runs the files in
// parallel processes, so a fixed port means the second stand's server never
// binds and its page talks to the first one's — which showed up as a session
// list that was somebody else's, not as a port error.
// PT_UI_PORT still pins it for a single file, which is what a debugger wants.
async function freePort() {
  if (process.env.PT_UI_PORT) return Number(process.env.PT_UI_PORT);
  const probe = createServer();
  await new Promise((res) => probe.listen(0, '127.0.0.1', res));
  const { port } = probe.address();
  await new Promise((res) => probe.close(res));
  return port;
}

async function waitForServer(url, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not answer on ${url}`);
}

// The stand creates and destroys tmux sessions, and this machine serves the
// owner's real ones. Every tmux call below must therefore land on the private
// server; this checks that it does instead of trusting that it does.
//
// Trusting the environment is exactly what went wrong the first time: this
// suite is developed from inside a tmux session, TMUX leaked into the child
// environment, and tmux honoured it over TMUX_TMPDIR — the tests created their
// sessions on the owner's live server. Hence both belts below: the socket is
// named explicitly with -S, and TMUX is scrubbed from the environment pockterm
// inherits.
function tmuxArgs(socket, rest) {
  return ['-S', socket, ...rest];
}

function assertPrivateTmux(socket, dir, env) {
  const seen = execFileSync('tmux', tmuxArgs(socket, ['display-message', '-p', '#{socket_path}']), { env })
    .toString().trim();
  if (!seen.startsWith(dir)) {
    throw new Error(`refusing to run: tmux socket ${seen} is outside the test directory ${dir}`);
  }
}

// raw:true starts the session under `stty raw -echo; cat -v` instead of a
// shell. Then the screen is a transcript of the bytes that reached the pty —
// escape sequences and control characters shown as ^[ and ^? — so a test can
// assert what was sent rather than what it looks like. Duplicates and
// swallowed keys become arithmetic instead of guesswork.
export async function startStand({ sessions = ['demo'], raw = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pockterm-ui-'));
  const port = await freePort();
  const uploads = join(dir, 'uploads');
  const env = {
    ...process.env,
    TMUX_TMPDIR: dir,
    POCKTERM_LISTEN: `127.0.0.1:${port}`,
    POCKTERM_UPLOAD_DIR: uploads,
    POCKTERM_TG_TOKEN: '',
    POCKTERM_TG_CHAT: '',
  };
  // Inside a tmux session these two point every child at that session's
  // server, whatever TMUX_TMPDIR says.
  delete env.TMUX;
  delete env.TMUX_PANE;

  // Where tmux puts its socket for this TMUX_TMPDIR — pockterm finds it
  // through the environment, the lines below name it outright.
  const socketDir = join(dir, `tmux-${process.getuid()}`);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const socket = join(socketDir, 'default');

  const sessionCmd = raw ? 'stty raw -echo; exec cat -v' : 'cat';
  for (const name of sessions) {
    execFileSync('tmux', tmuxArgs(socket, ['new-session', '-d', '-s', name, 'sh', '-c', sessionCmd]), { env });
  }
  // In raw mode the screen is read as a transcript that only ever grows at the
  // end. tmux's status line breaks that reading twice over: it sits below the
  // pane, so it lands at the end of the screen's text, and it rewrites itself
  // with the clock. Off, the screen holds the bytes and nothing else.
  if (raw) {
    execFileSync('tmux', tmuxArgs(socket, ['set-option', '-g', 'status', 'off']), { env });
  }
  assertPrivateTmux(socket, dir, env);

  // A Makefile the presets can reach. The real one launches agents through
  // the sandbox wrapper; here the targets only have to produce a session on
  // the private server, which is what the page and the endpoint are about.
  writeFileSync(join(dir, 'Makefile'), [
    'shell:',
    `\ttmux -S ${socket} new-session -d -s shell-$$$$ sh -c cat`,
    'claude:',
    `\ttmux -S ${socket} new-session -d -s claude-$$$$ sh -c cat`,
    '',
  ].join('\n'));
  env.POCKTERM_SESSION_DIR = dir;

  const server = spawn(join(ROOT, 'bin', 'pockterm'), [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  server.stdout.on('data', (d) => log.push(String(d)));
  server.stderr.on('data', (d) => log.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/api/sessions`);

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  // A phone, not a desktop: touch, a narrow viewport, and the clipboard
  // permissions Chrome would ask a human for.
  const context = await browser.newContext({
    viewport: { width: 390, height: 780 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  // Две разные вещи, и смешивать их нельзя. `pageerror` — необработанное
  // исключение, то есть всегда дефект: именно так страница умирала на загрузке
  // с ReferenceError, а телефон показывал это как машину без tmux-сессий.
  // Вывод в консоль бывает и безобидным — браузер сам просит /favicon.ico,
  // которого в бинаре нет, и пишет про 404.
  const consoleErrors = [];
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(String(e)); consoleErrors.push(String(e)); });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  return {
    page,
    base,
    uploads,
    consoleErrors,
    pageErrors,
    serverLog: () => log.join(''),
    // `query` открывает страницу с параметрами адреса — их читает выбор
    // режима клавиатуры (`?ime=`), и без этого его в стенде не потрогать.
    async open(query = '') {
      await page.goto(base + query);
      // The app restores the session it was last attached to (that is what
      // makes an orientation reload survivable), so a second open lands in
      // the terminal, not on the list.
      if (await page.locator('#screen-term:not([hidden])').count()) {
        await page.click('#back');
      }
      await page.waitForSelector('#session-list li');
    },
    // Attach to a session and wait until the terminal is live.
    async attach(name = sessions[0]) {
      await page.click(`button.session:has-text("${name}")`);
      await page.waitForSelector('#screen-term:not([hidden])');
      await page.waitForFunction(() => !document.getElementById('status') ||
        document.getElementById('status').hidden);
    },
    async stop() {
      await browser.close().catch(() => {});
      server.kill('SIGTERM');
      // Checked again on the way out: kill-server is the one command here
      // that could ruin somebody's day if it reached the wrong socket.
      try {
        assertPrivateTmux(socket, dir, env);
        execFileSync('tmux', tmuxArgs(socket, ['kill-server']), { env, stdio: 'ignore' });
      } catch (_) { /* already gone, or not ours to kill */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
