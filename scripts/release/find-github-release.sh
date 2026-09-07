#!/usr/bin/env bash
# Resolve exactly one GitHub Release by tag, including draft releases.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <tag>\n' "$0" >&2
  exit 2
fi

TAG="$1"

[[ -n "${GH_TOKEN:-}" ]] || {
  printf 'GH_TOKEN is required\n' >&2
  exit 1
}
[[ "${GITHUB_REPOSITORY:-}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || {
  printf 'GITHUB_REPOSITORY must be owner/repository\n' >&2
  exit 1
}

# GET /releases/tags/{tag} does not return drafts. List every page instead,
# validate the response shape, and require one exact tag_name match. Capture the
# API output first so an API/authentication failure cannot look like zero matches.
pages_file="$(mktemp --tmpdir github-releases.XXXXXX)"
trap 'rm -f "$pages_file"' EXIT
if ! gh api --paginate \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$GITHUB_REPOSITORY/releases?per_page=100" >"$pages_file"; then
  printf 'failed to list GitHub releases for %s\n' "$GITHUB_REPOSITORY" >&2
  exit 3
fi
if ! matches="$(jq -cs --arg tag "$TAG" '
  [
    .[] |
    if type == "array" then .[]
    else error("GitHub releases response was not an array")
    end |
    select(.tag_name == $tag)
  ]
' "$pages_file")"; then
  printf 'invalid GitHub releases response for %s\n' "$GITHUB_REPOSITORY" >&2
  exit 3
fi

match_count="$(jq -r 'length' <<<"$matches")"
if [[ "$match_count" == "0" ]]; then
  printf 'release %s does not exist\n' "$TAG" >&2
  exit 4
fi
if [[ "$match_count" != "1" ]]; then
  printf 'release %s is ambiguous: %s matches\n' "$TAG" "$match_count" >&2
  exit 5
fi

jq -c '.[0]' <<<"$matches"
