import { keyBytes } from './keys.js';
import { detectQuestion } from './detect.js';
import { noticeFrom } from './notify.js';
import { pickImage, carriesFiles, firstImage } from './paste.js';
import { snapshotText } from './select.js';
import { initDiag, environment, report } from './diag.js';
import { watch as watchInput } from './inputdiag.js';
import { Scroller, movedWholeScreen } from './scroll.js';
import { staleNotice } from './update.js';
import { endingKeys } from './ender.js';

const token = new URLSearchParams(location.search).get('token') || '';
const tokenQS = token ? `token=${encodeURIComponent(token)}` : '';

// Version of the code actually running. Bumped with the service worker's cache
// name — assets_test.go fails if the two drift, because a page that misreports
// itself is a page that never looks out of date. An installed PWA can keep
// running the version it was installed with, which is what makes the number
// worth having at all.
const APP_VERSION = 'v78';

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
  current = name;
  try { sessionStorage.setItem('pt-session', name); } catch (_) {}
  screenSessions.hidden = true;
  screenTerm.hidden = false;
  // A frozen screen belongs to the session it was frozen from.
  if (selectMode) setSelectMode(false);
  term.reset();
  document.getElementById('answers').hidden = true;
  lastAnswersSig = null;
  scrolledBack = false; // the new socket reports the pane's state on connect
  renderTabs();
  requestAnimationFrame(() => {
    // Size first, then the socket: tmux redraws immediately on attach.
    fitNow();
    connect();
    // The keyboard reappearing on a switch is not this code focusing
    // anything: on Android the textarea keeps focus after the keyboard is
    // dismissed, and the WebView re-shows it for a focused element when the
    // layout moves. That is why it only started after the first tap on the
    // input — before that nothing held focus. So when a soft keyboard is
    // known to exist and is currently down, the terminal gives up focus.
    if (sawKeyboard && !keyboardUp && term.textarea && document.activeElement === term.textarea) {
      term.textarea.blur();
    }
    report('switch', { keyboardUp, sawKeyboard });
  });
}

// Session tabs in the terminal header: tap one to switch to that session.
async function renderTabs() {
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
      b.textContent = s.name;
      b.dataset.session = s.name;
      keepsTerminalFocus(b);
      b.addEventListener('click', () => { if (s.name !== current) attach(s.name); });
      tabsEl.appendChild(b);
    }
  }
  for (const b of tabsEl.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.session === current);
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
  // And which page the server serves. CI installs a build as soon as it
  // arrives, so this frame is also how a reconnect after that restart is told
  // apart from any other reconnect.
  if (c && c.type === 'config') offerUpdate(c.version);
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

// Asking is not enough: the committed word arrives in a later task, so the key
// that ends the input waits for it. Everything about that rule, and why an
// Enter sent in the same tick overtook the word it was meant to follow, is in
// ender.js.
const enders = endingKeys({ send, commit: commitPendingInput });

term.onData((d) => {
  send(d);
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

// --- key bar ---
// Make the keyboard hand over the word it is still composing before a key
// from this bar reaches the pty.
//
// Gboard keeps the current word to itself until it decides the word is over,
// so Enter sent from here arrived before that word and the message went
// without it. Only the app can end a composition — a page cannot — so this
// asks it to, and does nothing in a real browser, where there is no such
// problem. Nothing else on the bar needs it: a key that is not an Enter does
// not end an input, and meddling with the composition for those is exactly
// what produced the mess.
function commitPendingInput() {
  try {
    if (window.PockNative && typeof window.PockNative.commitInput === 'function') {
      return !!window.PockNative.commitInput();
    }
  } catch (_) { /* the key still has to go through */ }
  return false;
}


document.querySelectorAll('#keybar button[data-key]').forEach((b) => {
  keepsTerminalFocus(b);
  b.addEventListener('click', () => {
    // Only the keys that end an input need the keyboard to hand over its word.
    const ends = b.dataset.key === 'enter' || b.dataset.key === 'alt-enter';
    if (ends) enders.press(keyBytes(b.dataset.key));
    else send(keyBytes(b.dataset.key));
    // No focus() here: the press already kept it, and calling it for someone
    // who was only reading would raise the keyboard over the screen.
  });
});

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
// terminal's own background rather than the page's, and a shift of at most two
// steps means at most two lines of it. `#term` clips, so nothing lands on the
// bars.
let trackEl = null;
function trackScreen(px) {
  if (!trackEl || !trackEl.isConnected) trackEl = document.querySelector('.xterm-screen');
  if (!trackEl) return;
  if (!px) {
    // Let go: the leftover is a fraction of a line that tmux cannot draw, so
    // it settles back instead of snapping.
    trackEl.style.transition = 'transform 90ms ease-out';
    trackEl.style.transform = '';
    return;
  }
  trackEl.style.transition = 'none'; // following a finger cannot be eased
  trackEl.style.transform = `translateY(${px.toFixed(1)}px)`;
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
const termBox = document.getElementById('term');
termBox.addEventListener('touchstart', (e) => {
  // Selection mode gives the drag gesture back to the browser: swiping has
  // to select text there, not scroll.
  scroller.stop();
  if (selectMode) { touchY = null; return; }
  touchY = e.touches[0].clientY;
  setScrollStep();
  scroller.start(e.timeStamp);
}, { passive: true });
termBox.addEventListener('touchmove', (e) => {
  if (touchY === null) return;
  const y = e.touches[0].clientY;
  scroller.move(y - touchY, e.timeStamp);
  touchY = y;
}, { passive: true });
termBox.addEventListener('touchend', (e) => {
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
  if (on) {
    hadTerminalFocus = !!term.textarea && document.activeElement === term.textarea;
    toast('select text, then Copy — the screen is frozen');
  } else if (hadTerminalFocus) {
    // Give the terminal its focus back only if selection mode took it away;
    // raising the keyboard for someone who was only reading is noise.
    term.focus();
  }
}
for (const b of document.querySelectorAll('#modebar button, #modebar label, #overflow button, #show-bars')) {
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
    const why = (await res.text().catch(() => '')).trim();
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
let notifyOn = false;

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
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // tag replaces a previous notice of the same kind instead of stacking:
  // five "asks for an answer" in a row is noise, not information.
  const n = new Notification(notice.title, { body: notice.body, tag: notice.tag });
  n.onclick = () => {
    window.focus();
    if (notice.session && notice.session !== current) attach(notice.session);
    n.close();
  };
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
  // The glide first. A flick's inertia goes on sending notches for up to a
  // second after the finger has left, and those would arrive behind the q and
  // put the pane straight back into the history it was just asked to leave —
  // the button then looked like it had done nothing. Found by the browser test
  // under load, where the glide outlives the tap by longer.
  scroller.stop();
  dropQueuedWheel();
  // q leaves tmux copy-mode, which lands on the bottom of the pane.
  send('q');
});

function setCopyMode(inMode, back) {
  const away = !!inMode && back > 0;
  if (away === scrolledBack) return;
  scrolledBack = away;
  toBottomBtn.hidden = !away;
  // Both numbers, not the conclusion: if the button lingers again, the journal
  // has to say whether tmux was in a mode and where it thought it was.
  report('mode', { in: !!inMode, back, shown: away });
  renderAnswers();
}

let lastAnswersSig = null;
function renderAnswers() {
  const lines = visibleLines();
  const q = scrolledBack ? null : detectQuestion(lines);
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

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
