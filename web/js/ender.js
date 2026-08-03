// Keys that end an input have to wait for the keyboard's last word.
//
// Gboard holds the word being typed as a composing region, and the page cannot
// end that itself — the app's bridge does, with `commitInput()`. That call was
// already made before Enter, and it was not enough: `commitInput` asks Android
// to restart the input, the committed text reaches the page in a later task,
// and an Enter sent in the same tick as the call overtakes it. The line then
// goes without its last word and the word turns up after the newline, which is
// what "our Enter does not send the last word" was. Nothing in the ordering is
// the app's to fix: the page is what sends the two things.
//
// So the key is held back: released a moment after the text arrives, or after a
// short wait when nothing was being composed. Both bounds are needed — the
// committed text can arrive in more than one chunk, and it can fail to arrive
// at all, and a terminal where Enter sometimes does nothing would be worse than
// the defect.

// How long to wait for a word that may not exist. Long enough for the trip
// through the bridge and the input connection, short enough not to read as lag
// on a key whose answer is a redraw 50ms away anyway.
const WAIT = 90; // milliseconds
// After text has arrived, how long to keep waiting for more of it. A commit
// delivered in two chunks must not have the newline land between them.
const GAP = 24; // milliseconds

// endingKeys returns { press, sawData }.
//
// press(bytes) sends bytes, after the keyboard has handed over what it was
// holding. sawData() is what the caller calls when input arrives from the
// terminal, which is how the wait ends early.
//
// commit() must return false when there is no bridge to ask — then there is no
// composition anyone can end, and the key goes at once. send, setTimer and
// clearTimer are injected so the whole rule can be tested on a clock that does
// not run.
export function endingKeys({ send, commit, setTimer = setTimeout, clearTimer = clearTimeout, wait = WAIT, gap = GAP }) {
  let pending = null;
  let timer = null;

  function flush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (pending === null) return;
    const bytes = pending;
    pending = null;
    send(bytes);
  }

  return {
    press(bytes) {
      // Two keys in a row keep their order: the first goes before the second
      // starts waiting. Dropping it instead would lose an Enter.
      flush();
      if (!commit()) {
        send(bytes);
        return;
      }
      pending = bytes;
      timer = setTimer(flush, wait);
    },
    sawData() {
      if (pending === null) return;
      clearTimer(timer);
      timer = setTimer(flush, gap);
    },
    // For the page's own diagnostics: whether a key is still being held.
    get waiting() { return pending !== null; },
  };
}
