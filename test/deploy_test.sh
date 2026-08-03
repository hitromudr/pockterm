#!/usr/bin/env bash
# Exercises deploy/pockterm-deploy in temporary paths — no root, no systemd,
# no touching the machine running the test. systemctl is a stub on PATH; what
# the script would have done to the host is read back from the files it leaves.
#
#   bash test/deploy_test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; exit 1; }

INCOMING="$WORK/incoming"
BIN="$WORK/bin/pockterm"
KEY="$WORK/deploy-hmac.key"
STUB="$WORK/stub"
mkdir -p "$INCOMING" "$WORK/bin" "$STUB"

printf 'test-key\n' > "$KEY"

# systemctl stub: records every call, and reports the unit as running.
cat > "$STUB/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
[ "${1:-}" = "is-active" ] && exit 0
exit 0
EOF
chmod +x "$STUB/systemctl"

# A "binary" that runs and answers --help, like the real one is checked to.
make_build() { printf '#!/bin/sh\necho %s\n' "$1" > "$WORK/build"; chmod +x "$WORK/build"; }

sign() { openssl dgst -sha256 -hmac "$(cat "$KEY")" -r "$1" | cut -d' ' -f1; }

drop() { # drop <marker> — put a signed build in the incoming directory
	make_build "$1"
	cp "$WORK/build" "$INCOMING/pockterm.new"
	sign "$INCOMING/pockterm.new" > "$INCOMING/pockterm.new.hmac"
}

deploy() { # deploy [extra env...] — run the script under test
	: > "$WORK/systemctl.log"
	env PATH="$STUB:$PATH" \
		SYSTEMCTL_LOG="$WORK/systemctl.log" \
		INCOMING="$INCOMING" KEY_FILE="$KEY" \
		BIN="$BIN" BIN_OWNER="$(id -un)" BIN_GROUP="$(id -gn)" \
		"$@" \
		bash "$ROOT/deploy/pockterm-deploy" > "$WORK/out" 2>&1
}

# --- a build arrives: it goes in ---
drop first
deploy || bad "the script failed on a fresh drop: $(cat "$WORK/out")"
grep -q first "$BIN" || bad "the binary was not installed"
grep -q 'restart pockterm.service' "$WORK/systemctl.log" || bad "the unit was not restarted"
[ -f "$INCOMING/pockterm.new" ] && bad "the drop was left behind"
ok "a build installs as soon as it arrives"

# --- somebody is looking: it still goes in ---
#
# This is the change the scheme is about. The install used to wait for an empty
# screen, which cost a parked build, a retry timer and a line in the menu
# explaining the wait — and the person waiting for the fix was the one holding
# it up. A restart costs a reconnect; the tmux session behind it is untouched.
drop second
deploy || bad "the script failed with a terminal open: $(cat "$WORK/out")"
grep -q second "$BIN" || bad "the build waited for the terminal to be free"
grep -q 'restart pockterm.service' "$WORK/systemctl.log" || bad "the unit was not restarted"
grep -q 'pockterm-deploy.timer' "$WORK/systemctl.log" && bad "the retry timer is back"
[ -f "$INCOMING/pockterm.pending" ] && bad "the build was parked"
ok "an open terminal is no longer a reason to hold a build back"

# --- the same bytes: no restart at all ---
drop second
deploy || bad "the script failed on identical bytes: $(cat "$WORK/out")"
grep -q 'restart' "$WORK/systemctl.log" && bad "identical bytes still restarted the unit"
grep -q 'не изменился' "$WORK/out" || bad "the script did not say the binary was unchanged"
ok "a docs-only rebuild drops nobody's terminal"

# --- a forged signature: refuse, and keep the running binary ---
drop third
printf 'deadbeef\n' > "$INCOMING/pockterm.new.hmac"
deploy && bad "a forged signature was accepted"
grep -q second "$BIN" || bad "the installed binary was touched by a rejected drop"
[ -f "$INCOMING/pockterm.new" ] && bad "the rejected drop was left to retrigger the path unit"
ok "a drop signed with the wrong key is refused and removed"

# --- nothing to do ---
deploy || bad "an empty directory made the script fail: $(cat "$WORK/out")"
grep -q 'нечего ставить' "$WORK/out" || bad "the script did not say there was nothing to install"
grep -q 'restart' "$WORK/systemctl.log" && bad "a restart with nothing to install"
ok "a trigger with nothing behind it is a no-op"

# --- a build parked by the previous scheme ---
#
# It is dropped, not installed: it is older than whatever arrives next, and ten
# megabytes of it sit in a directory mounted into a job container.
make_build parked
cp "$WORK/build" "$INCOMING/pockterm.pending"
sign "$INCOMING/pockterm.pending" > "$INCOMING/pockterm.pending.hmac"
date +%s > "$INCOMING/pockterm.pending.since"
drop sixth
deploy || bad "a leftover parked build broke the install: $(cat "$WORK/out")"
grep -q sixth "$BIN" || bad "the arriving build was not installed"
[ -f "$INCOMING/pockterm.pending" ] && bad "the parked build was left behind"
[ -f "$INCOMING/pockterm.pending.since" ] && bad "the parking timestamp was left behind"
ok "what the parking scheme left behind is cleaned up"

echo
printf '\033[1;34m[deploy-test]\033[0m all checks passed\n'
