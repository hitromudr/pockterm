// Key bar → terminal byte sequences. Pure functions, unit-tested.
const KEYS = {
  esc: '\x1b',
  // Tab is back on the bar since 2026-08-19, in the cell ^O had. It left once
  // as a key "an agent conversation does not use", which was a guess: the
  // agent's own input completes a path with it. `shift-tab` has no button.
  tab: '\t',
  'shift-tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  'ctrl-c': '\x03',
  // ^O — what an agent TUI reads as "unfold the output you collapsed". It took
  // the forward delete's key first (erasing forwards needs the arrows and
  // backspace anyway) and ✓'s on 2026-08-19, giving its own to Tab: accept is a
  // right arrow and an Enter, both of which the bar already has, and prompt
  // mode's quick row keeps the macro.
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

// Cyrillic letters by the key they sit on. `Ctrl` + `к` is `^R` because `к` is
// where `r` is — which is what a terminal on a laptop does with a Russian layout
// too: there Ctrl is applied one layer down, to the keycode, not to the letter the
// layout produced.
//
// A page cannot do that at the layer below, and it cannot switch the keyboard's
// language either — there is no API for it in the browser or in Android, the
// keyboard decides. `setImeMode` picks a *kind* of field (no suggestions, visible
// password) and says nothing about language, and on the client the owner actually
// has (a Chrome PWA) it does nothing at all. So the letter arrives Cyrillic and the
// translation is here, or the latch is a lever that only works after switching
// layouts by hand — two taps before every `^R`, which is worse than the pad the
// latch exists beside.
//
// ЙЦУКЕН against QWERTY, letters only: `х ъ ж э б ю` sit on brackets and
// punctuation, which are not control codes here.
const LAYOUT = {
  й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p',
  ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l',
  я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm',
};

// Ctrl latch: applied to the next typed character. Latin letters map to
// control codes 1..26; anything else passes through unchanged.
//
// The bar carries this instead of a backspace since 2026-08-12. Erasing is the
// one thing every on-screen keyboard already does, while ^R, ^D, ^Z and ^L it
// does not offer at all — and an agent's console asks for them. Anything that is
// not a Latin letter goes through untouched rather than being refused: a latch
// that swallowed a character would look like a keystroke lost to the network.
export function applyCtrl(ch) {
  const lower = ch.toLowerCase();
  const code = (LAYOUT[lower] || lower).charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  return ch;
}
