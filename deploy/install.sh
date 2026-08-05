#!/usr/bin/env bash
# install.sh — install pockterm on this machine: binary, token, systemd unit.
#
# Idempotent: re-running keeps the existing token and only restarts the
# service when something actually changed.
#
#   sudo bash deploy/install.sh              # install or update
#   sudo bash deploy/install.sh --tg         # ...and pair a Telegram bot
#   sudo bash deploy/install.sh --uninstall  # remove unit and binary
#
# The pieces it assembles (token, unit text, the Telegram chat id) come from
# the binary itself — `pockterm token`, `pockterm unit`, `pockterm tg-setup` —
# so this script stays readable.
#
# What it does beyond the binary and the unit is everything a first run needed
# doing by hand afterwards: the Makefile the "+" button starts sessions
# through, POCKTERM_SESSION_DIR pointing at it, and a restart when either
# changed. Each of those was a line in the README, and a phone with no session
# on it is exactly where a README cannot be followed.
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

# Set when the env file gained something the running service has not read, and
# when writing the unit already restarted for us. Together they decide whether
# the install ends in a restart — which drops the terminal somebody may be
# sitting in, so it happens only for a change that would otherwise be invisible
# until the next reboot.
ENV_CHANGED=""
UNIT_RESTARTED=""
WITH_TG=""

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
	warn "kept $ENV_FILE, the session Makefile and your tmux sessions — delete them yourself if you want them gone"
}

# pkg_hint turns a missing tool into the one line that installs it here. The
# distribution is read off the package manager that exists rather than off
# /etc/os-release: derivatives lie about the latter and all of them keep the
# tool.
pkg_hint() {
	if command -v apt-get >/dev/null; then echo "sudo apt-get install -y $1"
	elif command -v dnf >/dev/null; then echo "sudo dnf install -y $1"
	elif command -v pacman >/dev/null; then echo "sudo pacman -S --noconfirm $1"
	elif command -v zypper >/dev/null; then echo "sudo zypper install -y $1"
	elif command -v apk >/dev/null; then echo "sudo apk add $1"
	else echo "install $1 with your package manager"
	fi
}

# check_tools refuses what nothing works without and warns about what one
# feature needs. Neither was checked before, and neither absence announced
# itself: without tmux the phone gets an empty session list, and without make
# the "+" button is quietly off — both look like the terminal being broken
# rather than like a package that was never installed.
#
# The names are overridable because the test has to exercise a missing tool on
# a machine that has it.
check_tools() {
	local tmux_bin make_bin
	tmux_bin="${REQUIRE_TMUX:-tmux}"
	command -v "$tmux_bin" >/dev/null ||
		die "$tmux_bin is not installed — pockterm serves tmux sessions, so there would be nothing to serve: $(pkg_hint "$tmux_bin")"
	make_bin="${REQUIRE_MAKE:-make}"
	if ! command -v "$make_bin" >/dev/null; then
		warn "$make_bin is not installed — the \"+\" button starts sessions through it and stays off: $(pkg_hint "$make_bin")"
	fi
}

# session_root is where the session Makefile goes, and the directory whose
# folders the drawer offers to start a session in. POCKTERM_SESSION_DIR names
# it; the served account's home is the default, because that is where a person
# keeps projects.
session_root() {
	local home
	if [ -n "${POCKTERM_SESSION_DIR:-}" ]; then
		printf '%s' "$POCKTERM_SESSION_DIR"
		return
	fi
	home="$(getent passwd "$RUN_AS" 2>/dev/null | cut -d: -f6 || true)"
	printf '%s' "${home:-$HOME}"
}

# install_sessions puts the example Makefile in the projects root and points
# POCKTERM_SESSION_DIR at it, which is how the "+" button comes to work without
# anyone having read the README: copy the file, edit it, set the variable,
# restart — four steps, and the moment they are wanted is the moment a phone has
# no session to open and no way to start one.
#
# Two things it will not do. It never overwrites a Makefile it did not write:
# `make claude` in somebody else's Makefile is an unknown command, not a
# session. And it never changes a POCKTERM_SESSION_DIR that is already in the
# env file — that value was chosen by a person.
install_sessions() {
	local root src existing f
	if [ -n "${POCKTERM_NO_SESSIONS:-}" ]; then
		ok "session Makefile skipped (POCKTERM_NO_SESSIONS)"
		return
	fi
	root="$(session_root)"
	src="$PROJECT_DIR/deploy/sessions.mk.example"
	# `off` is what the server reads as "do not let the page start sessions", so
	# it is an answer here too rather than a directory that happens not to exist.
	if [ "$root" = off ]; then
		ok "sessions are off (POCKTERM_SESSION_DIR=off) — no Makefile installed"
		return
	fi
	if [ ! -d "$root" ]; then
		warn "$root does not exist — no session Makefile installed, so the \"+\" button stays off"
		return
	fi
	if [ ! -f "$src" ]; then
		warn "$src is missing — no session Makefile installed, so the \"+\" button stays off"
		return
	fi

	existing=""
	# make reads the first of these that exists, so all three have to be looked
	# at: writing Makefile next to a GNUmakefile would install a file make never
	# reads and report success.
	for f in GNUmakefile makefile Makefile; do
		if [ -f "$root/$f" ]; then existing="$root/$f"; break; fi
	done
	if [ -n "$existing" ]; then
		# The marker is in the example's header, so a copy the owner has since
		# edited is still recognised as ours — the file is meant to be edited.
		if grep -q 'pockterm-sessions' "$existing"; then
			ok "session Makefile already at $existing (yours to edit — kept)"
		else
			warn "$existing is not pockterm's — leaving it, and POCKTERM_SESSION_DIR, alone"
			warn "  for the \"+\" button: add the targets from $src to it, or point"
			warn "  POCKTERM_SESSION_DIR at another directory, then restart the service"
			return
		fi
	else
		install -m644 "$src" "$root/Makefile"
		if [ "$(id -u)" = 0 ]; then chown "$RUN_AS" "$root/Makefile" || true; fi
		ok "session Makefile → $root/Makefile (point CLAUDE in it at a wrapper to sandbox sessions)"
	fi

	if grep -q '^POCKTERM_SESSION_DIR=' "$ENV_FILE" 2>/dev/null; then
		ok "POCKTERM_SESSION_DIR kept ($ENV_FILE)"
	else
		(umask 077; printf 'POCKTERM_SESSION_DIR=%s\n' "$root" >> "$ENV_FILE")
		chmod 600 "$ENV_FILE"
		ok "POCKTERM_SESSION_DIR=$root → $ENV_FILE"
		ENV_CHANGED=1
	fi
}

# pair_telegram runs the pairing the binary already knows how to do, in the
# install rather than after it: on its own it is a second command plus a
# service restart, and the restart is the half people leave out.
pair_telegram() {
	echo
	log "telegram: make a bot with @BotFather, write anything to it, then answer here"
	if "$BIN" tg-setup --write "$ENV_FILE"; then
		ENV_CHANGED=1
		ok "telegram configured in $ENV_FILE"
	else
		warn "telegram is not configured — when the bot is ready: sudo $BIN tg-setup --write $ENV_FILE"
	fi
}

# Build from source when a toolchain is present, and only fall back to a
# prebuilt binary when there is none. Trusting whatever sits in bin/ was a
# real bug: a stale build ignores the subcommands this script relies on and
# starts the server instead, which hangs the install.
build_binary() {
	if [ -n "${POCKTERM_FROM_RELEASE:-}" ]; then
		fetch_release
		return
	fi
	if command -v go >/dev/null; then
		log "building from source" >&2
		(cd "$PROJECT_DIR" && go build -o bin/pockterm ./cmd/pockterm) >&2
		echo "$PROJECT_DIR/bin/pockterm"
		return
	fi
	if [ -x "$PROJECT_DIR/bin/pockterm" ]; then
		warn "no go toolchain — using the prebuilt $PROJECT_DIR/bin/pockterm" >&2
		echo "$PROJECT_DIR/bin/pockterm"
		return
	fi
	log "no go toolchain — taking the published build instead" >&2
	fetch_release
}

# fetch_release downloads a published binary for this architecture and checks
# it against the release's SHA256SUMS. Without this, installing starts with
# apt-getting a Go toolchain onto a machine that only needs to run one binary.
fetch_release() {
	local arch asset tmp base
	case "$(uname -m)" in
		x86_64 | amd64) arch=amd64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*) die "no published build for $(uname -m) — install go and re-run to build from source" ;;
	esac
	command -v curl >/dev/null || die "curl is needed to download a release (or install go and build from source)"
	base="${POCKTERM_RELEASE_BASE:-https://github.com/hitromudr/pockterm/releases/latest/download}"
	asset="pockterm-linux-$arch"
	tmp="$(mktemp -d)"

	log "downloading $asset" >&2
	curl -fsSL "$base/$asset" -o "$tmp/$asset" ||
		die "could not download $base/$asset"
	curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
		die "could not download $base/SHA256SUMS — refusing to install an unverified binary"
	# --ignore-missing: the file lists every architecture, only one was fetched.
	# Without --status the mismatch prints the sum, which says nothing useful.
	(cd "$tmp" && sha256sum --check --ignore-missing --status SHA256SUMS) ||
		die "checksum mismatch for $asset — the download is not what the release published"
	chmod +x "$tmp/$asset"
	ok "downloaded and verified $asset" >&2
	echo "$tmp/$asset"
}

main() {
	while [ $# -gt 0 ]; do
		case "$1" in
			--uninstall) uninstall; return ;;
			--tg) WITH_TG=1 ;;
			-h | --help)
				sed -n '2,20p' "${BASH_SOURCE[0]}"
				return
				;;
			*) die "unknown option: $1 (try --help)" ;;
		esac
		shift
	done

	check_tools

	local src
	src="$(build_binary)"

	mkdir -p "$PREFIX" "$UNIT_DIR" "$(dirname "$ENV_FILE")"
	install -m755 "$src" "$BIN"
	ok "binary → $BIN"

	# Token: generated once and kept. Regenerating it on every run would
	# invalidate the link already saved on the phone.
	#
	# Behind mutual TLS the token is not a second lock but a third wheel: the
	# certificate already decides who gets in, and a token the reverse proxy
	# does not know about turns every link without it into a 401 — which
	# looks, from the browser, exactly like a machine with no sessions.
	if [ -n "${POCKTERM_NO_TOKEN:-}" ]; then
		if [ -s "$ENV_FILE" ] && grep -q '^POCKTERM_TOKEN=' "$ENV_FILE"; then
			warn "POCKTERM_NO_TOKEN set, but $ENV_FILE already has a token — leaving it alone"
		else
			ok "no token generated (POCKTERM_NO_TOKEN)"
		fi
	elif [ -s "$ENV_FILE" ] && grep -q '^POCKTERM_TOKEN=' "$ENV_FILE"; then
		ok "token kept ($ENV_FILE)"
	else
		# Subshell: the tightened umask must not leak to the unit below,
		# which is meant to be world-readable like every other unit.
		(umask 077; printf 'POCKTERM_TOKEN=%s\n' "$("$BIN" token)" >> "$ENV_FILE")
		chmod 600 "$ENV_FILE"
		ok "token generated → $ENV_FILE (0600)"
		ENV_CHANGED=1
	fi

	install_sessions

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
			UNIT_RESTARTED=1
		fi
	fi

	if [ -n "$WITH_TG" ]; then
		pair_telegram
	fi

	# systemd reads the env file when the service starts, so anything added to
	# it above is not in effect yet. Only then, though: a restart drops every
	# open terminal, and an install that changed nothing must cost nobody a
	# reconnect.
	if [ -n "$ENV_CHANGED" ] && [ -z "$UNIT_RESTARTED" ] && use_systemd; then
		systemctl restart pockterm.service
		ok "service restarted to pick up $ENV_FILE"
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
	show_link
}

# show_link ends the install with something to point a camera at, rather than
# with homework. Which link depends on where the service listens:
#
#   PUBLIC_URL given   the real address, TLS in front — the end state
#   wildcard listen    this machine on the local network, over plain HTTP
#   loopback           nothing to scan; say how to get a phone on it instead
#
# The local-network case is a first run, not a deployment: the token keeps
# strangers on the Wi-Fi out, but the traffic is not encrypted, which is why
# the TLS examples still get printed.
show_link() {
	local token url
	# No env file at all is a normal state here (POCKTERM_NO_TOKEN), and sed
	# exits 2 over a missing file — which would end the install on its last
	# line, after everything already succeeded.
	token="$(sed -n 's/^POCKTERM_TOKEN=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)"

	if [ -n "${POCKTERM_PUBLIC_URL:-}" ]; then
		log "open this on your phone"
		POCKTERM_PUBLIC_URL="$POCKTERM_PUBLIC_URL" POCKTERM_TOKEN="$token" "$BIN" qr
		return
	fi

	if [ "${LISTEN%%:*}" = "0.0.0.0" ] || [ "${LISTEN#:}" != "$LISTEN" ]; then
		log "open this on your phone — same Wi-Fi, no TLS yet"
		if ! POCKTERM_LISTEN="$LISTEN" POCKTERM_TOKEN="$token" "$BIN" qr; then
			warn "could not work out this machine's address — run: $BIN qr http://<address>:${LISTEN##*:}"
		fi
		echo
		echo "  plain HTTP over your own network is fine to try it; before it lives"
		echo "  anywhere permanent, put TLS in front:"
		echo "    deploy/nginx-token.conf.example, deploy/nginx-mtls.conf.example"
		return
	fi

	log "the terminal is up, and reachable only from this machine"
	url="http://$LISTEN/"
	if [ -n "$token" ]; then
		url="$url?token=$token"
	fi
	echo "  here: $url"
	echo
	echo "  to try it from your phone on the same network, listen wider:"
	echo "    sudo POCKTERM_LISTEN=0.0.0.0:${LISTEN##*:} bash deploy/install.sh"
	echo "  the installer then prints a QR code to scan."
	echo
	echo "  for anything permanent, put TLS and authentication in front:"
	echo "    deploy/nginx-token.conf.example, deploy/nginx-mtls.conf.example"
	echo "    then: POCKTERM_PUBLIC_URL=https://your.domain sudo -E $BIN qr"
}

main "$@"
