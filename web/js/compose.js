// The composer's memory: what has been sent from it before, and what is
// half-written in it now.
//
// It exists because sending is not guaranteed and the field was cleared as if
// it were. `send()` drops what it is given when the socket is not open — a
// reconnect, a handover between Wi-Fi and cellular, a server restarted by CI —
// and the composer emptied itself in the same tick. Reported from the phone as
// the text disappearing when the send does not go through, with nothing to get
// it back from.
//
// Two answers, because they cover different halves of it. The field is no
// longer cleared unless the socket took the bytes, which handles a closed
// socket. And what did go out is kept, which is the only answer to a socket
// that was open and dead — from in here those two look the same (see
// js/link.js), so the page cannot refuse to send on a suspicion.
//
// What this deliberately does not do is queue. A message held back and
// delivered on the next connect would arrive minutes later into whatever the
// session is doing by then, and the pty has no idea it is a latecomer. The
// text stays in the field, where the person holding the phone decides.

// How many sent messages are kept. Short on purpose: the list is read on a
// phone, one line per entry, and anything past a screenful is a scroll rather
// than a memory.
export const HISTORY_MAX = 20;

// pushHistory(list, text) → the list with `text` at the front.
//
// Newest first, because that is the one being looked for. A repeat is moved
// rather than added: sending the same line twice is common — a retry after
// exactly this defect — and two identical rows say nothing the one does not.
export function pushHistory(list, text, max = HISTORY_MAX) {
  const kept = Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  if (!text || !text.trim()) return kept.slice(0, max);
  return [text, ...kept.filter((s) => s !== text)].slice(0, max);
}

// previewOf(text) → one line of it for the list.
//
// Newlines become a space: an entry is one row, and a message written in
// several lines would otherwise be a row of the first of them, which is often
// the least specific part of it.
export function previewOf(text, max = 90) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
