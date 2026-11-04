#!/usr/bin/env bash
# web-install-e2e.sh: drives an install through the setup API the way the
# setup web UI does. The install job then runs in-process inside
# sovereign-node-api.service as the unprivileged service user, a system service
# with no login session and so no systemd user bus. The CLI install runs as
# root and never reaches the user-service code paths this one does.
#
# Usage (run as root, on a host bootstrapped with install.sh --skip-install-run):
#   web-install-e2e.sh assert-no-user-bus
#   web-install-e2e.sh run <request.json> <final-job.json>
#
# Exit codes: 0 pass, 1 check failed, 64 usage error.
set -euo pipefail

API_SERVICE="${API_SERVICE:-sovereign-node-api.service}"
API_URL="${API_URL:-http://127.0.0.1:8787}"
INSTALL_TIMEOUT_SECONDS="${INSTALL_TIMEOUT_SECONDS:-900}"
POLL_SECONDS="${POLL_SECONDS:-5}"

die() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

api_main_pid() {
  local pid
  pid="$(systemctl show -p MainPID --value "$API_SERVICE")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || die "$API_SERVICE is not running (MainPID=$pid)"
  printf '%s\n' "$pid"
}

# Without these the test would pass for the wrong reason: a service user that
# has a user bus takes the user-service path the CLI install never skips.
assert_no_user_bus() {
  local pid uid user environ
  pid="$(api_main_pid)"
  uid="$(stat -c %u "/proc/$pid")"
  user="$(stat -c %U "/proc/$pid")"
  [[ "$uid" != "0" ]] || die "$API_SERVICE runs as root; the web-install path runs unprivileged"
  environ="$(tr '\0' '\n' <"/proc/$pid/environ")"
  if grep -Eq '^(XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=' <<<"$environ"; then
    die "$API_SERVICE has a user-session environment: $(grep -E '^(XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=' <<<"$environ" | tr '\n' ' ')"
  fi
  [[ ! -e "/run/user/$uid/bus" ]] || die "/run/user/$uid/bus exists, so $user has a user bus"
  if [[ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" == "yes" ]]; then
    die "$user has lingering enabled, so it gets a user manager and bus"
  fi
  printf 'PASS %s runs as %s (uid %s) with no systemd user bus\n' "$API_SERVICE" "$user" "$uid"
}

wait_for_api() {
  local _
  for _ in $(seq 1 60); do
    curl -fsS --max-time 2 "$API_URL/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "$API_URL/healthz did not answer"
}

run_install() {
  local request_file=$1 out_file=$2 work token csrf job_id deadline state
  [[ -f "$request_file" ]] || die "request file not found: $request_file"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  wait_for_api
  token="$(sovereign-node setup-ui issue-bootstrap-token --ttl-minutes 30 --json | jq -er '.result.token')"
  csrf="$(curl -fsS -c "$work/cookies" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg token "$token" '{token: $token}')" \
    "$API_URL/api/auth/login" | jq -er '.result.csrf')"

  curl -fsS -b "$work/cookies" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
    --data @"$request_file" "$API_URL/api/install/run" >"$work/start.json" || {
    cat "$work/start.json" 2>/dev/null || true
    die "POST /api/install/run was refused"
  }
  job_id="$(jq -er '.result.job.jobId' "$work/start.json")"
  printf 'Install job %s started through %s\n' "$job_id" "$API_URL"

  deadline=$((SECONDS + INSTALL_TIMEOUT_SECONDS))
  while :; do
    curl -fsS -b "$work/cookies" "$API_URL/api/install/jobs/$job_id" >"$out_file"
    state="$(jq -r '.result.job.state' "$out_file")"
    case "$state" in
      succeeded | failed | canceled) break ;;
    esac
    ((SECONDS < deadline)) || die "install job $job_id still $state after ${INSTALL_TIMEOUT_SECONDS}s"
    sleep "$POLL_SECONDS"
  done

  jq '{state: .result.job.state, gateway: .result.gateway, steps: [.result.job.steps[] | {id, state, error: (.error // null)}]}' "$out_file"
  [[ "$state" == "succeeded" ]] || die "install job $job_id ended $state"
  printf 'PASS install job %s succeeded\n' "$job_id"
}

case "${1:-}" in
  assert-no-user-bus)
    assert_no_user_bus
    ;;
  run)
    [[ $# -eq 3 ]] || {
      printf 'usage: %s run <request.json> <final-job.json>\n' "$0" >&2
      exit 64
    }
    run_install "$2" "$3"
    ;;
  *)
    printf 'usage: %s assert-no-user-bus | run <request.json> <final-job.json>\n' "$0" >&2
    exit 64
    ;;
esac
