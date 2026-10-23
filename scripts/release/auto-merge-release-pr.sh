#!/usr/bin/env bash
# Arm or disarm GitHub's native auto-merge on the Release Please PR.
#
# The release PR is armed only while it is exactly Release Please's single
# commit on top of the current main. Its changelog was then generated from
# every commit the merge will contain, so the release notes cannot miss one.
# When main moves past it, it is disarmed until Release Please rebuilds it on
# the new main (always-update), which re-runs this check and re-arms it.
#
# usage: auto-merge-release-pr.sh [<pr-number>]
# Without a number (a push to main), the open release PR is looked up.
#
# GH_TOKEN reads; RELEASE_PLEASE_TOKEN performs the merge-state changes. A
# merge performed via GITHUB_TOKEN would not emit the push event that the
# Release Please workflow's workflow_run trigger keys on.

set -euo pipefail

RELEASE_BRANCH="release-please--branches--main--components--sovereign-ai-node"

if [[ $# -gt 1 ]]; then
  printf 'usage: %s [<pr-number>]\n' "$0" >&2
  exit 2
fi
for var in GH_TOKEN RELEASE_PLEASE_TOKEN; do
  [[ -n "${!var:-}" ]] || { printf '::error::%s is required.\n' "$var"; exit 1; }
done
[[ "${GITHUB_REPOSITORY:-}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || {
  printf '::error::GITHUB_REPOSITORY must be owner/repository.\n'
  exit 1
}

PR="${1:-}"
if [[ -z "$PR" ]]; then
  PR="$(gh api \
    "repos/${GITHUB_REPOSITORY}/pulls?state=open&base=main&head=${GITHUB_REPOSITORY%%/*}:${RELEASE_BRANCH}" \
    --jq '.[0].number // empty')"
  if [[ -z "$PR" ]]; then
    echo "::notice::No open release PR; nothing to do."
    exit 0
  fi
fi
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || { printf '::error::invalid PR number: %s\n' "$PR"; exit 1; }

# Re-read from the API. pull_request_target runs with a writable token, so
# nothing here may depend on attacker-influenced payload fields without
# confirming them against the server's own view.
pr_tsv="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" \
  --jq '[.head.ref, .base.ref,
         (.head.repo.full_name == "'"${GITHUB_REPOSITORY}"'"),
         .draft, .state, .head.sha, (.auto_merge != null)] | @tsv')"
IFS=$'\t' read -r head_ref base_ref same_repo draft state head_sha armed <<<"$pr_tsv"

[[ "$head_ref" == "$RELEASE_BRANCH" ]] || {
  echo "::notice::PR #${PR} head '${head_ref}' is not the release branch; nothing to do."
  exit 0
}
[[ "$state" == "open" ]] || {
  echo "::notice::PR #${PR} is not open; nothing to do."
  exit 0
}

disarm() {
  if [[ "$armed" == "true" ]]; then
    GH_TOKEN="$RELEASE_PLEASE_TOKEN" gh pr merge "$PR" -R "$GITHUB_REPOSITORY" --disable-auto
    echo "auto-merge disarmed on PR #${PR}."
  fi
}

[[ "$base_ref" == "main" ]] || {
  disarm
  echo "::error::release PR targets '${base_ref}', not main."
  exit 1
}
[[ "$same_repo" == "true" ]] || {
  disarm
  echo "::error::release branch is not from this repository."
  exit 1
}
[[ "$draft" == "false" ]] || {
  disarm
  echo "::notice::PR #${PR} is a draft; not arming auto-merge."
  exit 0
}
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || {
  disarm
  printf '::error::invalid head SHA for PR #%s: %s\n' "$PR" "$head_sha"
  exit 1
}

# A release PR only ever moves the version bump. Anything else on this branch
# means something other than Release Please wrote to it, and it must not merge
# itself.
files_list="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR}/files" \
  --jq '.[].filename')" || { disarm; echo "::error::failed to list PR files."; exit 1; }
mapfile -t files < <(printf '%s' "$files_list" | sed '/^$/d')
(( ${#files[@]} > 0 )) || { disarm; echo "::error::no files reported."; exit 1; }
for f in "${files[@]}"; do
  case "$f" in
    .release-please-manifest.json|CHANGELOG.md|package.json) ;;
    *) disarm
       echo "::error::release PR changes '${f}', which a version bump never touches."
       exit 1 ;;
  esac
done
printf 'files: %s\n' "${files[*]}"

# Up to date means the PR head is one commit whose parent is the current main.
# "Update branch" (a merge from main) also yields behind_by == 0, but leaves
# the changelog generated from an older main; ahead_by == 1 rejects that.
main_sha="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha')" ||
  main_sha=""
[[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || {
  disarm
  printf '::error::invalid main SHA: %s\n' "$main_sha"
  exit 1
}
compare_tsv="$(gh api "repos/${GITHUB_REPOSITORY}/compare/${main_sha}...${head_sha}" \
  --jq '[.ahead_by, .behind_by] | @tsv')" || {
    disarm
    printf '::error::failed to compare PR #%s with main %s.\n' "$PR" "$main_sha"
    exit 1
  }
read -r ahead_by behind_by <<<"$compare_tsv"
if [[ "$ahead_by" != "1" || "$behind_by" != "0" ]]; then
  disarm
  echo "::notice::PR #${PR} head ${head_sha} is not one commit on current main ${main_sha} (ahead ${ahead_by}, behind ${behind_by}); auto-merge stays off until Release Please rebuilds it."
  exit 0
fi

# NO --admin. The ruleset's required status checks are the gate, and --admin
# is precisely the flag that bypasses them. --auto queues the merge for GitHub
# to perform once those checks pass; if they fail, the PR stays open.
# --match-head-commit refuses the merge if the branch moves after this check.
GH_TOKEN="$RELEASE_PLEASE_TOKEN" gh pr merge "$PR" -R "$GITHUB_REPOSITORY" \
  --squash --auto --match-head-commit "$head_sha"
gh pr view "$PR" -R "$GITHUB_REPOSITORY" \
  --json autoMergeRequest,mergeStateStatus \
  --jq '"auto-merge armed: \(.autoMergeRequest != null), state: \(.mergeStateStatus)"'
