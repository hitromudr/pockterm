// What the keyboard is actually doing to the terminal's input field.
//
// Every input defect reported from the phone — a word coming back after
// Backspace, a space going nowhere, a delete "inserting a line" — is a guess
// about Gboard's composing region, made from the outside. The stand cannot
// settle any of it: desktop Chromium has no IME at all. This turns the guess
// into a record: the composition events, the intents behind each edit, and
// what the page put on the wire, in order, in the server's journal.
//
// Off by default. It is noisy, and one line per keystroke does not belong in
// the journal of a box that also serves git and passwords.
//
// Two levels, and the difference matters more here than usual:
//   'on'    — shapes only: event names, inputTypes, lengths. Enough to see
//             who edits what and in which order; no typed text leaves the
//             page.
//   'chars' — the same plus the text itself. It answers "which word came
//             back", and it also writes whatever is being typed — including a
//             password typed into the terminal — into the journal. Deliberate,
//             short-lived, and the reason this is not the default.

// summarise turns one input-related event into the object that gets logged.
// Pure, so the shape is testable without a browser or a keyboard.
export function summarise(e, level) {
  const withText = level === 'chars';
  const out = { kind: e.type };
  if (typeof e.inputType === 'string' && e.inputType) out.inputType = e.inputType;
  if (typeof e.key === 'string') out.key = e.key.length === 1 && !withText ? 'char' : e.key;

  // `data` on a composition event is the whole composing region, not the
  // keystroke: its length is what tells a re-commit from a fresh word.
  const data = typeof e.data === 'string' ? e.data : null;
  if (data !== null) {
    out.len = data.length;
    if (withText) out.data = data;
  }
  return out;
}

// A field's own state at the moment of an event: what the IME has left in it.
export function fieldState(el, level) {
  if (!el) return {};
  const value = String(el.value == null ? '' : el.value);
  const s = { value: value.length, start: el.selectionStart, end: el.selectionEnd };
  if (level === 'chars') s.text = value;
  return s;
}

// watch wires the events onto a field and reports each one. Returns a function
// that unwires them, so the switch in the UI is a switch and not a reload.
//
// The order of the listeners is the order of the record, and the record is the
// point: `beforeinput` before the field changes, `input` after, composition
// around both.
export function watch(el, level, report) {
  if (!el) return () => {};
  const events = [
    'compositionstart', 'compositionupdate', 'compositionend',
    'beforeinput', 'input', 'keydown', 'keyup',
  ];
  const onEvent = (e) => {
    report('input', { ...summarise(e, level), field: fieldState(el, level) });
  };
  for (const name of events) el.addEventListener(name, onEvent);
  return () => {
    for (const name of events) el.removeEventListener(name, onEvent);
  };
}
