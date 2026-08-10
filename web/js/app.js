import { keyBytes } from './keys.js';
import { detectPrompt, answerKeys } from './detect.js';
import { noticeFrom, deliver, nextMode, modeLabel, shouldAskPermission } from './notify.js';
import { linkAction } from './link.js';
import { pickImage, carriesFiles, firstImage } from './paste.js';
import { snapshotText } from './select.js';
import { initDiag, environment, report } from './diag.js';
import { watch as watchInput } from './inputdiag.js';
import { keepEmpty } from './imefield.js';
import { Scroller, movedWholeScreen } from './scroll.js';
import { staleNotice } from './update.js';
import { endingKeys, commitComposition, endEditByBlur } from './ender.js';
import { pushHistory, previewOf } from './compose.js';
import { kindMark, kindName, labelBody, shortAge, builtinId, presetOf, markOf, MARKS, CUSTOM_MARK } from './kinds.js';
import { dropIndex } from './carry.js';
import { installDecision, installText, isIOS } from './install.js';

const token = new URLSearchParams(location.search).get('token') || '';
const tokenQS = token ? `token=${encodeURIComponent(token)}` : '';

// Version of the code actually running. Bumped with the service worker's cache
// name — assets_test.go fails if the two drift, because a page that misreports
// itself is a page that never looks out of date. An installed PWA can keep
// running the version it was installed with, which is what makes the number
// worth having at all.
const APP_VERSION = 'v142';

// Diagnostics go to the server's journal — see js/diag.js for why.
initDiag((line) => {
  try {
    navigator.sendBeacon(`/api/log?${tokenQS}`, new Blob([JSON.stringify(line)], { type: 'application/json' }));
  } catch (_) { /* never break the app over a log line */ }
});
report('hello', environment(APP_VERSION));

// The keyboard mode the page asks for at startup — `raw` for the terminal
// since it was finally measured rather than guessed (see IME_DEFAULT). The
// composer asks for `text` on its own, because suggestions and dictation are
// the reason it exists.
//
// The switch behind ⋯ changes this at any time and the choice is remembered,
// so a mode that misbehaves on some other phone costs a tap, not a release.
setTimeout(() => setImeMode(imeWanted()), 0);

// What is actually running, shown where it can be read without a console:
// the page's own version, and the app's when the page is inside it.
function appVersion() {
  try {
    if (window.PockNative && typeof window.PockNative.appVersion === 'function') {
      return String(window.PockNative.appVersion() || '');
    }
  } catch (_) { /* nothing to show */ }
  return '';
}

const screenSessions = document.getElementById('screen-sessions');
const screenTerm = document.getElementById('screen-term');
const sessionList = document.getElementById('session-list');
const folderList = document.getElementById('folder-list');
const emptyMsg = document.getElementById('empty');
const tabsEl = document.getElementById('tabs');
const statusEl = document.getElementById('status');
let tabsSignature = null;

// Returns {sessions} or {error}. The distinction matters: "no sessions" and
// "you are not allowed to ask" look identical to a user staring at an empty
// list, and the second one sends them looking for a tmux problem that does
// not exist.
async function fetchSessions() {
  try {
    const res = await fetch(`/api/sessions?${tokenQS}`);
    if (res.status === 401) return { error: 'unauthorized', sessions: [] };
    if (!res.ok) return { error: `server said ${res.status}`, sessions: [] };
    return { sessions: (await res.json()) || [] };
  } catch (_) {
    return { error: 'no connection to the server', sessions: [] };
  }
}

// --- terminal (created once, reused across sessions) ---
let fontSize = 14;
try { fontSize = parseInt(localStorage.getItem('pt-font'), 10) || 14; } catch (_) {}
const term = new Terminal({ fontSize, scrollback: 5000, theme: { background: '#0b0e14' } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));

// What xterm leaves in its own field is what the keyboard reads as the word
// being typed, and that is where a typed word came back a second time. Emptied
// once every edit is over — see js/imefield.js for the recording it is written
// from.
//
// Both lines go to the journal because the question "did this do anything" has
// three answers and two of them are silent: never wired at all, wired and never
// fired, wired and taking text away. Only the first clear is reported — one line
// per session says which of the three, and one line per word typed would be the
// input log, which is a switch and not a default.
report('field-guard', { wired: !!term.textarea });
let saidCleared = false;
const fieldGuard = keepEmpty(term.textarea, {
  onClear: (len) => {
    if (saidCleared) return;
    saidCleared = true;
    report('field-clear', { len, first: true });
  },
});

// Keep terminal control keys in the terminal instead of firing the browser
// (Ctrl+R reload, Ctrl+L address bar, Ctrl+W close, Ctrl+D bookmark). A
// normal tab still reserves Ctrl+W/T/N no matter what — install pockterm as
// a PWA (standalone window, no tabs) for those to reach the terminal too.
// Copy/paste (Ctrl+C with a selection, Ctrl+V, Ctrl+Shift+*) are left alone.
term.attachCustomKeyEventHandler((e) => {
  if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    // Reload / address bar / close-tab / bookmark — reclaim for the shell.
    if (['KeyR', 'KeyL', 'KeyW', 'KeyD'].includes(e.code)) {
      e.preventDefault();
    }
  }
  return true;
});

let ws = null;
let current = null; // attached session name, or null on the list screen
let retry = 1000;
const enc = new TextEncoder();

// --- session list screen ---
// Which render of the list is the current one. It clears the rows, then waits for
// the server, then fills them — so two runs that overlap both clear and both fill,
// and the drawer ends up with every session twice. That is not hypothetical: the
// custom buttons landing while the drawer is opening is exactly two runs at once.
let listGen = 0;

async function loadSessions() {
  const gen = ++listGen;
  sessionList.innerHTML = '';
  emptyMsg.hidden = true;
  // The tab strip is the same list, so it is refreshed by the same call. It used
  // to be redrawn only when a session was attached: closing one from the drawer
  // left its tab at the top, renaming one left the old name there, and starting
  // one showed nothing until you switched. Reported as the strip not being
  // redrawn when a terminal is closed.
  if (!screenTerm.hidden) renderTabs();
  const { sessions, error } = await fetchSessions();
  // A later call took over while this one was waiting: it has already cleared the
  // list and will fill it, and anything written from here would be written twice.
  if (gen !== listGen) return;
  // The message about the sessions belongs to the sessions: while the folder
  // list is up it would sit under a list it says nothing about — and "no
  // sessions" over a list of folders reads as the folders being the problem.
  if (error) {
    emptyMsg.hidden = foldersShown;
    emptyMsg.innerHTML = error === 'unauthorized'
      ? '<p>Доступ не разрешён.</p><p>Ссылка открыта без токена, ' +
        'а сервер его требует — открой её из закладки с <code>?token=…</code>.</p>'
      : `<p>${escapeHtml(error)}</p><p>Сессии узнать не удалось.</p>`;
    return;
  }
  if (sessions.length === 0) {
    emptyMsg.hidden = foldersShown;
    // Nothing running is exactly when the folders are the way out, so the
    // message points at them instead of at a server the phone cannot reach.
    emptyMsg.innerHTML = '<p>Нет активных tmux-сессий.</p>' +
      '<p>Открой 📁 и выбери папку — сессия начнётся в ней и возьмёт её имя.</p>';
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'session';
    // Three facts and each of them varies. Which button started it — the name is
    // the folder now, so it cannot say that, and it is what the list is scanned
    // for. Where the pane actually is — the name says where it was *opened*, and
    // a session opened in ~/work spent an afternoon in ~/work/self with nothing
    // saying so. How long it has been up — which of these is from yesterday.
    //
    // What used to be here was "1 window", and it was always 1: the Makefile
    // creates one, and the page can neither make nor reach a second.
    const meta = [
      kindName(s.kind, customButtons),
      s.dir || '',
      shortAge(s.created, Date.now()),
      s.attached ? 'attached' : '',
    ].filter(Boolean);
    // The same three answers the strip gives, in the list that has room to say
    // them: what it is (the mark, before the name), what it is doing (the state,
    // as a class — one value, so the classes are exclusive by construction), and
    // what is still running in it (the shield, from an attribute). One vocabulary
    // for both surfaces, because a row and a tab disagreeing about a session is
    // worse than either of them saying nothing.
    b.dataset.session = s.name;
    // Where in the sweep this one starts, from the name — so a drawer of working
    // sessions is not one decoration pulsing in step, and a row keeps its phase
    // when the list is rebuilt.
    b.style.animationDelay = workingPhase(s.name);
    // The mark is a cell of its own beside the name, never inside it: `.name` is
    // the session's name and nothing else — the page reads it back to attach, to
    // rename and to close, and a glyph spliced into it makes a session called
    // `⭐demo` that tmux has never heard of.
    b.innerHTML = '<span class="line"><span class="kind"></span>' +
      `<span class="name">${escapeHtml(s.name)}</span></span>` +
      `<span class="meta">${escapeHtml(meta.join(' · '))}</span>` +
      '<span class="bg"></span><span class="agents"></span>';
    b.addEventListener('click', () => attach(s.name));
    li.appendChild(b);

    const ren = document.createElement('button');
    ren.className = 'rename';
    ren.textContent = '✎';
    ren.title = `Rename ${s.name}`;
    ren.addEventListener('click', () => openRename(s.name));
    li.appendChild(ren);

    // Closing ends processes — an agent mid-task, an editor with unsaved
    // work. One stray touch must not do that, so the first tap only arms the
    // button and it disarms itself a few seconds later.
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '✕';
    close.title = `Close ${s.name}`;
    armTwice(close, `tap again to close ${s.name}`, () => killSession(s.name));
    li.appendChild(close);

    sessionList.appendChild(li);
  }
  paintRows(sessions);
}

// What is still running while the agent says nothing, one plate per kind: a
// shell in green, a monitor in cyan, each with how many of them there are.
//
// It was one plate carrying the sum, on the argument that a tab only has to say
// whether anything is left running. That is one question and the strip is read
// for two: a shell is something started and forgotten, a monitor is something
// watching for an answer, and "3" said neither. The kinds have always been
// counted apart — the footer says "1 shell, 2 monitors" and the session list has
// carried both numbers since the badge existed — so what changed is only that
// the page stopped adding them up.
//
// Drawn from attributes through pseudo-elements, so nothing here is text in the
// button: the label is the session's name, and rewriting it rebuilds the button
// under the finger. `data-bg` counts the plates rather than the processes; it is
// the room the corner has to reserve.
const BG_PLATES = [['sh', 'shells'], ['mon', 'monitors']];
// One head per subagent, and no number on it — the count is the row of heads.
// A number would have to be read; two heads are seen. Capped because the strip
// is 34px tall and a tab is not a bar chart: past this it says "several".
const AGENT_HEAD = '🤖';
const AGENT_HEADS_MAX = 4;
function paintBackground(b, s) {
  const box = b.querySelector('.bg');
  if (!box) return;
  let plates = 0;
  for (const [attr, field] of BG_PLATES) {
    const n = s[field] || 0;
    if (n > 0) { box.dataset[attr] = String(n); plates++; } else delete box.dataset[attr];
  }
  if (plates) b.dataset.bg = String(plates);
  else delete b.dataset.bg;
  // The subagents, on the opposite edge: a shell or a monitor is something the
  // agent left running, a subagent is another agent — different question, other
  // side of the tab.
  const heads = b.querySelector('.agents');
  if (!heads) return;
  const n = Math.min(s.agents || 0, AGENT_HEADS_MAX);
  heads.textContent = AGENT_HEAD.repeat(n);
  heads.title = n ? `${s.agents} subagent(s)` : '';
}

// paintRows puts the state on the rows the drawer already has.
//
// Painted, never rebuilt — the same rule the strip follows and for the same two
// reasons: a rebuild takes the row out from under the finger, and it takes the
// armed ✕ with it, so a session flipping between working and done would disarm a
// confirmation half way through. On a WebView it also hands focus back to the
// terminal, which raises the keyboard over the list being read.
//
// The mark is written into a span of its own for the same reason: the kind arrives
// on a later poll than the name — the session list is fetched before /api/presets
// answers — and rewriting a child's text costs nothing.
function paintRows(sessions) {
  const by = new Map(sessions.map((s) => [s.name, s]));
  for (const b of sessionList.querySelectorAll('button.session')) {
    const s = by.get(b.dataset.session);
    if (!s) continue;
    const st = s.state || '';
    b.classList.toggle('working', st === 'working');
    b.classList.toggle('done', st === 'done');
    b.classList.toggle('asking', st === 'asking');
    b.classList.toggle('current', s.name === current);
    paintBackground(b, s);
    const mark = b.querySelector('.line .kind');
    if (mark) mark.textContent = kindMark(s.kind || '', customButtons);
  }
}

// --- the folders of the projects root ---
// The other half of "start a session": which one, and where. A session is
// almost always about a project, and on a phone there is no cd worth typing —
// so the drawer offers the folders of the projects root, and the session it
// starts is named after the folder rather than after the command. The root
// itself is one of them: work is where the sessions that are about nothing in
// particular belong, and it is a folder like any other.
const foldersBtn = document.getElementById('folders');
const newWhereEl = document.getElementById('new-where');
// Which folder the next preset tap starts in: null is the plain +, which means
// the root and has meant it since before folders were listed.
let pendingDir = null;
let foldersShown = false;
let projectsRoot = '';

// showFolders swaps the drawer between its two lists. One at a time, because
// two scrolling lists on a phone leave neither of them room for a thumb.
function showFolders(on) {
  foldersShown = on && !!folderList;
  folderList.hidden = !foldersShown;
  sessionList.hidden = foldersShown;
  if (foldersShown) emptyMsg.hidden = true;
  foldersBtn.classList.toggle('on', foldersShown);
  if (foldersShown) loadFolders();
  else setPendingDir(null);
}

// setPendingDir says, above the presets, where they will start a session.
// Unsaid it would be a menu that starts one somewhere the owner did not mean.
function setPendingDir(dir) {
  pendingDir = dir;
  if (!newWhereEl) return;
  newWhereEl.hidden = !dir;
  if (dir) newWhereEl.textContent = `в ${dir === '.' ? projectsRoot || 'корне' : dir}`;
}

async function loadFolders() {
  try {
    const res = await fetch(`/api/dirs?${tokenQS}`);
    if (!res.ok) {
      // 404 is a host that does not list folders (no session Makefile), which
      // is not a fault — the button just has nothing to show.
      folderList.innerHTML = `<li class="note">${res.status === 404
        ? 'Этот хост не отдаёт список папок.'
        : escapeHtml((await res.text().catch(() => '')).trim() || `не вышло: ${res.status}`)}</li>`;
      return;
    }
    const { root, dirs } = await res.json();
    projectsRoot = root || '';
    folderList.innerHTML = '';
    // The root first and by its own name: a session in ~/work is ordinary, and
    // "корень" as a label would hide which directory that is.
    renderFolder('.', projectsRoot || 'корень', 'корень проектов');
    for (const d of dirs) renderFolder(d, d, '');
    if (!dirs.length) {
      folderList.insertAdjacentHTML('beforeend',
        '<li class="note">Внутри корня папок нет.</li>');
    }
  } catch (_) {
    folderList.innerHTML = '<li class="note">Нет связи с сервером.</li>';
  }
}

function renderFolder(dir, label, meta) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.className = 'folder';
  b.dataset.dir = dir;
  b.innerHTML = `<span class="name">${escapeHtml(label)}</span>` +
    (meta ? `<span class="meta">${escapeHtml(meta)}</span>` : '');
  // Tapping a folder does not start anything by itself: which preset still has
  // to be answered, and the presets are one menu shared by every way in here.
  b.addEventListener('click', async () => {
    setPendingDir(dir);
    newMenu.hidden = false;
    renameBox.hidden = true;
    screenSessions.scrollTop = 0;
    await customReady;
  });
  li.appendChild(b);
  folderList.appendChild(li);
}

// --- starting and renaming sessions ---
// pockterm still does not invent commands: the page asks for one of the
// presets the Makefile defines, and the server runs that target. What this
// closes is the dead end — no sessions left, and a phone with nowhere to type
// the command that would create one.
const newBtn = document.getElementById('new');
const newMenu = document.getElementById('new-menu');
const renameBox = document.getElementById('rename-box');
const renameInput = document.getElementById('rename-input');
let renameTarget = null;

// The same four presets live on two screens now: the list, and the tab strip of
// the session you are already in. One handler for both — two would drift, and the
// day they do somebody gets a session started by a different command than they
// thought they asked for.
const newMenuTerm = document.getElementById('new-menu-term');
const newTermBtn = document.getElementById('new-term');

newBtn.addEventListener('click', async () => {
  const opening = newMenu.hidden;
  newMenu.hidden = !newMenu.hidden;
  renameBox.hidden = true;
  // The plain + is the root, whatever folder was tapped before it.
  setPendingDir(null);
  // The buttons in it come from the host. Opening the menu before that answer
  // arrives shows an empty popup, which reads as "nothing can be started".
  if (opening) await customReady;
});

foldersBtn.addEventListener('click', () => showFolders(!foldersShown));

// Opening the presets over the terminal, and — the part that was missing —
// closing them again. One tap anywhere outside does it, through an invisible
// scrim that covers the header as well, so the + closes the menu it opened.
const menuScrim = document.getElementById('menu-scrim');
function setTermMenu(open) {
  if (!newMenuTerm) return;
  // The + over the terminal is the root: the folder list lives in the drawer,
  // and a folder tapped there must not follow the owner onto another screen.
  if (open) setPendingDir(null);
  newMenuTerm.hidden = !open;
  menuScrim.hidden = !open;
  newTermBtn.classList.toggle('on', open);
}

if (newTermBtn) {
  keepsTerminalFocus(newTermBtn);
  keepsTerminalFocus(menuScrim);
  newTermBtn.addEventListener('click', async () => {
    const opening = newMenuTerm.hidden;
    setTermMenu(opening);
    if (opening) await customReady;
  });
  menuScrim.addEventListener('click', () => setTermMenu(false));
}

function wirePreset(b) {
  keepsTerminalFocus(b);
  b.addEventListener('click', async () => {
    const preset = b.dataset.preset;
    // What to call it out loud. A custom button's preset is an id — "custom:b2"
    // in a toast says nothing to the person who named it "Квен".
    const shown = b.dataset.name || preset;
    // Read before the menu closes: closing clears it, and a tap that started a
    // session in the root while the caption said otherwise would be worse than
    // an error.
    const dir = pendingDir;
    newMenu.hidden = true;
    setTermMenu(false);
    setPendingDir(null);
    toast(dir && dir !== '.' ? `starting ${shown} in ${dir}…` : `starting ${shown}…`);
    try {
      const res = await fetch(`/api/sessions/new?${tokenQS}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No dir at all when none was asked for: an older server ignores the
        // field, and this way the plain + sends exactly what it always did.
        body: JSON.stringify(dir ? { preset, dir } : { preset }),
      });
      if (!res.ok) {
        const why = (await res.text().catch(() => '')).trim();
        toast(why || `could not start: ${res.status}`);
        report('start-session', { preset, dir: dir || '', ok: false, status: res.status });
        return;
      }
      report('start-session', { preset, dir: dir || '', ok: true });
      // Back to the sessions: what was asked for is a session, and the folder
      // list has nothing to show about it.
      if (foldersShown) showFolders(false);
      // tmux needs a moment before the session shows up in the listing.
      setTimeout(loadSessions, 400);
    } catch (_) {
      toast('no connection to the server');
    }
  });
}
for (const b of document.querySelectorAll('button[data-preset]')) wirePreset(b);

async function killSession(name) {
  try {
    const res = await fetch(`/api/sessions/kill?${tokenQS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    report('kill-session', { ok: res.ok, status: res.status });
    if (!res.ok) {
      toast((await res.text().catch(() => '')).trim() || `could not close: ${res.status}`);
      return;
    }
    toast(`closed ${name}`);
    if (current !== name) { loadSessions(); return; }
    // Read the strip while the closed tab is still in it: it is the fallback for
    // a session nothing was visited before, and a moment later it is gone.
    await stepBackFrom(name, tabBeside(name));
  } catch (_) {
    toast('no connection to the server');
  }
}

function openRename(name) {
  renameTarget = name;
  renameInput.value = name;
  renameBox.hidden = false;
  newMenu.hidden = true;
  renameInput.focus();
  renameInput.select();
}
document.getElementById('rename-cancel').addEventListener('click', () => {
  renameBox.hidden = true;
  renameTarget = null;
});
document.getElementById('rename-save').addEventListener('click', async () => {
  const to = renameInput.value.trim();
  if (!renameTarget || !to || to === renameTarget) { renameBox.hidden = true; return; }
  try {
    const res = await fetch(`/api/sessions/rename?${tokenQS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: renameTarget, to }),
    });
    if (!res.ok) {
      // The server explains why in plain text — a name it will not accept is
      // the common case, and silence would look like a broken button.
      toast((await res.text().catch(() => '')).trim() || `rename failed: ${res.status}`);
      return;
    }
    renameBox.hidden = true;
    renameTarget = null;
    loadSessions();
  } catch (_) {
    toast('no connection to the server');
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Two taps to remove, the first of them reversible: the button reddens, says
// `✕?` and asks in a toast, and only the second tap acts.
//
// One implementation for both lists rather than one each. A session and a custom
// button are worth different amounts — one ends an agent mid-task, the other is
// two fields to type again — and that is exactly why the difference must not be
// in the gesture: on a phone the two rows look alike, sit in the same drawer, and
// are hit by the same stray thumb. A ✕ that sometimes asks and sometimes does not
// is a ✕ nobody can trust.
//
// The arming expires after ARM_MS, because a button left armed is a button whose
// next tap, minutes later, does something other than what it says.
const ARM_MS = 4000;
function armTwice(btn, ask, act, armedText = '✕?') {
  // What it said before is what it says again on the way back: the same helper
  // serves a ✕ and a button with words on it.
  const idle = btn.textContent;
  let armed = null;
  btn.addEventListener('click', () => {
    if (!armed) {
      btn.classList.add('armed');
      btn.textContent = armedText;
      toast(ask);
      armed = setTimeout(() => {
        armed = null;
        btn.classList.remove('armed');
        btn.textContent = idle;
      }, ARM_MS);
      return;
    }
    clearTimeout(armed);
    armed = null;
    btn.classList.remove('armed');
    btn.textContent = idle;
    act();
  });
}

// --- the owner's own session buttons ---
//
// The four presets are make targets and always were: the Makefile decides how a
// session is launched and stays the only place that knows. A custom button does
// not break that — it names one target and carries a command to it — but it does
// answer the thing the four could not: a new agent (`qwen`, `opencode`) meant
// editing a Makefile that on the host this serves is written by ansible, which is
// a laptop and a deploy away from a phone that wants it now.
//
// The list is the host's, not the browser's, for the same reasons the
// notification switch is: what it starts happens on the host, a second phone must
// find the same buttons, and CI restarts the binary several times a day.
const customList = document.getElementById('custom-list');
const customLabel = document.getElementById('custom-label');
const customCmd = document.getElementById('custom-cmd');
const customAdd = document.getElementById('custom-add');
const customNote = document.getElementById('custom-note');
const customReset = document.getElementById('custom-reset');
// Which button the two fields below are currently about: null for a new one,
// an id while an existing one is being changed.
//
// One form for both, the way the session list has one rename field: a phone has
// no room for a second pair of inputs, and a form that appears per row would put
// the one being edited under the keyboard.
//
// Declared here rather than beside startEdit because the mark picker reads it while
// it draws itself, and it draws itself as the page loads: a `let` below that point
// is a ReferenceError, which took the whole page down.
let editingID = null;
const customMarkBtn = document.getElementById('custom-mark');
const markGrid = document.getElementById('mark-grid');
// The mark the form is about: '' means "let the page decide", which is what every
// button had before there was a grid.
let formMark = '';
const buttonsBox = document.getElementById('buttons-box');
let customButtons = [];

function note(text) {
  customNote.textContent = text || '';
  customNote.hidden = !text;
}

// --- the mark, picked from a grid ---
//
// The way to give a button a glyph was to type an emoji at the front of its label:
// a trick you had to know, and a character out of a name that has 24. Three custom
// buttons therefore drew the same ★, which is the row the owner was looking at when
// he asked for this.
//
// The grid is written from MARKS in js/kinds.js — one vocabulary, shared with the
// strip and the drawer — and the button beside the label shows what is chosen.
function paintMarkButton() {
  // What the button will actually be drawn with, not just what was picked: nothing
  // picked is the common case — every button of the owner's had it — and a ⭐ on the
  // form while the row two lines up shows ❄️ says the wrong thing about what is
  // being edited. markOf answers it, the same function the row and the tab use, so
  // the form previews what will happen rather than describing its own state.
  //
  // It follows the label as it is typed, because that is one of the things markOf
  // reads: typing "Codex" turns the button into ☀️ before anything is saved.
  const effective = markOf({ id: editingID || '', label: customLabel.value, mark: formMark });
  customMarkBtn.textContent = effective || CUSTOM_MARK;
  // Lit only for a glyph that was chosen: the rest is the page deciding, and the
  // grid's highlight has to say which of the forty is the owner's answer.
  customMarkBtn.classList.toggle('on', !!formMark);
  for (const b of markGrid.querySelectorAll('button')) {
    b.classList.toggle('on', b.textContent === formMark);
  }
}

function buildMarkGrid() {
  markGrid.innerHTML = '';
  for (const m of MARKS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = m;
    // Nothing here may move the focus. Picking a glyph hides the grid, and hiding
    // the focused element is what hands focus back to whatever had it before — on
    // Android that raises the keyboard, over the very grid being used. Same guard
    // as the tab strip and the terminal's menu.
    keepsTerminalFocus(b);
    b.addEventListener('click', () => {
      // The same glyph again means "no mark of my own": one tap in, one tap out,
      // rather than a separate button for clearing it.
      formMark = formMark === m ? '' : m;
      paintMarkButton();
      markGrid.hidden = true;
    });
    markGrid.appendChild(b);
  }
}
buildMarkGrid();
paintMarkButton();
keepsTerminalFocus(customMarkBtn);
customMarkBtn.addEventListener('click', () => {
  markGrid.hidden = !markGrid.hidden;
});
// The preview follows the label: what markOf answers depends on it.
customLabel.addEventListener('input', paintMarkButton);


// Draw the editor and, from the same list, the entries under +.
function renderCustom() {
  customList.innerHTML = '';
  for (const c of customButtons) {
    const li = document.createElement('li');
    // What a default runs is its own make target, and that is worth showing: the
    // command field being empty is not the same as the button doing nothing, and
    // on a phone there is nowhere else to find out which. A button that names a
    // target reads the same way, which is also how it is typed.
    const runs = c.cmd || `make ${c.target || c.id}`;
    // The mark in a cell of its own, here and in the menus and on the tabs: it is
    // the one element the emoji rule below is hung on, and a glyph mixed into a
    // label cannot be styled apart from it.
    li.innerHTML = `<span class="name"><span class="kind">${escapeHtml(markOf(c))}</span>` +
      `${escapeHtml(labelBody(c.label))}</span>` +
      `<code>${escapeHtml(runs)}</code>`;
    if (c.id === editingID) li.classList.add('editing');
    // Changing a button rather than deleting and adding it keeps its id, and the
    // id is what the sessions it started are marked with: retyping the same
    // command would leave every tab it had opened marked by a button that no
    // longer exists (see session.Kind in the Go side).
    const edit = document.createElement('button');
    edit.className = 'rename';
    edit.textContent = '✎';
    edit.title = c.id === editingID ? `Не менять ${c.label}` : `Изменить ${c.label}`;
    edit.addEventListener('click', () => {
      if (c.id === editingID) { cancelEdit(); return; }
      startEdit(c);
    });
    li.appendChild(edit);
    const del = document.createElement('button');
    del.className = 'close';
    del.textContent = '✕';
    del.title = `Remove ${c.label}`;
    // Two taps, the same as closing a session. It was one for a while, on the
    // grounds that this removes a button rather than a running agent — and a
    // stray touch took a button away with nothing asked, which is what it was
    // reported as. The rows look alike and are in the same drawer; the gesture
    // is where they must not differ.
    armTwice(del, `tap again to remove ${c.label}`, () => {
      if (c.id === editingID) cancelEdit();
      saveCustom(customButtons.filter((x) => x.id !== c.id));
    });
    li.appendChild(del);
    customList.appendChild(li);
  }
  // Both menus are written from the same list, defaults included. They used to
  // be four buttons spelled out in the HTML with the owner's own appended, and
  // that was a second answer to what exists: a default that had been renamed or
  // removed was still there, in its stock words, starting what it always had.
  for (const menu of [newMenu, newMenuTerm]) {
    if (!menu) continue;
    for (const old of menu.querySelectorAll('button.preset')) old.remove();
    for (const c of customButtons) {
      const b = document.createElement('button');
      // `own` is the tint that says this one is the owner's rather than a default
      // — the marks say it too, and a colour is what reads at a glance.
      b.className = builtinId(c.id) ? 'preset' : 'preset own';
      b.dataset.preset = presetOf(c);
      b.dataset.name = c.label;
      // A label that leads with a symbol carries its own mark, and then that is
      // the mark shown here and on the tab the session opens in. Drawing ★ in
      // front of it as well would leave two marks and no way to tell which of
      // them is the one on the tabs.
      const mk = document.createElement('span');
      mk.className = 'kind';
      mk.textContent = markOf(c);
      b.appendChild(mk);
      b.appendChild(document.createTextNode(labelBody(c.label)));
      wirePreset(b);
      menu.appendChild(b);
    }
  }
  // Tabs and drawer rows are marked from this list, and the first load of it
  // answers after they are already on screen.
  if (!screenTerm.hidden) renderTabs();
  if (screenSessions.classList.contains('open')) loadSessions();
}

// The first load, kept so anything that needs the buttons can wait for it: the
// menus are drawn from this list now, including the four, so a + tapped before
// the host has answered would open an empty menu. It is a promise rather than a
// flag because the answer is one fetch away, not one frame.
let customReady = null;

async function loadCustom() {
  try {
    const res = await fetch(`/api/presets?${tokenQS}`);
    if (!res.ok) {
      // A host that cannot edit them says 404. The four still work — the server
      // resolves them itself — so the menus are drawn from what they were.
      if (res.status === 404) {
        buttonsBox.hidden = true;
        customButtons = DEFAULT_BUTTONS.slice();
        renderCustom();
      }
      return;
    }
    const data = await res.json();
    customButtons = data.buttons || [];
    renderCustom();
  } catch (_) { /* offline: the buttons are the least of it */ }
}

// What a host without a button store has. Not a second source of truth: it is
// only reached on a 404, where there is no list to disagree with — the labels a
// store-carrying host uses come from it (session.DefaultButtons in Go).
const DEFAULT_BUTTONS = [
  { id: 'shell', label: 'Shell', cmd: '' },
  { id: 'claude', label: 'Claude', cmd: '' },
  { id: 'yolo', label: 'Claude (yolo)', cmd: '' },
  { id: 'continue', label: 'Continue', cmd: '' },
];

// Save the whole list and draw what the host says it now has — never what was
// just typed. A refusal is shown as it came: which button and why is the only
// thing that makes it actionable on a phone.
async function saveCustom(list) {
  note('');
  try {
    const res = await fetch(`/api/presets?${tokenQS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buttons: list }),
    });
    const text = await res.text();
    if (!res.ok) {
      note(text.trim() || `не сохранилось: ${res.status}`);
      report('custom-buttons', { ok: false, status: res.status });
      return false;
    }
    customButtons = (JSON.parse(text).buttons) || [];
    renderCustom();
    report('custom-buttons', { ok: true, count: customButtons.length });
    return true;
  } catch (_) {
    note('нет связи с сервером');
    return false;
  }
}

// What the command field says when nothing is typed in it. For a default that is
// not "type a command" but "leave this empty and the make target runs" — the one
// place a phone can be told that an empty field is an answer.
const CMD_PLACEHOLDER = customCmd.placeholder;

// startEdit puts an existing button into the form. The row it came from is
// marked, because the fields are nowhere near it once the keyboard is up and
// "which one am I changing" is then unanswerable.
function startEdit(c) {
  editingID = c.id;
  formMark = c.mark || '';
  paintMarkButton();
  customLabel.value = c.label;
  // Back into the field as it was typed: a target came in as `make <target>` and
  // has to go back out that way, or editing the label would turn the button into
  // one that runs nothing.
  customCmd.value = c.cmd || (c.target ? `make ${c.target}` : '');
  customCmd.placeholder = builtinId(c.id) ? `пусто — цель make ${c.id}` : CMD_PLACEHOLDER;
  note('');
  renderCustom();
  customAdd.textContent = 'Сохранить';
  customLabel.focus();
}

function cancelEdit() {
  if (editingID === null) return;
  editingID = null;
  formMark = '';
  paintMarkButton();
  markGrid.hidden = true;
  customLabel.value = '';
  customCmd.value = '';
  customCmd.placeholder = CMD_PLACEHOLDER;
  customAdd.textContent = 'Добавить';
  note('');
  renderCustom();
}

customAdd.addEventListener('click', async () => {
  const label = customLabel.value.trim();
  const cmd = customCmd.value.trim();
  // An empty command is an answer for a default and a mistake for anything else:
  // a default's id is a make target, so no command means the Makefile decides —
  // which is what the four did before they were editable at all.
  const keepsTarget = editingID !== null && builtinId(editingID);
  if (!label || (!cmd && !keepsTarget)) { note('нужны подпись и команда'); return; }
  // The whole list travels either way — the host replaces it and answers with
  // what it now has. Editing differs only in that the entry keeps its id and its
  // place in the row.
  // `make <target>` in this field means that target, and the host is what reads it
  // — the page sends what was typed. The old target is cleared with it: a button
  // whose command was rewritten must not keep a target it no longer names.
  const list = editingID === null
    ? [...customButtons, { label, cmd, mark: formMark }]
    : customButtons.map((c) => (c.id === editingID ? { ...c, label, cmd, target: '', mark: formMark } : c));
  if (await saveCustom(list)) {
    editingID = null;
    customAdd.textContent = 'Добавить';
    customLabel.value = '';
    customCmd.value = '';
    customCmd.placeholder = CMD_PLACEHOLDER;
    formMark = '';
    paintMarkButton();
    markGrid.hidden = true;
    renderCustom();
  }
});

// Back to the four, and only them: the defaults are the host's to restore, so the
// page asks rather than sending a list of its own — a page older than the binary
// would otherwise install whatever it thought the defaults were. The owner's own
// buttons are not defaults and are left alone; two taps, like every removal here,
// because it does undo renames and commands.
armTwice(customReset, 'ещё раз — и кнопки станут как были', async () => {
  note('');
  try {
    const res = await fetch(`/api/presets?${tokenQS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    const text = await res.text();
    if (!res.ok) { note(text.trim() || `не сбросилось: ${res.status}`); return; }
    cancelEdit();
    customButtons = (JSON.parse(text).buttons) || [];
    renderCustom();
    report('custom-buttons', { ok: true, reset: true, count: customButtons.length });
  } catch (_) {
    note('нет связи с сервером');
  }
}, '↻ Сбросить?');
customReady = loadCustom();

// --- settings, at the bottom of the drawer ---
//
// Open or closed is remembered (`pt-settings-open`), and that is a preference
// rather than a state: whoever keeps the size and the keyboard mode within reach
// had to reopen the panel on every visit to the drawer, because closing the
// drawer collapses it.
//
// So the two are separated. `showSettings` is the owner's answer and is written
// down; `collapseSettings` is what closing the drawer does — the panel goes away
// with the drawer that held it, and the answer stays for the next opening. A
// single function doing both would record "closed" every time the drawer shut,
// which is the preference being overwritten by the thing it is a preference
// about.
const settingsEl = document.getElementById('settings');
const settingsToggle = document.getElementById('settings-toggle');
const SETTINGS_KEY = 'pt-settings-open';

function paintSettings(on) {
  settingsEl.hidden = !on;
  settingsToggle.classList.toggle('on', on);
}

function showSettings(on) {
  paintSettings(on);
  try { localStorage.setItem(SETTINGS_KEY, on ? '1' : '0'); } catch (_) {}
}

// Collapse without answering the question: the drawer is going away and its
// panels go with it.
function collapseSettings() {
  paintSettings(false);
}

function settingsWanted() {
  try { return localStorage.getItem(SETTINGS_KEY) === '1'; } catch (_) { return false; }
}

// A pull up from that row opens the panel, which is the other half of the pull
// down that closes it: the panel slides up out of this very row, so in both
// directions the gesture says what the animation shows. The handler itself sits
// with the drawer's other touches below; what belongs here is what it costs. The
// swipe ends on the toggle, and the click that follows would put the panel
// straight back — so it is swallowed, exactly as `helpHeld` swallows the click at
// the end of a held tab. The flag is cleared at the next touchstart rather than
// waiting for a click that a browser may never send, or a suppressed click would
// eat the next honest tap instead.
let settingsSwiped = false;
settingsToggle.addEventListener('click', () => showSettings(settingsEl.hidden));

// Whatever the pull up started on, its click is not a tap.
//
// While the gesture only counted from the toggle row, the click to swallow was
// that row's own — it would have shut the panel the swipe had just opened. From
// anywhere in the drawer the click lands on whatever the finger came down on,
// and the things in there are sessions: a pull up over the list would open the
// settings and switch session on the way. So it is caught on the drawer in the
// capture phase, before it reaches the button it is aimed at.
screenSessions.addEventListener('click', (e) => {
  if (!settingsSwiped) return;
  settingsSwiped = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

// Whether anything under the finger can still be scrolled downwards. That is
// what tells a pull up meant for the settings from one meant for a list — and
// it is asked of the ancestors rather than of the list alone, because the
// drawer holds several (the sessions, the folders, the buttons of a preset).
function scrollableDown(el) {
  for (let n = el; n && n !== screenSessions.parentNode; n = n.parentElement) {
    if (n.scrollHeight - n.clientHeight > 1
        && n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
  }
  return false;
}

// The drawer, and the two things that are not the same: showing the list, and
// letting go of the session you are in.
//
// It was one screen replacing another, so opening the list closed the terminal —
// and the list is what you open to see what else is running. Now the terminal
// stays where it is underneath.
const drawerScrim = document.getElementById('drawer-scrim');
const drawerCloseBtn = document.getElementById('drawer-close');

// With no session attached the drawer is the only thing on the page: the
// terminal screen is hidden, and ☰ lives in its header. Closing it then left a
// black page with nothing to tap and no way back but a reload — which is what
// "the window hangs empty" was, after closing the very session you were sitting
// in. So it is modal until there is something behind it: no way out, and nothing
// pretending to be one.
function openDrawer() {
  screenSessions.classList.add('open');
  drawerScrim.hidden = !current;
  drawerCloseBtn.hidden = !current;
  // The panel comes back the way it was left, which is why closing the drawer
  // does not write "closed" down.
  paintSettings(settingsWanted());
  loadSessions();
  // The rows carry the state now, so the list is worth polling for while it is
  // open — including with nothing attached, when it is the only thing on screen.
  pollTabs(true);
}
function closeDrawer() {
  if (!current) return;
  screenSessions.classList.remove('open');
  drawerScrim.hidden = true;
  // The rename field and the presets belong to the list; leaving them open would
  // have them waiting behind a closed drawer. The folder view goes with them:
  // reopening the drawer to see what is running should show what is running.
  renameBox.hidden = true;
  newMenu.hidden = true;
  // Half-edited fields go with the panel that held them, for the same reason:
  // a form still saying "Сохранить" about a button chosen a day ago is a form
  // that saves the wrong thing when it is finally tapped.
  cancelEdit();
  collapseSettings();
  showFolders(false);
  // And it stops being a reason to poll: with the terminal on screen the strip is
  // still one, and pollTabs works that out for itself.
  pollTabs(true);
}
function toggleDrawer() {
  if (screenSessions.classList.contains('open')) closeDrawer();
  else openDrawer();
}
drawerScrim.addEventListener('click', closeDrawer);
drawerCloseBtn.addEventListener('click', closeDrawer);

// A swipe to the left puts the drawer away, next to ✕ and the scrim.
//
// It is where the panel goes anyway — the closed state is a transform off the
// left edge — so the gesture and the animation say the same thing. Nothing here
// makes the panel follow the finger: it closes once the swipe is unmistakably a
// swipe, and the transition carries the rest.
//
// Three ways it must not fire. The list scrolls vertically, so a drag that is
// mostly up or down is the list's. A text field (the rename box) drags a caret
// sideways, and taking that away would make renaming impossible. And with no
// session attached the drawer is modal — closeDrawer refuses then, which is the
// same refusal ✕ and the scrim get.
const DRAWER_SWIPE = 45; // px of sideways travel that means "away", or "here"
// And downward inside the settings, which is where that panel goes: it opens
// upward from the row at the bottom, so pulling it back down is the same
// statement as tapping the row again. A separate threshold from the drawer's
// because it competes with a different thing — the panel's own scrolling.
const SETTINGS_SWIPE = 45;
let drawerTouch = null;
screenSessions.addEventListener('touchstart', (e) => {
  drawerTouch = null;
  // Whatever the last gesture swallowed, it has had its click by now.
  settingsSwiped = false;
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  if (t.target instanceof Element && t.target.closest('input, textarea')) return;
  // Whether the finger came down inside the settings, and whether that panel was
  // at its top when it did. A pull-down anywhere else in it is a scroll, and
  // taking a scroll away from a list of buttons would be worse than one more tap.
  const inSettings = t.target instanceof Element && !settingsEl.hidden
    && settingsEl.contains(t.target) && settingsEl.scrollTop <= 0;
  // A pull up anywhere in the drawer opens the panel, and the one thing it must
  // not take is a scroll. It counted only from the row the panel opens out of,
  // on the argument that everything above it is a list that scrolls under the
  // same finger — but that row is one target at the very bottom of a tall
  // screen, and the gesture is wanted from wherever the thumb happens to be.
  //
  // So the bound is the scroll rather than the place: whatever is under the
  // finger keeps the gesture while it still has somewhere to go down. A short
  // list has nowhere, which is the common case and the one that reads as
  // "anywhere"; a long one is being scrolled, and a drawer that opened its
  // settings mid-scroll would be worse than one more tap.
  const canOpen = t.target instanceof Element && !scrollableDown(t.target);
  drawerTouch = { x: t.clientX, y: t.clientY, inSettings, canOpen };
}, { passive: true });
screenSessions.addEventListener('touchmove', (e) => {
  if (!drawerTouch || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - drawerTouch.x;
  const dy = e.touches[0].clientY - drawerTouch.y;
  if (drawerTouch.inSettings && dy > SETTINGS_SWIPE && Math.abs(dy) > Math.abs(dx)) {
    drawerTouch = null;
    // The owner's answer, so it is remembered as one: the same act as the toggle,
    // not the collapsing a closing drawer does.
    showSettings(false);
    return;
  }
  if (drawerTouch.canOpen && settingsEl.hidden
      && dy < -SETTINGS_SWIPE && Math.abs(dy) > Math.abs(dx)) {
    drawerTouch = null;
    settingsSwiped = true;
    showSettings(true);
    return;
  }
  if (dx > -DRAWER_SWIPE || Math.abs(dx) <= Math.abs(dy)) return;
  drawerTouch = null;
  closeDrawer();
}, { passive: true });
for (const end of ['touchend', 'touchcancel']) {
  screenSessions.addEventListener(end, () => { drawerTouch = null; }, { passive: true });
}

// No session attached: there is nothing to show under the drawer, so the
// terminal goes away with it and the drawer is all there is. That is where the
// page starts, and where closing the last session lands.
function showSessions() {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  current = null;
  try { sessionStorage.removeItem('pt-session'); } catch (_) {}
  screenTerm.hidden = true;
  // The strip belongs to a session; leaving it standing would flash the closed
  // one back on screen the moment the terminal is shown again.
  tabsEl.innerHTML = '';
  tabsSignature = null;
  pollTabs(false);
  openDrawer();
}

// The order tabs were visited in, oldest first, without the one you are in.
//
// Closing the session you are attached to used to land on the modal drawer even
// with others running: the tab under the finger was gone, and the place it had
// been was no longer anything to tap — reported as the interface sticking. So the
// page steps back to the tab it came from instead. The empty drawer is what is
// left when nothing is running at all, which is the case it was built for.
const visited = [];
function forget(name) {
  const at = visited.indexOf(name);
  if (at >= 0) visited.splice(at, 1);
}
function rememberVisit(name) {
  if (!name) return;
  forget(name);
  visited.push(name);
}

// Which tab stands next to this one in the strip, for when nothing was visited
// before it: to the left if there is one, otherwise to the right.
function tabBeside(name) {
  const names = [...tabsEl.querySelectorAll('button')].map((b) => b.dataset.session);
  const i = names.indexOf(name);
  if (i < 0) return null;
  return i > 0 ? names[i - 1] : names[i + 1] || null;
}

// Where closing the session you are in goes. The strip's order is read before the
// list is refetched, because by then the closed tab is gone from both.
async function stepBackFrom(closed, beside) {
  forget(closed);
  const { sessions } = await fetchSessions();
  const alive = new Set((sessions || []).map((s) => s.name));
  let back = null;
  while (visited.length) {
    const n = visited.pop();
    if (alive.has(n)) { back = n; break; }
  }
  if (!back && beside && alive.has(beside)) back = beside;
  if (!back && sessions && sessions.length) back = sessions[0].name;
  // Nothing left to go back to: the drawer, and it is modal there on purpose.
  if (!back) { showSessions(); return; }
  // Cleared first so the session that has just been closed is not remembered as
  // somewhere to return to.
  current = null;
  attach(back);
}

function attach(name) {
  // Nothing here touches focus, and that is the whole point.
  //
  // Focus and the keyboard are not the same thing on Android: dismissing the
  // keyboard with the back gesture leaves the textarea focused. Restoring
  // "the focus it had" therefore raised the keyboard for someone who had just
  // put it away — which is what a switch kept doing. The tab buttons do not
  // take focus (see keepsTerminalFocus), so whatever state the switch found
  // simply stays.
  // Close any current socket first (switching tabs) so its output stops
  // writing into the terminal we're about to reuse for another session.
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  rememberVisit(current);
  forget(name); // it is where you are now, not somewhere to go back to
  current = name;
  try { sessionStorage.setItem('pt-session', name); } catch (_) {}
  screenTerm.hidden = false;
  // There is something behind the drawer again, so it has a way out again.
  drawerCloseBtn.hidden = false;
  closeDrawer();
  // A frozen screen belongs to the session it was frozen from.
  if (selectMode) setSelectMode(false);
  term.reset();
  document.getElementById('answers').hidden = true;
  lastAnswersSig = null;
  scrolledBack = false; // the new socket reports the pane's state on connect
  renderTabs();
  // The strip is on screen now, so its colours have to keep up with the panes.
  pollTabs(true);
  requestAnimationFrame(() => {
    // Size first, then the socket: tmux redraws immediately on attach.
    fitNow();
    connect();
    // The keyboard reappearing on a switch is not this code focusing
    // anything: on Android the textarea keeps focus after the keyboard is
    // dismissed, and the WebView re-shows it for a focused element when the
    // layout moves. That is why it only started after the first tap on the
    // input — before that nothing held focus. So when a soft keyboard is
    // known to exist and is currently down, the terminal gives up focus —
    // `releaseTerminalFocus`, which the ⇩ shares for the same reason.
    report('switch', { keyboardUp, sawKeyboard, blurred: releaseTerminalFocus() });
  });
}

// Session tabs in the terminal header: tap one to switch to that session.
//
// A tab answers three different questions at once, so it says them three
// different ways: which sessions exist (the row), which one you are in (a frame
// around it), and what each is doing (the fill — neutral when the watcher has
// nothing to claim, a moving purple while output is arriving, green once it has
// gone quiet after doing something).
//
// The frame is why: "attached" used to be the fill, which left the state nowhere
// to go — the tab you were sitting in would have been the only one that could
// not tell you whether its agent was still running.
async function renderTabs() {
  // Not while a tab is being carried: the row is the thing being rearranged, and
  // rebuilding it would take the button out from under the finger.
  if (dragName) return;
  const { sessions } = await fetchSessions();
  const names = sessions.map((s) => s.name).join('\u0000');

  // Rebuilding the row would remove the button that was just tapped, and a
  // WebView answers the removal of the focused element by handing focus back
  // to the previous one — the terminal's textarea — which raises the keyboard.
  // So the row is rebuilt only when the set of sessions actually changed;
  // switching only moves the highlight.
  if (names !== tabsSignature) {
    tabsSignature = names;
    tabsEl.innerHTML = '';
    for (const s of sessions) {
      const b = document.createElement('button');
      // The mark lives in a span of its own so it can be rewritten without
      // touching the button: the kind arrives on a later poll than the name (the
      // list is fetched before the buttons are), and rebuilding the row under a
      // finger is what raises the keyboard.
      const mark = document.createElement('span');
      mark.className = 'kind';
      b.appendChild(mark);
      b.appendChild(document.createTextNode(s.name));
      // The corner where the plates go. An empty span draws nothing and takes no
      // room, and it is here from the start for the same reason the mark is: it
      // is painted on a later poll, and a tab must not be rebuilt to carry it.
      const bgBox = document.createElement('span');
      bgBox.className = 'bg';
      b.appendChild(bgBox);
      // The other corner: the heads of the subagents. Empty until there are any,
      // and painted rather than rebuilt for the same reason as everything else
      // on a tab — the button must not be taken out from under a finger.
      const heads = document.createElement('span');
      heads.className = 'agents';
      b.appendChild(heads);
      b.dataset.session = s.name;
      b.style.animationDelay = workingPhase(s.name);
      keepsTerminalFocus(b);
      b.addEventListener('click', () => {
        // A long press asks what the mark means; it must not also switch session.
        if (helpHeld) { helpHeld = false; return; }
        if (s.name !== current) attach(s.name);
      });
      tabsEl.appendChild(b);
    }
  }
  // State is a class, never a rebuild: a session that goes from working to done
  // and back several times a minute would otherwise take the row — and with it
  // the keyboard — along every time.
  const state = new Map(sessions.map((s) => [s.name, s.state || '']));
  // What is still running while the agent says nothing, by kind. It rides in the
  // same list as the colour, and it is drawn from attributes for the same reason
  // the colour is drawn as a class: the label must not be rewritten.
  const bg = new Map(sessions.map((s) => [s.name, s]));
  // What each one is, as opposed to what it is doing. Written into the mark's own
  // span for the same reason the state is written as a class — the label must not
  // be rebuilt — and it is the "+" menu's own glyph, so the strip needs no legend.
  kinds.clear();
  for (const s of sessions) kinds.set(s.name, s.kind || '');
  for (const b of tabsEl.querySelectorAll('button')) {
    const st = state.get(b.dataset.session) || '';
    const k = kindOf(b.dataset.session);
    const mark = b.querySelector('.kind');
    if (mark) mark.textContent = kindMark(k, customButtons);
    // For a pointer, which has a hover; the long press is what a phone has.
    const what = kindName(k, customButtons);
    if (what) b.title = `${b.dataset.session} · ${what}`;
    else b.removeAttribute('title');
    b.classList.toggle('active', b.dataset.session === current);
    b.classList.toggle('working', st === 'working');
    b.classList.toggle('done', st === 'done');
    // A question outranks the rest, and it cannot collide with them: the state is
    // one value, so the classes are exclusive by construction.
    b.classList.toggle('asking', st === 'asking');
    paintBackground(b, bg.get(b.dataset.session) || {});
  }
  // The drawer's rows say the same thing off the same answer: one fetch, so a row
  // and a tab cannot describe one session out of two different moments.
  paintRows(sessions);
}

// --- what the mark on a tab means ---
// A glyph is only obvious to whoever chose it, and this one is read on a phone
// that has no hover to explain it: the same press that would switch session holds
// instead, and the tab says what it is.
//
// Held rather than tapped because the tab already has a job, and a mark small
// enough not to crowd the name is too small to be a second target. `helpHeld`
// swallows the click the press ends in — without it, asking what a tab is would
// switch to it.
const kindHelpEl = document.getElementById('kind-help');
const HELP_HOLD_MS = 400;
const HELP_SHOWN_MS = 2600;
let helpTimer = null;
let helpHide = null;
let helpHeld = false;
let helpStart = null;

function hideKindHelp() {
  if (helpTimer) { clearTimeout(helpTimer); helpTimer = null; }
  if (helpHide) { clearTimeout(helpHide); helpHide = null; }
  helpStart = null;
  if (kindHelpEl) {
    kindHelpEl.hidden = true;
    kindHelpEl.classList.remove('carrying');
  }
}

// placePlate puts the plate under the box it is about, clamped to the screen: the
// strip scrolls sideways, so a tab can sit at either edge of it.
function placePlate(r, drop, centred) {
  const w = kindHelpEl.offsetWidth;
  const want = centred ? r.left + r.width / 2 - w / 2 : r.left;
  kindHelpEl.style.left = `${Math.max(4, Math.min(want, window.innerWidth - w - 4))}px`;
  kindHelpEl.style.top = `${r.bottom + drop}px`;
}

// showKindHelp puts the plate under the tab it is about, clamped to the screen:
// the strip scrolls sideways, so a tab can sit at either edge of it.
function showKindHelp(btn) {
  if (!kindHelpEl) return;
  const name = btn.dataset.session;
  const what = kindName(kindOf(name), customButtons);
  const mark = kindMark(kindOf(name), customButtons);
  // Nothing to explain: a session nobody stamped, or a button since removed.
  // A plate saying only the name would be a lever that answers nothing.
  if (!what) return;
  kindHelpEl.textContent = mark ? `${mark} ${what}` : what;
  kindHelpEl.hidden = false;
  kindHelpEl.classList.remove('carrying');
  placePlate(btn.getBoundingClientRect(), 4, false);
  helpHeld = true;
  helpHide = setTimeout(hideKindHelp, HELP_SHOWN_MS);
}

// The plate while a tab is being carried, and the finger is why it exists: the
// hand holding the tab covers it, so the row rearranges under something you
// cannot see. It says which session is in hand and it follows the tab, so where
// the tab has got to is readable without lifting the finger to look.
//
// Dropped clear of the thumb rather than sitting under the tab like the other
// plate — a pad is about a centimetre and a half, and a plate four pixels below
// the strip is under it.
const CARRY_DROP = 44;

function paintCarryPlate(btn) {
  if (!kindHelpEl || !btn) return;
  // The question's plate goes away by itself after a few seconds; this one stands
  // for as long as the tab is in hand, however long that is.
  if (helpHide) { clearTimeout(helpHide); helpHide = null; }
  const name = btn.dataset.session;
  const mark = kindMark(kindOf(name), customButtons);
  kindHelpEl.textContent = mark ? `${mark} ${name}` : name;
  kindHelpEl.hidden = false;
  kindHelpEl.classList.add('carrying');
  // Centred under the tab, since this one is about where the tab is.
  placePlate(btn.getBoundingClientRect(), CARRY_DROP, true);
}

// The kind of a session as the last poll reported it. Read from the strip rather
// than refetched: the plate is about the tab under the finger, and a fetch would
// answer after the finger is gone.
const kinds = new Map();
function kindOf(name) { return kinds.get(name) || ''; }

// --- carrying a tab to another place in the row ---
//
// The order is the owner's, because tmux's own is by name — the one order nobody
// chose, and the session you keep coming back to is not the one that sorts first.
//
// The gesture is the press that already existed. A hold picks the tab up (and puts
// the plate under it, which is what the hold used to be for on its own); moving
// then rearranges the row, and the plate goes because the question has been
// answered by the tab starting to move. A press that does not travel is still just
// the question. One gesture, and which of the two it was is decided by the finger
// rather than by a mode.
//
// Not the plain drag: that scrolls the strip, which is what a row wider than the
// screen needs. So the pickup costs a hold, exactly like the plate.
let dragName = null;
let dragMoved = false;
// When the strip was last touched, for telling a mouse from the mouse events a
// touch leaves behind it.
let lastTouchAt = 0;

function tabButton(name) {
  for (const b of tabsEl.querySelectorAll('button[data-session]')) {
    if (b.dataset.session === name) return b;
  }
  return null;
}

// The order the row is in now, which is what the host is told. Names and not
// indices: a session closed between the drag and the save is then simply absent.
async function saveTabOrder() {
  const names = [...tabsEl.querySelectorAll('button[data-session]')].map((b) => b.dataset.session);
  if (!names.length) return;
  try {
    const res = await fetch(`/api/sessions/order?${tokenQS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
    if (!res.ok) {
      // A host that cannot reorder, or a name it did not like. The next poll
      // redraws the row from tmux, so the drag simply does not stick.
      report('tab-order', { ok: false, status: res.status });
      return;
    }
    // The row already looks like this, so the next poll must not rebuild it and
    // take the keyboard with it.
    tabsSignature = names.join('\u0000');
    report('tab-order', { ok: true, count: names.length });
  } catch (_) { /* offline: the row snaps back on the next poll */ }
}

// carryTo puts the held tab where the pointer's x says it belongs. Shared by the
// finger and the mouse: the row is one row, and two copies of this would be two
// answers to where a tab goes.
function carryTo(x) {
  dragMoved = true;
  const held = tabButton(dragName);
  if (!held) return;
  // The x and nothing else — see js/carry.js for what reading the y as well cost.
  // The tab keeps being carried after the pointer has left the strip, because
  // there is nowhere else for it to go.
  const others = [...tabsEl.querySelectorAll('button[data-session]')].filter((b) => b !== held);
  const before = others[dropIndex(others.map((b) => b.getBoundingClientRect()), x)] || null;
  // Only when it actually changes: insertBefore of a node already there is a
  // remove and an add, and the button is under a finger.
  if (held.nextElementSibling !== before) tabsEl.insertBefore(held, before);
  paintCarryPlate(held);
}

// dropCarry ends one, saving the row only if the tab actually travelled.
function dropCarry() {
  const held = tabButton(dragName);
  if (held) held.classList.remove('dragging');
  const moved = dragMoved;
  dragName = null;
  dragMoved = false;
  // Nothing to save for a press that only asked what the tab is — and that one
  // keeps its plate for the few seconds it is allowed, where a carry's goes with
  // the finger that was holding the tab.
  if (moved) { hideKindHelp(); saveTabOrder(); }
  return moved;
}

// The press is watched on the strip, not on each tab: the row is rebuilt whenever
// the set of sessions changes, and listeners on it would go with it.
if (tabsEl) {
  tabsEl.addEventListener('touchstart', (e) => {
    lastTouchAt = Date.now();
    const btn = e.target.closest('button[data-session]');
    hideKindHelp();
    // A new gesture: whatever the last one suppressed, it has had its click by
    // now. Left standing, a press that ended off the tab would eat the next tap.
    helpHeld = false;
    if (!btn || e.touches.length !== 1) return;
    const t = e.touches[0];
    helpStart = { x: t.clientX, y: t.clientY };
    helpTimer = setTimeout(() => {
      helpTimer = null;
      showKindHelp(btn);
      dragName = btn.dataset.session;
      dragMoved = false;
      btn.classList.add('dragging');
    }, HELP_HOLD_MS);
  }, { passive: true });
  // A finger that travels before the hold is up is scrolling the strip, which is
  // what a strip of tabs wider than the screen is for. That gesture must not end
  // in a plate. After the hold, the same travel carries the tab instead.
  tabsEl.addEventListener('touchmove', (e) => {
    if (dragName) {
      // The row is being rearranged, not scrolled. Not passive for this one line:
      // the browser would take the gesture as its own sideways scroll.
      e.preventDefault();
      carryTo(e.touches[0].clientX);
      return;
    }
    if (!helpTimer || !helpStart) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - helpStart.x) > 10 || Math.abs(t.clientY - helpStart.y) > 10) {
      clearTimeout(helpTimer);
      helpTimer = null;
    }
  }, { passive: false });
  for (const end of ['touchend', 'touchcancel']) {
    tabsEl.addEventListener(end, () => {
      lastTouchAt = Date.now();
      if (helpTimer) { clearTimeout(helpTimer); helpTimer = null; }
      helpStart = null;
      if (dragName) dropCarry();
    }, { passive: true });
  }

  // --- the same carry with a mouse ---
  //
  // The page is opened on a laptop as well, and there the row could not be
  // rearranged at all: everything above listens for touches. Reported as the tabs
  // not moving in the web version.
  //
  // No hold here, and that is not an inconsistency: the hold on a phone buys the
  // gesture back from the strip's own sideways scroll, and a mouse scrolls it with
  // a wheel instead of by pushing it. So a plain drag is free — pick up after a
  // few pixels of travel, which is what tells a drag from the click that switches
  // session.
  //
  // A touch produces mouse events of its own after it ends, and those must not be
  // read as a second gesture: they would clear the suppression the hold just set
  // and turn "what is this tab" into a switch to it. Anything within
  // `AFTER_TOUCH` of a touch is that echo, not a mouse.
  const MOUSE_PICKUP = 5;
  const AFTER_TOUCH = 700;
  let mouseFrom = null;
  const echoOfTouch = () => Date.now() - lastTouchAt < AFTER_TOUCH;

  tabsEl.addEventListener('mousedown', (e) => {
    // Left button only: the other two belong to the browser.
    if (e.button !== 0 || echoOfTouch()) return;
    const btn = e.target.closest('button[data-session]');
    // A new gesture, and whatever the last one suppressed has had its click by
    // now. A drag that ends off the tab never produces one, so this is where the
    // suppression is cleared rather than in the click handler alone.
    helpHeld = false;
    if (!btn) return;
    mouseFrom = { x: e.clientX, name: btn.dataset.session };
  });

  // On the document, not the strip: the pointer leaves the row while dragging —
  // the same reason the finger's y is not read.
  document.addEventListener('mousemove', (e) => {
    if (echoOfTouch()) return;
    if (dragName && mouseFrom) {
      // Without this the browser drags a selection along with the tab.
      e.preventDefault();
      carryTo(e.clientX);
      return;
    }
    if (!mouseFrom || Math.abs(e.clientX - mouseFrom.x) < MOUSE_PICKUP) return;
    const btn = tabButton(mouseFrom.name);
    if (!btn) { mouseFrom = null; return; }
    dragName = mouseFrom.name;
    dragMoved = false;
    btn.classList.add('dragging');
    carryTo(e.clientX);
  });

  document.addEventListener('mouseup', () => {
    if (!mouseFrom) return;
    mouseFrom = null;
    // A drag ends in a click on whatever the release landed on, and that click
    // would switch session. `helpHeld` is what swallows it, exactly as it does
    // for the press that only asks what a mark means.
    if (dragName && dropCarry()) helpHeld = true;
  });
}
// Anywhere else, and the plate goes. It is an answer, not a state.
document.addEventListener('touchstart', (e) => {
  if (kindHelpEl && !kindHelpEl.hidden && !e.target.closest('#tabs')) hideKindHelp();
}, { passive: true });

// Where in the working animation a tab starts.
//
// Every tab used to start it at the same instant, so a row of busy sessions
// pulsed in unison — which reads as one decoration for the whole strip rather
// than as several sessions each doing their own thing. The offset comes from the
// name so a tab keeps its phase across rebuilds instead of jumping.
function workingPhase(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100000;
  return `-${h % 4200}ms`;
}

// The state is read rather than pushed, and this is what reads it — only while
// the terminal is on screen and the page is in front. A phone in a pocket keeps
// its socket for hours, and polling tmux for a strip nobody can see is work done
// for nobody. One `list-sessions` per poll; the copy-mode poll behind the same
// header runs every 400ms, so this is the cheap one.
const TAB_POLL_MS = 3000;
let tabPoll = null;
// The drawer counts as something to poll for, and it is the surface the question
// is usually asked from: it is what you open to see what else is running, and with
// nothing attached it is the only thing on screen — so the strip's own condition
// would leave the list as a snapshot of the moment it opened.
function pollTabs(on) {
  const drawerOpen = screenSessions.classList.contains('open');
  const want = on && document.visibilityState === 'visible' && (!screenTerm.hidden || drawerOpen);
  if (want === !!tabPoll) return;
  if (!want) { clearInterval(tabPoll); tabPoll = null; return; }
  tabPoll = setInterval(tickState, TAB_POLL_MS);
  tickState();
}
// One fetch for both surfaces. renderTabs paints the rows as well, and with the
// terminal hidden there is no strip to draw — only the drawer, which is then all
// there is.
function tickState() {
  if (!screenTerm.hidden || screenSessions.classList.contains('open')) renderTabs();
}
// Coming back to the page is when the answer is most out of date: the session was
// working when the phone went into the pocket and has probably finished since.
document.addEventListener('visibilitychange', () => pollTabs(true));

// --- websocket to the attached session ---
function connect() {
  if (!current) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // The size travels in the address, not in the first message after it.
  //
  // tmux attaches a client at whatever size its pty has, and sessions here are
  // grouped — one window, several clients. With `window-size latest` (tmux's own
  // default) the newest client's size becomes the window's, so a client attached
  // at 80x24 while waiting to be told better resizes the shared window under
  // every other client looking at that session: the laptop, and this phone's
  // other tabs. They then draw a screen tmux is filling to a different width,
  // which is halves of two lines in one row and a cursor landing nowhere —
  // reported from the phone twice, "потом прошло" being the resize arriving a
  // moment later. Every tab switch made a new one.
  const qs = [
    tokenQS,
    `session=${encodeURIComponent(current)}`,
    `cols=${term.cols}`,
    `rows=${term.rows}`,
  ].filter(Boolean).join('&');
  ws = new WebSocket(`${scheme}://${location.host}/ws?${qs}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    statusEl.hidden = true;
    retry = 1000;
    noteLink();
    sendResize();
    sendVisible();
  };
  ws.onmessage = (e) => {
    noteLink();
    if (typeof e.data === 'string') { onControl(e.data); return; }
    // One bad write must not take the socket handler with it: an exception
    // here leaves the terminal frozen with output still arriving.
    noteFrameArrived();
    try {
      term.write(new Uint8Array(e.data), scheduleScan);
    } catch (err) {
      report('write-failed', { message: String((err && err.message) || err).slice(0, 120) });
    }
  };
  ws.onclose = () => {
    if (!current) return; // left for the list on purpose
    statusEl.textContent = 'reconnecting…';
    statusEl.hidden = false;
    setTimeout(() => { if (current) connect(); }, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

// --- is the socket still there? ---
//
// A black-holed connection looks exactly like a quiet one from in here, which is
// why the freeze lasted a minute: nothing asked. See js/link.js for what the two
// numbers are and why the question is only asked while the page is on screen.
let lastRx = 0;
let pingSent = 0;

function noteLink() {
  lastRx = Date.now();
  pingSent = 0;
}

function checkLink() {
  if (!ws) return;
  const action = linkAction({
    open: ws.readyState === WebSocket.OPEN,
    visible: document.visibilityState === 'visible',
    now: Date.now(),
    lastRx,
    pingSent,
  });
  if (action === 'ping') {
    pingSent = Date.now();
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) { /* the close will follow */ }
    return;
  }
  if (action !== 'dead') return;
  // Nothing answered. Closing it is what starts the reconnect — onclose already
  // knows how — and the backoff starts over, because this is a socket being
  // discarded rather than a host that cannot be reached.
  report('socket-stalled', { silentMs: Date.now() - lastRx, session: current || '' });
  retry = 1000;
  pingSent = 0;
  const dead = ws;
  ws = null;
  // Both handlers, and onclose is the one that matters: closing a socket fires it,
  // and it schedules a reconnect of its own on top of the one below. That left two
  // sockets on the session, then four — every frame written into the same terminal
  // by each of them, which is what "терминал затроил" was. Same shape as every
  // other deliberate close on this page (showSessions, attach).
  dead.onmessage = null;
  dead.onclose = null;
  try { dead.close(); } catch (_) { /* already gone */ }
  statusEl.textContent = 'reconnecting…';
  statusEl.hidden = false;
  if (current) connect();
}

// One timer for the whole question, at a third of the shorter interval so a
// decision is never more than a moment late.
setInterval(checkLink, 2500);
// Coming back to the page is when a socket is most likely to have died while
// nobody was looking, and the throttled clock of a backgrounded page cannot have
// noticed. Ask at once instead of waiting for the next tick.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkLink();
});

// Server control frames: pong, error, the pane's copy-mode state, and a
// notification the watcher decided to raise.
function onControl(raw) {
  let c = null;
  try { c = JSON.parse(raw); } catch (_) { return; }
  if (c && c.type === 'mode') setCopyMode(!!c.in, c.back | 0);
  if (c && c.type === 'notify') show(noticeFrom(c));
  // What tmux does per wheel notch, asked of tmux rather than assumed: the
  // swipe follows the finger only if the page knows the size of a step.
  if (c && c.type === 'config' && c.wheelLines > 0) { wheelLines = c.wheelLines; setScrollStep(); }
  // How much of the bottom belongs to tmux's own status line.
  if (c && c.type === 'config' && typeof c.statusRows === 'number') statusRows = c.statusRows;
  // What the notification switch is set to, and whether this host has a bot at
  // all. It comes down the socket rather than being asked for over HTTP so the
  // button is right the moment it is drawn — and it comes on every connect,
  // because the state is the host's and another page may have changed it.
  if (c && c.type === 'config' && typeof c.notify === 'string') applyMode(c.notify, !!c.telegram);
  // And which page the server serves. CI installs a build as soon as it
  // arrives, so this frame is also how a reconnect after that restart is told
  // apart from any other reconnect.
  if (c && c.type === 'config') offerUpdate(c.version);
}

// send(data) → whether the socket took it.
//
// The answer is new; the dropping is not. A socket that is connecting, closing
// or gone silently swallowed everything handed to it, which is right for a
// keystroke — there is nowhere to put it — and wrong for a message somebody
// wrote: the composer cleared its field in the same tick, and the text was
// gone. So the outcome is returned, and what is worth keeping is kept by
// whoever knows it is worth keeping.
function send(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(enc.encode(data));
  return true;
}
function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}
// Telegram notifications stay quiet for a session that is on screen right
// now. A backgrounded tab keeps its socket open, so the server cannot tell
// from the connection alone — it needs this.
function sendVisible() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'visible', visible: document.visibilityState === 'visible' }));
  }
}

// sendInput is what every deliberate keystroke goes through, and it exists for
// one thing tmux does silently.
//
// A pane that tmux holds in copy-mode discards what is typed into it: printable
// characters go nowhere and the rest are the mode's own commands. On a laptop
// that is visible and the way out is `q`. On a phone it is invisible — the page
// enters copy-mode by its own scroll gesture, and a pane sitting in it at the
// live end looks exactly like a live one, which is why the way back (⇩) is
// deliberately not shown then. Reported as the terminal refusing text and a
// pasted image never arriving, with the cure found by hand: scroll up and come
// back, which is what ends the mode.
//
// So typing ends the mode. It is the one thing here that asks tmux to leave it,
// and the reason it may is that it is an act, not a guess: somebody is writing
// to the program *now*. The pane is shared, so a laptop reading history is taken
// to the end with it — against every keystroke on the phone going nowhere, that
// is the cheaper loss, and it is written down when it happens.
//
// The request goes as a control frame rather than a `q` because the page's
// picture of the mode is up to a poll old: `q` typed into a pane that has
// already left the mode is a character in somebody's prompt, while the frame
// (tmuxcmd.CancelMode) is refused with a message and types nothing. Ordered
// because the server handles it in the same loop that writes the keystrokes.
// What tmux last said about the pane: whether it is in a mode at all, and how
// far back it is scrolled. Two facts and not one — a pane in copy-mode at the
// live end has nowhere to go back to, which is why the ⇩ is hidden then, and it
// is exactly the state where a keystroke disappears with nothing on screen
// saying why.
let copyMode = false;
let copyBack = 0;

function leaveCopyMode(why, note) {
  // The glide first, and this is the trap the ⇩ button found before typing did:
  // a flick's inertia goes on sending notches for up to a second after the
  // finger has left, and those arrive behind the request and put the pane
  // straight back into the history it was just asked to leave. Typing right
  // after a swipe is the commonest way to meet it — the browser test does
  // exactly that, and without this the keystroke lands in a mode again.
  scroller.stop();
  dropQueuedWheel();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'leave-mode' }));
  }
  // How often this happens is a fact worth having: it is the page taking a mode
  // away from every client on the pane. `note` is whatever the caller had to
  // decide on the way in — the ⇩ says what it did about the focus, and that is
  // the one thing that separates "the keyboard came up again" from "it did not".
  report('leave-mode', { back: copyBack, why, ...note });
  // Optimistic, so a burst of keys asks once; the poll confirms it 400ms later.
  copyMode = false;
}

function sendInput(data) {
  if (copyMode) leaveCopyMode('typing');
  return send(data);
}

// Asking is not enough: the committed word arrives in a later task, so the key
// that ends the input waits for it. Everything about that rule, and why an
// Enter sent in the same tick overtook the word it was meant to follow, is in
// ender.js.
const enders = endingKeys({ send: sendInput, commit: commitPendingInput });

// A mouse report is not typing. xterm hands the wheel to the same callback as
// the keyboard, and while tmux has the mouse on, a scroll arrives here as
// `\x1b[<64;…M` — read as an act of typing it would cancel the very copy-mode
// the scroll had just entered, and drop the queued notches with it. The browser
// test caught that as a wheel that scrolled tmux nowhere.
const MOUSE_REPORT = /^\x1b\[(<|M)/;

term.onData((d) => {
  if (MOUSE_REPORT.test(d)) send(d);
  else sendInput(d);
  // No commitInput() here. Ending the composition after every single
  // character sounded thorough and was wrong: restartInput moves the caret
  // and reopens the input, so typing turned into jumping around the line.
  //
  // This, though, is where a held Enter learns that the word it was waiting for
  // has arrived — see ender.js.
  enders.sawData();
});

// One owner for typing, one for the bar.
//
// Four things used to write to the same textarea: xterm with the IME, an
// intercepted delete, a flush of whatever sat in the textarea, and a synthetic
// compositionend. Every combination of them produced its own surprise — a word
// reappearing, a space going nowhere, a line inserted by a delete. None of
// that is IME behaviour; it is four authors editing one buffer.
//
// So: the keyboard and xterm own what is typed, and nothing here touches the
// composition or the textarea. The bar sends bytes. The single exception is
// asking the app to end the composition before Enter — without it the message
// goes without the word the keyboard is still holding, which is a fact about
// Gboard, not a choice.

// Tapping a button must not take focus away from the terminal: on Android the
// soft keyboard closes the moment the textarea loses focus, and a focus
// restored later — in a timer, a frame callback, after an await — does not
// bring it back, because it is no longer inside the touch. preventDefault on
// the press keeps focus where it is; the click still fires.
function keepsTerminalFocus(el) {
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

// The other answer about the same focus: give it up.
//
// Focus and the keyboard are two different things on Android. Dismissing the
// keyboard leaves the terminal's textarea focused, and the system puts one back
// up for whatever holds focus as soon as the layout moves under it — so a page
// that is only being read has to hold no focus at all, or the next thing that
// moves brings the keyboard back over what is being read. Two places met that:
// a session switch, and the ⇩ that goes back to the live end.
//
// Two bounds, and they are why this is not simply a blur. While the keyboard is
// up, its owner is typing and taking the focus away would close it under them.
// And on a desktop nothing has ever raised one, where focus is the only thing
// that makes typing possible at all — `sawKeyboard` tells the two machines
// apart, and it is learned by watching a keyboard appear rather than guessed
// from the user agent.
function releaseTerminalFocus() {
  if (!sawKeyboard || keyboardUp) return false;
  if (!term.textarea || document.activeElement !== term.textarea) return false;
  term.textarea.blur();
  return true;
}

// --- key bar ---
// Make the keyboard hand over the word it is still composing before a key
// from this bar reaches the pty.
//
// Gboard keeps the current word to itself until it decides the word is over,
// so Enter sent from here arrived before that word and the message went
// without it. Nothing else on the bar needs this: a key that is not an Enter
// does not end an input, and meddling with the composition for those is
// exactly what produced the mess.
//
// Two ways to ask, and for three days there was only the one that this phone
// does not have. The app can restart the input; a browser cannot, but taking
// the focus off the field ends the composition just as well — see
// commitComposition in js/ender.js for why that had to be added and what the
// bridge-less path costs.
function commitPendingInput() {
  // Read before asking: `endEdit` ends the composition, so a state taken
  // afterwards describes what this call did rather than what it found.
  const wasComposing = fieldGuard.isComposing();
  const held = fieldGuard.held();
  // How much of the word xterm wiped on the way out and this put back — see
  // endEditByBlur. Zero on the bridge path, where no focus is moved at all.
  let restored = 0;
  const asked = commitComposition({
    bridge: () => {
      try {
        if (window.PockNative && typeof window.PockNative.commitInput === 'function') {
          return !!window.PockNative.commitInput();
        }
      } catch (_) { /* the key still has to go through */ }
      return false;
    },
    composing: () => fieldGuard.isComposing(),
    endEdit: () => { restored = endEditByBlur(term.textarea); },
  });
  // Behind the input log rather than on by default, which is where everything
  // per-keystroke in this area lives: the switch is what the owner turns on to
  // settle a question about the keyboard, and this is one of those questions.
  // It stayed on for one release while the browser path was being judged from
  // the phone — a line per Enter is a request per Enter, and it is not the
  // price of typing once the answer is known.
  //
  // What it says when it is on: what was asked, whether a composition was open,
  // and how much the field held. "The last word did not go" and "there was
  // nothing to wait for" look the same from a thumb.
  if (inputDiag !== 'off') {
    report('ender', { asked, composing: wasComposing, len: held, restored, native: !!window.PockNative });
  }
  return asked;
}


document.querySelectorAll('#keybar button[data-key]').forEach((b) => {
  keepsTerminalFocus(b);
  b.addEventListener('click', () => {
    // Only the keys that end an input need the keyboard to hand over its word.
    const ends = b.dataset.key === 'enter' || b.dataset.key === 'alt-enter';
    if (ends) enders.press(keyBytes(b.dataset.key));
    else sendInput(keyBytes(b.dataset.key));
    // No focus() here: the press already kept it, and calling it for someone
    // who was only reading would raise the keyboard over the screen.
  });
});

document.getElementById('back').addEventListener('click', toggleDrawer);
document.getElementById('refresh').addEventListener('click', loadSessions);

// Terminal text size (A-/A+), persisted; refit so the grid follows.
function setFont(sz) {
  fontSize = Math.max(9, Math.min(28, sz));
  term.options.fontSize = fontSize;
  try { localStorage.setItem('pt-font', String(fontSize)); } catch (_) {}
  // A-/A+ stays useful while reading a frozen screen.
  snapshotEl.style.fontSize = `${fontSize}px`;
  refit();
}
document.getElementById('font-dec').addEventListener('click', () => setFont(fontSize - 1));
document.getElementById('font-inc').addEventListener('click', () => setFont(fontSize + 1));
// Tapping the terminal returns keyboard focus to it (so typing goes in).
// Not in selection mode: focusing drops the browser's text selection, which
// is exactly what the user is in the middle of making.
document.getElementById('term').addEventListener('click', () => {
  if (selectMode) return;
  term.focus();
  refit();
});

// Touch scroll: a vertical swipe on the terminal is turned into tmux
// mouse-wheel events (SGR). tmux mouse mode is on for pockterm's sessions,
// so the wheel enters copy-mode and scrolls the history — this is what
// makes scrolling work on Android, where xterm's own scrollback is empty
// under tmux.
// Wheel notches are batched into one message per frame.
//
// A swipe produces twenty-odd notches in a second, and each one used to be its
// own socket message: tmux redrew after every one, and the redraws came back
// over the tunnel in clumps — the screen lost the finger and caught up in
// jumps of several lines. One message per frame lets tmux move the history in
// one go and answer with one screen.
let wheelPending = 0;
let wheelFlush = null;

function sendWheel(btn) {
  const dir = btn === 64 ? 1 : -1;
  // A reversal mid-swipe must not cancel out silently: flush what is queued
  // before turning around.
  if (wheelPending !== 0 && Math.sign(wheelPending) !== dir) flushWheel();
  wheelPending += dir;
  if (wheelFlush === null) wheelFlush = requestAnimationFrame(flushWheel);
}

// Notches queued for a frame that no longer matters. Dropping them is not the
// same as flushing them: they are movement the user has just cancelled, and
// sending them puts the pane back where it was asked to leave.
function dropQueuedWheel() {
  if (wheelFlush !== null) { cancelAnimationFrame(wheelFlush); wheelFlush = null; }
  wheelPending = 0;
  // And the shift must not go on covering movement that will never be sent.
  scroller.dropped();
}

function flushWheel() {
  if (wheelFlush !== null) { cancelAnimationFrame(wheelFlush); wheelFlush = null; }
  const n = Math.abs(wheelPending);
  if (n === 0) return;
  const btn = wheelPending > 0 ? 64 : 65;
  wheelPending = 0;
  wheelSentAt = performance.now();
  send(`\x1b[<${btn};1;1M`.repeat(n));
  // One message, one batch: what the shift below counts against the redraws
  // coming back.
  scroller.batched(wheelSentAt);
}

// When the last batch went out and whether its answer has arrived. The lag
// between the two is what "the screen loses the finger" is made of, and it is
// not visible from anywhere else.
//
// A frame arriving long after the batch is not that batch's answer, and the
// journal proved it: one gesture reported lag 5791ms — notches sent, six quiet
// seconds, then unrelated output counted as the reply. That reading went into
// the estimate the shift is predicted with, pushed it to its 200ms ceiling, and
// the screen then held every notch five times too long: a picture that lagged
// the finger and jumped to catch up, reported as the scroll juddering and still
// sticking. So a wait past this is not a measurement, it is a batch whose answer
// never came, and it is counted as one.
const LAG_MAX = 300; // milliseconds
let wheelSentAt = 0;
let wheelLag = 0;
let wheelLagAvg = 0;
let wheelLost = 0;
function noteFrameArrived() {
  if (!wheelSentAt) return;
  const lag = performance.now() - wheelSentAt;
  wheelSentAt = 0;
  if (lag > LAG_MAX) {
    wheelLost++;
    return;
  }
  wheelLag = Math.max(wheelLag, Math.round(lag));
  // Kept as a diagnostic only. The shift used to be predicted from this average
  // and that is what juddered: the trip averages 40-50ms here and peaks at 130,
  // so a long swipe mispredicted several of its notches. What the shift goes by
  // now is the screen moving — see noteScreenMoved.
  wheelLagAvg = wheelLagAvg ? wheelLagAvg * 0.8 + lag * 0.2 : lag;
}

// The pane's content moved: xterm repainted the whole viewport.
//
// This is the answer to a wheel batch, and it is an observation rather than a
// guess. A scroll is a repaint of every row; ordinary output touches the row it
// prints on — measured on the stand, a spinner renders [34,34] and a scroll
// [0,34] of 36 rows. While the pane is scrolled back tmux does not move the view
// for new output at all, which is the whole of the gesture this matters for.
function noteScreenMoved(start, end) {
  if (!movedWholeScreen(start, end, term.rows)) return;
  scroller.drew(performance.now());
}

// Following the finger between two whole lines.
//
// tmux draws in lines and answers over the tunnel, so a slow drag got nothing
// for a couple of lines of travel and then a jump — reported as the scroll
// sticking every few lines. The page shifts the screen it has already been
// given by the travel tmux has not drawn yet, and hands the shift back as the
// content arrives; the arithmetic is in scroll.js, this is only where it
// touches the DOM.
//
// The rows are shifted, not the viewport: what appears at the edge is then the
// terminal's own background rather than the page's, and the shift is capped at a
// few steps of it (MAX_TRACK). `#term` clips, so nothing lands on the bars.
// Whether the page holds the picture between whole lines at all.
//
// On, the rows are shifted to follow the finger and everything in the pane moves
// with them — the agent's own input box and prompt included, which is what
// "the input field keeps riding away" is about. Off, the screen moves only in
// whole lines, the way tmux draws it, and nothing in the pane can be off its
// grid by a fraction.
//
// A lever, not a decision. Which of the two reads better is a question about
// feel on a phone the stand cannot imitate, and the choice is remembered so
// answering it costs one tap rather than a deploy.
let smoothScroll = true;
try { smoothScroll = localStorage.getItem('pt-smooth') !== 'off'; } catch (_) {}

let trackEl = null;
function trackScreen(px) {
  if (!smoothScroll) px = 0;
  if (!trackEl || !trackEl.isConnected) trackEl = document.querySelector('.xterm-screen');
  if (!trackEl) return;
  if (!px) {
    // Let go: the leftover is a fraction of a line that tmux cannot draw, so
    // it settles back instead of snapping.
    trackEl.style.transition = 'transform 90ms ease-out';
    trackEl.style.transform = '';
    holdStatusRows(0, 'transform 90ms ease-out');
    return;
  }
  trackEl.style.transition = 'none'; // following a finger cannot be eased
  trackEl.style.transform = `translateY(${px.toFixed(1)}px)`;
  holdStatusRows(px, 'none');
}

// How many rows at the bottom of the grid are tmux's status line rather than
// the pane. The server asks tmux; 0 until it says otherwise, because a wrong
// guess here pins a row of real output while the rest follows the finger.
let statusRows = 0;

// The status line is not chrome to this page: tmux draws it into the bottom row
// of the same grid the pane lives in, so the shift above moved it along with
// everything else — reported as the green strip rising two lines on an upward
// swipe. Those rows get the shift taken straight back off them.
//
// The same transition on both, so the two cancel at every point of the settle
// rather than only at its end.
function holdStatusRows(px, transition) {
  if (statusRows <= 0) return;
  const rows = document.querySelectorAll('.xterm-rows > div');
  for (let i = Math.max(0, rows.length - statusRows); i < rows.length; i++) {
    rows[i].style.transition = transition;
    rows[i].style.transform = px ? `translateY(${(-px).toFixed(1)}px)` : '';
  }
}

// A row on screen, measured rather than computed: the font metrics of a
// monospace face are not the line box xterm actually draws.
function rowHeight() {
  const row = document.querySelector('.xterm-rows > div');
  const h = row && row.getBoundingClientRect().height;
  return h && h > 4 ? h : Math.max(8, fontSize * 1.2);
}

// How many lines tmux moves per wheel notch. Its own default is five, and the
// server replaces this with what the running tmux actually says.
let wheelLines = 5;

const scroller = new Scroller({
  notch: (dir) => sendWheel(dir > 0 ? 64 : 65), // +1 = towards history
  onTrack: trackScreen,
  // How a swipe felt is not observable from here: the screen it moves lives in
  // tmux, a notch away over the network. These numbers are.
  onGesture: (g) => {
    flushWheel(); // nothing queued may outlive the gesture that made it
    // `lost` counts batches whose answer never came within LAG_MAX. It is
    // reported because the alternative — folding those into `lag` — is what
    // wrecked the shift, and because a swipe full of them says the tunnel is
    // the problem and no amount of tuning here will help.
    report('scroll', {
      ...g,
      lines: wheelLines,
      lag: wheelLag,
      lost: wheelLost,
      predicted: Math.round(wheelLagAvg),
    });
    wheelLag = 0;
    wheelLost = 0;
  },
});
function setScrollStep() { scroller.setStep(rowHeight() * wheelLines); }
setScrollStep();

// Registered here rather than next to the terminal's other handlers: xterm
// renders while it is being opened, and a handler that reaches `scroller`
// before this line would throw on load — which is how the page once died with
// a ReferenceError and the phone showed an empty session list.
term.onRender((e) => noteScreenMoved(e.start, e.end));

let touchY = null;
// The whole terminal screen scrolls it, not just the box the text is drawn in.
//
// Reported as the scroll being cut off rather than covering the screen: a swipe
// that started over the key bar did nothing, and a downward one that ran into it
// had nowhere left to go. The bars take a third of a phone screen, and a thumb
// reaching them mid-swipe is the normal way a long swipe ends.
const gestureArea = document.getElementById('screen-term');

// Where a swipe is not the page's business: the composer is a text field the
// finger drags a caret through, the frozen copy is what a selection is made in,
// the tab strip scrolls sideways under its own gesture, and the answer buttons
// scroll under their own — six options with their labels are taller than the
// room the row is allowed, and a swipe there has to reach the last one rather
// than scroll the terminal underneath.
function ownsGesture(target) {
  return !(target instanceof Element) ||
    !target.closest('#composer, #snapshot, header.bar, #answers, #history-list');
}

// And a swipe to the right brings the drawer, which is the mirror of the swipe
// that puts it away: the panel lives off the left edge, so pulling rightwards is
// pulling it out from there. ☰ is at the top of a phone and the thumb is at the
// bottom, which is the whole reason for it.
//
// It rides on the terminal's own gesture rather than beside it, because the two
// share a finger and only one of them can have it. The scroll is vertical, so the
// drawer takes the gesture only when it is unmistakably sideways — and takes it
// whole: `scroller.cancel` ends the swipe the way a browser stealing it does,
// with no glide, or the terminal would go on scrolling behind an open drawer.
// Any sub-line shift the first few pixels bought is given back by the settle,
// which is `cancel`'s existing job.
let swipeFrom = null;
gestureArea.addEventListener('touchstart', (e) => {
  // Selection mode gives the drag gesture back to the browser: swiping has
  // to select text there, not scroll.
  scroller.stop();
  swipeFrom = null;
  if (selectMode || !ownsGesture(e.target)) { touchY = null; return; }
  touchY = e.touches[0].clientY;
  swipeFrom = { x: e.touches[0].clientX, y: touchY };
  setScrollStep();
  scroller.start(e.timeStamp);
}, { passive: true });
gestureArea.addEventListener('touchmove', (e) => {
  if (touchY === null) return;
  const y = e.touches[0].clientY;
  if (swipeFrom) {
    const dx = e.touches[0].clientX - swipeFrom.x;
    if (dx > DRAWER_SWIPE && dx > Math.abs(y - swipeFrom.y)) {
      swipeFrom = null;
      touchY = null;
      scroller.cancel(e.timeStamp, 'drawer');
      openDrawer();
      return;
    }
  }
  scroller.move(y - touchY, e.timeStamp);
  touchY = y;
}, { passive: true });
// The browser can take a gesture away mid-swipe — a system gesture at the
// screen edge, a second finger, its own scrolling. Reported as a long swipe
// being interrupted: without this the page never heard the gesture end, so the
// screen stayed shifted where the last touchmove left it and nothing moved
// again until the next touch. `touch-action: none` on the screen is the other
// half — it asks the browser not to take it in the first place.
gestureArea.addEventListener('touchcancel', (e) => {
  swipeFrom = null;
  if (touchY === null) return;
  touchY = null;
  scroller.cancel(e.timeStamp);
}, { passive: true });
gestureArea.addEventListener('touchend', (e) => {
  swipeFrom = null;
  if (touchY === null) return;
  touchY = null;
  scroller.end(e.timeStamp);
}, { passive: true });

// Hide/show the bottom bar to give the terminal the whole screen.
let panelsHidden = false;
const showBarsBtn = document.getElementById('show-bars');
function setPanelsHidden(on) {
  panelsHidden = on;
  screenTerm.classList.toggle('panels-hidden', on);
  showBarsBtn.hidden = !on;
  refit();
}
document.getElementById('hide').addEventListener('click', () => setPanelsHidden(true));
showBarsBtn.addEventListener('click', () => setPanelsHidden(false));

// tmux shares one window size across all clients of a session, so when a
// second (smaller) client connects the window shrinks and this one gets
// filler dots. Reclaim the size for whichever device is active: on focus,
// on becoming visible, so the device you're actually using wins.
window.addEventListener('focus', refit);
document.addEventListener('visibilitychange', () => {
  sendVisible();
  if (document.visibilityState === 'visible') refit();
});

// --- prompt mode: composer + detected answer buttons ---
const answersEl = document.getElementById('answers');
const composerEl = document.getElementById('composer');
const quickbarEl = document.getElementById('quickbar');
const promptEl = document.getElementById('prompt');
const modeBtn = document.getElementById('mode');
const keybarEl = document.getElementById('keybar');
const selbarEl = document.getElementById('selbar');
const selectBtn = document.getElementById('select');
const snapshotEl = document.getElementById('snapshot');
const pasteTargetEl = document.getElementById('paste-target');
const pickFileEl = document.getElementById('pick-file');
const toastEl = document.getElementById('toast');

// Quick macros for prompt mode. "accept" is right-arrow + Enter — one tap
// to accept Claude's inline suggestion; "ctrl-c" stops the running process.
const MACROS = {
  accept: '\x1b[C\r',
  enter: '\r',
  esc: '\x1b',
  'ctrl-c': '\x03',
};
// Macros live in two places now — the key bar and prompt mode's quick row —
// and both send the same thing.
document.querySelectorAll('button[data-macro]').forEach((b) => {
  keepsTerminalFocus(b);
  b.addEventListener('click', () => {
    // Same rule as the key bar's Enter, and the same list: what ends an input
    // waits for the word, what interrupts it (esc, ctrl-c) must not wait for
    // anything. Asking for a commit on those was what the comment above
    // already said not to do.
    const macro = b.dataset.macro;
    if (macro === 'enter' || macro === 'accept') enders.press(MACROS[macro]);
    else send(MACROS[macro]);
  });
});

// Bottom bars are mutually exclusive: selection mode wins over prompt mode
// (composer and key bar both steal the taps a selection needs), prompt mode
// swaps the key bar for the composer + quick macros. Detected answer buttons
// live above all of them and show in every mode.
// Which bar the phone opens on.
//
// Inside the app the composer comes first, and that is a decision about the
// keyboard rather than about layout: the terminal's own field is the one an
// IME rewrites behind the page's back — a word re-composed after a backspace,
// letters of one word spliced into the next — and dictation, which arrives in
// whole phrases, is the worst case of exactly that. The composer is an
// ordinary textarea: the text is finished before any of it reaches the pty.
//
// Nothing is taken away. Tapping the terminal still types straight into it,
// and ⌨ brings back the full key bar — and is remembered, so this is what
// shows until a choice is made, not a rule.
//
// In a browser the old default stands: there the keyboard is a keyboard.
function inApp() {
  return !!(window.PockNative && typeof window.PockNative.copy === 'function');
}

// Reported as "the input box sticks and it switches into it by itself". The
// default only applies until a choice is made, so either the choice is not
// being stored or something re-runs this — and from the page there is no way
// to tell which. The startup report below says what was found and what was
// chosen, so the next occurrence answers it from the journal.
function defaultPromptMode() {
  let saved = null;
  try { saved = localStorage.getItem('pt-bar'); } catch (_) {}
  const mode = saved === 'composer' ? true : saved === 'keys' ? false : inApp();
  report('bars', { saved: saved || '', inApp: inApp(), composer: mode });
  return mode;
}

let promptMode = defaultPromptMode();
let selectMode = false;
let hadTerminalFocus = false;
// focusNow: only a tap that asked for a mode may raise the keyboard. This
// function runs on every re-render — a session switch, a resize, an answer
// row appearing — and focusing from there is what kept pushing the keyboard
// onto the screen uninvited.
function renderBars(focusNow = false) {
  selbarEl.hidden = !selectMode;
  composerEl.hidden = selectMode || !promptMode;
  quickbarEl.hidden = selectMode || !promptMode;
  keybarEl.hidden = selectMode || promptMode;
  modeBtn.classList.toggle('on', promptMode);
  selectBtn.classList.toggle('on', selectMode);
  if (focusNow && promptMode && !selectMode) promptEl.focus();
  refit();
}
// Which keyboard the app should give this screen.
//
// The terminal wants a keyboard with no composing region: Gboard's document
// model is what made typed text drift, and only the app can turn it off (see
// TerminalWebView in the devops repo). The composer wants the opposite — it is
// an ordinary text field, and suggestions and dictation are the reason to use
// it. An app older than this call simply says no.
function setImeMode(mode) {
  try {
    if (window.PockNative && typeof window.PockNative.setImeMode === 'function') {
      const ok = window.PockNative.setImeMode(mode);
      report('ime-mode', { mode, ok: !!ok });
      return;
    }
  } catch (e) {
    report('ime-mode', { mode, error: (e && e.name) || 'error' });
  }
}

// Raw is opt-in until it is known to work: `?ime=raw`, remembered for the
// session so a reload keeps whatever was being tested.
// The parameter is read once, on load, and then the stored value is the only
// source. Re-reading it on every call meant a URL still carrying ?ime= undid
// every tap on the switch in ⋯ — and inside the Android client that URL cannot
// be edited, so the mode would have been stuck for good.
//
// Stored in localStorage, not sessionStorage: the app restarts its activity
// on a rotation or on coming back from the launcher, and the mode being
// tested vanished with it — the journal shows `raw` chosen at 16:04 and
// `text` again after the next load. A mode nobody can keep is a mode nobody
// can evaluate.
(function imeFromURL() {
  const fromUrl = new URLSearchParams(location.search).get('ime');
  if (!fromUrl) return;
  const asked = (fromUrl === 'raw' || fromUrl === 'raw-strict') ? fromUrl : 'text';
  try { localStorage.setItem('pt-ime', asked); } catch (_) {}
})();

// What the terminal asks for when nobody has chosen. `raw` since 2026-08-03:
// measured on the owner's phone under app 2.3, it is the mode where a
// backspace arrives as `deleteContentBackward` instead of a composition
// rewriting the whole word — which is what put a second copy of the word into
// the terminal — and the composing region covers the last word rather than
// everything typed so far. The keyboard comes up, which is what 2.1 failed at.
//
// `raw-strict` replaces the input type outright and stays opt-in: that is the
// variant that left the phone with no keyboard at all.
const IME_DEFAULT = 'raw';

function imeWanted() {
  let asked = null;
  try { asked = localStorage.getItem('pt-ime'); } catch (_) {}
  // A stored "text" is a decision, not an absence of one: whoever switched
  // back gets what they asked for, default or no default.
  if (asked === 'raw' || asked === 'raw-strict' || asked === 'text') return asked;
  return IME_DEFAULT;
}

// The three modes, in the order the button walks through them. Three taps
// come back to the start: a mode that takes the keyboard away must not be a
// one-way door on the only device that can test it.
const IME_MODES = ['text', 'raw', 'raw-strict'];

const imeBtn = document.getElementById('ime');

function renderImeButton() {
  if (imeBtn) imeBtn.textContent = '⌨ ' + imeWanted();
}

// Switch the mode from the page. The URL parameter cannot be reached inside
// the Android client — it loads a fixed address — and this is the same lever
// with somewhere to pull it.
function cycleIme() {
  const next = IME_MODES[(IME_MODES.indexOf(imeWanted()) + 1) % IME_MODES.length];
  try { localStorage.setItem('pt-ime', next); } catch (_) {}
  renderImeButton();
  // The composer keeps the ordinary keyboard whatever the terminal asked for,
  // so apply through the same rule rather than setting the new mode blindly.
  setImeMode(promptMode ? 'text' : imeWanted());
}

if (imeBtn) imeBtn.addEventListener('click', cycleIme);
renderImeButton();

function setPromptMode(on) {
  promptMode = on;
  try { localStorage.setItem('pt-bar', on ? 'composer' : 'keys'); } catch (_) {}
  // The composer always wants the ordinary keyboard; the terminal gets
  // whatever is being tested, which for now is the same thing.
  setImeMode(on ? 'text' : imeWanted());
  renderBars(true);
}
modeBtn.addEventListener('click', () => setPromptMode(!promptMode));
// The bars start hidden in the markup, so the chosen mode has to be drawn
// once — without focus, or opening a session would raise the keyboard at
// somebody who only wanted to read.
renderBars();

// Installing puts pockterm on the home screen as its own app: a standalone
// window with no tabs and no address bar, which is also the only way the
// Ctrl+W/T/N keys ever reach the shell. Chrome hands over its own prompt and
// only once, so the button appears when the offer arrives and disappears
// after it is used.
// The button in the drawer stays — it is where you go to install after waving
// the bar away — but the bar is what makes the offer findable. Two taps deep in
// a screen nobody opens on a first visit is not an offer.
const installBtn = document.getElementById('install');
const installBarEl = document.getElementById('install-bar');
const installTextEl = document.getElementById('install-text');
const installDoBtn = document.getElementById('install-do');
let installPrompt = null;
let installDismissed = false;
try { installDismissed = localStorage.getItem('pt-install-dismissed') === 'yes'; } catch (_) {}

function installState() {
  return installDecision({
    native: !!window.PockNative,
    // Both, because the two platforms answer in different places: Chrome opens
    // the installed app in a standalone display mode, Safari sets a flag.
    standalone: !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || navigator.standalone === true,
    prompt: !!installPrompt,
    ios: isIOS(navigator.userAgent || '', navigator.maxTouchPoints || 0),
    dismissed: installDismissed,
  });
}

let installOffered = '';
function renderInstall() {
  const state = installState();
  const text = installText(state);
  installBtn.hidden = !installPrompt;
  if (!text) {
    installBarEl.hidden = true;
    return;
  }
  installTextEl.textContent = text.body;
  installDoBtn.hidden = !text.action;
  if (text.action) installDoBtn.textContent = text.action;
  installBarEl.hidden = false;
  // Reported once per kind of offer, not once per render: the bar is redrawn
  // whenever the page reconsiders, and a counter that moves on redraw says
  // nothing about how often the offer is seen.
  if (installOffered === state) return;
  installOffered = state;
  report('install-offer', { how: state });
}

window.addEventListener('beforeinstallprompt', (e) => {
  // Chrome would otherwise show its own mini-infobar, which is easy to miss and
  // impossible to bring back; this page asks in its own words instead.
  e.preventDefault();
  installPrompt = e;
  renderInstall();
});

async function takeInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice.catch(() => ({ outcome: 'error' }));
  report('install-choice', { outcome });
  installPrompt = null;
  renderInstall();
}
installBtn.addEventListener('click', takeInstall);
installDoBtn.addEventListener('click', takeInstall);

// "Later" is remembered, because a bar that comes back on every load is a bar
// that gets ignored — and then the update bar in the same place gets ignored
// with it. A one-tap install offer still returns: see installDecision.
document.getElementById('install-close').addEventListener('click', () => {
  installDismissed = true;
  try { localStorage.setItem('pt-install-dismissed', 'yes'); } catch (_) {}
  report('install-dismissed', {});
  renderInstall();
});

window.addEventListener('appinstalled', () => {
  report('installed', {});
  installPrompt = null;
  renderInstall();
});

// Drawn once at load: on iOS nothing will ever fire an event, so a page that
// only reacted to one would never say anything there.
renderInstall();

// Text size, notifications, the keyboard mode and the smooth lever are settings,
// not controls — they live at the bottom of the drawer now (see #settings in
// index.html), where a decision is made, rather than over the terminal, where
// work is done.
const versionsEl = document.getElementById('versions');
{
  const app = appVersion();
  versionsEl.textContent = app ? `page ${APP_VERSION} · app ${app}` : `page ${APP_VERSION}`;
}
const smoothBtn = document.getElementById('smooth');
function renderSmooth() {
  smoothBtn.textContent = smoothScroll ? '〰 smooth' : '〰 lines';
  smoothBtn.classList.toggle('on', smoothScroll);
}
renderSmooth();
smoothBtn.addEventListener('click', () => {
  smoothScroll = !smoothScroll;
  try { localStorage.setItem('pt-smooth', smoothScroll ? 'on' : 'off'); } catch (_) {}
  renderSmooth();
  // Whatever the shift was at that moment belongs to the mode being left.
  trackScreen(0);
  report('smooth', { on: smoothScroll });
});

// --- the composer's memory ------------------------------------------------
// Why any of this exists is in js/compose.js: a send is not guaranteed, and the
// field used to be cleared as though it were.
let sentHistory = [];
try { sentHistory = JSON.parse(localStorage.getItem('pt-sent') || '[]'); } catch (_) { /* gone */ }
if (!Array.isArray(sentHistory)) sentHistory = [];
const historyBtn = document.getElementById('history');
const historyListEl = document.getElementById('history-list');

function saveHistory() {
  historyBtn.hidden = sentHistory.length === 0;
  try { localStorage.setItem('pt-sent', JSON.stringify(sentHistory)); } catch (_) { /* full or off */ }
}
saveHistory();

// The draft, written down as it is typed. A reload is the page's own suggestion
// after a deploy (see #update-bar), the WebView is killed whenever Android
// decides, and either used to take a half-written message with it.
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try { localStorage.setItem('pt-draft', promptEl.value); } catch (_) { /* full or off */ }
  }, 300);
}
try {
  const draft = localStorage.getItem('pt-draft');
  if (draft) promptEl.value = draft;
} catch (_) { /* gone */ }

function showHistory(on) {
  historyListEl.hidden = !on;
  historyBtn.classList.toggle('on', on);
  if (!on) return;
  historyListEl.innerHTML = '';
  for (const text of sentHistory) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = previewOf(text);
    b.title = text;
    // Into the field rather than straight down the socket: what is recalled is
    // usually being sent again *because* something went wrong with it, and a
    // second copy of the wrong thing is worse than the first.
    b.addEventListener('click', () => {
      promptEl.value = text;
      growPrompt();
      saveDraft();
      showHistory(false);
      promptEl.focus();
    });
    historyListEl.appendChild(b);
  }
}
historyBtn.addEventListener('click', () => showHistory(historyListEl.hidden));
// A tap anywhere else puts it away. It covers the bottom of the terminal, so
// the way out has to be the one a hand tries first — and the bar it belongs to
// can be swapped for the key bar while it is open, which would otherwise leave
// a list hanging over a composer that is no longer there.
document.addEventListener('pointerdown', (e) => {
  if (historyListEl.hidden) return;
  if (e.target instanceof Element && e.target.closest('#history-list, #history')) return;
  showHistory(false);
}, true);

// Send the composed prompt (text + Enter). The field is cleared only when the
// socket took the bytes, and what went out is remembered either way.
composerEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = promptEl.value;
  if (!text) return;
  const gone = sendInput(text + '\r');
  report('prompt', { chars: text.length, sent: gone, state: ws ? ws.readyState : -1 });
  if (!gone) {
    // Held, not queued: a message delivered on the next connect would arrive
    // into whatever the session is doing by then, and nothing downstream knows
    // it is a latecomer.
    toast('not sent: no connection — the text is still here');
    return;
  }
  sentHistory = pushHistory(sentHistory, text);
  saveHistory();
  promptEl.value = '';
  try { localStorage.removeItem('pt-draft'); } catch (_) { /* gone */ }
  growPrompt();
  promptEl.focus();
});
// Grow the textarea with its content, up to the CSS max-height.
function growPrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = promptEl.value ? promptEl.scrollHeight + 'px' : 'auto';
}
promptEl.addEventListener('input', () => {
  growPrompt();
  saveDraft();
});
growPrompt();

// --- selection mode and the clipboard ---
// Copy and paste are otherwise silent, and "no idea what got copied" is the
// complaint this has to answer, so every action reports what it moved.
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2500);
}

// The selection is captured while it is being made: tapping Copy moves the
// focus and can clear the document selection before the handler runs.
let lastSelection = '';
function remember(text) { if (text) lastSelection = text; }
document.addEventListener('selectionchange', () => remember(String(document.getSelection() || '')));
term.onSelectionChange(() => remember(term.getSelection()));

function selectedText() {
  return term.getSelection() || String(document.getSelection() || '') || lastSelection;
}

function dropSelection() {
  lastSelection = '';
  term.clearSelection();
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
}

// Selection mode covers the terminal with a frozen copy of the screen (see
// #snapshot in app.css) and selects from that. Selecting in the live
// terminal does not work: tmux mouse mode swallows the drag, and every
// write rebuilds the rows the selection is anchored in — with an agent
// printing a spinner the highlight disappears before Copy can be tapped.
// Entering starts from a clean slate: Copy must never hand over leftovers.
function setSelectMode(on) {
  selectMode = on;
  dropSelection();
  if (on) {
    snapshotEl.textContent = snapshotText(visibleLines());
    snapshotEl.style.fontSize = `${fontSize}px`;
  }
  snapshotEl.hidden = !on;
  if (!on) closePasteTarget();
  renderBars();
  if (on) {
    hadTerminalFocus = !!term.textarea && document.activeElement === term.textarea;
    toast('select text, then Copy — the screen is frozen');
  } else if (hadTerminalFocus) {
    // Give the terminal its focus back only if selection mode took it away;
    // raising the keyboard for someone who was only reading is noise.
    term.focus();
  }
}
for (const b of document.querySelectorAll('#modebar button, #modebar label, #settings button, #show-bars')) {
  keepsTerminalFocus(b);
}
selectBtn.addEventListener('click', () => setSelectMode(!selectMode));
document.getElementById('sel-done').addEventListener('click', () => setSelectMode(false));

// Put text in the device clipboard and report which way it went — "copied"
// with nothing in the clipboard is worse than an honest failure, and the
// only way to tell them apart on a phone is to say so on screen.
//
// The old fallback was a readonly, fully transparent textarea. On Android
// Chrome that combination reports success and copies nothing: the element is
// not rendered enough to hold a selection. A contenteditable node that is
// actually laid out, selected through a Range, does copy.
async function writeClipboard(text) {
  // Inside the owner's Android client the page is not in Chrome but in a
  // WebView, which has no asynchronous clipboard at all. That app injects a
  // bridge to the system clipboard; when it is there, nothing else comes
  // close for reliability.
  if (window.PockNative && typeof window.PockNative.copy === 'function') {
    try {
      if (window.PockNative.copy(text)) return 'native';
      lastCopyError = 'native bridge refused';
    } catch (e) {
      lastCopyError = `native bridge: ${(e && e.name) || 'error'}`;
    }
  }
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return 'api';
    } catch (e) {
      // Falls through, but the reason is worth keeping: "Document is not
      // focused" and a denied permission need different answers.
      lastCopyError = (e && e.name) || 'error';
    }
  } else {
    lastCopyError = 'no clipboard API (page is not a secure context)';
  }
  // Focus has to come back where it was: the node below is focused for
  // execCommand and then destroyed, and focus destroyed with it means no
  // keyboard until the page is reloaded.
  const hadFocus = document.activeElement;
  try {
    const host = document.createElement('div');
    host.contentEditable = 'true';
    host.textContent = text;
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inputmode', 'none'); // do not raise the keyboard for it
    host.tabIndex = -1;
    host.style.cssText =
      'position:fixed;left:0;bottom:0;width:2px;height:2px;padding:0;' +
      'border:0;outline:0;overflow:hidden;opacity:0.01;white-space:pre;z-index:-1';
    document.body.appendChild(host);

    const range = document.createRange();
    range.selectNodeContents(host);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    host.focus({ preventScroll: true });

    // The document-level copy listener must not treat this as the user's
    // own copy: the selection here is ours, not theirs.
    copyingViaFallback = true;
    const ok = document.execCommand('copy');
    copyingViaFallback = false;
    sel.removeAllRanges();
    host.remove();
    if (hadFocus && hadFocus.focus) hadFocus.focus({ preventScroll: true });
    return ok ? 'exec' : null;
  } catch (e) {
    lastCopyError = (e && e.name) || 'error';
    return null;
  }
}
let lastCopyError = '';
let copyingViaFallback = false;

// Read an image out of the clipboard where the browser allows it. Wrapped
// because navigator.clipboard.read is missing on Firefox and throws on a
// denied permission, and neither is worth a stack trace.
async function clipboardImage() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) return null;
    return await firstImage(await navigator.clipboard.read());
  } catch (_) {
    return null;
  }
}

// First non-blank line, trimmed: enough to recognise what was copied.
function preview(text) {
  const t = (text.split('\n').find((l) => l.trim()) || '').trim();
  return t.length > 28 ? `${t.slice(0, 28)}…` : t;
}

// Android's selection menu has its own Copy, and so does Ctrl+C — neither
// goes anywhere near the button below. Without this, copying that way left
// the frozen screen covering the terminal: taps did nothing, the keyboard
// never returned, and reloading the page was the only way out.
// A tap on the frozen screen that selects nothing means "I am done looking".
// Without it the only way out is the Done button, and every report so far has
// been that selection mode hangs the terminal — because from the outside a
// frozen screen and a hung one are the same picture.
snapshotEl.addEventListener('click', () => {
  const sel = String(window.getSelection() || '');
  if (sel) return; // a tap that lands inside a selection is not a way out
  setSelectMode(false);
  toast('screen is live again');
});

document.addEventListener('copy', () => {
  if (copyingViaFallback || !selectMode) return;
  const text = selectedText();
  setSelectMode(false);
  if (text) toast(`copied ${text.length} chars: ${preview(text)}`);
});

document.getElementById('copy').addEventListener('click', async () => {
  const text = selectedText();
  if (!text) { toast('nothing selected'); return; }
  lastCopyError = '';
  const how = await writeClipboard(text);
  report('copy', { how, chars: text.length, error: lastCopyError });
  if (!how) { toast(`copy failed: ${lastCopyError || 'blocked by the browser'}`); return; }
  // Leave selection mode on the way out: the frozen screen looks exactly
  // like the terminal, so staying in it after a copy reads as a hung app —
  // taps do nothing and the keyboard never comes back. Exiting here also
  // puts focus back in the terminal inside the same tap, which is what
  // Android needs to raise the keyboard.
  setSelectMode(false);
  // The mechanism is named because the fallback is the one that can lie.
  toast(`copied ${text.length} chars (${how}): ${preview(text)}`);
});

// --- pasting an image ---
// The pty carries keystrokes, so an image cannot go into the terminal at
// all. It goes to the server instead, which saves it and answers with a
// path; the path is what gets typed. Claude Code reads a file mentioned in
// the prompt, so from the phone this is the same gesture as pasting text.
async function attachImage(file) {
  closePasteTarget();
  const kb = Math.max(1, Math.round((file.size || 0) / 1024));
  toast(`uploading ${kb} KB…`);
  let res;
  try {
    res = await fetch(`/api/upload?${tokenQS}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch (_) {
    toast('upload failed: no connection');
    return;
  }
  if (!res.ok) {
    // The server explains a refusal in plain text (not an image, too large);
    // silence here would read as "the paste did nothing".
    //
    // 413 is the exception, and the tell is that it does not come from this
    // server at all — nothing here answers with it. The proxy in front refuses
    // the body before pockterm sees a byte of it, and what comes back is a page
    // of HTML, which is a poor thing to put in a toast. It only ever appeared
    // with a photo: a screenshot is a few hundred kilobytes and goes through,
    // a camera frame is several megabytes and does not.
    const why = res.status === 413
      ? `${kb} KB is more than the proxy in front lets through`
      : (await res.text().catch(() => '')).trim().slice(0, 120);
    // Written down, because a failed upload used to be the one outcome here
    // that left no line in the journal: "413 при загрузке фото" had to be
    // reported by hand before anything could be looked at.
    report('upload', {
      ok: false, status: res.status, bytes: file.size || 0, type: file.type || '', why,
    });
    toast(why ? `upload refused: ${why}` : `upload failed: ${res.status}`);
    return;
  }
  const { path } = await res.json().catch(() => ({}));
  report('upload', { ok: !!path, bytes: file.size || 0, type: file.type || '' });
  if (!path) { toast('upload failed: no path in the answer'); return; }
  // Trailing space so the next thing typed does not glue itself to the path.
  term.paste(`${path} `);
  // Same reason as after a copy: do not leave a frozen screen in the way of
  // what the user types next.
  if (selectMode) setSelectMode(false);
  toast(`attached ${path.split('/').pop()}`);
}

document.addEventListener('paste', (e) => {
  const file = pickImage(e.clipboardData);
  if (!file) return; // text: leave the terminal's own paste path alone
  e.preventDefault();
  attachImage(file);
});

// Drag and drop from a desktop file manager, same destination.
document.addEventListener('dragover', (e) => { if (carriesFiles(e.dataTransfer)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  const file = pickImage(e.dataTransfer);
  if (!file) return;
  e.preventDefault();
  attachImage(file);
});

// One way in for pasted text, whichever path produced it.
function pasteIntoTerminal(text) {
  term.paste(text);
  toast(`pasted ${text.length} chars`);
}

// When the browser will not read the clipboard for us, the system still
// will — its own Paste needs no permission. The field takes it, the terminal
// gets what landed there, and the field disappears again.
function openPasteTarget(why) {
  pasteTargetEl.value = '';
  pasteTargetEl.hidden = false;
  pasteTargetEl.focus();
  toast(why);
}
function closePasteTarget() {
  pasteTargetEl.value = '';
  pasteTargetEl.hidden = true;
}
pasteTargetEl.addEventListener('paste', () => {
  // An image is handled by the document-level listener (it cancels the
  // default, so nothing lands here). Text arrives after this event, hence
  // the tick.
  setTimeout(() => {
    const text = pasteTargetEl.value;
    closePasteTarget();
    if (!text) return;
    term.paste(text);
    toast(`pasted ${text.length} chars`);
  }, 0);
});
// Closing on blur must not race the paste itself: on Android the system
// paste menu can take focus away for a moment, and hiding the field then
// would drop what the user is about to paste.
pasteTargetEl.addEventListener('blur', () => {
  setTimeout(() => {
    if (!pasteTargetEl.hidden && !pasteTargetEl.value && document.activeElement !== pasteTargetEl) {
      closePasteTarget();
    }
  }, 600);
});

// Attach an image from storage. On Android a screenshot is a file, not
// clipboard content, so this is the only path that reaches it.
document.getElementById('pick').addEventListener('click', () => pickFileEl.click());
pickFileEl.addEventListener('change', () => {
  const file = pickFileEl.files && pickFileEl.files[0];
  pickFileEl.value = ''; // so picking the same file twice fires again
  if (file) attachImage(file);
});

document.getElementById('paste').addEventListener('click', async () => {
  let text = '';
  // Same bridge, other direction: a WebView never resolves readText().
  if (window.PockNative && typeof window.PockNative.read === 'function') {
    try {
      const native = String(window.PockNative.read() || '');
      report('paste', { via: 'native', chars: native.length });
      if (native) { pasteIntoTerminal(native); return; }
      // Empty is not the end of the road: the system clipboard holds no
      // plain text right now, but it may hold an image, and this WebView
      // does expose the browser clipboard as well. Falling through beats
      // announcing failure with two paths untried.
    } catch (e) {
      report('paste', { via: 'native', error: (e && e.name) || 'error' });
    }
  }
  try {
    text = (await navigator.clipboard.readText()) || '';
    report('paste', { via: 'browser', chars: text.length });
  } catch (e) {
    // readText refuses on an image-only clipboard and on a denied
    // permission; the image case is worth trying before giving up.
    const image = await clipboardImage();
    report('paste-refused', { error: (e && e.name) || 'error', gotImage: !!image });
    if (image) { attachImage(image); return; }
    openPasteTarget(`browser refused the clipboard (${(e && e.name) || 'error'}) — paste here`);
    return;
  }
  if (!text) {
    const image = await clipboardImage();
    report('paste', { via: 'image', found: !!image });
    if (image) { attachImage(image); return; }
    openPasteTarget('clipboard looks empty — paste here');
    return;
  }
  // term.paste honours bracketed-paste mode, so a multi-line paste arrives
  // as one block instead of firing a message per line in Claude Code.
  term.paste(text);
  toast(`pasted ${text.length} chars`);
});

// Read the visible terminal rows for the prompt detector.
function visibleLines() {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

// --- notifications while the page is open ---------------------------------
// One watcher decides for both channels: the server messages Telegram for a
// session nobody has open, and sends this page a frame when it is open but in
// the background — another tab, a phone with the screen off. The page keeps
// only the switch and the permission; deciding when to raise a notice is not
// its business any more, and why it stopped being it is in js/notify.js.
const bellBtn = document.getElementById('bell');
// Three states, one switch: this page while it is open, plus Telegram when
// nothing is, or neither. The host owns the value — see js/notify.js — and
// `notifyTG` is not part of it: it says whether the middle state exists here at
// all, which depends on a bot token this page never sees.
let notifyMode = 'off';
let notifyTG = false;
let notifyOn = false;
// The service worker's registration, once it is ready: the only path that can
// show a notification in Android Chrome, and the one that carries a tap. Null
// until then, and a notice arriving in that window falls back to the
// constructor — see deliver() in js/notify.js.
let swReg = null;

// --- input log ------------------------------------------------------------
// Records what the keyboard does to the terminal's field, into the server's
// journal: `journalctl -u pockterm | grep '"event":"input"'`. Off, shapes, or
// shapes plus the typed text — see js/inputdiag.js for why the last one is a
// separate step and not a default.
const inputDiagBtn = document.getElementById('input-diag');
const DIAG_LEVELS = ['off', 'on', 'chars'];
let inputDiag = 'off';
let unwatchInput = null;
try { inputDiag = DIAG_LEVELS.includes(localStorage.getItem('pt-input-diag')) ? localStorage.getItem('pt-input-diag') : 'off'; } catch (_) {}

function applyInputDiag() {
  if (unwatchInput) { unwatchInput(); unwatchInput = null; }
  if (inputDiag !== 'off') {
    unwatchInput = watchInput(term.textarea, inputDiag, report);
    report('input-log', { level: inputDiag });
  }
  inputDiagBtn.classList.toggle('on', inputDiag !== 'off');
  inputDiagBtn.title = inputDiag === 'off' ? 'Record what the keyboard does'
    : inputDiag === 'on' ? 'Recording (no text) — tap for text too' : 'Recording with text — tap to stop';
}

inputDiagBtn.addEventListener('click', () => {
  inputDiag = DIAG_LEVELS[(DIAG_LEVELS.indexOf(inputDiag) + 1) % DIAG_LEVELS.length];
  try { localStorage.setItem('pt-input-diag', inputDiag); } catch (_) {}
  applyInputDiag();
  toast(inputDiag === 'off' ? 'input log off'
    : inputDiag === 'on' ? 'input log on (no text)' : 'input log on — WITH TEXT');
});
applyInputDiag();
// The state the button shows before the socket says what the host has. Kept
// only as a cache — the server owns the switch, because half of it is Telegram
// — so a stale value costs one frame of a wrong label and nothing else.
try { notifyMode = localStorage.getItem('pt-notify-mode') || 'off'; } catch (_) {}
notifyOn = notifyMode !== 'off';

function renderBell() {
  const label = modeLabel(notifyMode, notifyTG);
  bellBtn.classList.toggle('on', label.on);
  bellBtn.textContent = label.text;
  bellBtn.title = label.title;
  // A mode that notifies, and a browser that was never asked whether it may.
  //
  // The default is pwa+tg, which means a fresh install starts in a notifying
  // state — and the permission used to be asked for only on the way *into* one.
  // Nobody taps a switch that already says what they want, so the page sat
  // labelled 🔔 and showed nothing, on the laptop PWA and on the phone alike.
  // The label says so now, and the tap that fixes it is the one on this button.
  const need = label.on && !nativeNotifier()
    && 'Notification' in window && Notification.permission === 'default';
  bellBtn.classList.toggle('unpermitted', need);
  if (need) bellBtn.title = 'Браузер не спрошен про уведомления — нажми, чтобы разрешить';
}

// Tell the host what the owner chose. The answer is the state after the change,
// so a tap that did not land shows as the label going back rather than as a
// button that lies until the next reload.
async function sendMode(mode) {
  const res = await fetch(`/api/notify${tokenQS ? `?${tokenQS}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.json();
  return body && body.mode ? body.mode : mode;
}

function applyMode(mode, telegram) {
  notifyMode = mode;
  notifyOn = mode !== 'off';
  if (typeof telegram === 'boolean') notifyTG = telegram;
  try { localStorage.setItem('pt-notify-mode', mode); } catch (_) {}
  renderBell();
  armPermissionAsk();
}

// Whether the browser has been asked at all. Kept per install rather than read
// off `Notification.permission`, which says `default` both for "never asked"
// and for "asked and dismissed" — see shouldAskPermission in js/notify.js.
const ASKED_KEY = 'pt-notify-asked';
let permissionArmed = false;

// armPermissionAsk asks for the notification permission at the first touch
// after the host has said it notifies — not on load, and not only from the bell.
//
// Not from the bell alone, because the default mode notifies: nobody taps a
// switch that already says what they want, so a first install stayed silent
// until its owner went looking for the lever. And not on load, because a prompt
// raised without a gesture is refused outright by some browsers and shown as a
// quieter, easier-to-miss UI by others — the first touch is a gesture, and on a
// phone it arrives within seconds of the page.
//
// The listener is passive and does not consume the event: it rides along with
// whatever the touch was for.
function armPermissionAsk() {
  if (permissionArmed) return;
  let asked = false;
  try { asked = localStorage.getItem(ASKED_KEY) === '1'; } catch (_) {}
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  if (!shouldAskPermission({ mode: notifyMode, permission, native: nativeNotifier(), asked })) return;
  permissionArmed = true;
  window.addEventListener('pointerdown', () => {
    // Remembered before the answer, not after: a dismissed prompt resolves to
    // `default`, and asking again on the next load is how a page loses the
    // right to ask at all.
    try { localStorage.setItem(ASKED_KEY, '1'); } catch (_) {}
    Promise.resolve(Notification.permission === 'default'
      ? Notification.requestPermission() : Notification.permission)
      .then((perm) => {
        report('notify-permission', { permission: perm, asked: 'first-touch' });
        renderBell();
      })
      .catch((e) => report('notify-permission', { error: (e && e.name) || 'error', asked: 'first-touch' }));
  }, { once: true, passive: true, capture: true });
}

bellBtn.addEventListener('click', async () => {
  const want = nextMode(notifyMode, notifyTG);
  // Permission is asked for whenever the mode being moved to notifies, and it is
  // not conditioned on the mode being off first. It used to be — "on the way in"
  // — and the way in is not the only way to arrive: the server's default is
  // pwa+tg, so a page can load already notifying and never be asked at all. That
  // left the switch labelled 🔔 with nothing coming out of it.
  //
  // A granted permission costs nothing here: the browser answers from what it
  // already knows without prompting.
  if (want !== 'off' && !nativeNotifier()) {
    if (!('Notification' in window)) { toast('this browser has no notifications'); return; }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    // A tap here is the asking, so the first-touch prompt has nothing left to do.
    try { localStorage.setItem(ASKED_KEY, '1'); } catch (_) {}
    renderBell();
    if (perm !== 'granted') {
      // Denied is sticky: the browser will not ask again from here.
      toast(perm === 'denied' ? 'notifications blocked in browser settings' : 'not allowed');
      report('notify-permission', { permission: perm });
      return;
    }
  }
  const before = notifyMode;
  try {
    applyMode(await sendMode(want));
    report('notify-mode', { mode: notifyMode, tg: notifyTG });
    toast(notifyMode === 'off' ? 'notifications off'
      : notifyMode === 'pwa+tg' ? 'notifications: this page + telegram' : 'notifications: this page');
  } catch (e) {
    // The host is the one that decides; a page that kept the new label would
    // claim a silence it cannot deliver.
    applyMode(before);
    toast('the host did not take that');
    report('notify-mode', { mode: before, error: (e && e.message) || 'error' });
  }
});
renderBell();

// A WebView has no Notification API at all, so the app carries them.
function nativeNotifier() {
  return !!(window.PockNative && typeof window.PockNative.notify === 'function');
}

// A frame arrived, so a notice is wanted: the server decided that, reading the
// switch at the moment of the event. The page's own copy of the switch is not
// consulted — it is a second owner of one fact, and the stale one, since the mode
// is changed from whichever page happens to be in hand.
function show(notice) {
  if (!notice) return;
  if (nativeNotifier()) {
    try {
      // Three arguments, so a tap opens the session the notice is about
      // rather than whatever was open last. An app built before that takes
      // two and refuses the call — hence the retry, which is what runs until
      // the phone is updated.
      let ok = false;
      try {
        ok = window.PockNative.notify(notice.title, notice.body, notice.session || '');
      } catch (_) { ok = false; }
      if (!ok) ok = window.PockNative.notify(notice.title, notice.body);
      report('notify', { via: 'native', ok: !!ok, tag: notice.tag });
      if (ok) return;
    } catch (e) {
      report('notify', { via: 'native', error: (e && e.name) || 'error' });
    }
  }
  // No permission, no notice — and said out loud. This used to be the one silent
  // return on the path: a phone or a laptop PWA that was never asked, or was
  // asked and refused, showed nothing and left nothing behind to explain it,
  // which is indistinguishable from a switch that does not work.
  if (!('Notification' in window)) {
    report('notify', { via: 'none', ok: false, reason: 'no Notification API', tag: notice.tag });
    return;
  }
  if (Notification.permission !== 'granted') {
    report('notify', { via: 'none', ok: false, reason: `permission ${Notification.permission}`, tag: notice.tag });
    return;
  }
  // The tag replaces a previous notice of the same kind instead of stacking:
  // five "asks for an answer" in a row is noise, not information. Which of the
  // two browser paths raised it is decided in js/notify.js and said out loud
  // here — this used to be one line that threw on the only phone that matters.
  const via = deliver(notice, {
    registration: swReg,
    Notifier: window.Notification,
    onClick: (n, handle) => {
      window.focus();
      if (n.session && n.session !== current) attach(n.session);
      handle.close();
    },
    onError: (e) => report('notify', { via: 'browser', ok: false, error: (e && e.name) || 'error' }),
  });
  report('notify', { via, ok: via !== 'none', tag: notice.tag });
}

// A new page on the server: say so, and let the owner take it.
//
// Not an automatic reload. Whatever is half-typed in the composer would go with
// it, and a terminal that reloads itself under the thumb is worse than one that
// is a version behind — the choice of moment is the point of the button. The
// notification goes out through the same path as the watcher's, so a phone with
// the page in the background hears about it too.
const updateBarEl = document.getElementById('update-bar');
const updateTextEl = document.getElementById('update-text');
let updateOffered = '';
function offerUpdate(served) {
  const notice = staleNotice(served, APP_VERSION);
  if (!notice) {
    updateBarEl.hidden = true;
    return;
  }
  updateTextEl.textContent = notice.text;
  updateBarEl.hidden = false;
  // The bar stays for as long as the version does; the notification is raised
  // once per version, because a tunnel that drops twice is not two deploys.
  if (updateOffered === served) return;
  updateOffered = served;
  report('update-offered', { served, running: APP_VERSION });
  show(notice);
}

document.getElementById('update-now').addEventListener('click', () => {
  report('update-taken', { served: updateOffered, running: APP_VERSION });
  // A plain reload is enough: the service worker is network-first, so the new
  // assets come from the server and the cache is only the offline fallback.
  location.reload();
});

// Scrolled back into tmux history: the numbered lines on screen belong to the
// past, so answering them would send digits to whatever is running now.
//
// "Scrolled back", not "in copy-mode". They are not the same state and the
// difference is what was reported: the round button offering the way back kept
// sitting there with nowhere to go. A pane can be in copy-mode at the live end
// — tmux does leave it when a scroll reaches the bottom, but only when the
// scroll is what got it there, and the page's own glide, a second client on the
// same pane or a mode entered by hand all end up in copy-mode showing the
// present. What matters here is whether there is history above, which is the
// second number in the mode frame.
let scrolledBack = false;
// Scrolled back into history, the way out was a tmux key nobody has on a
// phone. This button is the way back to the live end of the output, and it is
// on screen exactly while there is somewhere to come back from.
const toBottomBtn = document.getElementById('to-bottom');
keepsTerminalFocus(toBottomBtn);
toBottomBtn.addEventListener('click', () => {
  // This button is pressed to read, and on the owner's phone it brought the
  // keyboard up over what it had just gone back to. Nothing here focuses
  // anything: the terminal's textarea still holds the focus from whenever it was
  // last typed into — dismissing a keyboard does not take it away — and the
  // system puts a keyboard back up for a focused element as soon as the layout
  // moves, which is exactly what leaving copy-mode makes the pane do. So the
  // focus is given up first, the same answer a session switch already gives.
  // Tapping the terminal is still what asks for a keyboard, and still gets one.
  const blurred = releaseTerminalFocus();
  // The glide first. A flick's inertia goes on sending notches for up to a
  // second after the finger has left, and those would arrive behind the q and
  // put the pane straight back into the history it was just asked to leave —
  // the button then looked like it had done nothing. Found by the browser test
  // under load, where the glide outlives the tap by longer.
  // The same request typing makes — including stopping the glide, which is
  // where that rule was learned — and a request rather than a `q` because the
  // page's picture of the mode is a poll old: a `q` sent to a pane that has
  // already left the mode is a character in the program.
  leaveCopyMode('button', { blurred, keyboardUp, sawKeyboard });
});

function setCopyMode(inMode, back) {
  copyMode = !!inMode;
  copyBack = back | 0;
  const away = !!inMode && back > 0;
  if (away === scrolledBack) return;
  scrolledBack = away;
  toBottomBtn.hidden = !away;
  // Both numbers, not the conclusion: if the button lingers again, the journal
  // has to say whether tmux was in a mode and where it thought it was.
  report('mode', { in: !!inMode, back, shown: away });
  renderAnswers();
}

// How long the Enter waits for the pointer it is meant to press, and how often
// it looks. A menu redraws in a frame or two; a second is a whole eternity of
// them and still short enough that a tap either does something or says why.
const POINTER_WAIT = 1000;
const POINTER_POLL = 60;

// pressAnswer walks the menu to `want` and only then takes it.
//
// **The two halves cannot go out together**, which is what made every button but
// the first answer option one — measured on a real menu, see answerKeys in
// js/detect.js. An Enter in the same write is applied against the position the
// menu had before the arrows.
//
// So the Enter waits on the screen rather than on a clock: the page presses the
// arrows, watches the pointer with the very same detector the row is drawn from,
// and sends the Enter when it can see the option it is about to take. A pointer
// that never arrives means nothing is pressed at all — a wrong answer here looks
// exactly like the right one until you read what it did, so silence is the
// cheaper failure. Both outcomes go to the journal.
// The option is found by what it says, not by where it sat, and the pointer is
// watched by the option's own number rather than by its place in the row.
//
// A place is not a name here. AskUserQuestion scrolls its own list to keep the
// pointer in view, so the walk this function sends can push the options above
// the target off the top of that list: the answer the button was drawn for is
// still on screen and still the same answer, one or two rows higher. Reading the
// index alone, both halves then failed — the label at that index was somebody
// else's, so the press refused before it started, and after a walk that did land
// the cursor index no longer matched what was asked for. Reported from the phone
// as the two options at the bottom of a long menu doing nothing at all.
//
// `prompt` is what makes matching on a label safe: every AskUserQuestion carries
// a "Type something." and a "Chat about this", so a label alone would answer a
// menu that had been replaced by the next one since the row was drawn.
async function pressAnswer(prompt, label, want) {
  // Read the screen again rather than trusting the row: it was drawn from an
  // older scan, and between the two the pointer can have moved, the list can
  // have scrolled, the menu can have been replaced — or the line that says how
  // it is answered can simply have arrived. A menu is painted a line at a time,
  // so a row built before its `Enter to select · ↑/↓ to navigate` footer landed
  // carries digits, and digits on that menu are answered by whatever is
  // highlighted.
  const menu = detectPrompt(visibleLines());
  const at = menu && menu.prompt === prompt
    ? menu.options.findIndex((o) => o.label === label) : -1;
  if (at < 0) {
    report('answer', { want, gone: true, label });
    toast('the menu changed — nothing was answered');
    return;
  }
  const key = menu.options[at].key;
  const keys = answerKeys(menu, at);
  if (keys === null) {
    report('answer', { want, at, cursor: menu.cursor, navigate: menu.navigate, keys: false });
    toast('no way to answer this menu — nothing was sent');
    return;
  }
  if (!keys.move) { send(keys.commit); return; }
  if (!send(keys.move)) { toast('not sent: no connection'); return; }
  const until = Date.now() + POINTER_WAIT;
  let on = null;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POINTER_POLL));
    const now = detectPrompt(visibleLines());
    // Which option the pointer is on, by the option's own number: the list can
    // have scrolled under the walk, and then the index it arrives at is not the
    // index it was sent to.
    on = now && now.cursor >= 0 ? now.options[now.cursor].key : null;
    if (on === key) break;
  }
  report('answer', { want, at, key, from: menu.cursor, on, moved: on === key, navigate: menu.navigate });
  if (on !== key) {
    toast('the menu did not move — nothing was answered');
    return;
  }
  send(keys.commit);
}

let lastAnswersSig = null;
function renderAnswers() {
  const lines = visibleLines();
  const q = scrolledBack ? null : detectPrompt(lines);
  // Only rebuild when the detected prompt actually changed; otherwise the
  // buttons flicker (and detach mid-tap) on every terminal update.
  //
  // The cursor is in the signature: on an arrow-driven menu it is what the number
  // of presses is counted from, so a row built against an older position would
  // answer the wrong option.
  const sig = q ? JSON.stringify([q.options, q.cursor, q.navigate]) : null;
  if (sig === lastAnswersSig) return;
  lastAnswersSig = sig;
  answersEl.innerHTML = '';
  if (!q) { answersEl.hidden = true; return; }
  for (let i = 0; i < q.options.length; i++) {
    const o = q.options[i];
    const keys = answerKeys(q, i);
    // No way to answer that can be trusted: no button. One that sends a guess is
    // worse than none, because the answer it gives is indistinguishable from one
    // the owner meant.
    if (keys === null) continue;
    const b = document.createElement('button');
    b.textContent = `${o.key} · ${o.label}`;
    b.addEventListener('click', () => { pressAnswer(q.prompt, o.label, i); term.focus(); });
    answersEl.appendChild(b);
  }
  if (!answersEl.children.length) {
    // Says so, since there is no console on the phone and the row simply not
    // being there is the same thing on screen as no question at all.
    report('answers', { drawn: 0, navigate: q.navigate, cursor: q.cursor, options: q.options.length });
    answersEl.hidden = true;
    return;
  }
  const esc = document.createElement('button');
  esc.className = 'esc';
  esc.textContent = 'Esc';
  esc.addEventListener('click', () => { send('\x1b'); term.focus(); });
  answersEl.appendChild(esc);
  answersEl.hidden = false;
}

// Throttle scans: xterm's write callback can fire many times per second.
let scanTimer = null;
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => { scanTimer = null; renderAnswers(); }, 150);
}

// Keep the terminal grid in sync with the visible viewport. Debounced:
// a resize drag fires a burst of events and refitting on each flickers.
let refitTimer = null;
// The immediate half of refit. A switch must use this one: the socket opens
// at once, and tmux redraws for whatever size we have already reported. With
// the fit debounced, that size was still the previous session's — and the
// redraw arrived wrapped against the wrong width, which is what covered the
// screen in the same line repeated with mangled characters.
function fitNow() {
  const box = document.getElementById('term');
  if (screenTerm.hidden || !box || box.clientWidth < 8 || box.clientHeight < 8) return false;
  try {
    fit.fit();
  } catch (e) {
    report('fit-failed', { message: String((e && e.message) || e).slice(0, 120) });
    return false;
  }
  // What the page thinks its size is, on the element itself. A screenshot then
  // says it too, and the size is the first thing to know when a redraw arrives
  // wrapped against a width nobody here chose.
  box.dataset.size = `${term.cols}x${term.rows}`;
  return true;
}

function refit() {
  if (current === null) return;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    // Fitting against a box with no size is what breaks xterm: the phone
    // reported `Cannot read properties of undefined (reading 'replaceCells')`
    // from inside the renderer, after which the terminal stops drawing and
    // looks hung. A hidden screen, a collapsed layout mid-transition, a
    // keyboard covering everything — all produce that box.
    if (!fitNow()) return;
    sendResize();
  }, 100);
}
window.addEventListener('resize', refit);
// Refit whenever the terminal's box changes size — first render, and when
// the composer / answer buttons appear or grow and shrink the terminal.
if (window.ResizeObserver) {
  new ResizeObserver(refit).observe(document.getElementById('term'));
}
// Whether the keyboard is up cannot be read from focus: on Android the back
// gesture hides it and leaves the textarea focused. The viewport shrinking is
// the honest signal, and it is what "leave the keyboard as it was" has to be
// judged against.
let keyboardUp = false;
// Whether this device has a soft keyboard at all, learned by watching one
// appear. Without it the rule that gives up focus would blur the terminal on a
// desktop, where focus is the only thing that makes typing possible.
let sawKeyboard = false;
// Comparing the visible height against window.innerHeight cannot work here:
// this page asks for `interactive-widget=resizes-content`, so the keyboard
// shrinks both of them and the ratio never moves. The honest reference is the
// tallest the viewport has ever been in this orientation.
const tallestSeen = new Map();
function measureKeyboard() {
  const w = Math.round(window.innerWidth);
  const h = Math.round(window.visualViewport ? window.visualViewport.height : window.innerHeight);
  tallestSeen.set(w, Math.max(tallestSeen.get(w) || 0, h));
  keyboardUp = h < tallestSeen.get(w) * 0.8;
  if (keyboardUp) sawKeyboard = true;
}
measureKeyboard();
if (window.visualViewport) {
  const vv = window.visualViewport;
  vv.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    measureKeyboard();
    refit();
  });
}
window.addEventListener('resize', measureKeyboard);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
  // The registration is what shows a notification on the phone, so it is kept:
  // `ready` rather than the register() promise, because a worker installed by a
  // previous load is already there and register() would hand back one that has
  // not taken control yet.
  navigator.serviceWorker.ready.then((r) => { swReg = r; }).catch(() => {});
  // A tap on a notice raised by the worker arrives here when this page is still
  // open. The worker knows which session the notice was about and this page
  // knows what it is showing, so the switch happens on this side.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type !== 'notification-click') return;
    report('notify-tap', { session: msg.session || '', open: current || '' });
    if (msg.session && msg.session !== current) attach(msg.session);
  });
}

// Which session to open on load.
//
// `?session=<name>` wins over the restored one: it is how a tapped
// notification arrives — the app puts the session it was raised for into the
// URL. The parameter is dropped from the address afterwards, so a later reload
// (an orientation change, the system reviving the page) restores what was
// actually being looked at instead of reopening the notification's session
// forever.
async function init() {
  const asked = new URLSearchParams(location.search).get('session');
  if (asked) {
    const url = new URL(location.href);
    url.searchParams.delete('session');
    try { history.replaceState(null, '', url.pathname + url.search + url.hash); } catch (_) {}
  }
  let saved = null;
  try { saved = sessionStorage.getItem('pt-session'); } catch (_) {}
  const want = asked || saved;
  if (want) {
    const { sessions } = await fetchSessions();
    if (sessions.some((s) => s.name === want)) { attach(want); return; }
  }
  showSessions();
}
init();
