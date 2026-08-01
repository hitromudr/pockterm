import { keyBytes, applyCtrl } from './keys.js';

const statusEl = document.getElementById('status');
const term = new Terminal({
  fontSize: 14,
  scrollback: 5000,
  theme: { background: '#0b0e14' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();
term.focus();

let ws = null;
let retry = 1000;
let ctrlLatch = false;
const enc = new TextEncoder();
const token = new URLSearchParams(location.search).get('token') || '';

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${proto}://${location.host}/ws${qs}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    statusEl.hidden = true;
    retry = 1000;
    sendResize();
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return; // control frames (pong/error)
    term.write(new Uint8Array(e.data));
  };
  ws.onclose = () => {
    statusEl.textContent = 'reconnecting…';
    statusEl.hidden = false;
    setTimeout(connect, retry);
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
  if (ctrlLatch) {
    d = applyCtrl(d);
    setCtrl(false);
  }
  send(d);
});

const ctrlBtn = document.getElementById('key-ctrl');
function setCtrl(on) {
  ctrlLatch = on;
  ctrlBtn.classList.toggle('on', on);
}
document.querySelectorAll('#keybar button[data-key]').forEach((b) => {
  b.addEventListener('click', () => {
    send(keyBytes(b.dataset.key));
    term.focus();
  });
});
ctrlBtn.addEventListener('click', () => {
  setCtrl(!ctrlLatch);
  term.focus();
});

// Keep the layout inside the visible viewport (mobile keyboard) and the
// PTY in sync with the terminal grid. Debounced: a resize drag fires a
// burst of events, and refitting on each one makes the terminal flicker.
let refitTimer = null;
function refit() {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    fit.fit();
    sendResize();
  }, 100);
}
window.addEventListener('resize', refit);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`);
    refit();
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
connect();
