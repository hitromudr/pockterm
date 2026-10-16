// The rotation lock in the settings: the screen held in the orientation it is
// in when the switch is pressed, or left to follow the phone.
//
// `screen.orientation.lock` is the mechanism, and Chrome grants it only to a
// page in fullscreen — the installed app included. Measured on the owner's
// phone on 2026-10-16 (Chrome 155, `standalone: true` in the hello line): the
// lock outside fullscreen is refused with SecurityError, which is how Chromium
// spells "fullscreen required". So the switch takes fullscreen first and locks
// in it, and fullscreen needs a touch: what is put back after the app was
// reopened, or after a back gesture left fullscreen, waits for the next one.
//
// A refusal is said where the switch is, in words, and the switch goes back
// off — a lever that shows "locked" over a screen that still turns is the wrong
// answer looking like the right one.

// The family of an orientation type: what the lock holds. Upside down counts as
// the same, which is what a person holding the phone means by "не крутить".
export function lockFamily(type) {
  return String(type || '').startsWith('landscape') ? 'landscape' : 'portrait';
}

// The stored value, read back: a family, or null for "follow the phone".
export function storedLock(value) {
  return value === 'portrait' || value === 'landscape' ? value : null;
}

// The button says what holds now, not what a tap would do.
export function rotationLabel(locked) {
  if (locked === 'portrait') return '🔒 Портрет';
  if (locked === 'landscape') return '🔒 Альбом';
  return '⟳ Поворот';
}

// Why the lock was refused, for the line under the switch. `step` is what
// refused: 'fullscreen' (requestFullscreen) or 'lock' (screen.orientation.lock).
export function refusalText(err, step = 'lock') {
  const name = err && err.name;
  if (step === 'fullscreen') return 'браузер не дал полный экран, а без него поворот не блокируется';
  if (name === 'NotSupportedError') return 'здесь поворот не блокируется';
  if (name === 'SecurityError') return 'браузер блокирует поворот только в полноэкранном режиме';
  if (name === 'AbortError') return 'блокировку сбросил другой запрос поворота';
  return 'браузер не дал заблокировать поворот';
}
