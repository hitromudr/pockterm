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

// How long a session has been up, for the drawer's row.
//
// It replaced the window count, which was a constant: the Makefile creates one
// window and the page has no way to make or reach a second, so "1 window" was a
// field that never said anything. This one varies, and it answers the question
// the row is actually read for — which of these has been sitting there since
// yesterday.
//
// Coarse on purpose, one unit and no decimals: the row is one line on a phone,
// and "3ч" is the whole of what is wanted from it. `nowMs` is passed in so the
// clock is the caller's — there is no such thing as a test that waits an hour.
export function shortAge(createdSeconds, nowMs) {
  const created = Number(createdSeconds) || 0;
  if (created <= 0) return '';
  const mins = Math.floor((nowMs / 1000 - created) / 60);
  // A clock that disagrees with the host's, or a session created this second:
  // "0м" is honest and a negative number is not.
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins}м`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}ч`;
  return `${Math.floor(hours / 24)}д`;
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
