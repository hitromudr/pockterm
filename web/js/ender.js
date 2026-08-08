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

// commitComposition decides how — and whether — the keyboard is asked to hand
// over the word it is holding, before a key that ends an input goes out.
//
// **The browser was assumed to have no such problem, and that stopped being
// true when the phone stopped being the app.** `commitPendingInput` asked the
// bridge and returned false without one, with a comment saying a real browser
// does not need it; the ender then took that as "nothing to wait for" and sent
// the key at once. Since 2026-08-05 the owner's phone is a Chrome PWA with no
// bridge at all, and Gboard composes in a hidden textarea there exactly as it
// did in the app — so on the one device this serves, the wait never happened.
// Reported as the last word not being sent, dictating by voice: dictation is
// one long composing region, so the word is always still in the field when the
// Enter goes.
//
// A page cannot ask Android to restart the input. It can end a composition the
// ordinary way: taking the focus off the field makes the keyboard finish the
// word, which fires `compositionend`, which is what xterm forwards to the pty.
// Focus goes straight back, so the keyboard stays up. That is `endEdit`.
//
// Returning true means only "something was asked for, wait for it" — the
// waiting, the gap for text arriving in chunks and the bound for text that
// never arrives are the ender's, and all three already existed. Returning false
// means there is nothing to wait for and the key goes now, which is the right
// answer for a field with no composition open: whatever was typed has already
// been sent as key events.
//
// Nothing here reads, replaces or sends what was typed — the same bound the
// field rule keeps (see js/imefield.js), and for the same reason: the buffer
// has one owner.
export function commitComposition({ bridge, composing, endEdit }) {
  if (bridge()) return true;
  if (!composing()) return false;
  endEdit();
  return true;
}

// endEditByBlur is that `endEdit` on a real field, and it exists as a function
// of its own because the obvious two lines lose the word they were written to
// save.
//
// xterm wipes its own textarea when it loses the focus — `_handleTextAreaBlur`
// is `this.textarea.value = ""` — and it reads that same field a task later:
// `compositionend` schedules a `setTimeout(…, 0)` which takes what is in the
// field and sends it to the pty. Both are xterm's, and a blur runs them in the
// order that empties the field first. So the word was ended, wiped, and then
// read as nothing: `input.length > 0` is false and **nothing at all reaches the
// pty**. Measured on the owner's phone (Chrome PWA, Gboard, 2026-08-08, input
// log at `chars`): `ender asked:true composing:true len:4`, `compositionend`
// with the word in the field, and no data event after it — the line went with
// the last word missing entirely, which is the defect this whole file exists
// for, one layer further down.
//
// So what xterm wiped inside our own call is put back, before the task that
// reads it runs. This is the one write to that field on this page, and it is
// deliberately not an edit: the value goes back to exactly what the keyboard
// had left there, nothing is read out of it, and nothing is sent from here —
// xterm still owns the sending, `fieldHygiene` still owns the emptying (its
// deferred clear is scheduled from the same `compositionend`, so it runs after
// the read, which is the bound it already had).
//
// Returns how much was put back, for the journal: a field xterm did not wipe
// (a browser that ends the composition some other way, a future xterm) is left
// untouched and answers 0.
export function endEditByBlur(el) {
  if (!el) return 0;
  const held = el.value;
  el.blur();
  const wiped = held && el.value !== held;
  if (wiped) el.value = held;
  // Straight back, so the keyboard stays up: the composition is what was being
  // ended, not the typing.
  el.focus();
  return wiped ? held.length : 0;
}
