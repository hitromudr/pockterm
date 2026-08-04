// What a session is, as opposed to what it is doing.
//
// A session is named after the folder it was started in, so its name cannot say
// which button made it: "natal" and "natal-2" are the same project opened two
// different ways, and on a phone that difference is most of what you want from a
// list. The server reads the button off the session (tmux carries it, stamped by
// the Makefile) and it arrives as `kind` in the session list.
//
// The vocabulary here is the "+" menu's own. The glyphs are the ones on the
// buttons the owner taps to start a session, so a tab marked ⚡ needs no legend —
// it is the same mark as the button that made it. Two lists would drift, which
// is why this one is shared by the menu, the tab strip and the drawer.

// The four built-in presets, in the menu's own words and marks.
const BUILTIN = {
  shell: { mark: '▸', name: 'Shell' },
  claude: { mark: '✦', name: 'Claude' },
  yolo: { mark: '⚡', name: 'Claude (yolo)' },
  continue: { mark: '↻', name: 'Continue' },
};

// A custom button's mark when its label does not carry one of its own.
export const CUSTOM_MARK = '★';

const CUSTOM_PREFIX = 'custom:';

// The button id inside a kind, or '' for a built-in one. Ids and not labels,
// because a renamed button is still the same button and the sessions it started
// are still its.
export function customId(kind) {
  return kind && kind.startsWith(CUSTOM_PREFIX) ? kind.slice(CUSTOM_PREFIX.length) : '';
}

// A label may lead with its own mark, and then that is the mark: an emoji or a
// symbol in front of the name is the only way a custom button can be told from
// another one at a glance, and it costs the owner one character instead of a new
// field to fill in. A label that starts with a letter or a digit has no mark of
// its own and gets the shared ★.
function leadingMark(label) {
  const first = [...String(label || '')][0] || '';
  return first && !/[\p{L}\p{N}]/u.test(first) ? first : '';
}

// The label without the mark it leads with, for the menu button that draws both.
export function labelBody(label) {
  const mark = leadingMark(label);
  return mark ? String(label).slice(mark.length).trim() : String(label || '');
}

// The mark to draw for a custom button.
export function customMark(label) {
  return leadingMark(label) || CUSTOM_MARK;
}

// kindMark(kind, buttons) → the glyph for a tab, or '' when there is nothing to
// say. `buttons` is the custom list as the host reports it.
export function kindMark(kind, buttons) {
  if (!kind) return '';
  const id = customId(kind);
  if (id) {
    const b = (buttons || []).find((x) => x.id === id);
    // A button since removed: it was one of the owner's, and which one is no
    // longer known. The shared mark says that much and does not invent a name.
    return b ? customMark(b.label) : CUSTOM_MARK;
  }
  return BUILTIN[kind] ? BUILTIN[kind].mark : '';
}

// kindName(kind, buttons) → what to call it in words: the drawer's row and the
// tab's popup help. '' when there is nothing to say, which the callers leave out
// rather than writing "unknown".
export function kindName(kind, buttons) {
  if (!kind) return '';
  const id = customId(kind);
  if (id) {
    const b = (buttons || []).find((x) => x.id === id);
    return b ? labelBody(b.label) : '';
  }
  return BUILTIN[kind] ? BUILTIN[kind].name : '';
}
