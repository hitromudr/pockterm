// Whether to offer installing this page as an app, and how.
//
// The offer existed before this file and nobody found it: a button at the bottom
// of the drawer, next to the version line, unhidden when Chrome hands over its
// prompt. Reported from the outside as "по QR ничего не установилось — я закрыл
// и всё" — which is exactly what happens when the only affordance is two taps
// deep in a screen you have no reason to open on your first visit.
//
// So the decision is made here, and the offer is a bar rather than a button.
// Kept pure and separate because every branch of it is a device somebody else
// is holding: Chrome fires an event, Safari never does, and a WebView can
// install nothing at all.

// What to show.
//
//   'hidden'  nothing to offer
//   'prompt'  the browser handed over an install prompt — one tap installs
//   'ios'     no prompt exists here, but the manual route does
//
//   native      running inside an app that embeds this page (window.PockNative)
//   standalone  already running as an installed app
//   prompt      a beforeinstallprompt event is in hand
//   ios         an iPhone or iPad browser
//   dismissed   the bar was closed before, for this origin
export function installDecision({ native, standalone, prompt, ios, dismissed }) {
  // The bridge is proof that this already *is* an app: the owner's Android
  // client has no PWA install, and offering one there is an offer to nowhere.
  if (native) return 'hidden';
  // Installed already — Chrome opens the installed app in standalone display,
  // and iOS sets navigator.standalone.
  if (standalone) return 'hidden';
  // "Later" is answered before anything else is offered, including a prompt the
  // browser is holding. It was the other way round first, on the theory that a
  // one-tap install is too cheap to hide — and the browser test found what that
  // means: the ✕ is pressed in exactly the session where the prompt is in hand,
  // so the bar it was pressed on stayed on screen. Installing later is the
  // button in the drawer, which never goes away.
  if (dismissed) return 'hidden';
  if (prompt) return 'prompt';
  if (ios) return 'ios';
  // A desktop browser, or one whose criteria are not met. Nothing to say: the
  // drawer still has the button for whenever the prompt does arrive.
  return 'hidden';
}

// What the bar says. Russian, like the rest of the page's own text.
export function installText(decision) {
  switch (decision) {
    case 'prompt':
      return { body: 'Поставить как приложение — своё окно, без вкладок', action: 'Установить' };
    case 'ios':
      // Safari has no install event and no way to trigger the sheet from a
      // page, so the only honest thing is to say where it is.
      return { body: 'Поделиться → «На экран «Домой»» — и это приложение', action: '' };
    default:
      return null;
  }
}

// isIOS is a guess about a device from its user agent, which is why it is one
// small function and not a branch inside the decision. iPadOS reports itself as
// a Mac, and the touch points are what give it away.
export function isIOS(ua, maxTouchPoints = 0) {
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}
