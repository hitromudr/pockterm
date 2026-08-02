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

## Installing on a server

```bash
git clone https://github.com/hitromudr/pockterm && cd pockterm
sudo bash deploy/install.sh        # or: make install
```

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

## Notifications

A session comes under watch once you attach to it through pockterm, and
stays there while it lives. The server reads its screen every two seconds
and sends two kinds of event to Telegram:

- **asks for an answer** — an interactive menu appeared (one message per
  menu, not per poll);
- **finished** — the screen has not changed for `POCKTERM_IDLE` after
  something happened.

While the session is open in pockterm and the tab is on screen, its
notifications stay quiet — you can already see it. A backgrounded PWA
keeps its socket open but counts as not looking, so the message arrives.

The easiest way to find your chat id: message the bot, then open
`https://api.telegram.org/bot<token>/getUpdates`.

## Deployment

pockterm itself listens on loopback. Put a reverse proxy in front for
TLS and authentication (client certificates or the built-in token).
An example systemd unit is in `deploy/pockterm.service.example`.
The proxy must pass WebSocket upgrades for `/ws` and disable buffering.
The proxy must also preserve the original Host header (nginx:
`proxy_set_header Host $host;`) — the server checks `Origin` against the
request's `Host` and rejects the upgrade if the proxy rewrites it.

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
