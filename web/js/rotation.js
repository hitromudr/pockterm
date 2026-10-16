// The rotation lock in the settings: the screen held in the orientation it is
// in when the switch is pressed, or left to follow the phone.
//
// `screen.orientation.lock` is the whole mechanism, and the browser decides
// whether it works: Chrome on Android grants it to an installed app and to a
// page in fullscreen, and refuses everywhere else (NotSupportedError), the
// desktop included. So a refusal is said where the switch is, in words, and
// the switch goes back off — a lever that shows "locked" over a screen that
// still turns is the wrong answer looking like the right one.

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

// Why the lock was refused, for the line under the switch.
export function refusalText(err) {
  const name = err && err.name;
  if (name === 'NotSupportedError' || name === 'SecurityError') {
    return 'здесь поворот не блокируется: только в установленном приложении';
  }
  if (name === 'AbortError') return 'блокировку сбросил другой запрос поворота';
  return 'браузер не дал заблокировать поворот';
}
