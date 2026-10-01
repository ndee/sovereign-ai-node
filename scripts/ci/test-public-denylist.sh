#!/usr/bin/env bash
# Proves scripts/ci/public-denylist.sh fails on a sample hit in each scanned
# place and passes on clean input. Sample words are assembled from fragments so
# this file never matches the pattern itself.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/public-denylist.sh"
pattern="$here/../../.github/public-denylist.pattern"
bad="cat""house"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q -b main .
git config user.email t@example.invalid
git config user.name t
mkdir -p .github
cp "$pattern" .github/public-denylist.pattern
echo base >a.txt
git add -A && git commit -qm base
base="$(git rev-parse HEAD)"

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_pass() { PR_TITLE="${2:-t}" PR_BODY="${3:-b}" "$script" "$base" HEAD >/dev/null 2>&1 || fail "$1 should pass"; }
expect_fail() { if PR_TITLE="${2:-t}" PR_BODY="${3:-b}" "$script" "$base" HEAD >/dev/null 2>&1; then fail "$1 should fail"; fi; }

git checkout -qb clean
echo "hello" >a.txt && git commit -qam "chore: tidy"
expect_pass "clean input"
expect_fail "title hit" "fix $bad"
expect_fail "body hit" "t" "mentions $bad"

git checkout -qb diffhit "$base"
echo "host $bad" >a.txt && git commit -qam "chore: tidy"
expect_fail "added-line hit"

git checkout -qb removedonly "$base"
echo "host $bad" >a.txt && git commit -qam "chore: tidy" && base2="$(git rev-parse HEAD)"
echo "ok" >a.txt && git commit -qam "chore: tidy"
base="$base2" expect_pass "removed lines are not scanned"
base="$(git rev-parse "$base2"~1)"

git checkout -qb msghit "$base"
echo x >b.txt && git add b.txt && git commit -qm "chore: $bad"
expect_fail "commit-message hit"

git checkout -qb patternfile "$base"
echo "$bad" >>.github/public-denylist.pattern
git commit -qam "chore: pattern"
expect_pass "pattern file is excluded from the scan"
echo "public-denylist: self-test passed"
