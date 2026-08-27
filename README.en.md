# pockterm

[Русская версия](README.md)

Pocket terminal: a mobile-friendly PWA window onto your tmux sessions,
served by a single Go binary. Handy for driving any console from a phone —
for example [Claude Code](https://claude.com/claude-code) or any TUI.

- **One binary.** Static PWA is embedded; no runtime dependencies except
  `tmux` on the host.
- **Real terminal.** xterm.js over a WebSocket-to-PTY bridge, plus a key
  bar (Esc, Tab, arrows, Ctrl latch) for mobile keyboards. Ctrl reads the
  next letter off the ordinary keyboard — including a Cyrillic one, by the
  key it sits on (`Ctrl` `к` is `^R`, as in a terminal on a laptop) — and
  ends the composition itself, or the letter would stay with the keyboard.
  The `^A ^E ^K …` pad opens when there is no keyboard on screen.
- **A console pad at the top.** `$` in the pane's top corner opens twenty-three
  whole commands rather than bytes: `clear`, `reset`, `pwd`, `ls -al --color`,
  `cd ..`, `cd ~`, `df -h`, `free -h`, `uptime`, `uname -a`,
  `vcgencmd measure_temp`, `vcgencmd get_throttled`, `vcgencmd measure_clock v3d`,
  `ip -br a|grep '^[ew]'`, `curl eth0.me`, `netstat -tupln`, `systemctl --failed`,
  `systemctl -t service|cat`, `journalctl -p err -n20|cat`, `ps uaxf`, `docker ps`,
  `tmux ls`, `git status`. Every button is the same size, a long label takes a
  second line, and the pad has twenty-four cells counting the `▴`: both column
  counts the stylesheet uses — 3 on a phone, 6 beyond it — divide twenty-four, so
  the last row is always full, and the room a wider screen has goes into the button
  (the key bar's own size past 1300px) rather than into more columns. The label **is** the command, which
  is why `|cat` stands where a pager would otherwise open. It is at the top because
  a shell writes at the bottom: over the last rows it would cover the answer to the
  very command it sent. With the agent's own input box on screen the first tap only
  asks, `clear` typed in there being a message to Claude rather than a command. The
  three `vcgencmd` buttons are Raspberry Pi firmware and answer "command not found"
  elsewhere.
- **History under the thumb.** A swipe scrolls tmux's history, `⇞`/`⇟` move a
  screen at a time, and the bar down the right says where in the output you are
  — drag it to go anywhere. It is drawn over the terminal rather than beside it:
  in the flow it would narrow the pane, tmux would redraw to the new width, and
  the page would be reading a screen its own scrollbar reflowed.
- **List and attach.** pockterm lists running tmux sessions and attaches
  to the one you pick. It never **creates** sessions — you start those on
  the server yourself.
- **tmux grouped sessions.** Each client gets its own view size; your
  laptop's tmux window is never shrunk by a phone. The page names that size in
  the socket's address, so a client attaches at it rather than at 80×24 until
  told otherwise: a group has one window, and such a client would redraw it
  under everyone else.
- **Answer buttons.** An interactive menu (a Claude Code permission prompt,
  say) is recognised by its pointer and box rather than by any numbering,
  so a numbered list in prose produces no buttons. While the pane is
  scrolled back into history (copy-mode) the buttons stay hidden.
  The `Type something.` row is not an answer but the menu's own text field:
  its button is drawn outlined, walks the pointer onto the field and hands
  over the keyboard without pressing anything. An Enter over the empty field
  reaches the agent as a refusal to answer, which is what "the button sends a
  cancel" was. A question that takes several answers is toggled rather than
  answered: those buttons carry ☐/☑ and an Enter on an option flips the box.
  What ends such a question is a green `⏎ Submit` button of its own — the page
  walks the pointer onto that row one step at a time and presses Enter only on
  the screen that shows the pointer on it.
- **Clipboard exchange.** The ✂ button turns on selection mode: swiping
  stops scrolling, the text selects natively, and Copy / Paste move it to
  the device clipboard and back into the terminal. A long press takes a
  paragraph whole and marks it where it stands — a press on another one adds
  it, a press on a marked one drops it, a plain tap on text does nothing, and
  Copy hands over what is marked in the order it is on screen. Nothing outside the frozen copy ever reaches the
  clipboard.
- **Files, not only pictures.** A screenshot arrives through Paste (so does
  Ctrl+V, or dropping a file), and 📎 picks anything off the device — a spec, a
  log, a patch, a note. The clip asks which source first (🖼 pictures,
  📄 documents), because the filter that opens Android on the gallery is the one
  that hides every document, and no filter at all buries the screenshots. Only keystrokes fit through a pty, so the bytes go to
  the server, land as a file under the user's cache directory, and the terminal
  receives the path — which an agent reads anyway. An image is recognised by
  its bytes and keeps the extension they earn; anything else keeps the name it
  was picked under, reduced to one word a terminal line can carry
  (`заметки по стенду.md` → `…-заметки-по-стенду.md`), because that extension
  is what tells an agent what it is holding. Up to ten at a time: they upload
  one after another and their paths are typed in a single write, so the agent
  gets one message about several files rather than one message each.
- **Sessions from the UI.** `+` starts one from a fixed preset (`shell`,
  `claude`, `yolo`, `continue`), `✎` renames, `✕` closes in two taps. The page
  never sends a command, only a preset name, and the same Makefile people use
  by hand does the launching. It exists because a phone with no sessions left
  had no way to make one.
- **Telegram notifications.** The server reads the session's screen with
  `capture-pane` and messages you when the agent asks for an answer or
  falls silent — which works with pockterm closed, exactly when it matters.

## Quick start

```bash
make build
./bin/pockterm
# start a session: tmux new-session -d -s work
# open http://127.0.0.1:8130 and pick it
```

## On your phone in three minutes

The full route out — a domain, TLS, certificates — is what a permanent install
needs. To simply see the thing working, your own network is enough:

```bash
sudo POCKTERM_LISTEN=0.0.0.0:8130 bash deploy/install.sh
```

The installer sets up the service, generates a token and prints a QR code
carrying this machine's address. Point the camera of a phone on the same Wi-Fi
at it.

The traffic is plain HTTP: the token keeps strangers out, but nothing stops
someone on the same network from reading what crosses it. For anything
permanent put a reverse proxy in front (below) — the QR then carries the real
address:

```bash
POCKTERM_PUBLIC_URL=https://pockterm.example.com sudo -E pockterm qr
```

## Installing on a server

```bash
git clone https://github.com/hitromudr/pockterm && cd pockterm
sudo bash deploy/install.sh        # or: make install
```

Go is not always needed: with no toolchain around, the installer downloads the
published build for this architecture (linux amd64 and arm64) and checks it
against the release's `SHA256SUMS`. Force the download even when Go is present
with `POCKTERM_FROM_RELEASE=1`, or point it elsewhere with
`POCKTERM_RELEASE_BASE=<url>`. A file that does not match its sum is not
installed.

The script builds the binary into `/usr/local/bin`, generates a token in
`/etc/pockterm/pockterm.env` (mode 600), writes a systemd unit and starts the
service as the account whose tmux sessions you want served — under `sudo`,
that is whoever invoked it. Re-running is safe: the token is kept and the unit
is rewritten only when it actually changed. Remove it with
`sudo bash deploy/install.sh --uninstall`.

It also does what used to be left to a human afterwards — otherwise the first
session on a new phone meant reading this file to the end first:

- **Checks that the host has `tmux`** and refuses to install the service
  without it, printing the command that installs it here. An empty session list
  on a phone reads as a broken terminal rather than as a missing package. A
  missing `make` is a warning: only the + button depends on it.
- **Installs the session Makefile** (`deploy/sessions.mk.example`) into the
  projects root and writes `POCKTERM_SESSION_DIR` beside it, so the + button
  works straight away. The root defaults to the served account's home; name
  another with the same variable: `sudo POCKTERM_SESSION_DIR=/home/me/projects
  bash deploy/install.sh`. Somebody else's Makefile is neither overwritten nor
  pointed at — `make claude` in it is an unknown target, not a session — so the
  file and the variable are left alone and the reason is printed. A copy of its
  own is recognised by `pockterm-sessions` in the header, edits and all. Turn
  it off with `POCKTERM_NO_SESSIONS=1`.
- **Restarts the service when the env file changed**, and only then: a restart
  drops every open terminal, and an install that changed nothing must not cost
  anyone a reconnect.
- **`--tg` sets Telegram up during the install**: it asks for the bot token,
  finds the chat id, sends a test message and restarts the service. On its own
  that is `pockterm tg-setup --write /etc/pockterm/pockterm.env` — and the
  restart is the half people left out.

The service listens on loopback. To reach it from outside, put a reverse proxy
in front — worked examples ship alongside:

| File | When |
|---|---|
| `deploy/nginx-token.conf.example` | TLS plus the built-in token. To get started |
| `deploy/nginx-mtls.conf.example` | Client certificates. To keep |

With mTLS in front the token is not needed and gets in the way: the server
answers `401` to any link without it, which in a browser looks exactly like a
machine with no sessions. Install with `POCKTERM_NO_TOKEN=1`:

```bash
sudo POCKTERM_NO_TOKEN=1 bash deploy/install.sh
```

An existing token is left alone — the installer only warns about it.

A token in the address bar ends up in browser history and proxy logs, so a
lasting setup is better served by mTLS: an internet-wide scan then sees a
failed handshake rather than a login page. Issuing the certificates and
installing them on a phone is documented at the top of
`nginx-mtls.conf.example`.

## Connecting a phone

```bash
make qr PUBLIC_URL=https://pockterm.example.com
```

The QR code is printed straight into the terminal: point the camera at it and
the address opens, token included. **The page then offers to install itself** —
a bar under the session list's header with an "Установить" button: on Android,
Chrome builds and installs a real package, so pockterm turns up in the app list
and opens in its own window without tabs. Safari has no install event at all, so
there the same bar names the route instead: Share → "Add to Home Screen".

That offer used to be only a button in the drawer's settings, two taps deeper —
and a first visit closed the tab without installing anything. The button is
still there: it is how you install after dismissing the bar, which does not come
back ("later" is remembered).

Without a camera, `pockterm qr https://...` prints both the code and the plain
URL.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `POCKTERM_LISTEN` | `127.0.0.1:8130` | Listen address. Non-loopback requires `POCKTERM_TOKEN`. |
| `POCKTERM_TOKEN` | empty | Shared token (`?token=...`); mandatory off-loopback. |
| `POCKTERM_TG_TOKEN` | empty | Bot token from @BotFather. Empty disables notifications. |
| `POCKTERM_TG_CHAT` | empty | Chat id. Must be set together with the token, or startup fails. |
| `POCKTERM_TG_LINK` | empty | Link appended to each message (no token in it). |
| `POCKTERM_TG_PREVIEW` | on | `off` sends only the event and the session name, no screen text. |
| `POCKTERM_TG_API` | `https://api.telegram.org` | Bot API root: a local bot server or a test double. |
| `POCKTERM_IDLE` | `30s` | How much silence counts as "finished". |
| `POCKTERM_NOTIFY_FILE` | a file in the user's config dir | Where the notification switch is remembered; `off` keeps it in memory (lost on restart). |
| `POCKTERM_PRESETS_FILE` | a file in the user's config dir | Where the custom session buttons are remembered; `off` keeps them in memory. |
| `POCKTERM_UPLOAD_DIR` | user cache dir | Where attached files are saved (images and documents alike); `off` disables uploads. |
| `POCKTERM_SESSION_DIR` | the service's working dir | Where the session Makefile lives (the + button); `off` refuses to start any. |

## Starting sessions from the phone (the + button)

The page never sends a command — only a preset name (`shell`, `claude`,
`yolo`, `continue`) — and the server runs `make -C <dir> <preset>`. What a
session is stays the Makefile's decision, not pockterm's: it remains the one
place that knows about a sandbox wrapper, session numbering and slices.

`deploy/sessions.mk.example` is a working starting point, and
**`deploy/install.sh` puts it in place**: into the projects root, with
`POCKTERM_SESSION_DIR` in the env file. By hand only where the root is
somewhere else and the installer has already run:

```bash
cp deploy/sessions.mk.example ~/work/Makefile   # edit CLAUDE inside
echo 'POCKTERM_SESSION_DIR=/home/youruser/work' | sudo tee -a /etc/pockterm/pockterm.env
sudo systemctl restart pockterm
```

Without `POCKTERM_SESSION_DIR` the server looks in its own working directory —
for a unit, whatever `WorkingDirectory=` says (the example unit and the one the
installer writes both use the user's home). No Makefile, no + button; the log
says so at startup.

### The projects root, as somewhere to start

The 📁 button in the session drawer shows the drawer's other list: the folders
of the projects root (the same `POCKTERM_SESSION_DIR`), with the root itself
first. Tapping one opens the same four presets, and the session starts **in that
folder** and takes **its name**: `natal`, then `natal-2`. The name is still the
Makefile's decision — it is handed `DIR=` and `PREFIX=`, and the number that is
free as both a session and a group name remains its business.

Why this is not "the + with a path attached": a session is almost always about a
project, and on a phone there is no `cd` worth typing. And claude-1, claude-2,
claude-3 is not a list anyone can navigate — a folder in the name answers "what
is this" where the command does not. Renaming stays: the folder is where the name
starts, not a rule about it.

One level deep, no hidden directories. The page sends a folder name and nothing
else; the server joins the path itself and refuses anything that is not one plain
name inside the root (`..`, `/`, a leading dot), because the value reaches a
command line.

The plain + lost nothing: it still starts a preset in the root.

### Session buttons: the four defaults and your own, one list

The bottom of the drawer holds a **Settings** panel, and in it the session buttons: a
label and a command. One of your own joins the four defaults under + (and in the menu
over the terminal — it is one list), starts in the same folder and takes the same name
from it. So `qwen`, `opencode` or anything else arrives from the phone instead of
through an edit to a Makefile on the host.

**The four defaults are entries in that same list**, so they take the same edit and
the same removal. What makes one a default is that its id is a make target (`shell`,
`claude`, `yolo`, `continue`) and its command is empty: what the target does stays the
Makefile's decision. Give a default a command and it goes through the same `custom`
target while keeping its id — and with it the mark on every tab it has already opened:
`claude --model opus` is still `✦`. A removed button the server refuses to start,
since otherwise removing one would only have hidden it.

**A button may name a make target rather than carry a command.** Type `make
cont-yolo` in the command field and that is the target it runs, exactly as `make
claude` is for a default — which is what the rows show anyway. It exists because a
Makefile has targets the four do not cover, and `make cont-yolo` as a *command* runs
make inside the session the button just created: a second session appears beside it
and the first one dies. A target name is a narrower thing to allow than a command:
letters, digits and dashes, no arguments and no path. The target is one in **your**
Makefile, at the same trust as the four; an unknown one is refused by make itself and
the message reaches the drawer.

**"↻ Сбросить к умолчанию"** restores the four and leaves yours alone: the four are a
default and `qwen` typed on a phone is not. Two taps, like every removal here, because
it does undo renames and commands.

What launches it is still the Makefile: the command travels as `CMD=` to one target
(`custom`) which wraps it in the same launcher as every other target. A Makefile
without that target answers with its own "no rule to make target", and the text
reaches the drawer as it came.

The command is checked before it reaches a command line: letters, digits, spaces and
`- _ . / = : , @ +`, starting with a letter, a digit or a path. Quotes, `$`, `;`,
`&`, `|` are refused with a reason — the value reaches a shell inside the recipe, so
this is a gate rather than advice.

**A button's mark is picked from a grid.** Left of the label sits a button showing
the current glyph; tapping it opens a grid **right under it**, tapping a glyph picks
it and closes the grid, and tapping the one already chosen clears it. The button shows
the glyph the button will be drawn with rather than the one that was picked — with
nothing picked that is the page's own answer, and it follows the label as it is typed.
Glyphs that have a colour form carry it (`❄️`, not `❄`): in text presentation a mark
takes the colour of the label around it and goes unnoticed on a tab. The mark is drawn in the `+`
menu, on every tab the button opens, and in the drawer. The only way to have one
used to be an emoji at the front of the label — a trick you had to know, and a
character out of a name that has 24 — which is why three custom buttons all drew the
same `★`.

With nothing picked the order is: an emoji the label leads with (as before), then
what the id is known for — a default's own glyph, or the name of an agent this
recognises — and the shared `★` when nothing says anything. Exactly two names are
guessed at: **Claude is cold (`❄`), Codex is sol (`☀`)**; a third would be a guess,
and either is overruled by one tap in the grid.

Every button in the list carries two actions: `✎` to change it, and `✕` to remove it
**in two taps**, the same as closing a session: the first reddens the cross and asks,
the second acts, and the arming lapses after four seconds. It was one tap until a
stray touch took a button away with nothing asked — the rows in the drawer look
alike, and the gesture is where they must not differ. Editing loads the label and the command into the same two fields — a phone has no
room for a second pair, just as it has none for a second rename field — marks the
row they are about, and "Добавить" becomes "Сохранить"; tapping `✎` again cancels.
Changing a button is not deleting and re-adding it: it keeps its id, and the id is
what the tabs it opened are marked with, so retyping the same command would leave
those sessions marked by a button that no longer exists.

The list lives on the host (`POCKTERM_PRESETS_FILE`, next to the notification
switch) rather than in the browser: what it starts happens on the host, a second
phone must find the same buttons, and CI restarts the binary several times a day.

Everything that used to sit behind `⋯` over the terminal moved into the same panel —
text size, notifications, `〰 smooth`, the keyboard mode, the input log, the version
and Install. Moved rather than copied: two places holding one lever drift apart. The
`▾` that hides the bars stayed on the key bar, being an action on the working
surface rather than a setting.

The Settings panel also closes on a **swipe down** inside it: it opens upward from
the row at the bottom of the drawer, so pulling it back down says the same thing as
tapping that row. Only from the top of the panel, since it scrolls under the same
finger and taking that away from a list of buttons would be worse than one more tap.

Whether the Settings panel is open is **remembered**: closing the drawer collapses
it without answering for you, so it comes back the way it was left — on the next
visit to the drawer and after a reload.

### The order of the tabs: hold one and carry it

tmux orders its sessions by name, which is the one order nobody chose. The strip is
read left to right dozens of times a day, and the session you keep coming back to is
not the one whose name sorts first.

The gesture is the same press that makes a tab explain its mark: **hold** and the tab
lifts (with that plate under it), **move** and the row rearranges, let go and the
order is saved. A press that does not travel is still just the question about the
mark. A plain drag is no good for this — that scrolls the strip, which is wider than
the screen.

The order is kept in tmux itself, as an option on the session (`@pockterm-order`,
beside the button's stamp): it survives restarts of the binary (CI installs one
several times a day), a second phone sees the same row, and a session that is closed
takes its slot with it. A session started after the last drag lands at the end of the
strip rather than in the middle of somebody's arrangement.

### The tab strip: the colour says what the session is doing

A tab answers three different questions and says them three different ways:
which sessions exist (the row), which one you are in (**a frame**), and what each
is doing (**the fill**):

| Look | Meaning |
|---|---|
| plain | the watcher has nothing to claim: quiet since it started looking |
| moving purple | output is arriving right now |
| green | gone quiet after doing something — the same event the "finished" notification is raised from |
| moving blue with a yellow `!` over its top edge | the agent is waiting for an answer: a menu is on screen and nothing happens until it gets one |

Blue outranks the rest and waits for no history: a menu on screen is the one state
that is about the person holding the phone rather than about the machine, so it
beats both "working" and "gone quiet" — which would otherwise have a tab claim an
agent had finished while it stood there asking. The mark deliberately breaks the
tab's outline. It is the same detection the answer buttons come from; those exist
only for the session on screen, and the question you want to know about is usually
in the one that is not.

The state is not worked out by the page but by the same pane watcher that decides
about notifications, so the colour and the notification cannot disagree. It rides
along as `state` in the session list and refreshes every three seconds while the
terminal is on screen and the page is in front: a phone in a pocket keeps its
socket for hours, and polling tmux for a strip nobody can see is work done for
nobody.

A frame rather than a fill for the attached tab, because the fill is spoken for:
it used to say "you are here", which left the session you are sitting in as the
one tab that could not tell you whether its agent was still running.

The purple sweeps slowly and both ways, and every tab starts somewhere else in the
sweep (the phase comes from the session name, so a rebuild of the row does not
reset it): a row pulsing in step read as one decoration for the whole strip rather
than as several sessions each doing their own thing.

Besides the colour a tab carries a **green heraldic shield in its bottom-right
corner** (flat top, pointed bottom) — how
many shells and monitors the agent still has running. In the corner rather than
after the name: the row scrolls sideways and the names are what is read along it.
It is a second answer rather than a shade of the first: the colour goes out the
moment the agent stops speaking, while what it left running does not stop with it,
and "gone quiet" is not "gone quiet with two monitors watching". The count is read
off the agent's own status line (`1 shell, 1 monitor`) and travels in the same
session list as `shells` and `monitors`. The "… still running" line an agent prints
when a turn ends does not count: it was true then and says nothing about now.

## Notifications

A session comes under watch once you attach to it through pockterm, and
stays there while it lives. The server reads its screen every two seconds
with `capture-pane` and tells two events apart:

- **asks for an answer** — an interactive menu appeared (one message per
  menu, not per poll);
- **finished** — the agent's own counter (`✻ Pondering… (4m 23s · …)`) has left
  the screen and stayed away for 4s; or, for a pane with no counter to read, the
  screen has not changed for `POCKTERM_IDLE` after something happened.

**One decision, two channels.** The event goes to Telegram and, as a frame
on the websocket, to an open page, which raises a system notification (in
the app through the bridge, in a browser through the Notification API).
The page used to decide this itself, and it was wrong twice over: it read
every byte off the socket as activity, and tmux redraws its status line on
a clock, so the countdown to "finished" rarely ran out; the timer checking
it is throttled to about once a minute once Android backgrounds the
WebView. What arrived, and when, was unexplainable. The server reads the
pane directly — no status line in it, and nothing throttles it.

**One switch, three states** — the 🔔 button in Settings: `PWA` (notify the
open page only), `PWA+TG` (and Telegram when nothing is open) and `Off`
(neither). The state lives on the server rather than in the browser: half of
what it controls is sent from the host to a phone that has the page closed, and
a second phone must not quietly disagree with what the host is doing. It is
remembered across restarts — CI installs this binary on every push to `main`,
and a mode held in memory would return to its default several times a working
day. With no bot configured the middle state drops out of the ring: promising
Telegram where there is no token would be a lie.

**The page asks the browser for permission itself, at the first touch.** The
server's default is `PWA+TG`, so a fresh install starts in a notifying state, and
nobody taps a switch that already says what they want: permission used to be asked
for only there, which left every new install silent with nothing saying why. At the
first touch rather than on load, because a prompt raised without a gesture is
refused outright by some browsers and shown more quietly by the rest. Asked once: a
prompt dismissed without an answer leaves the same "never asked" state behind, and a
page that asks on every load loses the right to ask at all. What is left after that
is the dashed `🔔` — a tap on it is the second chance.

While the session is open in pockterm and the tab is on screen, its
notifications stay quiet — you can already see it. A backgrounded PWA
keeps its socket open but counts as not looking, so the message arrives.
If the system suspends the socket too, the frame never lands; Telegram
still does.

The text is short and identical in both channels: the title names the
session (`✅ claude-1 finished`), the body is the last meaningful line of
the pane. Meaningful is the operative word — agent TUIs draw an input box
and a shortcut hint below their output, and "the last non-blank line" is
those.

Switching them on is one command. Create a bot with @BotFather, send it any
message (until you do, Telegram tells the bot nothing about you), then run:

```bash
sudo pockterm tg-setup --write /etc/pockterm/pockterm.env
sudo systemctl restart pockterm
```

It asks for the token, finds the chat id itself, sends a test message and
writes the settings into the env file (0600), leaving every other line alone.
If the bot has been written to from several chats it lists them and asks you
to pick: `--chat <id>`. Without `--write` it just prints the lines to add.

`--link https://your.address` sets the link the messages carry.

## A socket that has gone quiet

A phone hands its socket between Wi-Fi and cellular whenever it feels like it, and
the far end of a handed-over connection is a black hole: `readyState` stays OPEN,
sends look like they succeed, and nothing arrives. It showed as the screen freezing —
the message had plainly been sent, the laptop's window showed the agent answering it,
and the phone caught up about a minute later, which is TCP giving up.

The page asks now: after 10s of silence it sends a `ping`, and if nothing arrives
within 5s the socket is discarded and the connection is made again. Any inbound frame
counts as the answer, so a busy session is never pinged. Nothing is asked while the
page is off screen: a backgrounded page has its timers throttled to about one firing a
minute, and tearing down a socket because the clock slowed is worse than the freeze
being fixed. Coming back to the page is itself a reason to ask.

## Deployment

pockterm itself listens on loopback. Put a reverse proxy in front for
TLS and authentication (client certificates or the built-in token).
An example systemd unit is in `deploy/pockterm.service.example`.
The proxy must pass WebSocket upgrades for `/ws` and disable buffering.
The proxy must also preserve the original Host header (nginx:
`proxy_set_header Host $host;`) — the server checks `Origin` against the
request's `Host` and rejects the upgrade if the proxy rewrites it.

## Updating: installed at once, the page offers to reload

Installing a new binary restarts the unit, and somebody is usually working in
the terminal it serves. That used to make the install wait for nobody to be
looking — which meant waiting for the very person waiting for the fix. Now
`deploy/pockterm-deploy` installs a build as it arrives: a restart costs one
reconnect, and the tmux session behind it is untouched.

| File | What it does |
|---|---|
| `deploy/pockterm-deploy` | verifies the signature, installs, restarts, rolls back |
| `deploy/pockterm-deploy.path` | notices a build arriving |
| `deploy/pockterm-deploy.service` | runs the script |

Identical bytes cause no restart, and a binary that fails to start is rolled
back to the previous one.

An open page reconnects after the restart and carries on running the assets it
already had. It cannot tell that by itself — its own code is the old code. So
the server names the page version it serves in the `config` frame (`APP_VERSION`
from its embedded `web/js/app.js`), the page compares it with its own and shows
a bar with an **Обновить** ("update") button. A reload on a tap rather than by
itself: the composer can hold a half-written message. The service worker is
network-first, so a plain reload is enough.

The scheme expects a CI job that drops a signed file into
`/var/lib/pockterm/incoming`; the signature matters because that directory is
visible to the build job. To exercise the script without touching the machine:
`make test-deploy`.

## Security model

pockterm hands a full terminal to whoever connects. Treat it like SSH:
never expose it without TLS plus authentication. The binary refuses to
listen on a non-loopback address without a token.

Notifications send a slice of the screen to an outside service: the
question line and its menu options, or the last line of output. The
amount is bounded (at most eight options, lines clipped at 200
characters), but session content still leaves the host.
`POCKTERM_TG_PREVIEW=off` reduces it to the event and the session name.
The link in a message carries no token.

## Development

```bash
make check    # gofmt, vet, go tests, node --test
```

### The pane's fonts

The pane is drawn in fonts carried in the binary — otherwise the machine picks the
face, and one screen comes out in three of them (Courier New on Windows, Droid Sans
Mono on the phone, `DejaVu Sans Mono` on Linux) with three cell widths.

There are two, because no single face has everything a pane shows:

- `pockterm-mono-400.woff2` — the letters, from Droid Sans Mono, the face
  Android's own `monospace` resolves to. The source is kept as
  `third_party/fonts/DroidSansMono.ttf`: Google Fonts dropped it and Debian ships
  only its CJK fallback. Apache 2.0.
- `pockterm-marks-{400,700}.woff2` — what that face has not got: box drawing,
  blocks, shapes, arrows, `✓ ✳ ❯ ❄ ☀ ★ ⇩`. From the system DejaVu Sans Mono,
  rescaled onto the same 600/1000 cell.

The order in `--mono` is the mechanism: letters, then marks, then the system names
— `⏵` is in neither file. Bold for the letters is synthesised by the browser: Droid
Sans Mono has no bold weight, as on the phone.

The bars are drawn in the same two families — the keys, the modes, the pager, the
console pad: `system-ui` is a stack too, so `Esc` and `Ctrl` came out in whatever
face the machine had and disagreed with the pane six pixels below them. Only `⏹`
and `☰` fall through (neither family has them), and the emoji, which no mono subset
could carry; `✂` is in the marks but is deliberately kept in colour (`#select` asks
for the emoji form by name). The composer's field is deliberately not in the list: prose is
written there.

Rebuild with `make font-subset` (needs `fonttools`, `python3-brotli`,
`fonts-dejavu-core`). The files are committed and are not rebuilt by `make check`:
a build that regenerated them would look like a new binary to CI. Licences:
`third_party/fonts/LICENSE-droid.txt` and `web/fonts/LICENSE-dejavu.txt`.
