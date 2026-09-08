#!/usr/bin/env bash
# Fail closed unless a completed CI push run validated the exact current main.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s <workflow-run-id> <head-sha>\n' "$0" >&2
  exit 2
fi

RUN_ID="$1"
EXPECTED_SHA="$2"

[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]] || {
  printf 'invalid workflow run ID: %s\n' "$RUN_ID" >&2
  exit 1
}
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'invalid CI head SHA: %s\n' "$EXPECTED_SHA" >&2
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

run_json="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID")" || {
    printf 'failed to read CI workflow run %s\n' "$RUN_ID" >&2
    exit 1
  }

jq -e \
  --argjson run_id "$RUN_ID" \
  --arg repo "$GITHUB_REPOSITORY" \
  --arg sha "$EXPECTED_SHA" '
    .id == $run_id and
    .name == "CI" and
    .path == ".github/workflows/ci.yml" and
    .event == "push" and
    .head_branch == "main" and
    .head_sha == $sha and
    .head_repository.full_name == $repo and
    .status == "completed" and
    .conclusion == "success"
  ' <<<"$run_json" >/dev/null || {
    printf 'workflow run %s is not a successful CI push for %s main at %s\n' \
      "$RUN_ID" "$GITHUB_REPOSITORY" "$EXPECTED_SHA" >&2
    exit 1
  }

jobs_file="$(mktemp --tmpdir github-actions-jobs.XXXXXX)"
trap 'rm -f "$jobs_file"' EXIT
if ! gh api --paginate \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/jobs?filter=latest&per_page=100" \
  --jq '.jobs' >"$jobs_file"; then
  printf 'failed to read jobs for CI workflow run %s\n' "$RUN_ID" >&2
  exit 1
fi

required_jobs='[
  "Detect install-relevant changes",
  "Lint",
  "Typecheck",
  "Unit Coverage",
  "Integration Coverage",
  "Smoke Tests",
  "Release Artifact Contract",
  "E2E Install (non-interactive)",
  "E2E Install (interactive)",
  "E2E Install (rerun after partial failure)",
  "Release Gate"
]'

if ! jq -es --argjson required "$required_jobs" '
  [ .[] | if type == "array" then .[] else error("jobs page was not an array") end ] as $jobs |
  [ $required[] as $name |
    ([ $jobs[] | select(.name == $name) ] | length == 1) and
    ([ $jobs[] | select(.name == $name) ][0] |
      .status == "completed" and .conclusion == "success")
  ] | all
' "$jobs_file" >/dev/null; then
  printf 'CI workflow run %s did not pass every required main job:\n' "$RUN_ID" >&2
  jq -rs --argjson required "$required_jobs" '
    [ .[] | if type == "array" then .[] else empty end ] as $jobs |
    $required[] as $name |
    ($jobs | map(select(.name == $name))) as $matches |
    "\($name): " +
      (if ($matches | length) == 1
       then "\($matches[0].status)/\($matches[0].conclusion)"
       else "\($matches | length) matches"
       end)
  ' "$jobs_file" >&2
  exit 1
fi

current_main_sha="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$GITHUB_REPOSITORY/git/ref/heads/main" \
  --jq '.object.sha')" || {
    printf 'failed to resolve current main ref\n' >&2
    exit 1
  }
[[ "$current_main_sha" == "$EXPECTED_SHA" ]] || {
  printf 'stale CI run: current main is %s, validated head is %s\n' \
    "$current_main_sha" "$EXPECTED_SHA" >&2
  exit 1
}

printf 'Validated CI run %s for current main at %s.\n' "$RUN_ID" "$EXPECTED_SHA"
