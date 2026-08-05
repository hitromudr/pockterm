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
export async function startStand({
  sessions = ['demo'],
  raw = false,
  desktop = false,
  // Folders under the projects root, which here is the same temporary directory
  // the session Makefile lives in — the drawer offers these to start a session
  // in, and names the session after the one that was tapped.
  projects = ['alpha', 'beta'],
} = {}) {
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
    // The notification switch is remembered on disk, and without this the stand
    // would read — and write — the host's own file: a test run would change what
    // the owner's phone does, and the run before it would decide what this one
    // starts with.
    POCKTERM_NOTIFY_FILE: join(dir, 'notify'),
    // The custom buttons are kept on the host, and without this the host is the
    // machine running the tests: a run would edit the owner's own buttons and
    // start from whatever the run before it left behind.
    POCKTERM_PRESETS_FILE: join(dir, 'buttons.json'),
    // How much silence counts as "finished". Two seconds instead of thirty so a
    // test can watch a tab go from working to done inside one run — the same
    // threshold the notification uses, and the state the strip is coloured by.
    POCKTERM_IDLE: '2s',
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

  // Folders to start a session in, plus the noise a real projects root has:
  // a dotted directory and a plain file, neither of which belongs in the list.
  for (const p of projects) {
    mkdirSync(join(dir, p), { recursive: true });
  }
  mkdirSync(join(dir, '.git'), { recursive: true });

  // A Makefile the presets can reach. The real one launches agents through
  // the sandbox wrapper; here the targets only have to produce a session on
  // the private server, which is what the page and the endpoint are about.
  //
  // It does honour DIR and PREFIX, because those are the whole point of the
  // folder list: the session opens in the folder and is named after it. The
  // bare name is taken when free and numbered otherwise, which is what the real
  // Makefile does — a stand that always numbered would pass a test the phone
  // would fail.
  // It also stamps KIND on the session, which is how a tab knows which button
  // made it — the page reads the option back with the session list. Each target
  // has its own default, like the real Makefile, so a session started by hand is
  // typed too. No "=" before the name: set-option reads its -t as a pane and
  // answers "no such session" for the exact-match form.
  const spawnLine = (fallback, cmd, kind) => [
    `\t@n="$(or $(PREFIX),${fallback})"; `
    + `if tmux -S ${socket} ls 2>/dev/null | grep -qE "^$$n:|\\(group $$n\\)"; then n="$$n-$$$$"; fi; \\`,
    `\t tmux -S ${socket} new-session -d -s "$$n" -c "$(or $(DIR),$(CURDIR))" sh -c ${cmd}; \\`,
    `\t k="$(or $(KIND),${kind})"; `
    + `if [ -n "$$k" ]; then tmux -S ${socket} set-option -t "$$n" @pockterm-kind "$$k"; fi; \\`,
    '\t echo "started $$n in $(or $(DIR),$(CURDIR))"',
  ];
  // `custom` is what the drawer's own buttons run, with their command in CMD.
  // Here it echoes the command into the session instead of running it: what the
  // test needs to see is that the command the owner typed arrived, and `qwen` is
  // not installed on a CI runner.
  writeFileSync(join(dir, 'Makefile'), [
    'shell:',
    ...spawnLine('shell', 'cat', 'shell'),
    'claude:',
    ...spawnLine('claude', 'cat', 'claude'),
    'custom:',
    `\t@test -n "$(CMD)" || { echo "usage: make custom CMD='qwen'"; exit 2; }`,
    ...spawnLine('custom', `'echo ran: $(CMD); exec cat'`, 'custom'),
    // A target the four do not cover, which is the case a button naming a target
    // exists for: the author's own Makefile has `cont-yolo`, and until buttons
    // could name a target there was no way to reach it from a phone.
    'cont-yolo:',
    ...spawnLine('cont', `'echo ran: the cont-yolo target; exec cat'`, 'custom'),
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
  // A phone by default. `desktop` is the other client this serves — the owner's
  // laptop opens the same page in Chrome, with a mouse and no touch at all, and
  // nothing covered it until a report came in from there.
  // `notifications` is granted for the same reason as the clipboard, and for one
  // more: the page asks for that permission at the first touch when the host says
  // it notifies, and the first touch in most of these tests is the start of a
  // swipe. A prompt the browser raises there is a prompt in the middle of the
  // gesture being measured.
  const allowed = ['clipboard-read', 'clipboard-write', 'notifications'];
  const context = await browser.newContext(desktop ? {
    viewport: { width: 1280, height: 800 },
    permissions: allowed,
  } : {
    viewport: { width: 390, height: 780 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    permissions: allowed,
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

  // The session list is a drawer over the terminal, and every helper that clicks
  // a session needs it open. By state, never by toggling ☰.
  async function openDrawer() {
    const open = await page.evaluate(
      () => document.getElementById('screen-sessions').classList.contains('open'));
    if (!open) await page.click('#back');
    await page.waitForFunction(
      () => Math.abs(document.getElementById('screen-sessions').getBoundingClientRect().x) < 1,
      null, { timeout: 5000 },
    );
  }

  // The settings live at the bottom of the drawer since the ⋯ menu was emptied
  // into it, so every test that pulls a lever opens them the same way: by state,
  // like the drawer itself, because the toggle toggles.
  async function openSettings() {
    await openDrawer();
    const open = await page.evaluate(() => !document.getElementById('settings').hidden);
    if (!open) await page.click('#settings-toggle');
    await page.waitForSelector('#settings:not([hidden])');
  }

  // Put the drawer away again, by state. A test that pulled a lever in the
  // settings has to: the drawer covers the terminal, and a swipe or a keystroke
  // aimed at the terminal would land on the scrim instead.
  async function shutDrawer() {
    const open = await page.evaluate(
      () => document.getElementById('screen-sessions').classList.contains('open'));
    if (open) await page.click('#drawer-close');
    // On the geometry, not the class: the panel slides out over 200ms, and a
    // touch aimed at the terminal in the meantime lands on the drawer that is
    // still covering it — which is a swipe that never reaches the page.
    await page.waitForFunction(() => {
      const el = document.getElementById('screen-sessions');
      return !el.classList.contains('open') && el.getBoundingClientRect().right <= 0;
    }, null, { timeout: 5000 });
  }

  return {
    page,
    base,
    uploads,
    openDrawer,
    openSettings,
    shutDrawer,
    // The private tmux server this stand created. Exposed so a test can ask
    // tmux what state the page put it in: what the page shows and what tmux
    // actually thinks are two different facts, and the interesting bugs live
    // in the gap — a button that says "scrolled back" while the pane is not.
    tmux(args) {
      return execFileSync('tmux', tmuxArgs(socket, args), { env }).toString();
    },
    consoleErrors,
    pageErrors,
    serverLog: () => log.join(''),
    // `query` открывает страницу с параметрами адреса — их читает выбор
    // режима клавиатуры (`?ime=`), и без этого его в стенде не потрогать.
    async open(query = '') {
      await page.goto(base + query);
      // The app restores the session it was last attached to (that is what makes
      // an orientation reload survivable), and it does so after load. Two things
      // follow, both learned the hard way: wait for one of the two outcomes
      // before touching anything, and open the drawer by its state rather than by
      // tapping ☰ — ☰ toggles, so a blind tap raced the restore and closed the
      // drawer that had just opened itself, leaving the next click to land on the
      // terminal instead of a session.
      await page.waitForFunction(() => {
        const term = document.getElementById('screen-term');
        const drawer = document.getElementById('screen-sessions');
        return !term.hidden || drawer.classList.contains('open');
      }, null, { timeout: 10000 });
      await openDrawer();
      await page.waitForSelector('#session-list li');
    },
    // Attach to a session and wait until the terminal is live — and until the
    // drawer that was covering it has actually gone.
    //
    // The same lesson as shutDrawer, learned twice: the panel slides out over
    // 200ms, so a touch dispatched at the terminal in the meantime lands on the
    // drawer instead. It does not fail loudly — the event goes to a <ul> in the
    // drawer, never reaches #screen-term, and the test times out waiting for a
    // gesture nobody received. Latent for as long as the page was quick enough:
    // it started failing when the drawer grew four rows, which is a change to
    // the timing and not to the page.
    async attach(name = sessions[0]) {
      await openDrawer();
      await page.click(`button.session:has-text("${name}")`);
      await page.waitForSelector('#screen-term:not([hidden])');
      await page.waitForFunction(() => !document.getElementById('status') ||
        document.getElementById('status').hidden);
      await page.waitForFunction(() => {
        const el = document.getElementById('screen-sessions');
        return !el.classList.contains('open') && el.getBoundingClientRect().right <= 0;
      }, null, { timeout: 5000 });
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
