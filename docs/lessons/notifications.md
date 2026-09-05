# Notifications are decided in one place

One event, two channels, and a body text that took a dozen readings to get honest. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

## Notifications are decided in one place

`internal/watch` reads each watched session's pane with `capture-pane` and emits two
events: a menu appeared, or the screen went quiet after doing something. Both channels —
Telegram and a `notify` frame to an open page — render that same event, through
`watch.Format` and `watch.Notice`.

The page decides nothing. It used to, and the result was notifications nobody could
predict: it counted "activity" from bytes on the socket, but tmux redraws its status line
on a clock, so the silence never lasted; and the timer that checked was throttled once
Android backgrounded the WebView. If you are tempted to raise a notice from the browser
again, read the header of `web/js/notify.js` first.

Body text comes from `watch.Tail`, not from the last non-blank line: agent TUIs draw an
input box and a shortcut hint under their output, so the honest last line is usually
`? for shortcuts` or a row of `─`. What that function has had to learn:

**What the agent said comes before what it ran.** Its own lines are marked with `●`, and
what sits under the last of them is the output of whatever it did last — which is how
"pockterm закончил" reached the phone with `{"name":"devops",` as its whole body, a
fragment of a `curl` that was honestly the last line on screen. `Tail` looks for the
lowest `●` line that is a sentence and strips the marker; `● Bash(…)` is skipped by its
shape, the agent pointing at a command rather than speaking. Reading up from the bottom
is the fallback, for a pane with no marker in it.

**A pane wraps a sentence, and the body used to be one line of it.** The notice read
`API Error: 529 Overloaded. This is a` and stopped there, while the same message from a
session last attached from a laptop arrived whole: the pane was 51 columns against 175.
The marker is on the first line only and the rest is a continuation indented under it, so
`wrapped` puts them back together, ending the paragraph where the pane does — a blank
line, a line back at the margin, another `●`, a tool's `⎿`, or anything already known to
be interface. `clip` caps the result at 200 characters with an ellipsis.

**Two lines of pure interface had to be named**, both full of words and none of them
about the work. The **status line** (`ctx 71% | dms@ai:~/work/exante (main) $ | Opus 5`)
arrived as the entire body of "exante закончил", and the **turn summary**
(`✻ Cooked for 19s`) is true and says nothing the title has not. Both are matched by
shape — `^ctx \d+%\s*\|` and `<one word> for <duration>` — and the shape has to start the
line, or a "собрал за 4s" in prose would vanish from a notice too. A notification cannot
be coloured either (`title` and `body` are plain strings), which is another reason not to
send a line whose colour is most of what makes it readable.

**And what was said *to* the agent is not what it said.** The `❯` marks the human's side
twice over: the input box at the bottom of the TUI, and the echo of every message already
sent, standing in the transcript above the answer to it. Claude Code writes a reply it
suggests into that box, so with no `●` in the visible screen — a long answer, its marker
scrolled off the 51 columns a phone gives the shared window — the fallback read one of the
two and the phone was told "✅ elect закончил" over a line the machine had proposed for the
owner to send. Measured on the owner's own panes 2026-08-18: devops answered
`❯ согласуй мост с mesh`, which is the message he had sent, not a word the agent said.
`withoutTheHumanSide` cuts the box structurally (`detect.InputBoxAt`: it is the bottom of
the TUI, so everything from it down is interface, whatever the footer looks like this
release) and blanks the echoes above it together with their wrapped continuations. The
space after the glyph tells the two apart — non-breaking in the box, ordinary in the echo
— and neither of them is the agent speaking, so `humanSaid` matches both.

**Nor is what a tool answered, and nor is one line of a paragraph.** Both were
found by checking the fix above against the live panes rather than by a report.
`wrapped` has ended a sentence at `⎿` from the beginning — the agent pointing at
output — and the fallback had no such rule, so it answered `59  loglevel = 4`
off mesh and `⎿  Interrupted· What should Claude do` off devops, where a turn had
been stopped by hand. `withoutTheOtherVoices` now blanks those blocks with their
wrapped lines, beside the input box and the echoes. And on a pane with no `●` the
last line on screen is the last line of a *paragraph*: elect would have been
announced with `станет ещё ниже.`, which is true and says nothing. `paragraphAt`
puts the paragraph back together, **only for text the pane indented** — a line at
the margin is a shell's output, where what is above belongs to another command.
The cap is counted in runes now, in both places: 200 bytes of Russian is a
hundred characters, and `clip`'s own bound is two hundred.

**A frame of the spinner is also a box glyph.** The fallback trims box-drawing
characters off a line so a boxed sentence reads as text — and `·`, added to the
spinner set on 2026-08-18, is in that set. Trimmed, `· Nebulizing… (thinking with
xhigh effort)` no longer looks like a counter to `detect.Live`, and it came out of
the loop as a body. Chrome is asked of both shapes now: the line as it is, and the
line with the frame off.

**What is wanted is one switch, and it is the server's.** `watch.Pref` holds `off`, `pwa`
or `pwa+tg`, `watch.Deliver` turns it into the two booleans the notifier obeys, and the
page reads and writes it over `/api/notify` — plus `notify` in the config frame, so the
button is right the moment it is drawn. Three reasons it is not a browser preference:
half of what it controls is sent from the host to a phone that has this page closed; a
second phone or a reinstalled PWA would disagree with what the host actually does; and
`off` has to mean silence in Telegram too. It is remembered on disk
(`POCKTERM_NOTIFY_FILE`) because CI restarts this binary on every push to `main`, and
`off` is the state whose loss is loud. Default is `pwa+tg`: an install must not silence a
phone that was being notified before it. The middle state exists only where a bot token
does — `NotifyMode` answers `telegram` alongside the mode, and `nextMode` drops `pwa+tg`
from the ring without one.

**Two paths raise a notice in a browser, and the weaker one looked like the only one.**
`new Notification(...)` is illegal in Android Chrome: the API is present, the permission
is granted, and the constructor throws — and the throw escaped `show()`, taking the rest
of the frame handler with it, so an installed PWA showed nothing at all until 2026-08-04.
`deliver()` prefers the service worker's registration, which is also the only path that
can carry a tap to a page that is gone: `notificationclick` in `sw.js` focuses an open
window and posts it the session, or opens one at `?session=`. Which path ran goes to the
journal (`notify via: …`).

**A notice goes to every open page, not to the pages attached to its session.** That
routing was the whole of "PWA notifications do not arrive" (2026-08-04, Telegram off).
Two sensible rules cancelled out: the watcher stayed silent about a session somebody had
visible, and `Notices` delivered only to sockets attached to *that* session — so the only
session a frame could reach was the one it was never sent for. `Notices` is keyed by
client id now and `Send` takes just the notice; the notice already names its session, and
a tap on it already switches there.

**Being on screen is a per-page answer, and it was everyone's.** That is right for
Telegram, which is one recipient, and no answer at all for the pages: with a phone open on
one session and a laptop showing the one beside it, a finish on the laptop's session
reached nobody. So `OnScreen` travels on the event, Telegram skips it, and `Notices.Send`
takes a `showing` predicate that drops only the sockets with that very session visible.
Every send says how many pages took it and how many were skipped.

**A page that was never asked cannot notify, and that looked identical to a broken
switch.** The default notifies, so a fresh install starts in a notifying state — and
permission used to be requested only on the way *into* one, which nobody walks when the
switch already says what they want; `show()` then returned silently on
`Notification.permission !== 'granted'`. Now the bell asks whenever the mode it moves to
notifies, an unpermitted `🔔` wears a dashed outline, the permission is in the `hello`
line, and a dropped notice says why. **And the bell is no longer the only place that asks
— the first touch does** (`shouldAskPermission` in `js/notify.js`, fired by
`armPermissionAsk` from a one-shot `pointerdown`). Two bounds, both learned from what
browsers do rather than from what they document: not **on load**, a prompt raised without
a gesture being refused outright by some browsers and shown as a quieter UI by others; and
**once per install**, which is why `pt-notify-asked` exists rather than reading
`Notification.permission` — `default` is also what a *dismissed* prompt leaves behind, and
a page that asks on every load is one the browser stops letting ask. The flag is written
before the answer comes back for the same reason. The UI stand grants `notifications`
alongside the clipboard, the first touch in most tests being the start of a swipe being
measured.

**Every notice names its own icon.** Left unset, Chrome draws a generic bell — and
unpredictably: two notices sat in the owner's shade one above the other, one bell and one
app mark, depending on whether the page was still there when the worker raised it.
`icons/icon-192-notify.png` is the app's own drawing in **white on nothing at all**,
passed as both `icon` and `badge`; no plate behind it, the shade drawing its own circle,
and the mark scaled to fill its box rather than keeping the installed icon's margin. It is
generated from `icon-192.png` (luminance to alpha), so the two cannot drift.

`show()` no longer consults the page's own copy of the switch: the frame's existence *is*
the decision, the server having read the mode at the moment of the event.

**A tag per kind is a tag per session, and it was not.** `pockterm-done` was the whole tag
for every session there is, so the second finish replaced the first — and a replacement
without `renotify` is drawn silently: no sound, no vibration, no banner. Measured rather
than reasoned about: on 2026-09-04 the journal has `done xnt-lr` at 18:53:08 and `done
xnt-mk` at 18:53:20, both `ok:true`, one line left in the shade. `tagFor` puts the session
in the tag and `renotify: true` goes with it, so a repeat about one session still collapses
into one line — which is what the tag was for — while the session next to it keeps its own.

**A resolved `showNotification` is not a notification.** A system channel switched off for
the installed app, a "Do not disturb", a shade that dropped it: all three resolve, and
`Notification.permission` says `granted` through every one of them. That gap cost 2026-09-04
— 55 lines of `notify … ok:true` about a phone whose shade was empty, with no way from here
to tell which half of the path had eaten them. `askShade` reads `getNotifications({tag})` a
tick after the call and the journal carries `notify-shade … "live":N`: `ok:true` with
`live:0` is the browser accepting a notice the device never drew. A browser with no
`getNotifications` is left alone rather than guessed at.

**The channel is testable by a tap** (`#notify-test`, `testNotice`). Everything else on this
path is raised by the watcher — hours apart, and only about a session no page is showing —
so "нет уведомлений" could not be told from "нет событий" without running an agent and
waiting. The probe carries its own tag, because a probe that replaced a real finish would
answer one question by destroying another. **Its answer is drawn where the button is**
(`#notify-note`), not in the toast: the toast lives inside the terminal screen and the
settings sit in the drawer over it, so a probe reporting there reports to nobody — the
browser test caught that on its first run, which is the whole reason it asserts on what the
tap said rather than only on the journal.

**A journal line says which install it came from.** Three installed PWAs answer this host —
the phone and two desktops — and `notify … ok:true` from a laptop in another room reads
exactly like the phone in a pocket. Every client line now carries `dev`, a short random tag
per install kept in `pt-device`; nothing else about the device is derived from it.

**A backgrounded PWA cannot be reached down its own socket, and the server could
not tell.** Android suspends it: the page stops answering, `keepAlive` gets no pong for
60 seconds and closes the connection — and everything written into it in between was
counted as delivered. The journal already carried the words, written for exactly this
case and never read as an answer: `done yarr to 1 page(s), 0 showing it` at 13:22:33 on
2026-09-05, no acknowledgement from any page, `socket gone: yarr answered no ping for
1m0s — anything sent into it was counted as delivered` at 13:23:25. The same event with
the PWA on screen (`done natal`, 13:37:21) was acknowledged in the same second and
`notify-shade` reported `live:1`. Nothing about permissions, nothing about the shade: the
frame never arrived.

**So there is a third channel, and it is the only one that reaches a phone in a
pocket.** `internal/push` speaks Web Push: RFC 8291 encryption in the RFC 8188 aes128gcm
coding, RFC 8292 for the authorization, and no library — the whole of it is checked
against the worked example in RFC 8291 §5, byte for byte, including the intermediate
values from its Appendix A. A round trip against ourselves would pass with the two key
derivations in the wrong order and every real device would discard the message in
silence, which is why the RFC's own numbers are in the test file.

**The key pair is a file, not a startup value** (`~/.config/pockterm/vapid.json`, 0600,
`POCKTERM_VAPID_FILE`). Its public half is baked into every subscription a browser ever
made: generating a new one leaves every device unreachable and tells nobody, and CI
installs a new binary several times a working day. The subscriptions live beside it
(`push.json`, `POCKTERM_PUSH_FILE`), keyed by endpoint and by the install's own `dev`
tag — a browser hands out a new endpoint whenever it renews, and without the second key
one phone quietly becomes five subscriptions, four of them silent. A broken file is an
error rather than a fresh start: starting over would cost every subscription there is.

**One event, one drawing.** With a subscription in place the page stops drawing notices
from the socket frame and the service worker draws the push instead — the same tag, so
the two cannot stack, and `renotify` so a replacement still alerts. Two channels
rendering one event is one finish arriving twice, and with a shared tag the second
arrives silently. Which one owns it is on the root element as `data-push`, beside
`data-kb`: from outside, "the page is drawing them" and "the worker is" look identical
until one of them stops.

**Being on screen is the same question it was for Telegram.** The push goes out when
nobody has that session visible, which is the rule the other out-of-band channel already
followed. The send is a goroutine: it is the one part of this path that talks to the
internet, and a push service taking twenty seconds must not hold up the watcher's next
poll. A service answering 404 or 410 has forgotten the subscription, so this end forgets
it too; anything else leaves it alone.

**The probe that matters is the delayed one** (`/api/push/test`, ten seconds). A notice
raised while the settings panel is open says nothing about the failure this channel
exists for, which happens with the app off screen. Ten seconds is enough to press the
button and put the phone down.

**What the path costs.** The push service — Google's FCM for Chrome — sees that a device
was notified and when; the body is encrypted to keys only that device holds, and the
server signs with its own. Nothing else about the session travels. `POCKTERM_VAPID_FILE=off`
or `POCKTERM_PUSH_FILE=off` turns the whole channel off, and the page is told so by a 404
on `/api/push` — at which point it goes back to drawing notices from the frame, which is
what it did before and which reaches nothing once the phone suspends it.
