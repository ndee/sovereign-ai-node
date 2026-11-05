#!/usr/bin/env bash
# test-host-resources-ansible.sh — Run the real post-install playbook against
# whatever ansible-core is on PATH, with stubbed host commands.
#
# The installer runs deploy/ansible/playbooks/post-install-local.yml with the
# host's own ansible-core: the distro package when none is installed (Debian 12
# ships 2.14, Ubuntu 24.04 ships 2.16), or whatever the host already has.
# ansible-core up to 2.18 templates differently from 2.19+: a value that looks
# like a JSON object or list is literal-eval'd into a Python dict or list, and a
# string module parameter then receives its Python repr. The install E2E jobs
# only see the ansible-core the CI runner happens to ship, so this script runs
# the playbook unchanged on the version under test and checks what it did.
#
# Stubs, all first on PATH:
#   runuser        runs the rest of its argv as the current user (the real one
#                  needs root; the switch itself is covered by the install E2E)
#   openclaw       records every call; `cron list --json` prints the case's
#                  canned output and exits with the case's status
#   sovereign-node answers `status --json` / `doctor --json` for the verify role
#
# Cases cover every shape `openclaw cron list --json` has had (an object with
# `jobs`, an object with `crons`, a bare list, an empty list), a failing CLI,
# blank output, and a plan without OpenClaw cron jobs. Every case also writes a
# managed file whose content is JSON and requires it byte for byte.
#
# Usage: test-host-resources-ansible.sh
#   ANSIBLE_PLAYBOOK  ansible-playbook binary to use (default: from PATH)
# Exit 0 = every case passed, 1 = at least one case failed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANSIBLE_DIR="$REPO_ROOT/deploy/ansible"
PLAYBOOK="$ANSIBLE_DIR/playbooks/post-install-local.yml"
ANSIBLE_PLAYBOOK="${ANSIBLE_PLAYBOOK:-ansible-playbook}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/host-resources-ansible.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
BIN_DIR="$WORK_DIR/bin"
mkdir -p "$BIN_DIR"

cat >"$BIN_DIR/runuser" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "-u" && -n "${2:-}" && "${3:-}" == "--" ]] || {
  printf 'unexpected runuser call: %s\n' "$*" >&2
  exit 64
}
shift 3
exec "$@"
EOF

cat >"$BIN_DIR/openclaw" <<'EOF'
#!/usr/bin/env bash
case_dir="$(cd "$(dirname "$0")/.." && pwd)/case"
printf '%s\n' "$*" >>"$case_dir/openclaw.log"
if [[ "$*" == "cron list --json" ]]; then
  cat "$case_dir/cron-list.stdout"
  exit "$(cat "$case_dir/cron-list.rc")"
fi
EOF

cat >"$BIN_DIR/sovereign-node" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "status --json") printf '{"result":{"hostResources":{},"bots":[]}}\n' ;;
  "doctor --json") printf '{"result":{"overall":"pass"}}\n' ;;
  *) printf 'unexpected sovereign-node call: %s\n' "$*" >&2; exit 64 ;;
esac
EOF
chmod 0755 "$BIN_DIR/runuser" "$BIN_DIR/openclaw" "$BIN_DIR/sovereign-node"

CASE_DIR="$WORK_DIR/case"
OPENCLAW_HOME_DIR="$WORK_DIR/home"
MANAGED_FILE="$WORK_DIR/managed/bot/config.json"
# Pretty-printed with a trailing newline, as bot config is written.
MANAGED_CONTENT_JSON='{\n  \"enabled\": true,\n  \"rooms\": [\"!alerts:example.org\"],\n  \"lastScan\": null\n}\n'

write_plan() {
  local with_crons="$1" crons="" cli=""
  if [[ "$with_crons" == "1" ]]; then
    crons=',
    {"id": "scan", "kind": "openclawCron", "desiredState": "present",
     "match": {"name": "scan-now", "agentId": "mail"},
     "spec": {"id": "scan-now", "agentId": "mail", "every": "30m", "session": "isolated",
              "message": "[scan] check the inbox"},
     "checks": []},
    {"id": "scan::supersede::0", "kind": "openclawCron", "desiredState": "absent",
     "match": {"name": "scan-legacy"}, "checks": []}'
    cli=',
  "openclawCli": {"user": "'"$(id -un)"'", "home": "'"$OPENCLAW_HOME_DIR"'",
                  "configPath": "'"$OPENCLAW_HOME_DIR"'/openclaw.json",
                  "command": ["'"$BIN_DIR"'/openclaw"]}'
  fi
  cat >"$CASE_DIR/plan.json" <<EOF
{
  "resources": [
    {"id": "config", "kind": "managedFile", "path": "$MANAGED_FILE",
     "content": "$MANAGED_CONTENT_JSON", "mode": "0640", "writePolicy": "always", "checks": []}$crons
  ]$cli
}
EOF
}

FAILURES=0
fail() {
  printf '  FAIL %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

# run_case NAME WITH_CRONS RC STDOUT EXPECTED_OPENCLAW_CALLS
run_case() {
  local name="$1" with_crons="$2" rc="$3" stdout="$4" expected="$5" log
  rm -rf "$CASE_DIR" "$WORK_DIR/managed"
  mkdir -p "$CASE_DIR" "$OPENCLAW_HOME_DIR"
  : >"$CASE_DIR/openclaw.log"
  printf '%s' "$stdout" >"$CASE_DIR/cron-list.stdout"
  printf '%s' "$rc" >"$CASE_DIR/cron-list.rc"
  write_plan "$with_crons"

  printf 'case %s\n' "$name"
  log="$CASE_DIR/ansible.log"
  if ! env "PATH=$BIN_DIR:$PATH" \
    "ANSIBLE_CONFIG=$ANSIBLE_DIR/ansible.cfg" \
    "ANSIBLE_ROLES_PATH=$ANSIBLE_DIR/roles" \
    "ANSIBLE_PYTHON_INTERPRETER=auto_silent" \
    "$ANSIBLE_PLAYBOOK" -i localhost, -c local "$PLAYBOOK" \
    -e "sovereign_host_resources_plan_file=$CASE_DIR/plan.json" >"$log" 2>&1; then
    fail "$name: the playbook failed"
    sed 's/^/    | /' "$log"
    return
  fi

  if ! cmp -s "$MANAGED_FILE" <(printf '%b' "${MANAGED_CONTENT_JSON//\\\"/\"}"); then
    fail "$name: the managed JSON file was not written byte for byte"
    sed 's/^/    | /' "$MANAGED_FILE"
  fi

  printf '%s' "$expected" >"$CASE_DIR/openclaw.expected"
  if [[ "$(cat "$CASE_DIR/openclaw.log")" != "$expected" ]]; then
    fail "$name: unexpected OpenClaw calls"
    printf '    expected:\n'
    sed 's/^/      /' "$CASE_DIR/openclaw.expected"
    printf '\n    got:\n'
    sed 's/^/      /' "$CASE_DIR/openclaw.log"
    return
  fi
  printf '  ok\n'
}

ADD_CALL='cron add --name scan-now --agent mail --every 30m --session isolated --message [scan] check the inbox --replace'
LIST_CALL='cron list --json'

"$ANSIBLE_PLAYBOOK" --version | head -n 1

# Pretty-printed like `JSON.stringify(value, null, 2)`, which OpenClaw prints.
run_case "jobs object" 1 0 '{
  "jobs": [
    {"id": "job-legacy", "name": "scan-legacy", "enabled": true, "lastRunAt": null},
    {"id": "job-other", "name": "unrelated", "enabled": false}
  ],
  "total": 2
}' "$LIST_CALL
cron rm job-legacy
$ADD_CALL"

run_case "crons object" 1 0 '{"crons": [{"id": "job-legacy", "name": "scan-legacy"}]}' \
  "$LIST_CALL
cron rm job-legacy
$ADD_CALL"

run_case "bare list" 1 0 '[{"id": "job-legacy", "name": "scan-legacy"}, {"id": "job-unnamed"}]' \
  "$LIST_CALL
cron rm job-legacy
$ADD_CALL"

run_case "empty jobs object" 1 0 '{"jobs": []}' "$LIST_CALL
$ADD_CALL"

run_case "empty list" 1 0 '[]' "$LIST_CALL
$ADD_CALL"

run_case "failing CLI" 1 1 'gateway closed (1006)' "$LIST_CALL
$ADD_CALL"

run_case "blank output" 1 0 '' "$LIST_CALL
$ADD_CALL"

run_case "no OpenClaw cron jobs in the plan" 0 0 '' ''

if [[ "$FAILURES" -gt 0 ]]; then
  printf '%d case(s) failed\n' "$FAILURES"
  exit 1
fi
printf 'all cases passed\n'
