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
SCRIPT="$REPO_ROOT/scripts/release/auto-merge-release-pr.sh"
RULESET_BRANCH="release-please--branches--main--components--sovereign-ai-node"

PASS=0
FAIL=0
check() {
  local name="$1"; shift
  if "$@"; then printf 'ok - %s\n' "$name"; PASS=$((PASS + 1))
  else printf 'FAIL - %s\n' "$name" >&2; FAIL=$((FAIL + 1)); fi
}

[[ -f "$WF" ]] || { printf 'missing workflow: %s\n' "$WF" >&2; exit 1; }
[[ -f "$SCRIPT" ]] || { printf 'missing script: %s\n' "$SCRIPT" >&2; exit 1; }

# --- static contract ----------------------------------------------------------

# Executable lines only, with shell line continuations joined, so prose that
# discusses a flag never reads as a use of it and a wrapped command is matched
# as one line.
code() { grep -vE '^\s*#' "$@" | sed -e ':a' -e '/\\$/N; s/\\\n//; ta'; }

# The single most important assertion in this file. `--admin` bypasses the
# ruleset's required status checks, which is the only thing standing between
# this automation and a red merge. If it ever appears here, everything else in
# this workflow is decoration.
no_admin_flag() { ! code "$WF" "$SCRIPT" | grep -qE '(^|[^-])--admin'; }
check "the workflow never passes --admin (which would bypass required checks)" no_admin_flag

uses_auto() { code "$SCRIPT" | grep -qE 'gh pr merge .* --auto'; }
check "the merge is queued with --auto, not performed directly" uses_auto

# --auto is what defers the decision to GitHub. A bare `gh pr merge` would merge
# immediately, at whatever CI state happened to hold.
no_bare_merge() {
  ! code "$WF" "$SCRIPT" | grep -E 'gh pr merge' | grep -qvE -- '--auto|--disable-auto'
}
check "there is no unconditional 'gh pr merge' anywhere in the workflow" no_bare_merge

pins_head() { code "$SCRIPT" | grep -qE 'gh pr merge .* --auto .*--match-head-commit "\$head_sha"'; }
check "the armed merge is pinned to the head commit that was checked" pins_head

scoped_to_release_branch() { grep -q "$RULESET_BRANCH" "$WF" && grep -q "$RULESET_BRANCH" "$SCRIPT"; }
check "scope is pinned to the exact release-please head ref" scoped_to_release_branch

reverifies_from_api() { grep -q 'gh api "repos/\${GITHUB_REPOSITORY}/pulls/\${PR}"' "$SCRIPT"; }
check "the head ref is re-read from the API, not trusted from the event payload" reverifies_from_api

# A release PR moves the version bump and nothing else.
has_file_allowlist() {
  grep -q '.release-please-manifest.json|CHANGELOG.md|package.json' "$SCRIPT"
}
check "the workflow enforces a version-bump-only file allowlist" has_file_allowlist

skips_drafts() { grep -q '"$draft" == "false"' "$SCRIPT"; }
check "draft PRs are excluded" skips_drafts

reruns_on_main_push() {
  grep -q '^  push:$' "$WF" && grep -A1 '^  push:$' "$WF" | grep -q 'branches: \[main\]'
}
check "every push to main re-runs the decision so a stale PR is disarmed" reruns_on_main_push

runs_trusted_script() { grep -q 'run: bash scripts/release/auto-merge-release-pr.sh' "$WF"; }
check "the workflow runs the decision script" runs_trusted_script

# pull_request_target has a writable token and secrets; checking out the PR
# head would run untrusted code with them.
no_pr_checkout() { ! grep -qE 'ref: .*github\.event\.pull_request\.head' "$WF"; }
check "the PR head is never checked out" no_pr_checkout

always_update() { [[ "$(jq -r '."always-update"' "$REPO_ROOT/release-please-config.json")" == "true" ]]; }
check "Release Please rebuilds the release PR on every validated main" always_update

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

# --- dynamic: the decision script against a mocked GitHub API ----------------
# This drives the shipped script, so it tests the logic itself rather than a
# restatement of it.
WORK_DIR="$(mktemp -d --tmpdir auto-merge-release-pr.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR/bin"
cat >"$WORK_DIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
jq_filter="."
for (( i = 1; i <= $#; i++ )); do
  if [[ "${!i}" == "--jq" ]]; then j=$((i + 1)); jq_filter="${!j}"; fi
done
case "$1 $2" in
  "pr merge")
    printf 'token=%s %s\n' "$GH_TOKEN" "$args" >>"$MOCK_CALLS"
    exit 0
    ;;
  "pr view") printf 'auto-merge armed: true, state: BLOCKED\n'; exit 0 ;;
esac
[[ "$1" == "api" ]] || exit 64
case "$args" in
  *"pulls?state=open&base=main&head=example:release-please--branches--main--components--sovereign-ai-node"*)
    jq -r "$jq_filter" "$MOCK_DIR/lookup.json" ;;
  *repos/example/project/pulls/7/files*) jq -r "$jq_filter" "$MOCK_DIR/files.json" ;;
  *repos/example/project/pulls/7*)
    [[ "${MOCK_PULL_FAILURE:-false}" != "true" ]] || exit 17
    jq -r "$jq_filter" "$MOCK_DIR/pull.json" ;;
  *git/ref/heads/main*) jq -r "$jq_filter" "$MOCK_DIR/main.json" ;;
  *"compare/$MOCK_MAIN_SHA...$MOCK_HEAD_SHA"*)
    [[ "${MOCK_COMPARE_FAILURE:-false}" != "true" ]] || exit 17
    jq -r "$jq_filter" "$MOCK_DIR/compare.json" ;;
  *) printf 'unexpected gh invocation: %s\n' "$args" >&2; exit 64 ;;
esac
EOF
chmod 0755 "$WORK_DIR/bin/gh"

export MOCK_DIR="$WORK_DIR" MOCK_CALLS="$WORK_DIR/calls"
export MOCK_MAIN_SHA=1111111111111111111111111111111111111111
export MOCK_HEAD_SHA=2222222222222222222222222222222222222222

# fixture [key=value...]: a release PR that is one commit on current main.
fixture() {
  local head_ref="$RULESET_BRANCH" base_ref=main repo=example/project draft=false
  local state=open armed=false ahead=1 behind=0 head_sha="$MOCK_HEAD_SHA"
  local main_sha="$MOCK_MAIN_SHA" files='[".release-please-manifest.json","CHANGELOG.md","package.json"]'
  local kv
  for kv in "$@"; do local "${kv%%=*}=${kv#*=}"; done
  jq -n --arg head_ref "$head_ref" --arg base_ref "$base_ref" --arg repo "$repo" \
    --argjson draft "$draft" --arg state "$state" --arg sha "$head_sha" --argjson armed "$armed" \
    '{head: {ref: $head_ref, sha: $sha, repo: {full_name: $repo}}, base: {ref: $base_ref},
      draft: $draft, state: $state,
      auto_merge: (if $armed then {merge_method: "squash"} else null end)}' >"$MOCK_DIR/pull.json"
  jq -n --argjson f "$files" '$f | map({filename: .})' >"$MOCK_DIR/files.json"
  jq -n --arg sha "$main_sha" '{object: {sha: $sha}}' >"$MOCK_DIR/main.json"
  jq -n --argjson a "$ahead" --argjson b "$behind" '{ahead_by: $a, behind_by: $b}' >"$MOCK_DIR/compare.json"
  printf '[{"number": 7}]\n' >"$MOCK_DIR/lookup.json"
}

# decide <label> <expected-exit> [pr-number...]
decide() {
  local label="$1" want="$2"; shift 2
  : >"$MOCK_CALLS"
  set +e
  PATH="$WORK_DIR/bin:$PATH" GH_TOKEN="${T_GH_TOKEN-read-token}" \
    RELEASE_PLEASE_TOKEN="${T_PAT-release-pat}" GITHUB_REPOSITORY="${T_REPO-example/project}" \
    bash "$SCRIPT" "$@" >"$WORK_DIR/$label.out" 2>&1
  local status=$?
  set -e
  [[ "$status" == "$want" ]] || {
    printf '%s: exit %s, expected %s\n' "$label" "$status" "$want" >&2
    cat "$WORK_DIR/$label.out" >&2
    return 1
  }
}
calls() { cat "$MOCK_CALLS"; }
armed_with_pat() {
  [[ "$(calls)" == "token=release-pat pr merge 7 -R example/project --squash --auto --match-head-commit $MOCK_HEAD_SHA" ]]
}
disarmed_with_pat() { [[ "$(calls)" == "token=release-pat pr merge 7 -R example/project --disable-auto" ]]; }
no_calls() { [[ ! -s "$MOCK_CALLS" ]]; }

arms_up_to_date() { fixture; decide up_to_date 0 7 && armed_with_pat; }
check "a release PR that is one commit on current main is armed, pinned to its head" arms_up_to_date

disarms_behind() {
  fixture armed=true behind=2; decide behind_armed 0 7 && disarmed_with_pat &&
    grep -q 'is not one commit on current main' "$WORK_DIR/behind_armed.out"
}
check "an armed release PR that fell behind main is disarmed" disarms_behind

leaves_behind_unarmed() { fixture behind=1; decide behind_unarmed 0 7 && no_calls; }
check "a release PR behind main is not armed" leaves_behind_unarmed

rejects_update_branch() { fixture ahead=2; decide merged_main_in 0 7 && no_calls; }
check "a release PR with main merged into it (stale changelog) is not armed" rejects_update_branch

push_disarms() { fixture armed=true behind=1; decide push_behind 0 && disarmed_with_pat; }
check "a push to main looks up the release PR and disarms it once it is behind" push_disarms

push_arms() { fixture; decide push_up_to_date 0 && armed_with_pat; }
check "a push-triggered decision arms a release PR that is up to date" push_arms

push_without_pr() {
  fixture; printf '[]\n' >"$MOCK_DIR/lookup.json"
  decide push_no_pr 0 && no_calls && grep -q 'No open release PR' "$WORK_DIR/push_no_pr.out"
}
check "a push with no open release PR does nothing" push_without_pr

rejects_source() {
  fixture armed=true files='["CHANGELOG.md","package.json","src/installer/real-service.ts"]'
  decide touches_src 1 7 && disarmed_with_pat &&
    grep -q "changes 'src/installer/real-service.ts'" "$WORK_DIR/touches_src.out"
}
check "a release PR that also touches src/ is rejected and disarmed" rejects_source

rejects_workflow_edit() {
  fixture files='["CHANGELOG.md",".github/workflows/release.yml"]'; decide touches_wf 1 7 && no_calls
}
check "a release PR that also edits a workflow is rejected" rejects_workflow_edit

rejects_lockfile() { fixture files='["package.json","pnpm-lock.yaml"]'; decide touches_lock 1 7 && no_calls; }
check "a release PR that also moves the lockfile is rejected" rejects_lockfile

rejects_no_files() { fixture files='[]'; decide no_files 1 7 && no_calls; }
check "a release PR that reports no files is rejected" rejects_no_files

ignores_other_branch() {
  fixture armed=true head_ref=feature/x; decide other_branch 0 7 && no_calls
}
check "a PR on any other branch is left untouched" ignores_other_branch

ignores_closed() { fixture state=closed; decide closed 0 7 && no_calls; }
check "a closed release PR is left alone" ignores_closed

disarms_draft() { fixture draft=true armed=true; decide draft 0 7 && disarmed_with_pat; }
check "a draft release PR is not armed (and is disarmed)" disarms_draft

rejects_base() { fixture base_ref=develop; decide wrong_base 1 7 && no_calls; }
check "a release PR that targets another base is rejected" rejects_base

rejects_fork() { fixture repo=attacker/fork armed=true; decide fork 1 7 && disarmed_with_pat; }
check "a release branch from a fork is rejected" rejects_fork

rejects_bad_head() { fixture head_sha=nope; decide bad_head 1 7 && no_calls; }
check "an invalid head SHA is rejected" rejects_bad_head

rejects_bad_main() { fixture main_sha=nope; decide bad_main 1 7 && no_calls; }
check "an unreadable main SHA is rejected" rejects_bad_main

compare_failure() { fixture armed=true; MOCK_COMPARE_FAILURE=true decide compare_fails 1 7 && disarmed_with_pat; }
check "a failed compare read disarms and fails" compare_failure

pull_failure() { fixture; MOCK_PULL_FAILURE=true decide pull_fails 17 7 && no_calls; }
check "a failed PR read fails without acting" pull_failure

requires_tokens() {
  fixture; T_PAT='' decide no_pat 1 7 && no_calls && T_GH_TOKEN='' decide no_token 1 7
}
check "both tokens are required" requires_tokens

validates_inputs() {
  fixture; decide too_many_args 2 7 8 && decide bad_number 1 x7 &&
    T_REPO='bad repo' decide bad_repo 1 7 && no_calls
}
check "arguments and repository are validated" validates_inputs

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
