#!/usr/bin/env bash
# Verify the exact local assets against a draft or published GitHub Release.

set -euo pipefail

if [[ $# -lt 5 ]]; then
  printf 'usage: %s <draft|published> <tag> <commit-sha> <release-id> <asset>...\n' "$0" >&2
  exit 2
fi

EXPECTED_STATE="$1"
TAG="$2"
EXPECTED_SHA="$3"
EXPECTED_RELEASE_ID="$4"
shift 4

case "$EXPECTED_STATE" in
  draft|published) ;;
  *)
    printf 'unsupported release state: %s\n' "$EXPECTED_STATE" >&2
    exit 2
    ;;
esac

[[ -n "${GH_TOKEN:-}" ]] || {
  printf 'GH_TOKEN is required\n' >&2
  exit 1
}
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'invalid release commit SHA: %s\n' "$EXPECTED_SHA" >&2
  exit 1
}
[[ "$EXPECTED_RELEASE_ID" =~ ^[1-9][0-9]*$ ]] || {
  printf 'invalid GitHub Release ID: %s\n' "$EXPECTED_RELEASE_ID" >&2
  exit 1
}

TAG_SHA="$(git rev-list -n 1 "$TAG")"
[[ "$TAG_SHA" == "$EXPECTED_SHA" ]] || {
  printf 'tag %s resolves to %s, expected %s\n' "$TAG" "$TAG_SHA" "$EXPECTED_SHA" >&2
  exit 1
}

expected='[]'
for asset in "$@"; do
  [[ -s "$asset" ]] || {
    printf 'missing or empty local release asset: %s\n' "$asset" >&2
    exit 1
  }
  name="$(basename "$asset")"
  size="$(stat -c '%s' "$asset")"
  digest="sha256:$(sha256sum "$asset" | awk '{print $1}')"
  expected="$(jq -cn \
    --argjson current "$expected" \
    --arg name "$name" \
    --argjson size "$size" \
    --arg digest "$digest" \
    '$current + [{name:$name,size:$size,digest:$digest,state:"uploaded"}]')"
done

[[ "$(jq -r 'map(.name) | unique | length' <<<"$expected")" == "$#" ]] || {
  printf 'local release asset names are not unique\n' >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
release_json="$(bash "$SCRIPT_DIR/find-github-release.sh" "$TAG")"

jq -e \
  --arg state "$EXPECTED_STATE" \
  --arg tag "$TAG" \
  --arg target_commitish "$EXPECTED_SHA" \
  --argjson release_id "$EXPECTED_RELEASE_ID" \
  --argjson expected "$expected" '
    .id == $release_id and
    .tag_name == $tag and
    .target_commitish == $target_commitish and
    (if $state == "draft" then
      .draft == true and .immutable == false
    else
      .draft == false and .immutable == true
    end) and
    ([.assets[] | {name,size,digest,state}] | sort_by(.name)) ==
      ($expected | sort_by(.name))
  ' <<<"$release_json" >/dev/null || {
    printf 'remote %s release metadata/assets do not match local bytes for %s\n' \
      "$EXPECTED_STATE" "$TAG" >&2
    exit 1
  }

printf 'Verified %s GitHub Release %s and %s assets.\n' "$EXPECTED_STATE" "$TAG" "$#"
