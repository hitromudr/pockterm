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
  // ^O — what an agent TUI reads as "unfold the output you collapsed". It
  // took the forward delete's key: erasing forwards needs the arrows and
  // backspace anyway, and this is a thing no on-screen keyboard offers.
  'ctrl-o': '\x0f',
  // Numbered menus are how an agent asks a question in the console, and the
  // on-screen keyboard is exactly the layer where Gboard doubles words.
  '1': '1',
  '2': '2',
  '3': '3',
  // A newline inside the message instead of sending it: ESC then CR, which is
  // what Alt+Enter puts on the wire. There is no other way to write a second
  // line from a phone — the on-screen Enter sends.
  'alt-enter': '\x1b\r',
};

export function keyBytes(name) {
  return KEYS[name] ?? '';
}

// Ctrl latch: applied to the next typed character. Latin letters map to
// control codes 1..26; anything else passes through unchanged.
//
// The bar carries this instead of a backspace since 2026-08-12. Erasing is the
// one thing every on-screen keyboard already does, while ^R, ^D, ^Z and ^L it
// does not offer at all — and an agent's console asks for them. Anything that is
// not a Latin letter goes through untouched rather than being refused: a latch
// that swallowed a character would look like a keystroke lost to the network.
export function applyCtrl(ch) {
  const code = ch.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  return ch;
}
