#!/usr/bin/env bash
# Prints the version of the binary this tree builds — MAJOR.MINOR.PATCH, worked
# out from the git history so that nobody bumps a number by hand.
#
# Counting starts at BASE, the last commit numbered by hand (v219), which is
# 1.0.0. Every commit after it that changes what goes into the binary moves the
# number, by the type in its subject:
#
#   feat: …          minor, patch back to 0
#   anything!: …     major (a breaking change, as conventional commits mark it)
#   anything else    patch
#
# A commit that touches only docs, tests or the CI files leaves the number alone.
# That is not tidiness: the host installs what CI drops only when the bytes
# differ from what is running, and the version is stamped into those bytes — a
# number that moved on a docs-only push would restart the terminal its author is
# sitting in.
#
# A tree without BASE in its history (a shallow clone, an exported tarball, the
# copies test/repro_test.sh builds) is 0.0.0-dev rather than a guess.
#
#   tools/version.sh
set -euo pipefail

BASE="${PT_VERSION_BASE:-2e52c26e37e921e80d7571740d257820de333f70}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! git rev-parse -q --verify "$BASE^{commit}" >/dev/null 2>&1 ||
	! git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
	echo "0.0.0-dev"
	exit 0
fi

# What the binary is built from: the Go sources (tests excluded) and the
# embedded web/ tree.
paths=(web cmd internal ':(glob)*.go' go.mod go.sum ':(exclude,glob)**/*_test.go')

major=1 minor=0 patch=0
while IFS= read -r subject; do
	if [[ "$subject" =~ ^[a-z]+(\([^\)]*\))?!: ]]; then
		major=$((major + 1)) minor=0 patch=0
	elif [[ "$subject" =~ ^feat(\([^\)]*\))?: ]]; then
		minor=$((minor + 1)) patch=0
	else
		patch=$((patch + 1))
	fi
done < <(git log --reverse --no-merges --format=%s "$BASE..HEAD" -- "${paths[@]}")

echo "$major.$minor.$patch"
