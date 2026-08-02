// Key bar → terminal byte sequences. Pure functions, unit-tested.
const KEYS = {
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  'ctrl-c': '\x03',
  // DEL, not BS: that is what a terminal expects from the Backspace key.
  // This one exists to bypass the Android keyboard — Gboard keeps its own
  // idea of the word being typed, and its Backspace re-commits that word
  // into a terminal that has already moved on.
  backspace: '\x7f',
};

export function keyBytes(name) {
  return KEYS[name] ?? '';
}

// Ctrl latch: applied to the next typed character. Latin letters map to
// control codes 1..26; anything else passes through unchanged.
export function applyCtrl(ch) {
  const code = ch.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  return ch;
}
