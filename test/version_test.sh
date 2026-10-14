#!/usr/bin/env bash
# Exercises tools/version.sh against a throwaway history: which commits move
# the number, and by how much.
#
#   bash test/version_test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; exit 1; }

R="$WORK/repo"
mkdir -p "$R/tools" "$R/web" "$R/internal" "$R/docs" "$R/test"
cp "$ROOT/tools/version.sh" "$R/tools/"
cd "$R"
git init -q
g() { git -c user.email=t@example.invalid -c user.name=t "$@"; }

# commit <subject> <file>: changes the file and commits it under the subject.
commit() {
	echo "$RANDOM$RANDOM" >> "$2"
	git add -A
	g commit -qm "$1"
}
expect() {
	local got
	got="$(PT_VERSION_BASE="$BASE" tools/version.sh)"
	[ "$got" = "$1" ] || bad "$2: got $got, want $1"
	ok "$2 → $1"
}

commit "chore: base" web/app.js
[ "$(tools/version.sh)" = "0.0.0-dev" ] || bad "a history without the default base is not 0.0.0-dev"
ok "history without the base → 0.0.0-dev"
BASE="$(git rev-parse HEAD)"

expect 1.0.0 "the base itself"
commit "docs: notes" docs/notes.md
expect 1.0.0 "docs-only commit"
commit "fix: something" test/case.test.mjs
expect 1.0.0 "tests-only commit, whatever its type"
commit "fix: in a test file" internal/x_test.go
expect 1.0.0 "a Go test file"
commit "fix: the server" internal/x.go
expect 1.0.1 "fix in the sources"
commit "refactor(web): tidy" web/app.js
expect 1.0.2 "any other type"
commit "feat(web): a button" web/app.js
expect 1.1.0 "feat"
commit "fix: after it" main.go
expect 1.1.1 "root .go file"
commit "feat!: drop the old socket" internal/x.go
expect 2.0.0 "breaking change"
commit "fix: go.sum" go.sum
expect 2.0.1 "go.sum"

# A branch merged in counts by its commits, not by the merge.
git checkout -q -b side
commit "feat: on a branch" web/side.js
git checkout -q -
commit "fix: on main" web/app.js
g merge -q --no-edit side
expect 2.1.1 "merge counts the merged commits only"
