#!/usr/bin/env bash
# Contract tests for CI-gated, publish-last release automation.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/release/require-successful-main-ci.sh"
CI_WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
RELEASE_WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"
WORK_DIR="$(mktemp -d --tmpdir release-workflow-gate.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/bin"
cat >"$WORK_DIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "$1" == "api" ]] || exit 64
case "$*" in
  *actions/runs/4242/jobs*)
    reads="$(( $(cat "$MOCK_JOBS_READS" 2>/dev/null || echo 0) + 1 ))"
    printf '%s\n' "$reads" >"$MOCK_JOBS_READS"
    (( reads > ${MOCK_JOBS_API_FAILURES:-0} )) || exit 17
    # MOCK_JOBS_SEQUENCE lists one jobs file per read; the last one repeats.
    if [[ -n "${MOCK_JOBS_SEQUENCE:-}" ]]; then
      read -r -a sequence <<<"$MOCK_JOBS_SEQUENCE"
      index=$(( reads - ${MOCK_JOBS_API_FAILURES:-0} - 1 ))
      (( index < ${#sequence[@]} )) || index=$(( ${#sequence[@]} - 1 ))
      cat "${sequence[$index]}"
    else
      cat "$MOCK_JOBS"
    fi
    ;;
  *actions/runs/4242*)
    [[ "${MOCK_RUN_API_FAILURE:-false}" != "true" ]] || exit 17
    cat "$MOCK_RUN"
    ;;
  *git/ref/heads/main*) printf '%s\n' "$MOCK_MAIN_SHA" ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 64 ;;
esac
EOF
chmod 0755 "$WORK_DIR/bin/gh"

export PATH="$WORK_DIR/bin:$PATH"
export GH_TOKEN=test-token
export GITHUB_REPOSITORY=example/project
export MOCK_RUN="$WORK_DIR/run.json"
export MOCK_JOBS="$WORK_DIR/jobs.json"
export MOCK_MAIN_SHA=1111111111111111111111111111111111111111
export MOCK_JOBS_READS="$WORK_DIR/jobs-reads"
export RELEASE_GUARD_RETRY_BASE_SECONDS=0

write_success_run() {
  jq -cn \
    --arg sha "$MOCK_MAIN_SHA" \
    '{
      id: 4242,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      head_sha: $sha,
      head_repository: {full_name: "example/project"},
      status: "completed",
      conclusion: "success"
    }' >"$MOCK_RUN"
}

write_success_jobs() {
  jq -cn '[
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
  ] | map({name: ., status: "completed", conclusion: "success"})' >"$MOCK_JOBS"
}

expect_gate_failure() {
  local label="$1"
  rm -f "$MOCK_JOBS_READS"
  if bash "$GATE" 4242 1111111111111111111111111111111111111111 \
      >"$WORK_DIR/$label.out" 2>"$WORK_DIR/$label.err"; then
    printf 'gate unexpectedly accepted %s\n' "$label" >&2
    exit 1
  fi
}

write_success_run
write_success_jobs
bash "$GATE" 4242 "$MOCK_MAIN_SHA" >/dev/null

jq '.conclusion = "failure"' "$MOCK_RUN" >"$WORK_DIR/run-failed.json"
export MOCK_RUN="$WORK_DIR/run-failed.json"
expect_gate_failure failed_workflow

export MOCK_RUN="$WORK_DIR/run.json"
jq '.conclusion = "cancelled"' "$MOCK_RUN" >"$WORK_DIR/run-cancelled.json"
export MOCK_RUN="$WORK_DIR/run-cancelled.json"
expect_gate_failure cancelled_workflow

export MOCK_RUN="$WORK_DIR/run.json"
jq '.event = "pull_request"' "$MOCK_RUN" >"$WORK_DIR/run-pr.json"
export MOCK_RUN="$WORK_DIR/run-pr.json"
expect_gate_failure pull_request

export MOCK_RUN="$WORK_DIR/run.json"
jq '.head_branch = "feature"' "$MOCK_RUN" >"$WORK_DIR/run-branch.json"
export MOCK_RUN="$WORK_DIR/run-branch.json"
expect_gate_failure wrong_branch

export MOCK_RUN="$WORK_DIR/run.json"
jq '.head_repository.full_name = "attacker/fork"' "$MOCK_RUN" >"$WORK_DIR/run-fork.json"
export MOCK_RUN="$WORK_DIR/run-fork.json"
expect_gate_failure fork

export MOCK_RUN="$WORK_DIR/run.json"
jq '(.[] | select(.name == "E2E Install (interactive)")).conclusion = "failure"' \
  "$WORK_DIR/jobs.json" >"$WORK_DIR/jobs-failed.json"
export MOCK_JOBS="$WORK_DIR/jobs-failed.json"
expect_gate_failure failed_e2e

jq '(.[] | select(.name == "E2E Install (interactive)")).conclusion = "skipped"' \
  "$WORK_DIR/jobs.json" >"$WORK_DIR/jobs-skipped.json"
export MOCK_JOBS="$WORK_DIR/jobs-skipped.json"
expect_gate_failure skipped_e2e

jq 'del(.[] | select(.name == "Release Gate"))' \
  "$WORK_DIR/jobs.json" >"$WORK_DIR/jobs-no-sentinel.json"
export MOCK_JOBS="$WORK_DIR/jobs-no-sentinel.json"
expect_gate_failure missing_sentinel

jq '. + [(.[] | select(.name == "Release Gate"))]' \
  "$WORK_DIR/jobs.json" >"$WORK_DIR/jobs-duplicate-sentinel.json"
export MOCK_JOBS="$WORK_DIR/jobs-duplicate-sentinel.json"
expect_gate_failure duplicate_rerun_jobs

export MOCK_JOBS="$WORK_DIR/jobs.json"
export MOCK_MAIN_SHA=2222222222222222222222222222222222222222
expect_gate_failure stale_main

export MOCK_MAIN_SHA=1111111111111111111111111111111111111111
export MOCK_RUN_API_FAILURE=true
expect_gate_failure api_failure
unset MOCK_RUN_API_FAILURE

expect_jobs_reads() {
  local label="$1" want="$2"
  [[ "$(cat "$MOCK_JOBS_READS")" == "$want" ]] || {
    printf '%s: expected %s jobs reads, got %s\n' "$label" "$want" "$(cat "$MOCK_JOBS_READS")" >&2
    exit 1
  }
}

expect_gate_success() {
  local label="$1"
  rm -f "$MOCK_JOBS_READS"
  bash "$GATE" 4242 "$MOCK_MAIN_SHA" >"$WORK_DIR/$label.out" 2>"$WORK_DIR/$label.err" || {
    printf 'gate unexpectedly rejected %s:\n' "$label" >&2
    cat "$WORK_DIR/$label.err" >&2
    exit 1
  }
}

# A lagging jobs read for a finished run is retried, and every retry is logged.
jq '(.[] | select(.name == "Integration Coverage")) |= (.status = "in_progress" | .conclusion = null)' \
  "$WORK_DIR/jobs.json" >"$WORK_DIR/jobs-stale.json"
jq 'del(.[] | select(.name == "Lint"))' \
  "$WORK_DIR/jobs.json" >"$WORK_DIR/jobs-missing.json"
export MOCK_JOBS_SEQUENCE="$WORK_DIR/jobs-stale.json $WORK_DIR/jobs-missing.json $WORK_DIR/jobs.json"
expect_gate_success stale_jobs_read_recovers
expect_jobs_reads stale_jobs_read_recovers 3
grep -q '^jobs read 1/5 for CI workflow run 4242: a required job has not completed; retrying in 0s$' \
  "$WORK_DIR/stale_jobs_read_recovers.err"
grep -q '^Integration Coverage: in_progress/null$' "$WORK_DIR/stale_jobs_read_recovers.err"
grep -q '^jobs read 2/5 .*retrying' "$WORK_DIR/stale_jobs_read_recovers.err"
grep -q '^Lint: 0 matches$' "$WORK_DIR/stale_jobs_read_recovers.err"
if grep -q '^jobs read 3/5' "$WORK_DIR/stale_jobs_read_recovers.err"; then
  printf 'a successful read must not be logged as a retry\n' >&2
  exit 1
fi

# The retry is bounded: a read that never settles fails after five reads.
export MOCK_JOBS_SEQUENCE="$WORK_DIR/jobs-stale.json"
expect_gate_failure stale_jobs_read_persists
expect_jobs_reads stale_jobs_read_persists 5
grep -q '^jobs read 4/5 ' "$WORK_DIR/stale_jobs_read_persists.err"
grep -q 'did not pass every required main job after 5 reads (a required job has not completed)' \
  "$WORK_DIR/stale_jobs_read_persists.err"

# A failed jobs API call is retried the same way.
unset MOCK_JOBS_SEQUENCE
export MOCK_JOBS_API_FAILURES=2
expect_gate_success jobs_api_failure_recovers
expect_jobs_reads jobs_api_failure_recovers 3
grep -q '^jobs read 2/5 for CI workflow run 4242: the jobs API read failed; retrying in 0s$' \
  "$WORK_DIR/jobs_api_failure_recovers.err"
export MOCK_JOBS_API_FAILURES=5
expect_gate_failure jobs_api_failure_persists
expect_jobs_reads jobs_api_failure_persists 5
grep -q 'after 5 reads (the jobs API read failed)' "$WORK_DIR/jobs_api_failure_persists.err"
unset MOCK_JOBS_API_FAILURES

# A completed non-success job, a duplicate job or a malformed page is final.
export MOCK_JOBS="$WORK_DIR/jobs-failed.json"
expect_gate_failure failed_job_not_retried
expect_jobs_reads failed_job_not_retried 1
grep -q '^E2E Install (interactive): completed/failure$' "$WORK_DIR/failed_job_not_retried.err"
export MOCK_JOBS="$WORK_DIR/jobs-duplicate-sentinel.json"
expect_gate_failure duplicate_job_not_retried
expect_jobs_reads duplicate_job_not_retried 1
printf '{"jobs":"not-an-array"}\n' >"$WORK_DIR/jobs-malformed.json"
export MOCK_JOBS="$WORK_DIR/jobs-malformed.json"
expect_gate_failure malformed_jobs_not_retried
expect_jobs_reads malformed_jobs_not_retried 1
export MOCK_JOBS="$WORK_DIR/jobs.json"

# Exponential back-off: 2s, 4s, 8s, 16s between the five reads by default.
RELEASE_GUARD_RETRY_BASE_SECONDS=bad expect_gate_failure invalid_retry_delay
grep -q 'invalid RELEASE_GUARD_RETRY_BASE_SECONDS: bad' "$WORK_DIR/invalid_retry_delay.err"
cat >"$WORK_DIR/bin/sleep" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >>"$MOCK_SLEEP_LOG"
EOF
chmod 0755 "$WORK_DIR/bin/sleep"
export MOCK_SLEEP_LOG="$WORK_DIR/sleeps"
export MOCK_JOBS_SEQUENCE="$WORK_DIR/jobs-stale.json"
(unset RELEASE_GUARD_RETRY_BASE_SECONDS; expect_gate_failure default_back_off)
[[ "$(paste -sd' ' "$MOCK_SLEEP_LOG")" == "2 4 8 16" ]] || {
  printf 'unexpected back-off delays: %s\n' "$(paste -sd' ' "$MOCK_SLEEP_LOG")" >&2
  exit 1
}
rm -f "$WORK_DIR/bin/sleep"
unset MOCK_JOBS_SEQUENCE MOCK_SLEEP_LOG

# Static contracts prevent a refactor from restoring push-triggered publication.
grep -q '^  workflow_run:$' "$RELEASE_WORKFLOW"
grep -q '^    workflows: \[CI\]$' "$RELEASE_WORKFLOW"
grep -q '^    types: \[completed\]$' "$RELEASE_WORKFLOW"
if grep -q '^  push:$' "$RELEASE_WORKFLOW"; then
  printf 'release workflow must not publish directly from push\n' >&2
  exit 1
fi
grep -q "github.event_name == 'workflow_dispatch'" "$RELEASE_WORKFLOW"
grep -q "github.ref == 'refs/heads/main'" "$RELEASE_WORKFLOW"
grep -q "github.event.workflow_run.event == 'push'" "$RELEASE_WORKFLOW"
grep -q "github.event.workflow_run.head_branch == 'main'" "$RELEASE_WORKFLOW"
grep -q "github.event.workflow_run.conclusion == 'success'" "$RELEASE_WORKFLOW"
grep -q 'github.event.workflow_run.head_sha' "$RELEASE_WORKFLOW"
grep -q 'ref: ${{ steps.ci.outputs.sha }}' "$RELEASE_WORKFLOW"
grep -q 'scripts/release/require-successful-main-ci.sh' "$RELEASE_WORKFLOW"
grep -q '\.head_sha == $sha' "$RELEASE_WORKFLOW"
grep -q 'Current main .* has no successful completed push CI run' "$RELEASE_WORKFLOW"
[[ "$(grep -c 'GH_TOKEN="$RELEASE_PLEASE_TOKEN" gh release' "$RELEASE_WORKFLOW")" == "3" ]] || {
  printf 'release mutations must use the release PAT only for the gh command\n' >&2
  exit 1
}

[[ "$(grep -c "github.event_name == 'push' ||" "$CI_WORKFLOW")" == "3" ]] || {
  printf 'all three installer E2Es must run on every main push\n' >&2
  exit 1
}
grep -q '^  release_gate:$' "$CI_WORKFLOW"
grep -q "^    if: always() && github.event_name == 'push'$" "$CI_WORKFLOW"
[[ "$(sed -n '/^  release_gate:/,$p' "$CI_WORKFLOW" | grep -c '^      - e2e_')" == "3" ]] || {
  printf 'Release Gate must depend on all three installer E2Es\n' >&2
  exit 1
}

action_line="$(grep -n 'googleapis/release-please-action' "$RELEASE_WORKFLOW" | cut -d: -f1)"
publish_line="$(grep -n 'name: Publish the immutable release' "$RELEASE_WORKFLOW" | cut -d: -f1)"
last_gate_line="$(grep -n 'require-successful-main-ci.sh' "$RELEASE_WORKFLOW" | tail -1 | cut -d: -f1)"
[[ "$action_line" -lt "$publish_line" && "$last_gate_line" -gt "$publish_line" ]] || {
  printf 'publication must follow release automation and contain the final stale-head gate\n' >&2
  exit 1
}

# Release Please may only run once the pending-release-PR check allowed it,
# and a held run must not reach the draft/publish path at all.
pending_line="$(grep -n 'scripts/release/check-pending-release-pr.sh "$CI_HEAD_SHA"' "$RELEASE_WORKFLOW" | cut -d: -f1)"
[[ -n "$pending_line" && "$pending_line" -lt "$action_line" ]] || {
  printf 'the pending release PR check must run before Release Please\n' >&2
  exit 1
}
grep -q "^        if: github.event_name == 'workflow_run' && steps.pending.outputs.proceed == 'true'$" \
  "$RELEASE_WORKFLOW"
[[ "$(sed -n "$((pending_line + 1)),${action_line}p" "$RELEASE_WORKFLOW" | grep -c "steps.pending.outputs.proceed == 'true'")" == "1" ]] || {
  printf 'Release Please must be gated on the pending release PR check\n' >&2
  exit 1
}
resolve_line="$(grep -n 'name: Resolve release state and immutable tag' "$RELEASE_WORKFLOW" | cut -d: -f1)"
[[ "$(sed -n "$((resolve_line + 2))p" "$RELEASE_WORKFLOW")" == "        if: steps.pending.outputs.proceed != 'false'" ]] || {
  printf 'a held release run must not resolve or publish a release\n' >&2
  exit 1
}

printf 'CI-gated release workflow contract passed.\n'
