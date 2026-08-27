#!/usr/bin/env bash
# Exercises the kill target of deploy/sessions.mk.example against a real tmux —
# its own server, in its own TMUX_TMPDIR, so it can never reach the sessions of
# whoever runs it.
#
# It exists because `make kill` is the second door to the same action the phone's
# ✕ is, and it had the same defect: a session closed on its own leaves its window
# standing in the client session pockterm attaches with, and the process in it
# goes on running where `make ls` cannot show it.
#
#   bash test/sessions_mk_test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MK="$ROOT/deploy/sessions.mk.example"
WORK="$(mktemp -d)"

ok()  { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; exit 1; }

command -v tmux >/dev/null || { echo "tmux not installed, skipping"; exit 0; }

# The socket, and it is the whole of the isolation. `-L` names the server on
# every single call; nothing here may reach tmux any other way.
#
# TMUX_TMPDIR was tried first and cost the owner every session on this machine
# on 2026-08-27. It sets where a *new* default socket goes, and a tmux client
# with $TMUX in its environment talks to the server that variable names whatever
# it says — and $TMUX is set for anything run inside a pane, which is where this
# test is run from. So every command went to the live server, the stand check
# failed against the owner's own session list, and the `kill-server` in the exit
# trap took the lot. Hence: -L on every call, $TMUX out of the environment, and
# the guard below, which refuses to go on unless the socket is provably ours.
SOCK="pockterm-mk-test-$$-$(date +%s)"
unset TMUX TMUX_PANE
TMUX_BIN="$(command -v tmux)"

# The shim is the guard, and it is deliberately not a convention. The recipe
# under test calls `tmux` by name — it is a Makefile on somebody's host, not a
# thing that takes an injection point — so the socket has to be put where any
# call finds it, including one this file forgot to write as `tm`. First on PATH,
# and it is what `mk` below runs against.
mkdir -p "$WORK/stub"
cat > "$WORK/stub/tmux" <<EOF
#!/usr/bin/env bash
exec "$TMUX_BIN" -L "$SOCK" "\$@"
EOF
chmod +x "$WORK/stub/tmux"
PATH="$WORK/stub:$PATH"

tm() { "$TMUX_BIN" -L "$SOCK" "$@"; }

cleanup() { tm kill-server 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# Nothing may be created, let alone killed, until this server is known to be
# ours and empty. A socket that already carries sessions is not this test's, and
# the exit trap below ends with kill-server.
if tm ls 2>/dev/null | grep -q .; then
	bad "the socket $SOCK already carries sessions — refusing to touch it"
fi
# And the shim has to be the tmux everything else finds, or the line above
# proved something about a server nobody is going to use.
[ "$(command -v tmux)" = "$WORK/stub/tmux" ] || bad "the tmux shim is not first on PATH"

mk() { make --no-print-directory -f "$MK" -C "$WORK" "$@"; }
sessions() { tm ls -F '#{session_name}' 2>/dev/null | sort | tr '\n' ' '; }
has() { tm has-session -t "=$1" 2>/dev/null; }

start_work() { # start_work — a work session with a process of its own to watch
	tm new-session -d -s work "sleep 9999"
	tm display-message -p -t work '#{pane_pid}'
}

alive() { kill -0 "$1" 2>/dev/null; }

gone_within() { # gone_within <pid> <seconds>
	local i=0
	while alive "$1" && [ "$i" -lt "$2""0" ]; do sleep 0.1; i=$((i+1)); done
	! alive "$1"
}

echo "kill closes the client session holding the window"
pid="$(start_work)"
# What a page leaves in tmux: its own session grouped with the work session,
# sharing its window. Detached is enough — holding the window is what a group
# member does, attached or not.
tm new-session -d -s pockterm-client-1 -t work
[ "$(sessions)" = "pockterm-client-1 work " ] || bad "stand: $(sessions)"
alive "$pid" || bad "the pane's process was not running to begin with"

out="$(mk kill NAME=work)"
[ "$out" = "killed work" ] || bad "said: $out"
gone_within "$pid" 3 || bad "the pane's process $pid outlived the session that was closed"
[ -z "$(sessions)" ] || bad "sessions left behind: $(sessions)"
ok "the window went with the session, and so did the process in it"

echo "kill leaves another session's client alone"
pid="$(start_work)"
tm new-session -d -s other "sleep 9999"
tm new-session -d -s pockterm-client-2 -t other
mk kill NAME=work >/dev/null
has other || bad "the other session was closed too"
has pockterm-client-2 || bad "the other session's client was closed"
gone_within "$pid" 3 || bad "the pane's process $pid survived"
tm kill-server 2>/dev/null || true
ok "only the group of the session being closed is touched"

echo "a session nobody has open is closed on its own"
pid="$(start_work)"
out="$(mk kill NAME=work)"
[ "$out" = "killed work" ] || bad "said: $out"
gone_within "$pid" 3 || bad "the pane's process $pid survived"
ok "one kill, and nothing left"

echo "a renamed session is found by its group, not by its name"
pid="$(start_work)"
tm new-session -d -s pockterm-client-3 -t work
# tmux names a group after the session it was created from and never renames it,
# so after this the session and its clients' group no longer share a name.
tm rename-session -t "=work" lendrail
out="$(mk kill NAME=lendrail)"
[ "$out" = "killed lendrail" ] || bad "said: $out"
gone_within "$pid" 3 || bad "the pane's process $pid outlived the renamed session"
[ -z "$(sessions)" ] || bad "sessions left behind: $(sessions)"
ok "the group is the key, and it keeps the old name"

echo "a name nothing carries says so"
out="$(mk kill NAME=nope)"
[ "$out" = "no session nope" ] || bad "said: $out"
ok "no session nope"

echo "no name at all is a usage line, not a close"
pid="$(start_work)"
out="$(mk kill)"
case "$out" in usage:*) ;; *) bad "said: $out" ;; esac
alive "$pid" || bad "a bare 'make kill' closed something"
has work || bad "a bare 'make kill' closed the session"
ok "usage, and nothing touched"

printf '\033[1;32mall good\033[0m\n'
