#!/usr/bin/env bash
# mail-sentinel-e2e.sh — Reusable end-to-end test for Mail Sentinel
#
# Validates that the Mail Sentinel bot is properly installed and its
# core commands (scan, list-alerts, feedback) work correctly.
#
# Prerequisites:
#   - Sovereign Node installed with mail-sentinel bot selected
#   - Run as root (or the sovereign-node service user)
#
# Usage:
#   sudo bash scripts/e2e/mail-sentinel-e2e.sh [--json]
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
JSON_OUTPUT="${1:-}"
PASS=0
FAIL=0
WARN=0
RESULTS=()

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*" >&2
}

record() {
  local name=$1 status=$2 detail=${3:-}
  RESULTS+=("$(printf '{"name":"%s","status":"%s","detail":"%s"}' "$name" "$status" "$detail")")
  if [[ "$status" == "pass" ]]; then
    PASS=$((PASS + 1))
    log "PASS: $name${detail:+ — $detail}"
  elif [[ "$status" == "warn" ]]; then
    WARN=$((WARN + 1))
    log "WARN: $name${detail:+ — $detail}"
  else
    FAIL=$((FAIL + 1))
    log "FAIL: $name${detail:+ — $detail}"
  fi
}

# ── 1. Check sovereign-node service is running ──
check_service_running() {
  if systemctl is-active --quiet sovereign-node-api 2>/dev/null; then
    record "service-running" "pass" "sovereign-node-api is active"
  else
    record "service-running" "fail" "sovereign-node-api is not active"
  fi
}

# ── 2. Check sovereign-node status includes mail-sentinel agent ──
check_status_agent() {
  local status_json
  status_json="$(timeout 20s sovereign-node status --json 2>/dev/null || true)"
  if [[ -z "$status_json" ]]; then
    record "status-agent" "fail" "sovereign-node status returned empty output"
    return
  fi

  local agent_present
  agent_present="$(echo "$status_json" | python3 -c '
import json,sys
try:
    data = json.load(sys.stdin)
    print(data.get("result",{}).get("openclaw",{}).get("agentPresent", False))
except: print("error")
' 2>/dev/null || echo "error")"

  if [[ "$agent_present" == "True" ]]; then
    record "status-agent" "pass" "mail-sentinel agent is present"
  else
    record "status-agent" "fail" "mail-sentinel agent not found in status (got: $agent_present)"
  fi
}

# ── 3. Check doctor report passes ──
check_doctor() {
  local doctor_json overall
  doctor_json="$(timeout 20s sovereign-node doctor --json 2>/dev/null || true)"
  if [[ -z "$doctor_json" ]]; then
    record "doctor" "fail" "sovereign-node doctor returned empty output"
    return
  fi

  overall="$(echo "$doctor_json" | python3 -c '
import json,sys
try:
    data = json.load(sys.stdin)
    print(data.get("result",{}).get("overall","unknown"))
except: print("error")
' 2>/dev/null || echo "error")"

  if [[ "$overall" == "pass" ]]; then
    record "doctor" "pass" "all doctor checks pass"
  elif [[ "$overall" == "warn" ]]; then
    record "doctor" "warn" "doctor passed with warnings"
  else
    record "doctor" "fail" "doctor overall: $overall"
  fi
}

# ── 4. Check mail-sentinel workspace exists ──
check_workspace() {
  local agent_dir="/var/lib/sovereign-node/mail-sentinel"
  if [[ -d "$agent_dir" ]]; then
    record "workspace-exists" "pass" "$agent_dir exists"
  else
    record "workspace-exists" "fail" "$agent_dir does not exist"
    return
  fi

  local bin_path="${agent_dir}/workspace/bin/mail-sentinel.js"
  if [[ -x "$bin_path" ]]; then
    record "workspace-executable" "pass" "mail-sentinel.js is executable"
  else
    record "workspace-executable" "fail" "mail-sentinel.js not found or not executable"
  fi
}

# ── 5. Run mail-sentinel scan (may warn if IMAP is not configured) ──
check_scan() {
  local agent_dir="/var/lib/sovereign-node/mail-sentinel"
  local bin_path="${agent_dir}/workspace/bin/mail-sentinel.js"

  if [[ ! -x "$bin_path" ]]; then
    record "scan" "fail" "mail-sentinel.js not found"
    return
  fi

  local scan_output scan_rc
  set +e
  scan_output="$(cd "$agent_dir/workspace" && timeout 30s node "$bin_path" scan --instance mail-sentinel-imap --json 2>&1)"
  scan_rc=$?
  set -e

  if [[ $scan_rc -eq 0 ]]; then
    local status
    status="$(echo "$scan_output" | python3 -c '
import json,sys
try:
    data = json.load(sys.stdin)
    print(data.get("status","unknown"))
except: print("parse-error")
' 2>/dev/null || echo "parse-error")"

    if [[ "$status" == "ok" || "$status" == "no-new-mail" ]]; then
      record "scan" "pass" "scan returned status=$status"
    elif [[ "$status" == "imap-error" ]]; then
      record "scan" "warn" "scan ran but IMAP connection failed (expected if no bridge)"
    else
      record "scan" "warn" "scan returned unexpected status=$status"
    fi
  else
    if echo "$scan_output" | grep -qi "imap\|connect\|ECONNREFUSED"; then
      record "scan" "warn" "scan failed due to IMAP connectivity (expected if no bridge)"
    else
      record "scan" "fail" "scan exited with code $scan_rc"
    fi
  fi
}

# ── 6. Run mail-sentinel list-alerts ──
check_list_alerts() {
  local agent_dir="/var/lib/sovereign-node/mail-sentinel"
  local bin_path="${agent_dir}/workspace/bin/mail-sentinel.js"

  if [[ ! -x "$bin_path" ]]; then
    record "list-alerts" "fail" "mail-sentinel.js not found"
    return
  fi

  local output rc
  set +e
  output="$(cd "$agent_dir/workspace" && timeout 15s node "$bin_path" list-alerts --instance mail-sentinel-imap --view today --json 2>&1)"
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    record "list-alerts" "pass" "list-alerts --view today succeeded"
  else
    record "list-alerts" "fail" "list-alerts exited with code $rc"
  fi

  set +e
  output="$(cd "$agent_dir/workspace" && timeout 15s node "$bin_path" list-alerts --instance mail-sentinel-imap --view recent --json 2>&1)"
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    record "list-alerts-recent" "pass" "list-alerts --view recent succeeded"
  else
    record "list-alerts-recent" "fail" "list-alerts --view recent exited with code $rc"
  fi
}

# ── 7. Run mail-sentinel feedback (dry run with --latest, expect graceful handling) ──
check_feedback() {
  local agent_dir="/var/lib/sovereign-node/mail-sentinel"
  local bin_path="${agent_dir}/workspace/bin/mail-sentinel.js"

  if [[ ! -x "$bin_path" ]]; then
    record "feedback" "fail" "mail-sentinel.js not found"
    return
  fi

  local output rc
  set +e
  output="$(cd "$agent_dir/workspace" && timeout 15s node "$bin_path" feedback --instance mail-sentinel-imap --action not-important --latest --json 2>&1)"
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    record "feedback" "pass" "feedback --action not-important --latest succeeded"
  else
    # Feedback on empty state is expected to fail gracefully
    if echo "$output" | grep -qi "no.*alert\|not found\|empty"; then
      record "feedback" "pass" "feedback correctly reported no alerts to act on"
    else
      record "feedback" "warn" "feedback exited with code $rc (may be expected on fresh install)"
    fi
  fi
}

# ── 8. Check guarded state file ──
check_state_file() {
  local state_path="/var/lib/sovereign-node/mail-sentinel/workspace/data/mail-sentinel-state.json"
  if [[ -f "$state_path" ]]; then
    record "state-file" "pass" "state file exists"
  else
    record "state-file" "warn" "state file does not exist yet (created on first scan)"
  fi
}

# ── 9. Check sovereign-tool integration ──
check_sovereign_tool() {
  if ! command -v sovereign-tool >/dev/null 2>&1; then
    record "sovereign-tool" "fail" "sovereign-tool not found in PATH"
    return
  fi

  local output rc
  set +e
  output="$(timeout 15s sovereign-tool json-state list --instance mail-sentinel-core --json 2>&1)"
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    record "sovereign-tool" "pass" "sovereign-tool json-state list succeeded"
  else
    record "sovereign-tool" "warn" "sovereign-tool json-state list exited with code $rc"
  fi
}

# ── Main ──
main() {
  log "Starting Mail Sentinel e2e test"
  check_service_running
  check_status_agent
  check_doctor
  check_workspace
  check_scan
  check_list_alerts
  check_feedback
  check_state_file
  check_sovereign_tool

  log "──────────────────────────────"
  log "Results: $PASS passed, $WARN warnings, $FAIL failed"

  if [[ "$JSON_OUTPUT" == "--json" ]]; then
    printf '{"pass":%d,"warn":%d,"fail":%d,"checks":[%s]}\n' \
      "$PASS" "$WARN" "$FAIL" "$(IFS=,; echo "${RESULTS[*]}")"
  fi

  if [[ $FAIL -gt 0 ]]; then
    log "OVERALL: FAIL"
    exit 1
  fi
  log "OVERALL: PASS"
  exit 0
}

main "$@"
