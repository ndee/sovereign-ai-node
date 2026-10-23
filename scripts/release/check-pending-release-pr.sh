#!/usr/bin/env bash
# Decide whether Release Please may run against the validated main commit.
#
# Release Please releases every merged release PR still labelled
# "autorelease: pending" at that PR's own merge commit, before anything else
# in the workflow can look at it. The rest of the release workflow only
# accepts the CI-validated main head, so a pending release PR merged at any
# other commit must stop the run here, before a tag or draft exists.
#
# Appends proceed=true or proceed=false to $GITHUB_OUTPUT and exits 0 for
# either decision. Exits non-zero when the state cannot be read, including a
# pending release PR whose merge commit is not a full SHA, so the step fails
# closed without running Release Please.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <validated-main-sha>\n' "$0" >&2
  exit 2
fi

VALIDATED_SHA="$1"
PENDING_LABEL="autorelease: pending"
RELEASE_BRANCH_PREFIX="release-please--branches--main"

[[ "$VALIDATED_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'invalid validated main SHA: %s\n' "$VALIDATED_SHA" >&2
  exit 1
}
[[ -n "${GH_TOKEN:-}" ]] || {
  printf 'GH_TOKEN is required\n' >&2
  exit 1
}
[[ "${GITHUB_REPOSITORY:-}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || {
  printf 'GITHUB_REPOSITORY must be owner/repository\n' >&2
  exit 1
}
[[ -n "${GITHUB_OUTPUT:-}" ]] || {
  printf 'GITHUB_OUTPUT is required\n' >&2
  exit 1
}

# The issues listing is read from the primary store, unlike search, so a
# just-applied label is not missed.
candidates="$(gh api --paginate \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$GITHUB_REPOSITORY/issues?state=closed&labels=autorelease%3A%20pending&per_page=100" \
  --jq '.[] | select(.pull_request.merged_at != null) | .number')" || {
    printf 'failed to list merged release PRs labelled "%s"\n' "$PENDING_LABEL" >&2
    exit 1
  }

pending=0
mismatched=()
for number in $candidates; do
  [[ "$number" =~ ^[1-9][0-9]*$ ]] || {
    printf 'invalid pull request number: %s\n' "$number" >&2
    exit 1
  }
  # API version 2026-03-10 no longer returns merge_commit_sha for pulls.
  pr_tsv="$(gh api \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/$GITHUB_REPOSITORY/pulls/$number" \
    --jq '[.base.ref, .head.ref, (.merged | tostring), (.merge_commit_sha // "")] | @tsv')" || {
      printf 'failed to read pull request #%s\n' "$number" >&2
      exit 1
    }
  IFS=$'\t' read -r base_ref head_ref merged merge_sha <<<"$pr_tsv"
  # Release Please only acts on its own branches into main.
  [[ "$base_ref" == "main" && "$head_ref" == "$RELEASE_BRANCH_PREFIX"* && "$merged" == "true" ]] ||
    continue
  pending=$((pending + 1))
  if [[ ! "$merge_sha" =~ ^[0-9a-f]{40}$ ]]; then
    message="Release held: cannot read the merge commit of merged release PR #$number"
    message+=" (merge_commit_sha: ${merge_sha:-<missing>})."
    message+=" Release Please did not run, so no tag or draft release was created."
    message+=" See docs/RELEASING.md (Held release)."
    printf '::error::%s\n' "$message"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      printf '%s\n' "$message" >>"$GITHUB_STEP_SUMMARY"
    fi
    exit 1
  fi
  if [[ "$merge_sha" != "$VALIDATED_SHA" ]]; then
    mismatched+=("#$number merged at $merge_sha")
  fi
done

if (( ${#mismatched[@]} > 0 )); then
  held="$(printf '%s, ' "${mismatched[@]}")"
  message="Release held: merged release PR ${held%, } but CI validated main $VALIDATED_SHA."
  message+=" Release Please did not run, so no tag or draft release was created."
  message+=" See docs/RELEASING.md (Held release)."
  printf '::warning::%s\n' "$message"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$message" >>"$GITHUB_STEP_SUMMARY"
  fi
  echo 'proceed=false' >>"$GITHUB_OUTPUT"
  exit 0
fi

if (( pending > 0 )); then
  printf 'Merged release PR matches validated main %s; Release Please may create its release.\n' \
    "$VALIDATED_SHA"
else
  printf 'No merged release PR is pending; Release Please may only open or update the release PR.\n'
fi
echo 'proceed=true' >>"$GITHUB_OUTPUT"
