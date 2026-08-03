#!/usr/bin/env bash
# Exercises deploy/pockterm-deploy in temporary paths — no root, no systemd,
# no touching the machine running the test. systemctl and curl are stubs on
# PATH; what the script would have done to the host is read back from the
# files they leave.
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

# curl stub: answers with whatever $PRESENCE_STATE says — a number of visible
# clients, or "down" for a server that does not answer at all.
cat > "$STUB/curl" <<'EOF'
#!/usr/bin/env bash
state="$(cat "$PRESENCE_STATE" 2>/dev/null || echo down)"
[ "$state" = down ] && exit 7
printf '{"clients":%s,"visible":%s}\n' "$state" "$state"
EOF
chmod +x "$STUB/systemctl" "$STUB/curl"

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
		PRESENCE_STATE="$WORK/presence" \
		INCOMING="$INCOMING" KEY_FILE="$KEY" ENV_FILE="$WORK/pockterm.env" \
		BIN="$BIN" BIN_OWNER="$(id -un)" BIN_GROUP="$(id -gn)" \
		"$@" \
		bash "$ROOT/deploy/pockterm-deploy" > "$WORK/out" 2>&1
}

looking() { printf '%s\n' "$1" > "$WORK/presence"; }

# --- nobody is looking: install straight away ---
looking 0
drop first
deploy || bad "the script failed with nobody looking: $(cat "$WORK/out")"
grep -q first "$BIN" || bad "the binary was not installed"
grep -q 'restart pockterm.service' "$WORK/systemctl.log" || bad "the unit was not restarted"
[ -f "$INCOMING/pockterm.new" ] && bad "the drop was left behind"
ok "an empty screen installs the build and restarts the unit"

# --- somebody is looking: park it, do not restart ---
looking 2
drop second
deploy || bad "the script failed while someone was looking: $(cat "$WORK/out")"
grep -q first "$BIN" || bad "the binary changed under an open terminal"
grep -q 'restart' "$WORK/systemctl.log" && bad "the unit was restarted under an open terminal"
[ -f "$INCOMING/pockterm.pending" ] || bad "the build was not parked"
[ -f "$INCOMING/pockterm.new" ] && bad "the trigger file was left for the path unit to loop on"
grep -q 'start pockterm-deploy.timer' "$WORK/systemctl.log" || bad "the retry timer was not started"
ok "an open terminal parks the build and leaves the unit alone"

# --- the viewer leaves: the parked build goes in on the next timer tick ---
looking 0
deploy || bad "the parked build did not install: $(cat "$WORK/out")"
grep -q second "$BIN" || bad "the parked build was not installed"
grep -q 'restart pockterm.service' "$WORK/systemctl.log" || bad "the unit was not restarted"
grep -q 'stop pockterm-deploy.timer' "$WORK/systemctl.log" || bad "the retry timer was not stopped"
[ -f "$INCOMING/pockterm.pending" ] && bad "the parked build was left behind"
ok "the build lands in the first gap, then the timer is stopped"

# --- the same bytes: no restart at all ---
looking 0
drop second
deploy || bad "the script failed on identical bytes: $(cat "$WORK/out")"
grep -q 'restart' "$WORK/systemctl.log" && bad "identical bytes still restarted the unit"
grep -q 'не изменился' "$WORK/out" || bad "the script did not say the binary was unchanged"
ok "a docs-only rebuild drops nobody's terminal"

# --- a forged signature: refuse, and keep the running binary ---
looking 0
drop third
printf 'deadbeef\n' > "$INCOMING/pockterm.new.hmac"
deploy && bad "a forged signature was accepted"
grep -q second "$BIN" || bad "the installed binary was touched by a rejected drop"
[ -f "$INCOMING/pockterm.new" ] && bad "the rejected drop was left to retrigger the path unit"
ok "a drop signed with the wrong key is refused and removed"

# --- waiting too long: install anyway ---
looking 3
drop fourth
deploy || bad "parking failed: $(cat "$WORK/out")"
[ -f "$INCOMING/pockterm.pending" ] || bad "the build was not parked"
# Backdate the wait past the limit; the viewer is still there.
printf '%s\n' "$(( $(date +%s) - 7200 ))" > "$INCOMING/pockterm.pending.since"
deploy FORCE_AFTER=3600 || bad "the overdue build did not install: $(cat "$WORK/out")"
grep -q fourth "$BIN" || bad "the overdue build was not installed"
grep -q 'не дожидаясь паузы' "$WORK/out" || bad "the script did not say why it stopped waiting"
ok "a build waiting past FORCE_AFTER goes in regardless"

# --- the server cannot answer: treat it as a free moment ---
looking down
drop fifth
deploy || bad "the script failed with an unreachable server: $(cat "$WORK/out")"
grep -q fifth "$BIN" || bad "nothing was installed while the server was down"
ok "a server that cannot answer is not a reason to hold a build back"

echo
printf '\033[1;34m[deploy-test]\033[0m all checks passed\n'
