#!/usr/bin/env bash
# Contract tests for draft-aware GitHub Release lookup and staged verification.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOKUP="$REPO_ROOT/scripts/release/find-github-release.sh"
WORK_DIR="$(mktemp -d --tmpdir github-release-lookup.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/bin"
cat >"$WORK_DIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "$1" == "api" && "$2" == "--paginate" ]] || {
  printf 'unexpected gh invocation: %s\n' "$*" >&2
  exit 64
}

if [[ "${MOCK_GH_FAILURE:-false}" == "true" ]]; then
  printf 'mock GitHub API failure\n' >&2
  exit 17
fi

cat "$MOCK_GH_PAGES"
EOF
chmod 0755 "$WORK_DIR/bin/gh"

export GH_TOKEN=test-token
export GITHUB_REPOSITORY=example/project
export PATH="$WORK_DIR/bin:$PATH"

cat >"$WORK_DIR/pages.json" <<'EOF'
[{"id":11,"tag_name":"v1.2.3","draft":false},{"id":12,"tag_name":"v1.2.30","draft":false}]
[{"id":22,"tag_name":"v2.4.0","draft":true}]
EOF
export MOCK_GH_PAGES="$WORK_DIR/pages.json"

published_json="$(bash "$LOOKUP" v1.2.3)"
jq -e '.id == 11 and .draft == false and .tag_name == "v1.2.3"' \
  <<<"$published_json" >/dev/null

draft_json="$(bash "$LOOKUP" v2.4.0)"
jq -e '.id == 22 and .draft == true' <<<"$draft_json" >/dev/null

set +e
bash "$LOOKUP" v9.9.9 >"$WORK_DIR/missing.out" 2>"$WORK_DIR/missing.err"
missing_status=$?
set -e
[[ "$missing_status" == "4" ]] || {
  printf 'missing release returned %s instead of 4\n' "$missing_status" >&2
  exit 1
}
grep -q 'does not exist' "$WORK_DIR/missing.err"

cat >"$WORK_DIR/duplicate-pages.json" <<'EOF'
[{"id":31,"tag_name":"v3.0.0","draft":true}]
[{"id":32,"tag_name":"v3.0.0","draft":false}]
EOF
export MOCK_GH_PAGES="$WORK_DIR/duplicate-pages.json"
set +e
bash "$LOOKUP" v3.0.0 >"$WORK_DIR/duplicate.out" 2>"$WORK_DIR/duplicate.err"
duplicate_status=$?
set -e
[[ "$duplicate_status" == "5" ]] || {
  printf 'ambiguous release returned %s instead of 5\n' "$duplicate_status" >&2
  exit 1
}
grep -q 'is ambiguous: 2 matches' "$WORK_DIR/duplicate.err"

export MOCK_GH_FAILURE=true
set +e
bash "$LOOKUP" v1.2.3 >"$WORK_DIR/api-failure.out" 2>"$WORK_DIR/api-failure.err"
api_status=$?
set -e
[[ "$api_status" == "3" ]] || {
  printf 'GitHub API failure returned %s instead of 3\n' "$api_status" >&2
  exit 1
}
grep -q 'mock GitHub API failure' "$WORK_DIR/api-failure.err"
grep -q 'failed to list GitHub releases' "$WORK_DIR/api-failure.err"
unset MOCK_GH_FAILURE

printf '{}\n' >"$WORK_DIR/malformed-pages.json"
export MOCK_GH_PAGES="$WORK_DIR/malformed-pages.json"
set +e
bash "$LOOKUP" v1.2.3 >"$WORK_DIR/malformed.out" 2>"$WORK_DIR/malformed.err"
malformed_status=$?
set -e
[[ "$malformed_status" == "3" ]] || {
  printf 'malformed response returned %s instead of 3\n' "$malformed_status" >&2
  exit 1
}
grep -q 'response was not an array' "$WORK_DIR/malformed.err"
grep -q 'invalid GitHub releases response' "$WORK_DIR/malformed.err"

# The workflow stages these two files before checking out the older release
# tag. Exercise that staged pair to prove recovery keeps the corrected lookup.
TOOL_DIR="$WORK_DIR/release-tooling"
install -d -m 0755 "$TOOL_DIR"
install -m 0755 \
  "$REPO_ROOT/scripts/release/find-github-release.sh" \
  "$REPO_ROOT/scripts/release/verify-github-assets.sh" \
  "$TOOL_DIR/"

FIXTURE_REPO="$WORK_DIR/release-repo"
git init -q -b main "$FIXTURE_REPO"
git -C "$FIXTURE_REPO" config user.name 'Release Test'
git -C "$FIXTURE_REPO" config user.email release-test@example.invalid
printf 'release source\n' >"$FIXTURE_REPO/source.txt"
git -C "$FIXTURE_REPO" add source.txt
git -C "$FIXTURE_REPO" commit -q -m 'release fixture'

asset="$WORK_DIR/example.tgz"
printf 'release asset\n' >"$asset"
asset_size="$(stat -c '%s' "$asset")"
asset_digest="sha256:$(sha256sum "$asset" | awk '{print $1}')"
tag="v7.8.9"
tag_sha="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
git -C "$FIXTURE_REPO" tag "$tag"
jq -cn \
  --arg tag "$tag" \
  --arg sha "$tag_sha" \
  --arg name "$(basename "$asset")" \
  --argjson size "$asset_size" \
  --arg digest "$asset_digest" \
  '[{id:22,tag_name:$tag,target_commitish:$sha,draft:true,immutable:false,assets:[{name:$name,size:$size,digest:$digest,state:"uploaded"}]}]' \
  >"$WORK_DIR/staged-pages.json"
export MOCK_GH_PAGES="$WORK_DIR/staged-pages.json"

(
  cd "$FIXTURE_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" draft "$tag" "$tag_sha" 22 "$asset"
)

if (
  cd "$FIXTURE_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" draft "$tag" "$tag_sha" 23 "$asset"
) >/dev/null 2>&1; then
  printf 'verifier accepted the wrong release ID\n' >&2
  exit 1
fi

jq --arg sha '0000000000000000000000000000000000000000' \
  '.[0].target_commitish = $sha' "$WORK_DIR/staged-pages.json" \
  >"$WORK_DIR/wrong-target-pages.json"
export MOCK_GH_PAGES="$WORK_DIR/wrong-target-pages.json"
if (
  cd "$FIXTURE_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" draft "$tag" "$tag_sha" 22 "$asset"
) >/dev/null 2>&1; then
  printf 'verifier accepted the wrong target commit\n' >&2
  exit 1
fi

export MOCK_GH_PAGES="$WORK_DIR/staged-pages.json"
jq '.[0].draft = null' "$WORK_DIR/staged-pages.json" \
  >"$WORK_DIR/invalid-draft-pages.json"
export MOCK_GH_PAGES="$WORK_DIR/invalid-draft-pages.json"
if (
  cd "$FIXTURE_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" draft "$tag" "$tag_sha" 22 "$asset"
) >/dev/null 2>&1; then
  printf 'verifier accepted an invalid draft state\n' >&2
  exit 1
fi

jq '.[0].target_commitish = "'"$tag_sha"'" | .[0].draft = false | .[0].immutable = true' \
  "$WORK_DIR/staged-pages.json" >"$WORK_DIR/published-pages.json"
export MOCK_GH_PAGES="$WORK_DIR/published-pages.json"
(
  cd "$FIXTURE_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" published "$tag" "$tag_sha" 22 "$asset"
)

printf 'GitHub release lookup contract passed.\n'
