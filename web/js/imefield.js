// What the terminal's own field is left holding, and why that types the word
// twice.
//
// xterm.js keeps a hidden textarea under the cursor and treats it as a capture
// surface: what lands in it is sent to the pty and the field is supposed to go
// back to empty. It does not. Measured on the owner's phone (Chrome PWA,
// Gboard, 2026-08-06, with `🔍 Input log` at `chars`), typing `порт`, then a
// space, then a backspace:
//
//   compositionend        "порт"      field="порт"   ← sent, field not cleared
//   insertText " "                    field="порт "
//   deleteContentBackward             field="порт"
//   compositionstart      ""          field="порт"   ← the keyboard re-opens
//   insertCompositionText "порт"      field="порт"   ← sent a SECOND time
//
// and the same block again for every further space-and-backspace. The word is
// not corrupted on its way anywhere: it is **written twice**, because what the
// keyboard found in the field it took for the word being typed now. That is
// what "орарь орарл" on screen was, and what a session's worth of drift is made
// of — the residue grows with every word, and the keyboard reads all of it.
//
// The same phone in its other mood — tapping rather than gliding — opens no
// composition at all: the letters arrive as key events and never touch the
// field, while every space lands in it and stays (16 of them in half a minute
// of typing, in the same recording). Different route, same residue, so the rule
// here is about the field rather than about compositions.
//
// So the field is emptied once an edit is over. Two bounds, and both are the
// difference between this and the four-authors-in-one-buffer mess that the
// terminal's input handling was before (see app.js, "One owner for typing"):
//
//   - Never while a composition is open. What is in the field then is being
//     written, and the keyboard owns it.
//   - Never in the same task as the event. xterm reads the field on a
//     `setTimeout(0)` scheduled from `compositionend` — clearing before that
//     runs would send nothing at all, which is worse than sending twice.
//
// Nothing here reads or replaces what was typed, and nothing is sent from here:
// the only operation is emptying a field that the keyboard has finished with.

// fieldHygiene is the rule, with the field and the clock injected so it can be
// tested without a browser — which is the only way it can be tested at all:
// desktop Chromium has no IME, so the stand cannot produce a single event
// above.
//
// empty() answers whether the field is already empty (then there is nothing to
// do, and writing to a field needlessly is one more thing the keyboard can
// react to). clear() empties it. defer() runs a callback in a later task.
//
// onCompose is called whenever a composition opens or closes, and it exists so
// that one listener answers that question for the whole page: what is being
// composed is drawn by xterm at the cursor, and anything the page draws over the
// pane's own rows sits on top of it — see paintAnswers in js/app.js. A second
// listener on these events would be a second answer to the one question this
// rule already tracks.
//
// onEdit is the same arrangement for the other question asked of these events:
// something has just been typed into the field, and whether a composition is open
// around it. The Ctrl latch needs it — under a composing keyboard the letter sits
// in the field and xterm sends nothing until the composition ends, so there is no
// keystroke to turn into a control code (see armCtrl in js/app.js).
export function fieldHygiene({
  empty, clear, defer = (fn) => setTimeout(fn, 0), onCompose = () => {}, onEdit = () => {},
}) {
  let composing = false;
  let scheduled = false;

  function later() {
    if (scheduled) return;
    scheduled = true;
    defer(() => {
      scheduled = false;
      // A composition can open again while we wait — a suggestion tapped, a
      // word re-entered. The field is the keyboard's again and what is in it
      // is being written now.
      if (composing) return;
      if (empty()) return;
      clear();
    });
  }

  return {
    // on takes the event name and nothing else: what an edit did is the
    // keyboard's business, and this rule is only about what it left behind.
    on(kind) {
      if (kind === 'compositionstart') { composing = true; onCompose(true); return; }
      if (kind === 'compositionend') { composing = false; onCompose(false); later(); return; }
      if (kind !== 'input') return;
      onEdit(composing);
      if (!composing) later();
    },
    // For the tests and for the diagnostics: whether a composition is open.
    isComposing() { return composing; },
  };
}

// keepEmpty wires the rule onto a real field. Returns a function that unwires
// it, so this can be switched off from the page without a reload — the phone is
// the only device that can judge it, and a lever it cannot let go of is not one
// to hand it.
//
// The listeners go on after xterm's own, which is what puts our deferred clear
// behind the timeout xterm schedules from the same event.
//
// `onClear` is how any of this is answerable from the outside. A field that was
// never found (xterm creating its textarea later than this call, say) and a
// rule that fires and takes nothing look identical from a phone, and both look
// exactly like the defect still being there — which is the shape of every
// question this file exists to settle. The caller reports what it wants; here
// the only job is to say what happened.
// The return value carries `isComposing` as well as the unwire, because one
// other decision on this page needs the same answer: an Enter from the key bar
// must not overtake a word the keyboard is still holding, and whether it is
// holding one is exactly what this rule already tracks. Two places watching the
// same events would be two answers to one question — see commitComposition in
// js/ender.js for what is done with it.
export function keepEmpty(el, opts = {}) {
  const { onClear = () => {}, ...rest } = opts;
  if (!el) {
    const off = () => {};
    off.isComposing = () => false;
    off.held = () => 0;
    return off;
  }
  const rule = fieldHygiene({
    empty: () => !el.value,
    clear: () => { const len = el.value.length; el.value = ''; onClear(len); },
    ...rest,
  });
  const kinds = ['compositionstart', 'compositionend', 'input'];
  const onEvent = (e) => rule.on(e.type);
  for (const k of kinds) el.addEventListener(k, onEvent);
  const off = () => { for (const k of kinds) el.removeEventListener(k, onEvent); };
  off.isComposing = () => rule.isComposing();
  // What the field is holding, for the journal alone (`held`, not `length`: a
  // function's own length is read-only and the assignment throws): the phone is the judge of
  // everything in this file, and a number is what makes it judgeable.
  off.held = () => el.value.length;
  return off;
}
