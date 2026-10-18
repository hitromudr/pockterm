// OSC 52: the terminal is asked to put text in the clipboard.
//
// tmux's mouse is on, so a mouse drag over the pane is tmux's and not the
// page's: it enters copy-mode, and the release runs `copy-pipe-and-cancel`,
// which takes the text into tmux's buffer, leaves the mode and tells the outer
// terminal through this sequence (`set-clipboard external`, and the client's
// TERM=xterm-256color carries the `clipboard` feature). xterm.js has no handler
// for it, so the sequence was dropped — reported as a drag that highlights,
// snaps back to the live screen and leaves the clipboard as it was.
//
// `data` is what follows `52;`: the target (`c`, `p`, `s`, digits — or empty)
// and the base64 of the text. Answers the text, or null for what is not a
// write: `?` asks the terminal to *read* the clipboard back into the pane,
// which this page never does, and a body that does not decode is nobody's text.
export function osc52Text(data) {
  const at = data.indexOf(';');
  if (at < 0) return null;
  const body = data.slice(at + 1);
  if (body === '' || body === '?') return null;
  let bin;
  try {
    bin = atob(body);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
