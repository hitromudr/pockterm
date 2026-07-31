# pockterm

[Русская версия](README.md)

Pocket terminal: a mobile-friendly PWA attached to a tmux session,
served by a single Go binary. Built for driving
[Claude Code](https://claude.com/claude-code) (or any TUI) from a phone.

- **One binary.** Static PWA is embedded; no runtime dependencies except
  `tmux` on the host.
- **Real terminal.** xterm.js over a WebSocket-to-PTY bridge, plus a key
  bar (Esc, Tab, arrows, Ctrl latch) for mobile keyboards.
- **tmux grouped sessions.** Each client gets its own view size; your
  laptop's tmux window is never shrunk by a phone.
- **Survives reboots.** If the target session is missing, pockterm
  bootstraps it with a configurable command.

## Quick start

```bash
make build
POCKTERM_SESSION=claude ./bin/pockterm
# open http://127.0.0.1:8130
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `POCKTERM_LISTEN` | `127.0.0.1:8130` | Listen address. Non-loopback requires `POCKTERM_TOKEN`. |
| `POCKTERM_SESSION` | `claude` | tmux session (group) to attach to. |
| `POCKTERM_BOOTSTRAP` | login shell | Command used to create the session when missing. |
| `POCKTERM_TOKEN` | empty | Shared token (`?token=...`); mandatory off-loopback. |

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

## Development

```bash
make check    # gofmt, vet, go tests, node --test
```
