import { keyBytes, applyCtrl } from './keys.js';

const token = new URLSearchParams(location.search).get('token') || '';
const tokenQS = token ? `token=${encodeURIComponent(token)}` : '';

const screenSessions = document.getElementById('screen-sessions');
const screenTerm = document.getElementById('screen-term');
const sessionList = document.getElementById('session-list');
const emptyMsg = document.getElementById('empty');
const sessName = document.getElementById('sess-name');
const statusEl = document.getElementById('status');

// --- terminal (created once, reused across sessions) ---
const term = new Terminal({ fontSize: 14, scrollback: 5000, theme: { background: '#0b0e14' } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));

let ws = null;
let current = null; // attached session name, or null on the list screen
let retry = 1000;
let ctrlLatch = false;
const enc = new TextEncoder();

// --- session list screen ---
async function loadSessions() {
  sessionList.innerHTML = '';
  emptyMsg.hidden = true;
  let sessions = [];
  try {
    const res = await fetch(`/api/sessions?${tokenQS}`);
    sessions = await res.json();
  } catch (_) {
    sessions = [];
  }
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
  screenTerm.hidden = true;
  screenSessions.hidden = false;
  loadSessions();
}

function attach(name) {
  current = name;
  sessName.textContent = name;
  screenSessions.hidden = true;
  screenTerm.hidden = false;
  term.reset();
  requestAnimationFrame(() => { fit.fit(); term.focus(); connect(); });
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
    term.write(new Uint8Array(e.data));
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

// Keep the terminal grid in sync with the visible viewport. Debounced:
// a resize drag fires a burst of events and refitting on each flickers.
let refitTimer = null;
function refit() {
  if (current === null) return;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => { fit.fit(); sendResize(); }, 100);
}
window.addEventListener('resize', refit);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`);
    refit();
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
showSessions();
