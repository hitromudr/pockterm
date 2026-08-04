# pockterm

[Русская версия](README.md)

Pocket terminal: a mobile-friendly PWA window onto your tmux sessions,
served by a single Go binary. Handy for driving any console from a phone —
for example [Claude Code](https://claude.com/claude-code) or any TUI.

- **One binary.** Static PWA is embedded; no runtime dependencies except
  `tmux` on the host.
- **Real terminal.** xterm.js over a WebSocket-to-PTY bridge, plus a key
  bar (Esc, Tab, arrows, Ctrl latch) for mobile keyboards.
- **List and attach.** pockterm lists running tmux sessions and attaches
  to the one you pick. It never **creates** sessions — you start those on
  the server yourself.
- **tmux grouped sessions.** Each client gets its own view size; your
  laptop's tmux window is never shrunk by a phone.
- **Answer buttons.** An interactive menu (a Claude Code permission prompt,
  say) is recognised by its pointer and box rather than by any numbering,
  so a numbered list in prose produces no buttons. While the pane is
  scrolled back into history (copy-mode) the buttons stay hidden.
- **Clipboard exchange.** The ✂ button turns on selection mode: swiping
  stops scrolling, the text selects natively, and Copy / Paste move it to
  the device clipboard and back into the terminal.
- **Images from the clipboard.** The same Paste button takes a screenshot
  (so does Ctrl+V, or dropping a file): only keystrokes fit through a pty,
  so the image goes to the server, lands as a file under the user's cache
  directory, and the terminal receives its path — which an agent reads
  anyway.
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
the address opens, token included. Then "Add to Home Screen" and pockterm
behaves like an app — its own window without tabs, and the keyboard shortcuts
reach the terminal.

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
| `POCKTERM_UPLOAD_DIR` | user cache dir | Where pasted images are saved; `off` disables uploads. |
| `POCKTERM_SESSION_DIR` | the service's working dir | Where the session Makefile lives (the + button); `off` refuses to start any. |

## Starting sessions from the phone (the + button)

The page never sends a command — only a preset name (`shell`, `claude`,
`yolo`, `continue`) — and the server runs `make -C <dir> <preset>`. What a
session is stays the Makefile's decision, not pockterm's: it remains the one
place that knows about a sandbox wrapper, session numbering and slices.

`deploy/sessions.mk.example` is a working starting point:

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

## Notifications

A session comes under watch once you attach to it through pockterm, and
stays there while it lives. The server reads its screen every two seconds
with `capture-pane` and tells two events apart:

- **asks for an answer** — an interactive menu appeared (one message per
  menu, not per poll);
- **finished** — the screen has not changed for `POCKTERM_IDLE` after
  something happened.

**One decision, two channels.** The event goes to Telegram and, as a frame
on the websocket, to an open page, which raises a system notification (in
the app through the bridge, in a browser through the Notification API).
The page used to decide this itself, and it was wrong twice over: it read
every byte off the socket as activity, and tmux redraws its status line on
a clock, so the countdown to "finished" rarely ran out; the timer checking
it is throttled to about once a minute once Android backgrounds the
WebView. What arrived, and when, was unexplainable. The server reads the
pane directly — no status line in it, and nothing throttles it.

**One switch, three states** — the 🔔 button in the ⋯ menu: `PWA` (notify the
open page only), `PWA+TG` (and Telegram when nothing is open) and `Off`
(neither). The state lives on the server rather than in the browser: half of
what it controls is sent from the host to a phone that has the page closed, and
a second phone must not quietly disagree with what the host is doing. It is
remembered across restarts — CI installs this binary on every push to `main`,
and a mode held in memory would return to its default several times a working
day. With no bot configured the middle state drops out of the ring: promising
Telegram where there is no token would be a lie.

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
