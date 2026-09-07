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
  *actions/runs/4242/jobs*) cat "$MOCK_JOBS" ;;
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

printf 'CI-gated release workflow contract passed.\n'
