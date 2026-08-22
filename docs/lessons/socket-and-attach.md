# The socket, and attaching at a size

What a dead socket looks like from either end, and why the size travels in the address. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

## A message that did not go out is still the owner's

`send()` drops what it is given when the socket is not open, which is right for a
keystroke: nowhere to put it, and nobody typed it twice. The composer handed it a
whole message and cleared its field in the same tick, as though the socket had
taken it — reported as the text disappearing when the send does not go through.
The moments when a send fails are exactly the ones with a long message in the
box: a reconnect, a Wi-Fi/cellular handover, the unit restarted by CI under
whoever is typing.

So `send()` answers whether the socket took the bytes and the composer clears
only then. **Held, not queued**: a message delivered on the next connect would
arrive minutes later into whatever the session is doing by then, and nothing
downstream — pty, tmux, the agent — knows it is a latecomer.

**And what did go out is kept**, because the other half cannot be detected at all
(an open dead socket looks like a quiet one, see the watchdog below). The last
twenty messages live in `localStorage` (`pt-sent`, `js/compose.js`), newest
first, a repeat moved rather than added — sending the same line twice is what a
retry looks like. `↻` opens them and is hidden until there is one; a recalled
message goes **into the field, not down the socket**, since it is usually being
recalled because something went wrong with it.

**The draft is written down as it is typed** (`pt-draft`, 300ms timer). The page
asks for a reload after a deploy and Android kills a WebView whenever it likes;
both used to take a half-written message with them. That is also the fear behind
the update bar being a button rather than an automatic reload.

## A quiet socket and a dead socket look the same from in here

Reported as the screen freezing: a message typed on the phone had plainly been
sent — the laptop showed the agent answering it — while the phone sat on the same
frame and caught up "about a minute later". Nothing was frozen. The socket had
been handed between Wi-Fi and cellular, the far end was a black hole,
`readyState` stayed OPEN and sends appeared to succeed. The minute is TCP giving
up.

**`ping` was answered by the server before anything sent one.** The protocol had
the question and the page never asked it. `linkAction` in `web/js/link.js`
decides, and it is a pure function because the alternative is a timer nobody can
test: after `PING_AFTER` of silence the page asks, and if nothing arrives within
`PONG_WAIT` the socket is discarded and `connect()` runs again — fifteen seconds
against the minute it was. Any inbound traffic counts as the answer, so a busy
session is never pinged.

**Only while the page is on screen.** A backgrounded page has its timers
throttled to roughly one firing a minute, so every measurement it takes is late
by construction. A pocketed phone keeps its socket, and `visibilitychange` asks
the moment it comes back — which is when the answer is most often "gone".

**Discarding a socket means both its handlers, and `onclose` is the one that
matters.** Closing a socket fires it, and `onclose` schedules a reconnect of its
own — so the first version of this watchdog left the page with two sockets, then
four, each writing every frame into the same terminal and carrying every
keystroke. Reported within the hour: "терминал затроил", "по три сообщения
начали отправляться".

**The reconnect a close armed is the other half of the same rule.** Anything that
opens a socket before that timer fires — a tab tapped, the watchdog, the restore
on load — leaves it to open a **second** one on top of the one now in hand. Every
deploy makes the race: a restart drops every socket at once and the page is
reattached by hand within the second the backoff is armed for. Reported after two
deploys in an evening as everything on screen being drawn twice, which reads as a
message having been sent again; nothing is, the page writes to the newest socket
and reads frames from both, so what doubles is the picture. `dropSocket` is the
one way a socket is let go, it clears the pending timer with the handlers, and
`connect` calls it first.

The backoff resets when the watchdog fires: this is a socket being thrown away,
not a host that cannot be reached. `socket-stalled` goes to the journal with the
length of the silence.

Two tests, each made rather than waited for. The UI test drops the page's own
sends (`WebSocket.prototype.send` swallowed) and requires the journal line, the
reconnect and a terminal that types again; with the watchdog's timer commented
out it times out. The race test closes the page's socket from outside and taps a
tab inside the second, then counts open sockets in the page and clients at
`/api/presence` — one, where the old code gives two.

## The page cannot hold a socket it is not looking at, so the server holds it

Reported as no PWA notifications on a guest Wi-Fi, with the terminal working
whenever it was opened. Nothing about the notification path is network-dependent
— and that is the point: what fails is the socket it rides on, and both ends
called it open.

Everything above is the page's answer to a dead socket, and it has a hole exactly
where a notification lives. The watchdog runs **only while the page is on
screen**, for the good reason stated there; a notice is sent precisely when
nobody is looking. And a quiet session writes nothing at all — a `mode` frame
goes out only when the mode changes, so between two keystrokes this socket can
carry no bytes for hours. Something on the way then drops the idle connection, a
guest network's gateway being the reported case, and this server writes a notice
into the kernel and counts it delivered.

**Measured before it was fixed, out of the journal on the owner's own host**
(2026-08-20, ten days): of **515** notices sent to a page the server believed
open, **102** were never acknowledged by any page — `notify: … to N page(s)`
against the page's own `client: {"event":"notify"…}` — with **60**
`socket-stalled` reports beside them, which is the same socket found dead later
by the one end that could still look. A lost notification says nothing about
itself: no notice on the phone, a success in the journal, and 20% is not a rate
anybody would guess from a thumb.

**A protocol ping is the only thing that can answer this, because the browser's
network stack answers it rather than the page.** `keepAlive` in
`internal/server/server.go` sends one every `pingEvery` (20s, under the minute
that is the aggressive floor for a consumer gateway; the proxy in front is set to
an hour), which keeps the mapping alive through a pocketed phone whose timers are
asleep. `pongWait` (60s, three pings) is a read deadline refreshed by **anything**
inbound — a pong, a keystroke, a resize — so what is bounded is silence, not
pongs. A far end that stops answering trips it, the socket is let go, and the
journal says `socket gone: <session> answered no ping for …`. That is how the
count stops lying: after this, `to N page(s)` is at most `pongWait` stale instead
of hours wrong.

The write is deliberately **not** taken under `writeMu`: `WriteControl` is the one
method gorilla documents as safe beside any other, and the mutex would put the
ping behind a PTY write blocked on a socket nobody is reading — the very socket
this exists to find.

**What it does not fix**: a page that is gone. 16 of those ten days' notices went
to nobody at all (`to 0 page(s), 0 showing it`), and no keepalive reaches a closed
PWA — that is what Telegram is for, and `pwa+tg` rather than `pwa` is the switch
that covers it. Web Push would be the other answer and is not built here.

Three tests, each checked against its own defect: a quiet socket is pinged (with
`keepAlive` unwired, no ping in five seconds), a client that hears the ping and
says nothing is let go with a line in the journal (with the deadline gone, it is
kept for ever), and a client that answers keeps its socket through several
`pongWait`s (with the pong handler gone, it is dropped once). The bounds are vars
rather than consts for the third reason a test ever asks for that: a test that
waits a real minute is a test nobody runs.

## A client attaches at a size, and the wrong one is everyone's problem

Sessions here are grouped (`new-session -t <name>`, one window, several clients)
and tmux's `window-size latest` gives the shared window the size of the newest
client. A client attached at a default 80x24 and told its real size a moment
later resizes the window under **every other client on that session**, the laptop
included, which keeps drawing at its own width while tmux fills lines to 80: on
screen, halves of two lines in one row and a cursor landing nowhere.

Reported twice as a desync — "на всех вкладках курсор прыгает, потом прошло" —
and both halves of that sentence are the mechanism: every tab switch attaches a
new client, and the page's first `resize` a moment later fixed it.

The size travels in the socket's address (`/ws?session=…&cols=…&rows=…`) and
`requestedSize` reads it there, so the pty is created at the page's size. Missing
or absurd values fall back to 80x24, the value coming from a query string.

**Measuring this after an ordinary attach proves nothing**, which the first
version of the test demonstrated by passing against the defect: `sendResize`
corrects the window first. The test drops resize frames on their way out and
compares `#{window_width}` with what the page says its size is — 80 against 44 on
the old code. The page publishes that size on `#term` (`data-size`, `fitNow`).
