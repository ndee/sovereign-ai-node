#!/usr/bin/env bash
# Contract tests for the pending-release-PR check that runs before Release
# Please: it may only let Release Please create a release when every merged,
# still-pending release PR was merged at the CI-validated main commit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/release/check-pending-release-pr.sh"
WORK_DIR="$(mktemp -d --tmpdir check-pending-release-pr.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

VALIDATED=1111111111111111111111111111111111111111
OTHER=2222222222222222222222222222222222222222
RELEASE_BRANCH=release-please--branches--main--components--sovereign-ai-node

mkdir -p "$WORK_DIR/bin" "$WORK_DIR/pulls"
cat >"$WORK_DIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "$1" == "api" ]] || exit 64
args="$*"
jq_filter=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--jq" ]]; then jq_filter="$2"; shift; fi
  shift
done
case "$args" in
  *"issues?state=closed&labels=autorelease%3A%20pending&per_page=100"*)
    [[ "${MOCK_LIST_FAILURE:-false}" != "true" ]] || exit 17
    jq -r "$jq_filter" "$MOCK_ISSUES"
    ;;
  *repos/example/project/pulls/*)
    number="${args##*pulls/}"
    number="${number%% *}"
    [[ "${MOCK_PULL_FAILURE:-}" != "$number" ]] || exit 17
    # Like GitHub: API version 2026-03-10 omits merge_commit_sha from pulls.
    case "$args" in
      *"X-GitHub-Api-Version: 2022-11-28"*) shape='.' ;;
      *"X-GitHub-Api-Version: 2026-03-10"*) shape='del(.merge_commit_sha)' ;;
      *) printf 'unexpected API version: %s\n' "$args" >&2; exit 64 ;;
    esac
    jq "$shape" "$MOCK_PULLS/$number.json" | jq -r "$jq_filter"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$args" >&2; exit 64 ;;
esac
EOF
chmod 0755 "$WORK_DIR/bin/gh"

export PATH="$WORK_DIR/bin:$PATH"
export GH_TOKEN=test-token
export GITHUB_REPOSITORY=example/project
export MOCK_ISSUES="$WORK_DIR/issues.json"
export MOCK_PULLS="$WORK_DIR/pulls"

# issues <number>... : closed issues/PRs carrying the pending label; numbers
# prefixed with "u" are closed without merging, "i" are plain issues.
issues() {
  local entry out='[]'
  for entry in "$@"; do
    case "$entry" in
      u*) out="$(jq --argjson n "${entry#u}" '. + [{number: $n, pull_request: {merged_at: null}}]' <<<"$out")" ;;
      i*) out="$(jq --argjson n "${entry#i}" '. + [{number: $n}]' <<<"$out")" ;;
      *) out="$(jq --argjson n "$entry" '. + [{number: $n, pull_request: {merged_at: "2026-10-21T15:44:38Z"}}]' <<<"$out")" ;;
    esac
  done
  printf '%s\n' "$out" >"$MOCK_ISSUES"
}

# pull <number> <merge-sha> [head-ref] [base-ref] [merged]
# A merge-sha of "" omits the field, "null" sends it as null.
pull() {
  jq -n \
    --argjson number "$1" \
    --arg sha "$2" \
    --arg head "${3:-$RELEASE_BRANCH}" \
    --arg base "${4:-main}" \
    --argjson merged "${5:-true}" \
    '{number: $number, state: "closed", merged: $merged,
      merged_at: (if $merged then "2026-10-21T15:44:38Z" else null end),
      base: {ref: $base}, head: {ref: $head}}
     + (if $sha == "" then {} elif $sha == "null" then {merge_commit_sha: null}
        else {merge_commit_sha: $sha} end)' \
    >"$MOCK_PULLS/$1.json"
}

run_check() {
  local label="$1"
  export GITHUB_OUTPUT="$WORK_DIR/$label.output"
  if [[ "${NO_STEP_SUMMARY:-false}" == "true" ]]; then
    unset GITHUB_STEP_SUMMARY
  else
    export GITHUB_STEP_SUMMARY="$WORK_DIR/$label.summary"
  fi
  : >"$GITHUB_OUTPUT"
  set +e
  bash "$CHECK" "${CHECK_SHA:-$VALIDATED}" >"$WORK_DIR/$label.out" 2>"$WORK_DIR/$label.err"
  status=$?
  set -e
}

expect_decision() {
  local label="$1" want="$2"
  run_check "$label"
  [[ "$status" == "0" ]] || {
    printf '%s: check exited %s:\n' "$label" "$status" >&2
    cat "$WORK_DIR/$label.err" >&2
    exit 1
  }
  [[ "$(cat "$GITHUB_OUTPUT")" == "proceed=$want" ]] || {
    printf '%s: expected proceed=%s, got: %s\n' "$label" "$want" "$(cat "$GITHUB_OUTPUT")" >&2
    exit 1
  }
}

expect_error() {
  local label="$1"
  run_check "$label"
  [[ "$status" != "0" ]] || {
    printf '%s: check unexpectedly succeeded\n' "$label" >&2
    exit 1
  }
  [[ ! -s "$GITHUB_OUTPUT" ]] || {
    printf '%s: a failed check must not record a decision\n' "$label" >&2
    exit 1
  }
}

# Nothing pending: Release Please may run (it can only open or update a PR).
issues
expect_decision none_pending true
grep -q 'No merged release PR is pending' "$WORK_DIR/none_pending.out"

# The release PR was merged at the validated main commit: release proceeds.
issues 314
pull 314 "$VALIDATED"
expect_decision merged_at_validated_main true
grep -q 'matches validated main' "$WORK_DIR/merged_at_validated_main.out"

# The merged release PR is older than the validated main: hold, no release.
pull 314 "$OTHER"
expect_decision merged_at_older_commit false
grep -q "^::warning::Release held: merged release PR #314 merged at $OTHER but CI validated main $VALIDATED\. Release Please did not run, so no tag or draft release was created\." \
  "$WORK_DIR/merged_at_older_commit.out"
grep -q '^Release held: merged release PR #314' "$WORK_DIR/merged_at_older_commit.summary"

# A merge commit that cannot be read fails closed, distinct from a mismatch.
expect_unreadable_merge_sha() {
  local label="$1" shown="$2"
  expect_error "$label"
  grep -qF "::error::Release held: cannot read the merge commit of merged release PR #314 (merge_commit_sha: $shown). Release Please did not run, so no tag or draft release was created." \
    "$WORK_DIR/$label.out"
  grep -qF 'Release held: cannot read the merge commit of merged release PR #314' \
    "$WORK_DIR/$label.summary"
  ! grep -q 'but CI validated main' "$WORK_DIR/$label.out"
}
pull 314 ""
expect_unreadable_merge_sha missing_merge_sha '<missing>'
pull 314 null
expect_unreadable_merge_sha null_merge_sha '<missing>'
pull 314 c9e08e0
expect_unreadable_merge_sha short_merge_sha c9e08e0
pull 314 ABCDEF0123456789ABCDEF0123456789ABCDEF01
expect_unreadable_merge_sha uppercase_merge_sha ABCDEF0123456789ABCDEF0123456789ABCDEF01
pull 314 ""
NO_STEP_SUMMARY=true expect_error missing_merge_sha_without_summary
grep -q '^::error::Release held: cannot read the merge commit' \
  "$WORK_DIR/missing_merge_sha_without_summary.out"

# Two pending release PRs: any mismatch holds, and every one is named.
issues 314 320
pull 314 "$OTHER"
pull 320 "$VALIDATED"
expect_decision one_of_two_mismatched false
grep -q "merged release PR #314 merged at $OTHER but" "$WORK_DIR/one_of_two_mismatched.out"
pull 320 3333333333333333333333333333333333333333
expect_decision both_mismatched false
grep -q "#314 merged at $OTHER, #320 merged at 3333333333333333333333333333333333333333 but" \
  "$WORK_DIR/both_mismatched.out"

# Labelled items Release Please would never release are ignored.
issues u401 i402 403 404 405
pull 403 "$OTHER" feature/not-a-release-branch
pull 404 "$OTHER" "$RELEASE_BRANCH" develop
pull 405 "$OTHER" "$RELEASE_BRANCH" main false
expect_decision unrelated_labelled_items_ignored true
grep -q 'No merged release PR is pending' "$WORK_DIR/unrelated_labelled_items_ignored.out"

# Unreadable state fails closed, without a decision.
issues 314
pull 314 "$VALIDATED"
MOCK_LIST_FAILURE=true expect_error list_failure
grep -q 'failed to list merged release PRs labelled "autorelease: pending"' "$WORK_DIR/list_failure.err"
MOCK_PULL_FAILURE=314 expect_error pull_failure
grep -q 'failed to read pull request #314' "$WORK_DIR/pull_failure.err"
printf '[{"number": "x1", "pull_request": {"merged_at": "2026-10-21T00:00:00Z"}}]\n' >"$MOCK_ISSUES"
expect_error invalid_number
grep -q 'invalid pull request number: x1' "$WORK_DIR/invalid_number.err"

# Input validation.
issues
CHECK_SHA=not-a-sha expect_error invalid_sha
grep -q 'invalid validated main SHA: not-a-sha' "$WORK_DIR/invalid_sha.err"
GH_TOKEN='' expect_error missing_token
grep -q 'GH_TOKEN is required' "$WORK_DIR/missing_token.err"
GITHUB_REPOSITORY='bad repo' expect_error invalid_repository
grep -q 'GITHUB_REPOSITORY must be owner/repository' "$WORK_DIR/invalid_repository.err"
set +e
env -u GITHUB_OUTPUT bash "$CHECK" "$VALIDATED" >/dev/null 2>"$WORK_DIR/no_output.err"
no_output_status=$?
bash "$CHECK" >/dev/null 2>"$WORK_DIR/usage.err"
usage_status=$?
set -e
[[ "$no_output_status" == "1" ]] && grep -q 'GITHUB_OUTPUT is required' "$WORK_DIR/no_output.err"
[[ "$usage_status" == "2" ]] && grep -q '^usage: ' "$WORK_DIR/usage.err"

printf 'Pending release PR check contract passed.\n'
