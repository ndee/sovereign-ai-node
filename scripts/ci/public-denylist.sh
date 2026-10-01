#!/usr/bin/env bash
# Fails when text that must not appear in this public repository shows up in a
# pull request. Scans, case-insensitively:
#   * lines ADDED by the diff (base...head)
#   * the pull request title and body (PR_TITLE / PR_BODY env)
#   * every commit message in base..head
# The pattern lives in .github/public-denylist.pattern, which is excluded from
# the diff scan so this check does not trip on itself.
# Usage: scripts/ci/public-denylist.sh <base-ref> <head-ref>
set -euo pipefail

base="${1:?base ref required}"
head="${2:?head ref required}"
root="$(git rev-parse --show-toplevel)"
pattern_file="${PUBLIC_DENYLIST_PATTERN_FILE:-$root/.github/public-denylist.pattern}"
pattern_rel=".github/public-denylist.pattern"

failed=0
report() {
  echo "::error::denylist match in $1" >&2
  printf '%s\n' "$2" | head -n 20 >&2
  failed=1
}

if hits="$(git diff -U0 --no-color "$base...$head" -- . ":(exclude)$pattern_rel" |
  grep -E '^\+' | grep -vE '^\+\+\+ ' | grep -iEf "$pattern_file")"; then
  report "added diff lines" "$hits"
fi
if hits="$(git log "$base..$head" --format=%B | grep -iEf "$pattern_file")"; then
  report "commit messages" "$hits"
fi
if hits="$(printf '%s\n' "${PR_TITLE:-}" | grep -iEf "$pattern_file")"; then
  report "pull request title" "$hits"
fi
if hits="$(printf '%s\n' "${PR_BODY:-}" | grep -iEf "$pattern_file")"; then
  report "pull request body" "$hits"
fi

if [ "$failed" -ne 0 ]; then
  echo "public-denylist: failed" >&2
  exit 1
fi
echo "public-denylist: clean"
