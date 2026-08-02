import { keyBytes, applyCtrl } from './keys.js';
import { detectQuestion } from './detect.js';
import { newState, questionNotice, noteActivity, doneNotice } from './notify.js';
import { pickImage, carriesFiles, firstImage } from './paste.js';
import { snapshotText } from './select.js';
import { initDiag, environment, report } from './diag.js';

const token = new URLSearchParams(location.search).get('token') || '';
const tokenQS = token ? `token=${encodeURIComponent(token)}` : '';

// Version of the code actually running. Bumped with the service worker's
// cache name: a mismatch between the two is itself a diagnosis, because an
// installed PWA can keep running the version it was installed with.
const APP_VERSION = 'v42';

// Diagnostics go to the server's journal — see js/diag.js for why.
initDiag((line) => {
  try {
    navigator.sendBeacon(`/api/log?${tokenQS}`, new Blob([JSON.stringify(line)], { type: 'application/json' }));
  } catch (_) { /* never break the app over a log line */ }
});
report('hello', environment(APP_VERSION));

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
const emptyMsg = document.getElementById('empty');
const tabsEl = document.getElementById('tabs');
const statusEl = document.getElementById('status');

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
let ctrlLatch = false;
const enc = new TextEncoder();

// --- session list screen ---
async function loadSessions() {
  sessionList.innerHTML = '';
  emptyMsg.hidden = true;
  const { sessions, error } = await fetchSessions();
  if (error) {
    emptyMsg.hidden = false;
    emptyMsg.innerHTML = error === 'unauthorized'
      ? '<p>Доступ не разрешён.</p><p>Ссылка открыта без токена, ' +
        'а сервер его требует — открой её из закладки с <code>?token=…</code>.</p>'
      : `<p>${escapeHtml(error)}</p><p>Сессии узнать не удалось.</p>`;
    return;
  }
  if (sessions.length === 0) {
    emptyMsg.hidden = false;
    emptyMsg.innerHTML = '<p>Нет активных tmux-сессий.</p>' +
      '<p>Запусти сессию на сервере и нажми обновить.</p>';
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'session';
    const win = `${s.windows} window${s.windows === 1 ? '' : 's'}`;
    b.innerHTML = `<span class="name">${escapeHtml(s.name)}</span>` +
      `<span class="meta">${win}${s.attached ? ' · attached' : ''}</span>`;
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
    let armed = null;
    close.addEventListener('click', () => {
      if (!armed) {
        close.classList.add('armed');
        close.textContent = '✕?';
        toast(`tap again to close ${s.name}`);
        armed = setTimeout(() => {
          armed = null;
          close.classList.remove('armed');
          close.textContent = '✕';
        }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      killSession(s.name);
    });
    li.appendChild(close);

    sessionList.appendChild(li);
  }
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

newBtn.addEventListener('click', () => {
  newMenu.hidden = !newMenu.hidden;
  renameBox.hidden = true;
});

for (const b of newMenu.querySelectorAll('button[data-preset]')) {
  b.addEventListener('click', async () => {
    const preset = b.dataset.preset;
    newMenu.hidden = true;
    toast(`starting ${preset}…`);
    try {
      const res = await fetch(`/api/sessions/new?${tokenQS}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset }),
      });
      if (!res.ok) {
        const why = (await res.text().catch(() => '')).trim();
        toast(why || `could not start: ${res.status}`);
        report('start-session', { preset, ok: false, status: res.status });
        return;
      }
      report('start-session', { preset, ok: true });
      // tmux needs a moment before the session shows up in the listing.
      setTimeout(loadSessions, 400);
    } catch (_) {
      toast('no connection to the server');
    }
  });
}

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
    if (current === name) showSessions();
    else loadSessions();
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

function showSessions() {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  current = null;
  try { sessionStorage.removeItem('pt-session'); } catch (_) {}
  screenTerm.hidden = true;
  screenSessions.hidden = false;
  loadSessions();
}

function attach(name) {
  // Whether the keyboard was up is the user's decision, not the switch's.
  // Focusing the terminal unconditionally raised it on every tab tap, on a
  // screen where it eats half the view; leaving focus alone keeps whatever
  // state the switch found.
  const hadFocus = !!term.textarea && document.activeElement === term.textarea;
  // Close any current socket first (switching tabs) so its output stops
  // writing into the terminal we're about to reuse for another session.
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  current = name;
  try { sessionStorage.setItem('pt-session', name); } catch (_) {}
  screenSessions.hidden = true;
  screenTerm.hidden = false;
  // A frozen screen belongs to the session it was frozen from.
  if (selectMode) setSelectMode(false);
  term.reset();
  document.getElementById('answers').hidden = true;
  lastAnswersSig = null;
  inCopyMode = false; // the new socket reports the pane's state on connect
  renderTabs();
  requestAnimationFrame(() => { fit.fit(); if (hadFocus) term.focus(); connect(); });
}

// Session tabs in the terminal header: tap one to switch to that session.
async function renderTabs() {
  const { sessions } = await fetchSessions();
  tabsEl.innerHTML = '';
  for (const s of sessions) {
    const b = document.createElement('button');
    b.textContent = s.name;
    if (s.name === current) b.className = 'active';
    keepsTerminalFocus(b);
    b.addEventListener('click', () => { if (s.name !== current) attach(s.name); });
    tabsEl.appendChild(b);
  }
}

// --- websocket to the attached session ---
function connect() {
  if (!current) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = [tokenQS, `session=${encodeURIComponent(current)}`].filter(Boolean).join('&');
  ws = new WebSocket(`${scheme}://${location.host}/ws?${qs}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { statusEl.hidden = true; retry = 1000; sendResize(); sendVisible(); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') { onControl(e.data); return; }
    noteActivity(notifyState, Date.now());
    term.write(new Uint8Array(e.data), scheduleScan);
  };
  ws.onclose = () => {
    if (!current) return; // left for the list on purpose
    statusEl.textContent = 'reconnecting…';
    statusEl.hidden = false;
    setTimeout(() => { if (current) connect(); }, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

// Server control frames: pong, error, and the pane's copy-mode state.
function onControl(raw) {
  let c = null;
  try { c = JSON.parse(raw); } catch (_) { return; }
  if (c && c.type === 'mode') setCopyMode(!!c.in);
  // The server's own idle threshold, so its Telegram notice and this page's
  // notification mean the same thing.
  if (c && c.type === 'config' && c.idle > 0) idleMs = c.idle * 1000;
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(data));
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

term.onData((d) => {
  if (ctrlLatch) { d = applyCtrl(d); setCtrl(false); }
  send(d);
});

// Tapping a button must not take focus away from the terminal: on Android the
// soft keyboard closes the moment the textarea loses focus, and a focus
// restored later — in a timer, a frame callback, after an await — does not
// bring it back, because it is no longer inside the touch. preventDefault on
// the press keeps focus where it is; the click still fires.
function keepsTerminalFocus(el) {
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

// --- key bar ---
const ctrlBtn = document.getElementById('key-ctrl');
function setCtrl(on) { ctrlLatch = on; ctrlBtn.classList.toggle('on', on); }
// Make the keyboard hand over the word it is still composing before a key
// from this bar reaches the pty.
//
// Gboard keeps the current word to itself until it decides the word is over.
// Enter sent from here arrived *before* that word, so the message went
// without its last word; the same stale composing region is what makes
// Backspace re-commit a word the terminal has already moved past. Only the
// app can end a composition — a page cannot — so this asks it to, and does
// nothing in a real browser, where the problem does not exist.
function commitPendingInput() {
  try {
    if (window.PockNative && typeof window.PockNative.commitInput === 'function') {
      window.PockNative.commitInput();
    }
  } catch (_) { /* the key still has to go through */ }
}

document.querySelectorAll('#keybar button[data-key]').forEach((b) => {
  keepsTerminalFocus(b);
  b.addEventListener('click', () => {
    commitPendingInput();
    send(keyBytes(b.dataset.key));
    term.focus();
  });
});
ctrlBtn.addEventListener('click', () => { setCtrl(!ctrlLatch); term.focus(); });

document.getElementById('back').addEventListener('click', showSessions);
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
function sendWheel(btn) { send(`\x1b[<${btn};1;1M`); }
let touchY = null;
const termBox = document.getElementById('term');
termBox.addEventListener('touchstart', (e) => {
  // Selection mode gives the drag gesture back to the browser: swiping has
  // to select text there, not scroll.
  touchY = selectMode ? null : e.touches[0].clientY;
}, { passive: true });
termBox.addEventListener('touchmove', (e) => {
  if (touchY === null) return;
  let dy = e.touches[0].clientY - touchY;
  const step = 20;
  while (dy >= step) { sendWheel(64); dy -= step; touchY += step; }   // swipe down → history
  while (dy <= -step) { sendWheel(65); dy += step; touchY -= step; }  // swipe up → newer
}, { passive: true });
termBox.addEventListener('touchend', () => { touchY = null; }, { passive: true });

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
  b.addEventListener('click', () => { commitPendingInput(); send(MACROS[b.dataset.macro]); term.focus(); });
});

// Bottom bars are mutually exclusive: selection mode wins over prompt mode
// (composer and key bar both steal the taps a selection needs), prompt mode
// swaps the key bar for the composer + quick macros. Detected answer buttons
// live above all of them and show in every mode.
let promptMode = false;
let selectMode = false;
function renderBars() {
  selbarEl.hidden = !selectMode;
  composerEl.hidden = selectMode || !promptMode;
  quickbarEl.hidden = selectMode || !promptMode;
  keybarEl.hidden = selectMode || promptMode;
  modeBtn.classList.toggle('on', promptMode);
  selectBtn.classList.toggle('on', selectMode);
  if (promptMode && !selectMode) promptEl.focus();
  refit();
}
function setPromptMode(on) { promptMode = on; renderBars(); }
modeBtn.addEventListener('click', () => setPromptMode(!promptMode));

// Installing puts pockterm on the home screen as its own app: a standalone
// window with no tabs and no address bar, which is also the only way the
// Ctrl+W/T/N keys ever reach the shell. Chrome hands over its own prompt and
// only once, so the button appears when the offer arrives and disappears
// after it is used.
const installBtn = document.getElementById('install');
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  installBtn.hidden = false;
  report('install-offer', {});
});
installBtn.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice.catch(() => ({ outcome: 'error' }));
  report('install-choice', { outcome });
  installPrompt = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => report('installed', {}));

// Text size, notifications and hiding the bars are settings, not controls:
// they belong behind one button instead of taking four permanent slots away
// from the session tabs.
const moreBtn = document.getElementById('more');
const versionsEl = document.getElementById('versions');
{
  const app = appVersion();
  versionsEl.textContent = app ? `page ${APP_VERSION} · app ${app}` : `page ${APP_VERSION}`;
}
const overflowEl = document.getElementById('overflow');
moreBtn.addEventListener('click', () => {
  overflowEl.hidden = !overflowEl.hidden;
  moreBtn.classList.toggle('on', !overflowEl.hidden);
  refit();
});

// Send the composed prompt (text + Enter), then clear and keep the field.
composerEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = promptEl.value;
  if (!text) return;
  send(text + '\r');
  promptEl.value = '';
  promptEl.style.height = 'auto';
  promptEl.focus();
});
// Grow the textarea with its content, up to the CSS max-height.
promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = promptEl.scrollHeight + 'px';
});

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
  if (on) toast('select text, then Copy — the screen is frozen');
  else term.focus();
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
    const why = (await res.text().catch(() => '')).trim();
    toast(why ? `upload refused: ${why}` : `upload failed: ${res.status}`);
    return;
  }
  const { path } = await res.json().catch(() => ({}));
  report('upload', { ok: !!path, bytes: file.size || 0, type: file.type || '' });
  if (!path) { toast('upload failed: no path in the answer'); return; }
  if (ctrlLatch) setCtrl(false);
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
  if (ctrlLatch) setCtrl(false);
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
    if (ctrlLatch) setCtrl(false);
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
  if (ctrlLatch) setCtrl(false); // a latched Ctrl would mangle the text
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
// The server messages Telegram for a session nobody is watching. This covers
// the case in between: the page is open but in the background — another tab,
// a phone with the screen off — where the client already has the whole
// stream and a notification costs nothing.
const bellBtn = document.getElementById('bell');
const notifyState = newState();
let notifyOn = false;
let idleMs = 30_000; // overwritten by the server's own threshold on connect
try { notifyOn = localStorage.getItem('pt-notify') === 'on'; } catch (_) {}

function renderBell() {
  bellBtn.classList.toggle('on', notifyOn);
  bellBtn.title = notifyOn ? 'Notifications on' : 'Notify when the agent asks or finishes';
}

bellBtn.addEventListener('click', async () => {
  if (notifyOn) {
    notifyOn = false;
  } else {
    if (nativeNotifier()) {
      // The app notifies for us; it asked Android for the permission itself.
      notifyOn = true;
      try { localStorage.setItem('pt-notify', 'on'); } catch (_) {}
      renderBell();
      toast('notifications on (app)');
      return;
    }
    if (!('Notification' in window)) { toast('this browser has no notifications'); return; }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      // Denied is sticky: the browser will not ask again from here.
      toast(perm === 'denied' ? 'notifications blocked in browser settings' : 'not allowed');
      return;
    }
    notifyOn = true;
  }
  try { localStorage.setItem('pt-notify', notifyOn ? 'on' : 'off'); } catch (_) {}
  renderBell();
  toast(notifyOn ? 'notifications on' : 'notifications off');
});
renderBell();

// A WebView has no Notification API at all, so the app carries them.
function nativeNotifier() {
  return !!(window.PockNative && typeof window.PockNative.notify === 'function');
}

function show(notice) {
  if (!notice || !notifyOn) return;
  if (nativeNotifier()) {
    try {
      const ok = window.PockNative.notify(notice.title, notice.body);
      report('notify', { via: 'native', ok: !!ok, tag: notice.tag });
      if (ok) return;
    } catch (e) {
      report('notify', { via: 'native', error: (e && e.name) || 'error' });
    }
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // tag replaces a previous notice of the same kind instead of stacking:
  // five "asks for an answer" in a row is noise, not information.
  const n = new Notification(notice.title, { body: notice.body, tag: notice.tag });
  n.onclick = () => { window.focus(); n.close(); };
}

// Checked on a timer rather than on output, because "finished" is defined by
// the absence of output.
setInterval(() => show(doneNotice(notifyState, Date.now(), idleMs, document.hidden)), 5000);

// Scrolled back into tmux history (copy-mode): the numbered lines on screen
// belong to the past, so answering them would send digits to whatever is
// running now. No buttons until the pane leaves the mode.
let inCopyMode = false;
function setCopyMode(on) {
  if (on === inCopyMode) return;
  inCopyMode = on;
  renderAnswers();
}

let lastAnswersSig = null;
function renderAnswers() {
  const lines = visibleLines();
  const q = inCopyMode ? null : detectQuestion(lines);
  // Kept for the "finished" notice: the last line of output says more than
  // "the run ended" on its own.
  notifyState.tail = [...lines].reverse().find((l) => l.trim()) || '';
  show(questionNotice(notifyState, q, document.hidden));
  // Only rebuild when the detected prompt actually changed; otherwise the
  // buttons flicker (and detach mid-tap) on every terminal update.
  const sig = q ? JSON.stringify(q.options) : null;
  if (sig === lastAnswersSig) return;
  lastAnswersSig = sig;
  answersEl.innerHTML = '';
  if (!q) { answersEl.hidden = true; return; }
  for (const o of q.options) {
    const b = document.createElement('button');
    b.textContent = `${o.key} · ${o.label}`;
    // digit + Enter picks the menu item in one tap.
    b.addEventListener('click', () => { send(o.key + '\r'); term.focus(); });
    answersEl.appendChild(b);
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
function refit() {
  if (current === null) return;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => { fit.fit(); sendResize(); }, 100);
}
window.addEventListener('resize', refit);
// Refit whenever the terminal's box changes size — first render, and when
// the composer / answer buttons appear or grow and shrink the terminal.
if (window.ResizeObserver) {
  new ResizeObserver(refit).observe(document.getElementById('term'));
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`);
    refit();
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

// Restore the last session (survives an orientation-change reload / reopen).
async function init() {
  let saved = null;
  try { saved = sessionStorage.getItem('pt-session'); } catch (_) {}
  if (saved) {
    const { sessions } = await fetchSessions();
    if (sessions.some((s) => s.name === saved)) { attach(saved); return; }
  }
  showSessions();
}
init();
