// The scrollbar's arithmetic: where the thumb goes, and where a finger on the
// track means to be.
//
// Kept out of the DOM for the reason the swipe's arithmetic is: the numbers come
// from tmux over a socket — how far back the pane is scrolled and how much
// history there is — and getting them wrong shows as a bar that points at the
// wrong part of the output, which looks exactly like a bar that works.
//
// The model is the whole scrollable extent: `hist` lines of history with the
// `rows` on screen below them. The thumb covers the screen's share of that, and
// its travel is the history alone — at the live end (`back` 0) it sits at the
// bottom of the track, and `back === hist` puts it at the top.

// How small the thumb may get. A bar over a session with thousands of lines of
// history would otherwise draw a target of two pixels, and this one is dragged
// with a thumb.
export const MIN_THUMB = 28; // px

// thumb answers where to draw it, or null when there is nothing to scroll —
// which is a bar that must not be on screen at all rather than one drawn full
// height. A pane with no history has nowhere to go, and a control that cannot
// do anything is a control that explains itself only by being pressed.
export function thumb({ hist, rows, back, track, min = MIN_THUMB }) {
  if (!(hist > 0) || !(rows > 0) || !(track > 0)) return null;
  const height = Math.max(min, Math.min(track, Math.round((track * rows) / (hist + rows))));
  const span = track - height;
  const at = Math.max(0, Math.min(hist, back | 0));
  // Rounded to whole pixels: a thumb redrawn on every poll at a fractional
  // offset shimmers while output flows, and nothing here is more precise than a
  // line anyway.
  const top = span <= 0 ? 0 : Math.round((span * (hist - at)) / hist);
  return { height, top, span };
}

// backAt turns a thumb position into the place in the history it stands for:
// the top of the track is the oldest line kept, the bottom is the live end.
//
// It takes where the *thumb* should go rather than where the finger is, so the
// caller decides whether a finger grabbed the thumb somewhere off its centre —
// a drag that jumps the thumb under the hand is a bar that fights back.
export function backAt({ top, span, hist }) {
  if (!(span > 0) || !(hist > 0)) return 0;
  const f = Math.max(0, Math.min(1, top / span));
  return Math.round(hist * (1 - f));
}
