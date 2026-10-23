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

# The run itself is already completed, so a required job that reads as
# missing or not completed is a lagging jobs API, not a real state. Only
# those reads are retried; a completed non-success job fails at once.
JOBS_READ_ATTEMPTS=5
retry_delay="${RELEASE_GUARD_RETRY_BASE_SECONDS:-2}"
[[ "$retry_delay" =~ ^[0-9]+$ ]] || {
  printf 'invalid RELEASE_GUARD_RETRY_BASE_SECONDS: %s\n' "$retry_delay" >&2
  exit 1
}

jobs_summary() {
  jq -rs --argjson required "$required_jobs" '
    [ .[] | if type == "array" then .[] else empty end ] as $jobs |
    $required[] as $name |
    ($jobs | map(select(.name == $name))) as $matches |
    "\($name): " +
      (if ($matches | length) == 1
       then "\($matches[0].status)/\($matches[0].conclusion)"
       else "\($matches | length) matches"
       end)
  ' "$jobs_file"
}

# Prints pass, pending or fail for the jobs read in $jobs_file.
jobs_verdict() {
  jq -rs --argjson required "$required_jobs" '
    [ .[] | if type == "array" then .[] else error("jobs page was not an array") end ] as $jobs |
    [ $required[] as $name | [ $jobs[] | select(.name == $name) ] ] as $matches |
    if any($matches[]; length > 1 or
           (length == 1 and .[0].status == "completed" and .[0].conclusion != "success"))
    then "fail"
    elif all($matches[]; length == 1 and .[0].status == "completed")
    then "pass"
    else "pending"
    end
  ' "$jobs_file"
}

attempt=1
while :; do
  if gh api --paginate \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/jobs?filter=latest&per_page=100" \
    --jq '.jobs' >"$jobs_file"; then
    verdict="$(jobs_verdict 2>/dev/null)" || verdict="fail"
    reason="a required job has not completed"
  else
    verdict="pending"
    reason="the jobs API read failed"
  fi

  case "$verdict" in
    pass) break ;;
    fail)
      printf 'CI workflow run %s did not pass every required main job:\n' "$RUN_ID" >&2
      jobs_summary >&2 || true
      exit 1
      ;;
  esac

  if (( attempt >= JOBS_READ_ATTEMPTS )); then
    printf 'CI workflow run %s did not pass every required main job after %d reads (%s):\n' \
      "$RUN_ID" "$attempt" "$reason" >&2
    jobs_summary >&2 || true
    exit 1
  fi
  delay=$(( retry_delay * (1 << (attempt - 1)) ))
  printf 'jobs read %d/%d for CI workflow run %s: %s; retrying in %ss\n' \
    "$attempt" "$JOBS_READ_ATTEMPTS" "$RUN_ID" "$reason" "$delay" >&2
  jobs_summary >&2 || true
  sleep "$delay"
  attempt=$(( attempt + 1 ))
done

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
