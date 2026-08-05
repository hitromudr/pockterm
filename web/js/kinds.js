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

// The grid of marks a button can be given, in the drawer.
//
// A curated set rather than a keyboard: the mark is read at tab size on a phone, so
// what belongs here is glyphs that stay legible at 13px — and picking one from a
// grid is a tap, where typing an emoji into a label was a trick you had to know.
//
// First row: what the four defaults use, so a custom button can look like one on
// purpose. After that agents, languages, and the plain shapes that say "this one is
// different" without saying anything else.
// The glyphs carry U+FE0F where they have an emoji presentation — `❄️` rather than
// `❄` — because a mark drawn in text presentation takes the colour of whatever it
// sits in: on a tab it came out the same shade as the session's name, which is a
// mark nobody notices. With the selector the platform draws its colour version, and
// the same string then looks the same in the grid, in the menu and on the tab.
//
// The ones with no colour form (`✦ ↻ ▸ ⌁ ⎔ ◆ ●`…) stay monochrome, and that is a
// choice on offer rather than an omission: the four defaults are drawn with two of
// them.
export const MARKS = [
  '❄️', '☀️', '✦', '⚡', '↻', '▸', '⭐', '🌙',
  '✳️', '✴️', '❇️', '💠', '🌀', '⬡', '🔷', '🔴',
  '🔺', '🟩', '⬢', '➕', '⚙️', '⏳', '☕', '✂️',
  '🤖', '🧠', '🐍', '🦀', '🐧', '🚀', '🔧', '🧪',
  '📦', '🔒', '🎯', '🧭', '🔥', '💤', '🌊', '🌱',
];

// What an agent's name suggests when nothing was picked. Two entries, because two
// agents are what this serves and a guess about a third would be a guess: Claude is
// cold, Codex is sol. It only ever applies to a button with no mark of its own, so
// one tap in the grid overrules it.
const NAMED = [
  [/claude/i, '❄️'],
  [/codex/i, '☀️'],
];

// The four built-in presets, in the menu's own words and marks.
//
// The marks are this file's business and stay here. The words are a fallback
// only: the four are entries in the host's button list now and can be renamed,
// so the label to show comes from that list when it is there — see kindName. A
// tab whose button has since been removed is what these names are left for.
const BUILTIN = {
  shell: { mark: '▸', name: 'Shell' },
  claude: { mark: '❄️', name: 'Claude' },
  yolo: { mark: '⚡', name: 'Claude (yolo)' },
  continue: { mark: '↻', name: 'Continue' },
};

// A custom button's mark when its label does not carry one of its own.
export const CUSTOM_MARK = '⭐';

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
  const id = customId(kind) || kind;
  const b = (buttons || []).find((x) => x.id === id);
  // The button as it stands, by the same rule the menu draws it with: a tab has to
  // carry the mark of the button that made it, and two rules would drift.
  if (b) return markOf(b);
  // A button since removed: which one it was is no longer known. The shared mark
  // says that much for one of the owner's own; a default still has its own glyph.
  if (BUILTIN[id]) return BUILTIN[id].mark;
  return customId(kind) ? CUSTOM_MARK : '';
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
  // The list first: a default can be renamed, and then that is what it is called
  // everywhere. The stock name is the fallback for a tab whose button is gone.
  const b = (buttons || []).find((x) => x.id === kind);
  if (b) return labelBody(b.label);
  return BUILTIN[kind] ? BUILTIN[kind].name : '';
}

// builtinId reports whether an id is one of the four — which is to say whether
// its button runs a make target of its own. The page needs it to know what to
// send when the button is tapped: a default by its own name, everything else
// behind the "custom:" prefix.
export function builtinId(id) {
  return !!BUILTIN[id];
}

// presetOf(button) → what to send to start it.
export function presetOf(b) {
  return builtinId(b.id) ? b.id : CUSTOM_PREFIX + b.id;
}

// markOf(button) → the glyph to draw for it in the menu, the list and the tabs it
// opens.
//
// In order: what was picked in the grid, then a mark the label leads with (which is
// how this worked before there was a grid, and still works), then what the id is
// known for — a default's own glyph, or the name of an agent this recognises — and
// the shared star when nothing says anything.
export function markOf(b) {
  if (!b) return CUSTOM_MARK;
  if (b.mark) return b.mark;
  const lead = leadingMark(b.label);
  if (lead) return lead;
  if (builtinId(b.id)) return BUILTIN[b.id].mark;
  const named = NAMED.find(([re]) => re.test(String(b.label || '')));
  return named ? named[1] : CUSTOM_MARK;
}
