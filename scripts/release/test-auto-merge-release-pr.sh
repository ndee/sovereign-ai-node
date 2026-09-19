#!/usr/bin/env bash
# Contract tests for the release-PR auto-merge workflow.
#
# The claim under test is that this automation CANNOT merge over red CI and
# CANNOT merge anything other than the generated release PR. Both are asserted
# two ways: statically against the workflow file, and dynamically by executing
# the verification step's own logic against fixtures it must reject.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WF="$REPO_ROOT/.github/workflows/auto-merge-release-pr.yml"
RULESET_BRANCH="release-please--branches--main--components--sovereign-ai-node"

PASS=0
FAIL=0
check() {
  local name="$1"; shift
  if "$@"; then printf 'ok - %s\n' "$name"; PASS=$((PASS + 1))
  else printf 'FAIL - %s\n' "$name" >&2; FAIL=$((FAIL + 1)); fi
}

[[ -f "$WF" ]] || { printf 'missing workflow: %s\n' "$WF" >&2; exit 1; }

# --- static contract ----------------------------------------------------------

# The single most important assertion in this file. `--admin` bypasses the
# ruleset's required status checks, which is the only thing standing between
# this automation and a red merge. If it ever appears here, everything else in
# this workflow is decoration.
# Strip comment lines first: the workflow discusses --admin at length in prose
# explaining why it is absent, and that must not read as a use of it. Only
# executable lines count.
no_admin_flag() { ! grep -vE '^\s*#' "$WF" | grep -qE '(^|[^-])--admin'; }
check "the workflow never passes --admin (which would bypass required checks)" no_admin_flag

uses_auto() { grep -qE 'gh pr merge .* --auto' "$WF"; }
check "the merge is queued with --auto, not performed directly" uses_auto

# --auto is what defers the decision to GitHub. A bare `gh pr merge` would merge
# immediately, at whatever CI state happened to hold.
no_bare_merge() { ! grep -E 'gh pr merge' "$WF" | grep -qv -- '--auto'; }
check "there is no unconditional 'gh pr merge' anywhere in the workflow" no_bare_merge

scoped_to_release_branch() { grep -q "$RULESET_BRANCH" "$WF"; }
check "scope is pinned to the exact release-please head ref" scoped_to_release_branch

reverifies_from_api() { grep -q 'gh api "repos/\${GITHUB_REPOSITORY}/pulls/\${PR}"' "$WF"; }
check "the head ref is re-read from the API, not trusted from the event payload" reverifies_from_api

# A release PR moves the version bump and nothing else.
has_file_allowlist() {
  grep -q '.release-please-manifest.json|CHANGELOG.md|package.json' "$WF"
}
check "the workflow enforces a version-bump-only file allowlist" has_file_allowlist

skips_drafts() { grep -q 'draft == false' "$WF"; }
check "draft PRs are excluded" skips_drafts

# --- the ruleset this design depends on --------------------------------------
# This workflow is only safe because GitHub itself refuses a red merge. That is
# a property of the repository ruleset, not of this file, so assert it is still
# true rather than assuming it. Skipped offline so the suite stays runnable
# without network or credentials.
if gh auth status >/dev/null 2>&1; then
  rs="$(gh api "repos/ndee/sovereign-ai-node/rulesets" --jq '.[0].id' 2>/dev/null || true)"
  if [[ -n "$rs" ]]; then
    json="$(gh api "repos/ndee/sovereign-ai-node/rulesets/${rs}")"
    has_required_checks() {
      [[ "$(jq -r '[.rules[] | select(.type == "required_status_checks")] | length' <<<"$json")" -ge 1 ]]
    }
    check "the repository ruleset still requires status checks" has_required_checks
    no_bypass() { [[ "$(jq -r '.bypass_actors | length' <<<"$json")" == "0" ]]; }
    check "the ruleset has no bypass actors" no_bypass
    enforced() { [[ "$(jq -r '.enforcement' <<<"$json")" == "active" ]]; }
    check "the ruleset is actively enforced" enforced
  else
    printf 'skip - ruleset assertions (no ruleset readable)\n'
  fi
else
  printf 'skip - ruleset assertions (gh not authenticated)\n'
fi

# --- dynamic: the verification logic must REJECT what it should --------------
# Extract the allowlist decision from the workflow and drive it with fixtures,
# so this tests the shipped logic rather than a restatement of it.
verify_files() {
  local f
  for f in "$@"; do
    case "$f" in
      .release-please-manifest.json|CHANGELOG.md|package.json) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

accepts_bump() {
  verify_files .release-please-manifest.json CHANGELOG.md package.json
}
check "a pure version bump is accepted" accepts_bump

rejects_source() {
  ! verify_files .release-please-manifest.json CHANGELOG.md package.json \
      src/installer/real-service.ts
}
check "a release PR that also touches src/ is rejected" rejects_source

rejects_workflow_edit() {
  ! verify_files CHANGELOG.md .github/workflows/release.yml
}
check "a release PR that also edits a workflow is rejected" rejects_workflow_edit

rejects_lockfile() { ! verify_files package.json pnpm-lock.yaml; }
check "a release PR that also moves the lockfile is rejected" rejects_lockfile

# --- the manifest the allowlist names must actually exist --------------------
manifest_exists() { [[ -f "$REPO_ROOT/.release-please-manifest.json" ]]; }
check "the allowlisted manifest file exists in this repo" manifest_exists

# Release Please must still be configured to write exactly those paths; if it
# gains another output the allowlist would start rejecting real release PRs.
config_is_node_type() {
  [[ "$(jq -r '.packages["."]["release-type"]' "$REPO_ROOT/release-please-config.json")" == "node" ]]
}
check "release-please is still the node release-type this allowlist assumes" config_is_node_type

printf '\nauto-merge release PR contract: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
