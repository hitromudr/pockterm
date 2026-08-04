#!/usr/bin/env bash
# Proves the shipped build is reproducible: the same source in two different
# directories has to produce the same bytes.
#
# It is the deploy path that needs this. The host installs what CI drops only
# when the bytes differ from what is already running, which is what keeps a
# docs-only push from dropping the terminal its author is sitting in. Without
# reproducibility that guard never fires: go stamps the commit hash and the
# build directory into the binary, so every push looks like a new one — measured
# on 2026-08-04, when a commit touching only CLAUDE.md restarted the unit.
#
# Builds through `make build-arm64` on purpose, so dropping the flags from the
# Makefile fails here rather than silently on the host.
#
#   bash test/repro_test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; exit 1; }

# Two copies under names of different lengths: the build directory is stamped in
# unless -trimpath says otherwise, and equal-length paths would hide that.
A="$WORK/a"
B="$WORK/bbbbbbbbbbbb"

n=0
for d in "$A" "$B"; do
	mkdir -p "$d"
	# Tracked files as they are in the working copy, not as they are at HEAD:
	# what this has to answer is whether the change about to be committed keeps
	# the build reproducible. bin/ and node_modules/ are untracked, so they stay
	# out on their own.
	git -C "$ROOT" ls-files -z | tar -C "$ROOT" --null -T - -cf - | tar -x -C "$d"
	# Each copy gets its own git history, with a different commit in it. Without
	# that the copies have no VCS at all and go has nothing to stamp — so the
	# test would pass with -buildvcs=false removed, which is the very stamp that
	# restarted the unit on a docs-only push.
	n=$((n + 1))
	(
		cd "$d"
		git init -q
		git add -A
		GIT_AUTHOR_DATE="2026-01-0$n 00:00:00 +0000" \
		GIT_COMMITTER_DATE="2026-01-0$n 00:00:00 +0000" \
		git -c user.email=t@example.invalid -c user.name=t commit -qm "copy $n"
	)
done

rev_a="$(git -C "$A" rev-parse HEAD)"
rev_b="$(git -C "$B" rev-parse HEAD)"
[ "$rev_a" != "$rev_b" ] || bad "the two copies must differ in revision for this to prove anything"

echo "building twice (this is two real cross-compiles)"
for d in "$A" "$B"; do
	make -C "$d" build-arm64 >/dev/null || bad "build failed in $d"
done

sum_a="$(sha256sum "$A/bin/pockterm-linux-arm64" | cut -d' ' -f1)"
sum_b="$(sha256sum "$B/bin/pockterm-linux-arm64" | cut -d' ' -f1)"

if [ "$sum_a" != "$sum_b" ]; then
	printf '  %s  %s\n' "$sum_a" "$A"
	printf '  %s  %s\n' "$sum_b" "$B"
	bad "same source, different bytes — the deploy no-op guard is dead"
fi
ok "same source, same bytes (${sum_a:0:16}…)"

# The two stamps that broke it, named so a future reader knows what to look for.
stamps="$(go version -m "$A/bin/pockterm-linux-arm64" 2>/dev/null || true)"
case "$stamps" in
	*vcs.revision*) bad "vcs.revision is stamped in — every commit is new bytes" ;;
esac
ok "no vcs stamp in the binary"

echo "repro: OK"
