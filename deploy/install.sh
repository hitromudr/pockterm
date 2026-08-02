#!/usr/bin/env bash
# install.sh — install pockterm on this machine: binary, token, systemd unit.
#
# Idempotent: re-running keeps the existing token and only restarts the
# service when something actually changed.
#
#   sudo bash deploy/install.sh              # install or update
#   sudo bash deploy/install.sh --uninstall  # remove unit and binary
#
# The pieces it assembles (token, unit text) come from the binary itself —
# `pockterm token`, `pockterm unit` — so this script stays readable.
#
# Paths can be overridden, which is also how the test suite exercises this
# script without touching a real system:
#   PREFIX=/tmp/x UNIT_DIR=/tmp/x ENV_FILE=/tmp/x/pockterm.env bash install.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PREFIX:-/usr/local/bin}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
ENV_FILE="${ENV_FILE:-/etc/pockterm/pockterm.env}"
LISTEN="${POCKTERM_LISTEN:-127.0.0.1:8130}"
# Under sudo the interesting account is the one that invoked it: its tmux
# sessions are what the terminal will serve.
RUN_AS="${POCKTERM_USER:-${SUDO_USER:-$(id -un)}}"
BIN="$PREFIX/pockterm"
UNIT="$UNIT_DIR/pockterm.service"

log()  { printf '\033[1;34m[pockterm]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# systemd steps are skipped when there is no systemd, or when the unit is
# being written somewhere else (a test, a container image).
use_systemd() {
	[ "$UNIT_DIR" = "/etc/systemd/system" ] && command -v systemctl >/dev/null
}

uninstall() {
	log "removing pockterm"
	if use_systemd; then
		systemctl disable --now pockterm.service 2>/dev/null || true
	fi
	rm -f "$UNIT" "$BIN"
	use_systemd && systemctl daemon-reload
	ok "unit and binary removed"
	warn "kept $ENV_FILE and your tmux sessions — delete them yourself if you want them gone"
}

# Build from source when a toolchain is present, and only fall back to a
# prebuilt binary when there is none. Trusting whatever sits in bin/ was a
# real bug: a stale build ignores the subcommands this script relies on and
# starts the server instead, which hangs the install.
build_binary() {
	if command -v go >/dev/null; then
		log "building from source" >&2
		(cd "$PROJECT_DIR" && go build -o bin/pockterm ./cmd/pockterm) >&2
		echo "$PROJECT_DIR/bin/pockterm"
		return
	fi
	[ -x "$PROJECT_DIR/bin/pockterm" ] || die "no go toolchain and no prebuilt bin/pockterm"
	warn "no go toolchain — using the prebuilt $PROJECT_DIR/bin/pockterm" >&2
	echo "$PROJECT_DIR/bin/pockterm"
}

main() {
	if [ "${1:-}" = "--uninstall" ]; then
		uninstall
		return
	fi

	local src
	src="$(build_binary)"

	mkdir -p "$PREFIX" "$UNIT_DIR" "$(dirname "$ENV_FILE")"
	install -m755 "$src" "$BIN"
	ok "binary → $BIN"

	# Token: generated once and kept. Regenerating it on every run would
	# invalidate the link already saved on the phone.
	if [ -s "$ENV_FILE" ] && grep -q '^POCKTERM_TOKEN=' "$ENV_FILE"; then
		ok "token kept ($ENV_FILE)"
	else
		# Subshell: the tightened umask must not leak to the unit below,
		# which is meant to be world-readable like every other unit.
		(umask 077; printf 'POCKTERM_TOKEN=%s\n' "$("$BIN" token)" >> "$ENV_FILE")
		chmod 600 "$ENV_FILE"
		ok "token generated → $ENV_FILE (0600)"
	fi

	local rendered
	rendered="$("$BIN" unit --user "$RUN_AS" --listen "$LISTEN" --env-file "$ENV_FILE" --binary "$BIN")"
	if [ -f "$UNIT" ] && [ "$rendered" = "$(cat "$UNIT")" ]; then
		ok "unit unchanged"
	else
		printf '%s' "$rendered" > "$UNIT"
		chmod 644 "$UNIT"
		ok "unit → $UNIT"
		if use_systemd; then
			systemctl daemon-reload
			systemctl enable --now pockterm.service
			systemctl restart pockterm.service
		fi
	fi

	if use_systemd; then
		if systemctl is-active --quiet pockterm.service; then
			ok "service running as $RUN_AS on $LISTEN"
		else
			die "service failed to start — journalctl -u pockterm"
		fi
	else
		warn "systemd steps skipped (UNIT_DIR=$UNIT_DIR)"
	fi

	echo
	log "next: publish it and open the link on your phone"
	echo "  the terminal listens on $LISTEN — put TLS and authentication in front"
	echo "  examples: deploy/nginx-token.conf.example, deploy/nginx-mtls.conf.example"
	echo
	echo "  then show the QR for your phone:"
	echo "    POCKTERM_PUBLIC_URL=https://your.domain sudo -E $BIN qr"
}

main "$@"
