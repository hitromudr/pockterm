// Decide when the open page should raise a desktop notification.
//
// The server already notifies Telegram for a session nobody is looking at.
// This covers the other half: the page is open but in the background — a
// switched tab, a phone with the screen off — where a notification is both
// useful and free, since the client already receives the whole stream.
//
// Kept pure and tested: the rules are easy to get subtly wrong (notifying
// twice for one prompt, or announcing "finished" for a session that never
// started anything), and those mistakes are the kind users stop trusting.

// A prompt is worth announcing once, when it appears or changes.
export function questionNotice(state, menu, hidden) {
  // The prompt is part of the signature, not just the options: "Yes / No" is
  // the most common pair there is, and two different questions offering it
  // would otherwise look like the same one.
  const sig = menu ? JSON.stringify([menu.prompt, menu.options]) : null;
  const changed = sig !== state.lastMenu;
  state.lastMenu = sig;
  if (!menu || !changed || !hidden) return null;
  return {
    title: 'Агент просит ответ',
    body: [menu.prompt, ...menu.options.map((o) => `${o.key}. ${o.label}`)]
      .filter(Boolean).join('\n'),
    tag: 'pockterm-question',
  };
}

// Output arrived: the session is doing something, and whatever "finished"
// was announced before no longer applies.
export function noteActivity(state, now) {
  state.lastOutput = now;
  state.active = true;
  state.doneSent = false;
}

// Silence for long enough, after something actually happened, means the run
// is over. Announced once per quiet period.
export function doneNotice(state, now, idleMs, hidden) {
  if (!state.active || state.doneSent) return null;
  if (state.lastOutput === null || now - state.lastOutput < idleMs) return null;
  state.doneSent = true;
  if (!hidden) return null;
  return {
    title: 'Агент закончил',
    body: state.tail || 'Вывод остановился',
    tag: 'pockterm-done',
  };
}

export function newState() {
  return { lastMenu: null, lastOutput: null, active: false, doneSent: false, tail: '' };
}
