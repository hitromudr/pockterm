import { keyBytes, applyCtrl } from './keys.js';
import { detectQuestion } from './detect.js';

const token = new URLSearchParams(location.search).get('token') || '';
const tokenQS = token ? `token=${encodeURIComponent(token)}` : '';

const screenSessions = document.getElementById('screen-sessions');
const screenTerm = document.getElementById('screen-term');
const sessionList = document.getElementById('session-list');
const emptyMsg = document.getElementById('empty');
const tabsEl = document.getElementById('tabs');
const statusEl = document.getElementById('status');

async function fetchSessions() {
  try {
    const res = await fetch(`/api/sessions?${tokenQS}`);
    return (await res.json()) || [];
  } catch (_) {
    return [];
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
  const sessions = await fetchSessions();
  if (!sessions || sessions.length === 0) {
    emptyMsg.hidden = false;
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
    sessionList.appendChild(li);
  }
}

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
  // Close any current socket first (switching tabs) so its output stops
  // writing into the terminal we're about to reuse for another session.
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  current = name;
  try { sessionStorage.setItem('pt-session', name); } catch (_) {}
  screenSessions.hidden = true;
  screenTerm.hidden = false;
  term.reset();
  document.getElementById('answers').hidden = true;
  lastAnswersSig = null;
  renderTabs();
  requestAnimationFrame(() => { fit.fit(); term.focus(); connect(); });
}

// Session tabs in the terminal header: tap one to switch to that session.
async function renderTabs() {
  const sessions = await fetchSessions();
  tabsEl.innerHTML = '';
  for (const s of sessions) {
    const b = document.createElement('button');
    b.textContent = s.name;
    if (s.name === current) b.className = 'active';
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
  ws.onopen = () => { statusEl.hidden = true; retry = 1000; sendResize(); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return; // control frames (pong/error)
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

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(data));
}
function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

term.onData((d) => {
  if (ctrlLatch) { d = applyCtrl(d); setCtrl(false); }
  send(d);
});

// --- key bar ---
const ctrlBtn = document.getElementById('key-ctrl');
function setCtrl(on) { ctrlLatch = on; ctrlBtn.classList.toggle('on', on); }
document.querySelectorAll('#keybar button[data-key]').forEach((b) => {
  b.addEventListener('click', () => { send(keyBytes(b.dataset.key)); term.focus(); });
});
ctrlBtn.addEventListener('click', () => { setCtrl(!ctrlLatch); term.focus(); });

document.getElementById('back').addEventListener('click', showSessions);
document.getElementById('refresh').addEventListener('click', loadSessions);

// Terminal text size (A-/A+), persisted; refit so the grid follows.
function setFont(sz) {
  fontSize = Math.max(9, Math.min(28, sz));
  term.options.fontSize = fontSize;
  try { localStorage.setItem('pt-font', String(fontSize)); } catch (_) {}
  refit();
}
document.getElementById('font-dec').addEventListener('click', () => setFont(fontSize - 1));
document.getElementById('font-inc').addEventListener('click', () => setFont(fontSize + 1));
// Tapping the terminal returns keyboard focus to it (so typing goes in).
document.getElementById('term').addEventListener('click', () => { term.focus(); refit(); });

// Touch scroll: a vertical swipe on the terminal is turned into tmux
// mouse-wheel events (SGR). tmux mouse mode is on for pockterm's sessions,
// so the wheel enters copy-mode and scrolls the history — this is what
// makes scrolling work on Android, where xterm's own scrollback is empty
// under tmux.
function sendWheel(btn) { send(`\x1b[<${btn};1;1M`); }
let touchY = null;
const termBox = document.getElementById('term');
termBox.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
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
document.getElementById('hide').addEventListener('click', () => {
  panelsHidden = !panelsHidden;
  screenTerm.classList.toggle('panels-hidden', panelsHidden);
  document.getElementById('hide').classList.toggle('on', panelsHidden);
  refit();
});

// tmux shares one window size across all clients of a session, so when a
// second (smaller) client connects the window shrinks and this one gets
// filler dots. Reclaim the size for whichever device is active: on focus,
// on becoming visible, so the device you're actually using wins.
window.addEventListener('focus', refit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refit();
});

// --- prompt mode: composer + detected answer buttons ---
const answersEl = document.getElementById('answers');
const composerEl = document.getElementById('composer');
const quickbarEl = document.getElementById('quickbar');
const promptEl = document.getElementById('prompt');
const modeBtn = document.getElementById('mode');
const keybarEl = document.getElementById('keybar');

// Quick macros for prompt mode. "accept" is right-arrow + Enter — one tap
// to accept Claude's inline suggestion; "ctrl-c" stops the running process.
const MACROS = {
  accept: '\x1b[C\r',
  enter: '\r',
  esc: '\x1b',
  'ctrl-c': '\x03',
};
document.querySelectorAll('#quickbar button[data-macro]').forEach((b) => {
  b.addEventListener('click', () => { send(MACROS[b.dataset.macro]); term.focus(); });
});

// Prompt mode swaps the key bar for the composer + quick macros. Detected
// answer buttons show in both modes (they help whenever a prompt appears).
function setPromptMode(on) {
  modeBtn.classList.toggle('on', on);
  composerEl.hidden = !on;
  quickbarEl.hidden = !on;
  keybarEl.hidden = on;
  if (on) promptEl.focus();
  refit();
}
modeBtn.addEventListener('click', () => setPromptMode(composerEl.hidden));

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

let lastAnswersSig = null;
function renderAnswers() {
  const q = detectQuestion(visibleLines());
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
    const sessions = await fetchSessions();
    if (sessions.some((s) => s.name === saved)) { attach(saved); return; }
  }
  showSessions();
}
init();
