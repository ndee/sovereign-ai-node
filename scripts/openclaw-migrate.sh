#!/usr/bin/env bash
# Unattended, staged migration of the bundled OpenClaw runtime to a newer
# release line, run as root on an installed node.
#
#   bash scripts/openclaw-migrate.sh --target <openclaw version> --out <dir> [--dry-run]
#
# Writes <out>/migration.log (secrets redacted), <out>/result.json and
# <out>/npm-shrinkwrap.json. Exits 0 only when every step succeeded.
#
# The file is deliberately self-contained (its JSON/semver helpers are inline
# Node.js) so it can be copied onto a device on its own.

# Steps are dispatched by name through run_step, which shellcheck cannot follow.
# shellcheck disable=SC2317
set -uo pipefail

SCRIPT_NAME="openclaw-migrate"
RESULT_SCHEMA=1

# ---------------------------------------------------------------------------
# Tunables. Defaults match a node installed by this repository's installer;
# every one can be overridden from the environment for a non-standard layout.
# ---------------------------------------------------------------------------
UNIT_DIR="${OPENCLAW_MIGRATE_UNIT_DIR:-/etc/systemd/system}"
GATEWAY_UNIT="${OPENCLAW_MIGRATE_GATEWAY_UNIT:-sovereign-openclaw-gateway.service}"
DEFAULT_SERVICE_USER="sovereign-node"
DEFAULT_SERVICE_HOME="/var/lib/sovereign-node/openclaw-home"
BACKUP_ROOT="${OPENCLAW_MIGRATE_BACKUP_ROOT:-/var/backups/sovereign-node/openclaw-migrate}"
LOCK_FILE="${OPENCLAW_MIGRATE_LOCK_FILE:-/run/sovereign-openclaw-migrate.lock}"
GATEWAY_URL="${OPENCLAW_MIGRATE_GATEWAY_URL:-http://127.0.0.1:18789/}"
NODE_MIN="${OPENCLAW_MIGRATE_NODE_MIN:-22.22.3}"
NODE_MAX_EXCLUSIVE="${OPENCLAW_MIGRATE_NODE_MAX_EXCLUSIVE:-23.0.0}"
# The last 6.x patch. The Matrix plugin dropped its migration of the legacy
# flat store in 2026.8.1, so a node that still has one must pass through a
# 2026.6 release (doctor --fix, then one gateway start) first.
STAGE_VERSION="${OPENCLAW_MIGRATE_STAGE_VERSION:-2026.6.35}"
STAGE_SETTLE="${OPENCLAW_MIGRATE_STAGE_SETTLE:-30}"
MIN_FREE_BYTES="${OPENCLAW_MIGRATE_MIN_FREE_BYTES:-1073741824}"
DOCTOR_TIMEOUT="${OPENCLAW_MIGRATE_DOCTOR_TIMEOUT:-600}"
CMD_TIMEOUT="${OPENCLAW_MIGRATE_CMD_TIMEOUT:-180}"
NPM_TIMEOUT="${OPENCLAW_MIGRATE_NPM_TIMEOUT:-1800}"
HEALTH_TIMEOUT="${OPENCLAW_MIGRATE_HEALTH_TIMEOUT:-240}"
HEALTH_POLL="${OPENCLAW_MIGRATE_HEALTH_POLL:-3}"
STOP_TIMEOUT="${OPENCLAW_MIGRATE_STOP_TIMEOUT:-120}"
# Space-separated argument lists for the OpenClaw CLI. Kept overridable so a
# trial run can adapt to a changed CLI surface without editing the script.
DOCTOR_ARGS="${OPENCLAW_MIGRATE_DOCTOR_ARGS:-doctor --fix --non-interactive}"
VALIDATE_ARGS="${OPENCLAW_MIGRATE_VALIDATE_ARGS:-config validate}"
MATRIX_VERIFY_ARGS="${OPENCLAW_MIGRATE_MATRIX_VERIFY_ARGS:-matrix verify status}"
# Matrix left core in 2026.5.x; %VERSION% is replaced by the OpenClaw version
# being installed so plugin and host stay in lockstep. Empty disables it.
DEFAULT_MATRIX_PLUGIN_ARGS="plugins install npm:@openclaw/matrix@%VERSION% --force"
MATRIX_PLUGIN_ARGS="${OPENCLAW_MIGRATE_MATRIX_PLUGIN_ARGS-$DEFAULT_MATRIX_PLUGIN_ARGS}"
# auto: opt in to a private/loopback homeserver only when the configured one is.
ALLOW_PRIVATE_MATRIX="${OPENCLAW_MIGRATE_ALLOW_PRIVATE_MATRIX:-auto}"
# The /tools/invoke session the mail review uses; probed for llm-task.
LLM_TASK_SESSION="${OPENCLAW_MIGRATE_LLM_TASK_SESSION:-agent:mail-sentinel:main}"
# What a CLI prints when it wanted to ask something. Doctor does not prompt
# without a TTY upstream; this catches it if that ever changes.
PROMPT_REGEX="${OPENCLAW_MIGRATE_PROMPT_REGEX:-(\(y/n\)|\[y/n\]|\by/N\b|\bY/n\b|ExitPromptError|force closed the prompt|prompt was cancel|cancelled by user|not a tty|stdin is not a|use arrow keys|press (enter|space|return) to|^\s*[◆◇]\s.*\?\s*$|\?\s*›)}"

# ---------------------------------------------------------------------------
# Runtime state.
# ---------------------------------------------------------------------------
TARGET=""
OUT_DIR=""
DRY_RUN=0
FROM_VERSION=""
SERVICE_USER=""
SERVICE_HOME=""
STATE_DIR=""
CONFIG_PATH=""
ENV_FILE=""
UNIT_PATH=""
OPENCLAW_BIN=""
PKG_DIR=""
NPM_PREFIX=""
NPM_OWNER=""
NODE_BIN=""
NODE_VERSION=""
NODE_NEEDS_UPGRADE=0
FLAT_MATRIX_STORE=""
LOBSTER_BIN=""
SCAN_UNITS=()
ACTIVE_UNITS=()
TOUCHED=0
TOUCHED_BY=""
UNITS_STOPPED=0
RESUMING=0
ALREADY_DONE=0
BACKUP_PATH=""
BACKUP_BYTES=0
BACKUP_SOURCE_BYTES=0
PKG_BACKUP_PATH=""
DOCTOR_PROMPT_SEEN=false
DOCTOR_RUNS_FILE=""
LOBSTER_VERSION=""
LOBSTER_OK=false
LOBSTER_DETAIL=""
SHRINKWRAP_SOURCE=""
SHRINKWRAP_PACKAGES=0
FAILED_STEP=""
FINAL_MESSAGE=""
UNITS_RESTARTED=false
STEPS_FILE=""
LOG_FILE=""
WORK_DIR=""
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

usage() {
  cat <<'EOF'
Usage: bash scripts/openclaw-migrate.sh --target <openclaw version> --out <dir> [--dry-run]

Unattended staged migration of the bundled OpenClaw runtime. Run as root.

  --target <version>   OpenClaw release to migrate to (for example 2026.8.35)
  --out <dir>          Directory for migration.log, result.json, npm-shrinkwrap.json
  --dry-run            Print the plan and exit; changes nothing and writes nothing
  -h, --help           Show this help

Exit status is 0 only when every step succeeded. A second run against a node
that this script already migrated to <version> is a no-op success.
EOF
}

# ---------------------------------------------------------------------------
# Logging. Everything that reaches migration.log goes through redact first.
# ---------------------------------------------------------------------------
log() {
  local line
  line="[$SCRIPT_NAME] $(date -u +%H:%M:%S) $*"
  if [[ -n "$LOG_FILE" ]]; then
    printf '%s\n' "$line" | redact | tee -a "$LOG_FILE"
  else
    printf '%s\n' "$line"
  fi
}

die_usage() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  usage >&2
  exit 2
}

# Strips secret values from a stream: every value in the gateway env file,
# the gateway token from the OpenClaw config, and common token shapes.
# shellcheck disable=SC2016
REDACT_JS='
const fs = require("node:fs");
const [envFile, configPath] = process.argv.slice(1);
const secrets = new Set();
try {
  for (const raw of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m) continue;
    const value = m[2].trim().replace(/^(["\x27])(.*)\1$/, "$2");
    if (/(TOKEN|KEY|SECRET|PASSWORD|PASS)/i.test(m[1]) && value.length >= 4) secrets.add(value);
  }
} catch {}
try {
  const text = fs.readFileSync(configPath, "utf8");
  const re = /"?(?:token|accessToken|password|apiKey|secret)"?\s*:\s*"([^"]{4,})"/gi;
  for (const m of text.matchAll(re)) secrets.add(m[1]);
} catch {}
const ordered = [...secrets].sort((a, b) => b.length - a.length);
const patterns = [
  /sk-or-v1-[A-Za-z0-9]+/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /syt_[A-Za-z0-9_]+/g,
  /(authorization:\s*bearer\s+)[^\s"]+/gi,
  /((?:access_?token|api_?key|password|secret|token)["\x27]?\s*[:=]\s*["\x27]?)[^\s"\x27,}]{4,}/gi,
];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  let out = input;
  for (const s of ordered) out = out.split(s).join("<redacted>");
  for (const p of patterns) out = out.replace(p, (_m, keep) => (typeof keep === "string" ? keep : "") + "<redacted>");
  process.stdout.write(out);
});
'

redact() {
  if [[ -n "$NODE_BIN" ]]; then
    "$NODE_BIN" -e "$REDACT_JS" "${ENV_FILE:-/nonexistent}" "${CONFIG_PATH:-/nonexistent}"
  else
    sed -E 's/(token|password|secret|api_?key)([=:]\s*)\S+/\1\2<redacted>/Ig'
  fi
}

# Appends a command's captured output to the log, redacted and indented.
log_output() {
  local file="$1"
  [[ -s "$file" && -n "$LOG_FILE" ]] || return 0
  redact <"$file" | sed 's/^/    | /' >>"$LOG_FILE"
}

# ---------------------------------------------------------------------------
# Small helpers.
# ---------------------------------------------------------------------------
# Compares two dotted versions (numeric segments, pre-release ignored).
# Prints -1, 0 or 1.
version_cmp() {
  local IFS=.
  local -a a b
  read -r -a a <<<"${1%%-*}"
  read -r -a b <<<"${2%%-*}"
  local i x y
  for ((i = 0; i < 3; i++)); do
    x="${a[i]:-0}"
    y="${b[i]:-0}"
    x="${x//[^0-9]/}"
    y="${y//[^0-9]/}"
    if ((10#${x:-0} < 10#${y:-0})); then
      echo -1
      return
    fi
    if ((10#${x:-0} > 10#${y:-0})); then
      echo 1
      return
    fi
  done
  echo 0
}

version_lt() { [[ "$(version_cmp "$1" "$2")" == "-1" ]]; }

json_field() {
  # json_field <file> <dotted.path> — prints the value or nothing.
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    try {
      let v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const k of process.argv[2].split(".")) v = v == null ? undefined : v[k];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    } catch {}
  ' "$1" "$2"
}

unit_value() {
  # unit_value <unit file> <Key> — last assignment wins, like systemd.
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

unit_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^Environment=${key}=//p" "$file" | tail -n 1
}

# Reads a non-secret KEY=VALUE from the gateway env file.
env_file_value() {
  local file="$1" key="$2"
  [[ -r "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

bytes_of() {
  du -sb "$1" 2>/dev/null | cut -f1
}

free_bytes() {
  local dir="$1"
  while [[ ! -e "$dir" && "$dir" != "/" ]]; do dir="$(dirname "$dir")"; done
  df -PB1 "$dir" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

device_of() {
  local dir="$1"
  while [[ ! -e "$dir" && "$dir" != "/" ]]; do dir="$(dirname "$dir")"; done
  stat -c %d "$dir"
}

# Runs a command as <user>, keeping the caller's environment out of it.
as_user() {
  local user="$1"
  shift
  if [[ "$(id -un)" == "$user" ]]; then
    "$@"
  else
    runuser -u "$user" -- "$@"
  fi
}

# The service user loads the gateway env file itself, so its secrets never
# appear in an argument list visible in /proc.
# shellcheck disable=SC2016
ENV_LOADER='f="$1"; shift; if [ -r "$f" ]; then while IFS= read -r l || [ -n "$l" ]; do case "$l" in [A-Za-z_]*=*) export "$l" ;; esac; done < "$f"; fi; exec "$@"'

# Runs the OpenClaw CLI as the service user with the gateway's environment.
# Stdin is closed: an upstream step that wants to ask something must see EOF
# instead of waiting for an answer that will never come.
openclaw_cli() {
  local timeout_s="$1"
  shift
  as_user "$SERVICE_USER" env -i \
    HOME="$SERVICE_HOME" \
    PATH="$UNIT_PATH" \
    OPENCLAW_HOME="$SERVICE_HOME" \
    OPENCLAW_CONFIG="$CONFIG_PATH" \
    OPENCLAW_CONFIG_PATH="$CONFIG_PATH" \
    CI=1 NO_COLOR=1 TERM=dumb \
    timeout -k 10 "$timeout_s" bash -c "$ENV_LOADER" _ "$ENV_FILE" "$OPENCLAW_BIN" "$@" </dev/null
}

# Same npm invocation the installer uses for OpenClaw (`npm install -g
# openclaw@<v>` with CI=1, HOME, NPM_CONFIG_CACHE and the install prefix),
# run as the owner of the existing tree so ownership does not change.
npm_install_openclaw() {
  local version="$1" out="$2" home
  home="$(getent passwd "$NPM_OWNER" | cut -d: -f6)"
  [[ -n "$home" ]] || home="$SERVICE_HOME"
  as_user "$NPM_OWNER" env -i \
    HOME="$home" \
    PATH="$UNIT_PATH" \
    CI=1 \
    NPM_CONFIG_CACHE="$home/.npm" \
    npm_config_prefix="$NPM_PREFIX" \
    timeout -k 30 "$NPM_TIMEOUT" npm install -g "openclaw@${version}" </dev/null >"$out" 2>&1
}

installed_openclaw_version() {
  json_field "$PKG_DIR/package.json" version
}

systemctl_quiet() {
  systemctl "$@" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Step bookkeeping.
# ---------------------------------------------------------------------------
record_step() {
  # record_step <name> <ok:true|false> <seconds> <skipped:true|false> <detail>
  local detail="${5//$'\t'/ }"
  detail="${detail//$'\n'/ }"
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$detail" >>"$STEPS_FILE"
}

STEP_DETAIL=""
run_step() {
  local name="$1" fn="$2" start rc
  STEP_DETAIL=""
  log "step $name: start"
  start="$(date +%s)"
  "$fn"
  rc=$?
  local seconds=$(($(date +%s) - start))
  if ((rc == 0)); then
    record_step "$name" true "$seconds" false "$STEP_DETAIL"
    log "step $name: ok (${seconds}s)${STEP_DETAIL:+ - $STEP_DETAIL}"
    return 0
  fi
  record_step "$name" false "$seconds" false "$STEP_DETAIL"
  log "step $name: FAILED (${seconds}s)${STEP_DETAIL:+ - $STEP_DETAIL}"
  FAILED_STEP="$name"
  fail_closed
}

skip_step() {
  record_step "$1" true 0 true "$2"
  log "step $1: skipped - $2"
}

mark_touched() {
  if ((TOUCHED == 0)); then
    TOUCHED=1
    TOUCHED_BY="$1"
    write_marker in-progress
  fi
}

# ---------------------------------------------------------------------------
# Marker: lets a re-run tell "already migrated" from "half migrated".
# ---------------------------------------------------------------------------
marker_path() { printf '%s/state.json' "$BACKUP_ROOT"; }

write_marker() {
  local status="$1"
  mkdir -p "$BACKUP_ROOT" && chmod 0700 "$BACKUP_ROOT"
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [path, status, from, target, backup, pkg, bytes] = process.argv.slice(1);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
    const sameRun = prev.target === target && prev.status !== "completed";
    const next = {
      status, target,
      from: sameRun && prev.from ? prev.from : from,
      backup: { path: (sameRun && prev.backup?.path) || backup || null,
                package: (sameRun && prev.backup?.package) || pkg || null,
                bytes: (sameRun && prev.backup?.bytes) || Number(bytes) || 0 },
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path + ".tmp", JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(path + ".tmp", path);
  ' "$(marker_path)" "$status" "$FROM_VERSION" "$TARGET" "$BACKUP_PATH" "$PKG_BACKUP_PATH" "$BACKUP_BYTES"
}

marker_field() {
  [[ -f "$(marker_path)" ]] || return 0
  json_field "$(marker_path)" "$1"
}

# ---------------------------------------------------------------------------
# Unit handling.
# ---------------------------------------------------------------------------
discover_scan_units() {
  local f
  SCAN_UNITS=()
  for f in "$UNIT_DIR"/sovereign-*scan*.timer "$UNIT_DIR"/sovereign-*scan*.service; do
    [[ -e "$f" ]] || continue
    SCAN_UNITS+=("$(basename "$f")")
  done
}

# Units to stop, timers first so nothing new is scheduled mid-migration.
units_in_stop_order() {
  local u
  for u in "${SCAN_UNITS[@]}"; do [[ "$u" == *.timer ]] && printf '%s\n' "$u"; done
  for u in "${SCAN_UNITS[@]}"; do [[ "$u" == *.service ]] && printf '%s\n' "$u"; done
  printf '%s\n' "$GATEWAY_UNIT"
}

record_active_units() {
  local u
  ACTIVE_UNITS=()
  while IFS= read -r u; do
    if systemctl_quiet is-active "$u"; then
      ACTIVE_UNITS+=("$u")
    fi
  done < <(units_in_stop_order)
}

# Starts the gateway, then whatever scan unit was running before. A scan
# service with a timer is left to its timer: it is a one-shot job.
start_units() {
  local u rc=0
  systemctl start "$GATEWAY_UNIT" >>"$LOG_FILE" 2>&1 || rc=1
  for u in "${ACTIVE_UNITS[@]}"; do
    [[ "$u" == "$GATEWAY_UNIT" ]] && continue
    if [[ "$u" == *.service && -e "$UNIT_DIR/${u%.service}.timer" ]]; then
      continue
    fi
    systemctl start "$u" >>"$LOG_FILE" 2>&1 || rc=1
  done
  return "$rc"
}

# ---------------------------------------------------------------------------
# Failure handling.
# ---------------------------------------------------------------------------
fail_closed() {
  local backup_hint=""
  if [[ -n "$BACKUP_PATH" ]]; then
    backup_hint=" State backup: $BACKUP_PATH."
    [[ -n "$PKG_BACKUP_PATH" ]] && backup_hint+=" Package backup: $PKG_BACKUP_PATH."
  fi
  if ((TOUCHED == 0)); then
    if ((UNITS_STOPPED == 1)); then
      if start_units; then
        UNITS_RESTARTED=true
        FINAL_MESSAGE="Step '$FAILED_STEP' failed before anything was changed; units were restarted on the unchanged OpenClaw $FROM_VERSION.$backup_hint"
      else
        FINAL_MESSAGE="Step '$FAILED_STEP' failed before anything was changed, but restarting the units on OpenClaw $FROM_VERSION failed too; check 'systemctl status $GATEWAY_UNIT'.$backup_hint"
      fi
    else
      FINAL_MESSAGE="Step '$FAILED_STEP' failed before anything was changed; no unit was stopped and OpenClaw $FROM_VERSION is untouched.$backup_hint"
    fi
  else
    local rollback=""
    if [[ -n "$BACKUP_PATH" && -n "$PKG_BACKUP_PATH" ]]; then
      rollback=" To roll back: systemctl stop $GATEWAY_UNIT; rm -rf '$PKG_DIR' && tar -xzpf '$PKG_BACKUP_PATH' -C '$(dirname "$PKG_DIR")'; rm -rf '$STATE_DIR' && tar -xzpf '$BACKUP_PATH' -C '$SERVICE_HOME'; systemctl start $GATEWAY_UNIT."
    fi
    FINAL_MESSAGE="Step '$FAILED_STEP' failed after '$TOUCHED_BY' had already changed the OpenClaw tree or state, so the units were NOT restarted on the old version (it is no longer intact).${backup_hint}${rollback}"
  fi
  log "$FINAL_MESSAGE"
  finish 1
}

# shellcheck disable=SC2016
RESULT_JS='
const fs = require("node:fs");
const [stepsFile, out, ok, target, from, backupPath, backupBytes, backupSourceBytes, pkgBackup,
  promptSeen, runsFile, lobVersion, lobOk, lobDetail, swSource, swPackages, message, failedStep,
  unitsRestarted, startedAt, dryRun, alreadyDone, resumed, schema] = process.argv.slice(1);
const steps = [];
try {
  for (const line of fs.readFileSync(stepsFile, "utf8").split("\n")) {
    if (!line) continue;
    const [name, sok, seconds, skipped, detail] = line.split("\t");
    const step = { name, ok: sok === "true", seconds: Number(seconds) || 0 };
    if (skipped === "true") step.skipped = true;
    if (detail) step.detail = detail;
    steps.push(step);
  }
} catch {}
const runs = [];
try {
  for (const line of fs.readFileSync(runsFile, "utf8").split("\n")) {
    if (!line) continue;
    const [version, phase, exitCode, timedOut, seen] = line.split("\t");
    runs.push({ version, phase, exit: Number(exitCode), timed_out: timedOut === "true",
      interactive_prompt_seen: seen === "true" });
  }
} catch {}
const result = {
  ok: ok === "true",
  target,
  from: from || null,
  steps,
  lobster: { version: lobVersion || null, ok: lobOk === "true", ...(lobDetail ? { detail: lobDetail } : {}) },
  doctor: { interactive_prompt_seen: promptSeen === "true", runs },
  backup: { path: backupPath || null, bytes: Number(backupBytes) || 0,
    source_bytes: Number(backupSourceBytes) || 0, package_path: pkgBackup || null },
  shrinkwrap: { source: swSource || null, packages: Number(swPackages) || 0 },
  already_migrated: alreadyDone === "true",
  resumed: resumed === "true",
  failed_step: failedStep || null,
  units_restarted_on_old_version: unitsRestarted === "true",
  message: message || null,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  schema: Number(schema),
};
fs.writeFileSync(out + ".tmp", JSON.stringify(result, null, 2) + "\n");
fs.renameSync(out + ".tmp", out);
'

write_result() {
  local ok="$1"
  "$NODE_BIN" -e "$RESULT_JS" \
    "$STEPS_FILE" "$OUT_DIR/result.json" "$ok" "$TARGET" "$FROM_VERSION" \
    "$BACKUP_PATH" "$BACKUP_BYTES" "$BACKUP_SOURCE_BYTES" "$PKG_BACKUP_PATH" \
    "$DOCTOR_PROMPT_SEEN" "$DOCTOR_RUNS_FILE" "$LOBSTER_VERSION" "$LOBSTER_OK" "$LOBSTER_DETAIL" \
    "$SHRINKWRAP_SOURCE" "$SHRINKWRAP_PACKAGES" "$FINAL_MESSAGE" "$FAILED_STEP" \
    "$UNITS_RESTARTED" "$STARTED_AT" "$DRY_RUN" \
    "$([[ $ALREADY_DONE == 1 ]] && echo true || echo false)" \
    "$([[ $RESUMING == 1 ]] && echo true || echo false)" "$RESULT_SCHEMA"
}

finish() {
  local rc="$1"
  if [[ -n "$NODE_BIN" ]]; then
    write_result "$([[ $rc == 0 ]] && echo true || echo false)" ||
      log "could not write $OUT_DIR/result.json"
  else
    # Without a usable node there is no JSON writer; emit a minimal result.
    # TARGET is validated against a version pattern, so it needs no escaping.
    printf '{"ok":false,"target":"%s","from":null,"steps":[],"lobster":{"version":null,"ok":false},"doctor":{"interactive_prompt_seen":false},"backup":{"path":null,"bytes":0},"failed_step":"%s","message":"no node runtime found to write the full result"}\n' \
      "$TARGET" "${FAILED_STEP:-preflight}" >"$OUT_DIR/result.json"
  fi
  [[ -n "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
  log "result: $OUT_DIR/result.json (exit $rc)"
  exit "$rc"
}

# ---------------------------------------------------------------------------
# Discovery (read-only; shared by --dry-run and the real run).
# ---------------------------------------------------------------------------
DISCOVERY_ERROR=""
discover() {
  local unit_file="$UNIT_DIR/$GATEWAY_UNIT" exec_start real
  if [[ ! -f "$unit_file" ]]; then
    DISCOVERY_ERROR="gateway unit $unit_file not found"
    return 1
  fi
  SERVICE_USER="${OPENCLAW_MIGRATE_SERVICE_USER:-$(unit_value "$unit_file" User)}"
  SERVICE_USER="${SERVICE_USER:-$DEFAULT_SERVICE_USER}"
  SERVICE_HOME="${OPENCLAW_MIGRATE_SERVICE_HOME:-$(unit_env_value "$unit_file" HOME)}"
  SERVICE_HOME="${SERVICE_HOME:-$(unit_value "$unit_file" WorkingDirectory)}"
  SERVICE_HOME="${SERVICE_HOME:-$DEFAULT_SERVICE_HOME}"
  STATE_DIR="${OPENCLAW_MIGRATE_STATE_DIR:-$SERVICE_HOME/.openclaw}"
  UNIT_PATH="$(unit_env_value "$unit_file" PATH)"
  UNIT_PATH="${UNIT_PATH:-$SERVICE_HOME/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
  ENV_FILE="$(unit_value "$unit_file" EnvironmentFile)"
  ENV_FILE="${ENV_FILE#-}"
  ENV_FILE="${ENV_FILE:-$SERVICE_HOME/gateway.env}"
  CONFIG_PATH="$(env_file_value "$ENV_FILE" OPENCLAW_CONFIG_PATH)"
  CONFIG_PATH="${CONFIG_PATH:-$STATE_DIR/openclaw.json5}"

  exec_start="$(unit_value "$unit_file" ExecStart)"
  OPENCLAW_BIN="${OPENCLAW_MIGRATE_OPENCLAW_BIN:-${exec_start%% *}}"
  if [[ -z "$OPENCLAW_BIN" || "$OPENCLAW_BIN" != /* ]]; then
    OPENCLAW_BIN="$(PATH="$UNIT_PATH" command -v openclaw || true)"
  fi
  if [[ -z "$OPENCLAW_BIN" || ! -e "$OPENCLAW_BIN" ]]; then
    DISCOVERY_ERROR="openclaw binary not found (unit ExecStart: '${exec_start}')"
    return 1
  fi
  real="$(readlink -f "$OPENCLAW_BIN")"
  PKG_DIR="$(dirname "$real")"
  if [[ "$PKG_DIR" != */lib/node_modules/openclaw ]]; then
    DISCOVERY_ERROR="openclaw resolves to $real, which is not inside an npm global prefix (<prefix>/lib/node_modules/openclaw)"
    return 1
  fi
  NPM_PREFIX="${PKG_DIR%/lib/node_modules/openclaw}"
  NPM_OWNER="$(stat -c %U "$PKG_DIR")"

  NODE_BIN="${OPENCLAW_MIGRATE_NODE_BIN:-$(PATH="$UNIT_PATH" command -v node || true)}"
  if [[ -z "$NODE_BIN" ]]; then
    DISCOVERY_ERROR="no node executable on the gateway PATH ($UNIT_PATH)"
    return 1
  fi
  NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null)"
  NODE_VERSION="${NODE_VERSION#v}"
  FROM_VERSION="$(installed_openclaw_version)"
  if [[ -z "$FROM_VERSION" ]]; then
    DISCOVERY_ERROR="cannot read the installed OpenClaw version from $PKG_DIR/package.json"
    return 1
  fi

  discover_scan_units
  detect_flat_matrix_store
  discover_lobster
  return 0
}

# The pre-account Matrix layout kept its sync store and crypto directory
# directly under <state>/matrix/. Later releases only read the per-account
# layout (<state>/matrix/accounts/...), which the 6.x doctor migrates to.
detect_flat_matrix_store() {
  local m="$STATE_DIR/matrix" candidate
  FLAT_MATRIX_STORE=""
  for candidate in "$m/bot-storage.json" "$m/crypto" "$m/storage.json" "$m/sync-store.json"; do
    if [[ -e "$candidate" ]]; then
      FLAT_MATRIX_STORE="$candidate"
      return 0
    fi
  done
}

discover_lobster() {
  local home candidate
  LOBSTER_BIN="${OPENCLAW_MIGRATE_LOBSTER_BIN:-}"
  [[ -n "$LOBSTER_BIN" ]] && return 0
  home="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6)"
  for candidate in ${home:+"$home/.npm-global/bin/lobster"} "$SERVICE_HOME/.npm-global/bin/lobster"; do
    if [[ -x "$candidate" ]]; then
      LOBSTER_BIN="$candidate"
      return 0
    fi
  done
  LOBSTER_BIN="$(PATH="$UNIT_PATH" command -v lobster || true)"
}

node_in_range() {
  local v="$1"
  [[ -n "$v" ]] || return 1
  ! version_lt "$v" "$NODE_MIN" && version_lt "$v" "$NODE_MAX_EXCLUSIVE"
}

# ---------------------------------------------------------------------------
# Steps.
# ---------------------------------------------------------------------------
step_preflight() {
  if [[ -n "$DISCOVERY_ERROR" ]]; then
    STEP_DETAIL="$DISCOVERY_ERROR"
    return 1
  fi
  log "openclaw: $FROM_VERSION at $PKG_DIR (prefix $NPM_PREFIX, owner $NPM_OWNER)"
  log "service: user $SERVICE_USER, home $SERVICE_HOME, state $STATE_DIR, config $CONFIG_PATH"
  log "node: $NODE_VERSION ($NODE_BIN); required >=$NODE_MIN <$NODE_MAX_EXCLUSIVE"
  log "scan units: ${SCAN_UNITS[*]:-none}; flat matrix store: ${FLAT_MATRIX_STORE:-none}; lobster: ${LOBSTER_BIN:-not found}"

  if ! [[ -d "$STATE_DIR" ]]; then
    STEP_DETAIL="OpenClaw state dir $STATE_DIR does not exist"
    return 1
  fi
  if version_lt "$TARGET" "$FROM_VERSION"; then
    STEP_DETAIL="target $TARGET is older than the installed $FROM_VERSION; this script does not downgrade"
    return 1
  fi
  if [[ "$NODE_VERSION" =~ ^[0-9]+ ]] && ! version_lt "$NODE_VERSION" "$NODE_MAX_EXCLUSIVE"; then
    STEP_DETAIL="node $NODE_VERSION is above the supported range (<$NODE_MAX_EXCLUSIVE); this script does not downgrade Node"
    return 1
  fi
  if ! node_in_range "$NODE_VERSION"; then
    NODE_NEEDS_UPGRADE=1
    log "node $NODE_VERSION is below $NODE_MIN; it will be upgraded first"
  fi
  local tool
  for tool in npm timeout tar systemctl curl; do
    if ! PATH="$UNIT_PATH:$PATH" command -v "$tool" >/dev/null 2>&1; then
      STEP_DETAIL="required tool '$tool' not found"
      return 1
    fi
  done
  if ! systemctl cat "$GATEWAY_UNIT" >/dev/null 2>&1; then
    STEP_DETAIL="systemd does not know $GATEWAY_UNIT"
    return 1
  fi
  record_active_units
  log "units active before the migration: ${ACTIVE_UNITS[*]:-none}"

  if ((ALREADY_DONE == 1)); then
    STEP_DETAIL="already migrated to $TARGET"
    return 0
  fi
  local state_bytes pkg_bytes need_backup need_prefix free_backup free_prefix
  state_bytes="$(bytes_of "$STATE_DIR")"
  pkg_bytes="$(bytes_of "$PKG_DIR")"
  need_backup=$((state_bytes + pkg_bytes + MIN_FREE_BYTES))
  need_prefix=$((pkg_bytes + MIN_FREE_BYTES))
  free_backup="$(free_bytes "$BACKUP_ROOT")"
  free_prefix="$(free_bytes "$NPM_PREFIX")"
  if [[ "$(device_of "$BACKUP_ROOT")" == "$(device_of "$NPM_PREFIX")" ]]; then
    need_backup=$((need_backup + pkg_bytes))
    need_prefix=$need_backup
  fi
  log "disk: state ${state_bytes}B, package ${pkg_bytes}B; free ${free_backup}B at backup root, ${free_prefix}B at prefix"
  if ((free_backup < need_backup)); then
    STEP_DETAIL="not enough free space for the backup: need ${need_backup} bytes, have ${free_backup}"
    return 1
  fi
  if ((free_prefix < need_prefix)); then
    STEP_DETAIL="not enough free space in $NPM_PREFIX: need ${need_prefix} bytes, have ${free_prefix}"
    return 1
  fi
  STEP_DETAIL="from $FROM_VERSION to $TARGET; node $NODE_VERSION"
}

step_stop() {
  local u rc=0
  UNITS_STOPPED=1
  while IFS= read -r u; do
    if ! timeout "$STOP_TIMEOUT" systemctl stop "$u" >>"$LOG_FILE" 2>&1; then
      rc=1
      STEP_DETAIL="systemctl stop $u failed"
    fi
  done < <(units_in_stop_order)
  ((rc == 0)) || return 1
  if systemctl_quiet is-active "$GATEWAY_UNIT"; then
    STEP_DETAIL="$GATEWAY_UNIT is still active after stop"
    return 1
  fi
  STEP_DETAIL="stopped $(units_in_stop_order | tr '\n' ' ')"
}

step_backup() {
  local stamp dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$BACKUP_ROOT/$stamp-$FROM_VERSION"
  if ! mkdir -p "$dir" || ! chmod 0700 "$BACKUP_ROOT" "$dir"; then
    STEP_DETAIL="cannot create $dir"
    return 1
  fi
  BACKUP_SOURCE_BYTES="$(bytes_of "$STATE_DIR")"
  local state_archive="$dir/openclaw-state.tar.gz" pkg_archive="$dir/openclaw-package.tar.gz"
  if ! tar -C "$(dirname "$STATE_DIR")" --numeric-owner -czpf "$state_archive" "$(basename "$STATE_DIR")" 2>>"$LOG_FILE"; then
    STEP_DETAIL="tar of $STATE_DIR failed"
    return 1
  fi
  if ! tar -C "$(dirname "$PKG_DIR")" --numeric-owner -czpf "$pkg_archive" "$(basename "$PKG_DIR")" 2>>"$LOG_FILE"; then
    STEP_DETAIL="tar of $PKG_DIR failed"
    return 1
  fi
  if ! tar -tzf "$state_archive" >/dev/null 2>&1 || ! tar -tzf "$pkg_archive" >/dev/null 2>&1; then
    STEP_DETAIL="backup archive does not read back"
    return 1
  fi
  chmod 0600 "$state_archive" "$pkg_archive"
  BACKUP_PATH="$state_archive"
  PKG_BACKUP_PATH="$pkg_archive"
  BACKUP_BYTES="$(stat -c %s "$state_archive")"
  STEP_DETAIL="$BACKUP_PATH (${BACKUP_BYTES} bytes from ${BACKUP_SOURCE_BYTES} bytes of state)"
}

step_node() {
  # A newer Node 22 still runs the installed OpenClaw, so this step does not
  # count as touching the old tree.
  local out="$WORK_DIR/apt.out"
  {
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update -y &&
      DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --only-upgrade nodejs
  } </dev/null >"$out" 2>&1
  local rc=$?
  log_output "$out"
  NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null)"
  NODE_VERSION="${NODE_VERSION#v}"
  if ((rc != 0)); then
    STEP_DETAIL="apt-get upgrade of nodejs failed (exit $rc)"
    return 1
  fi
  if ! node_in_range "$NODE_VERSION"; then
    STEP_DETAIL="node is $NODE_VERSION after the upgrade; need >=$NODE_MIN <$NODE_MAX_EXCLUSIVE (install it from a repository that carries it)"
    return 1
  fi
  STEP_DETAIL="node $NODE_VERSION"
}

# Runs `openclaw doctor` with stdin at EOF and a hard timeout, and decides
# whether it tried to ask something. A prompt is a failure even when the CLI
# exits 0: the unattended path must not depend on a default answer.
run_doctor() {
  local version="$1" phase="$2" out="$WORK_DIR/doctor-$1-$2.out" rc timed_out=false seen=false
  # shellcheck disable=SC2086
  openclaw_cli "$DOCTOR_TIMEOUT" $DOCTOR_ARGS >"$out" 2>&1
  rc=$?
  log_output "$out"
  if ((rc == 124 || rc == 137)); then
    timed_out=true
    seen=true
  elif grep -qiE "$PROMPT_REGEX" "$out"; then
    seen=true
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$version" "$phase" "$rc" "$timed_out" "$seen" >>"$DOCTOR_RUNS_FILE"
  if [[ "$seen" == true ]]; then
    DOCTOR_PROMPT_SEEN=true
    if [[ "$timed_out" == true ]]; then
      STEP_DETAIL="doctor ($version, $phase) did not finish within ${DOCTOR_TIMEOUT}s with stdin closed (waiting for input)"
    else
      STEP_DETAIL="doctor ($version, $phase) asked an interactive question (exit $rc)"
    fi
    return 1
  fi
  if ((rc != 0)); then
    STEP_DETAIL="doctor ($version, $phase) exited $rc"
    return 1
  fi
  STEP_DETAIL="doctor ($version, $phase) ok"
}

install_version() {
  local version="$1" out="$WORK_DIR/npm-$1.out" got
  npm_install_openclaw "$version" "$out"
  local rc=$?
  log_output "$out"
  if ((rc != 0)); then
    STEP_DETAIL="npm install -g openclaw@$version exited $rc"
    return 1
  fi
  got="$(installed_openclaw_version)"
  if [[ "$got" != "$version" ]]; then
    STEP_DETAIL="after npm install the tree reports $got, expected $version"
    return 1
  fi
  return 0
}

# Is the configured homeserver one the Matrix plugin's SSRF guard blocks by
# default (loopback, RFC 1918, link-local, *.local/.internal, single label)?
matrix_homeserver_is_private() {
  local url host
  url="$(env_file_value "$ENV_FILE" MATRIX_HOMESERVER)"
  [[ -n "$url" ]] || url="$(json_field "$CONFIG_PATH" channels.matrix.homeserver)"
  [[ -n "$url" ]] || return 1
  host="${url#*://}"
  host="${host%%/*}"
  if [[ "$host" == \[* ]]; then
    host="${host#[}"
    host="${host%%]*}"
  else
    host="${host%%:*}"
  fi
  case "$host" in
    localhost | ::1 | 127.* | 10.* | 192.168.* | 169.254.* | *.local | *.internal | *.lan | fd* | fc*) return 0 ;;
    172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
  esac
  [[ "$host" != *.* ]]
}

# Installs the Matrix channel plugin matching <version> and, for a private
# homeserver, opts in to it. Both are config/state changes made through the
# CLI, so the plugin's own config contract decides what is valid.
install_matrix_plugin() {
  local version="$1" out="$WORK_DIR/matrix-plugin-$1.out" rc args allow
  if [[ -z "$MATRIX_PLUGIN_ARGS" ]]; then
    STEP_DETAIL="matrix plugin install disabled"
    return 0
  fi
  args="${MATRIX_PLUGIN_ARGS//%VERSION%/$version}"
  # shellcheck disable=SC2086
  openclaw_cli "$NPM_TIMEOUT" $args >"$out" 2>&1
  rc=$?
  log_output "$out"
  if ((rc != 0)); then
    STEP_DETAIL="openclaw $args exited $rc"
    return 1
  fi
  allow="$ALLOW_PRIVATE_MATRIX"
  if [[ "$allow" == auto ]]; then
    if matrix_homeserver_is_private; then allow=1; else allow=0; fi
  fi
  if [[ "$allow" == 1 ]]; then
    openclaw_cli "$CMD_TIMEOUT" config set channels.matrix.network.dangerouslyAllowPrivateNetwork true --strict-json >"$out" 2>&1
    rc=$?
    log_output "$out"
    if ((rc != 0)); then
      STEP_DETAIL="enabling channels.matrix.network.dangerouslyAllowPrivateNetwork exited $rc"
      return 1
    fi
    STEP_DETAIL="installed $args; private homeserver opt-in set"
    return 0
  fi
  STEP_DETAIL="installed $args"
}

# Holds the gateway up once on the stage release: the 2026.6 Matrix plugin
# finishes moving the flat store and recoverable room keys at startup.
run_stage_gateway() {
  systemctl start "$GATEWAY_UNIT" >>"$LOG_FILE" 2>&1 || {
    STEP_DETAIL="starting $GATEWAY_UNIT on $STAGE_VERSION failed"
    return 1
  }
  step_health || {
    STEP_DETAIL="on $STAGE_VERSION: $STEP_DETAIL"
    timeout "$STOP_TIMEOUT" systemctl stop "$GATEWAY_UNIT" >>"$LOG_FILE" 2>&1
    return 1
  }
  sleep "$STAGE_SETTLE"
  if ! timeout "$STOP_TIMEOUT" systemctl stop "$GATEWAY_UNIT" >>"$LOG_FILE" 2>&1; then
    STEP_DETAIL="stopping $GATEWAY_UNIT after the $STAGE_VERSION start failed"
    return 1
  fi
}

step_stage() {
  mark_touched stage
  install_version "$STAGE_VERSION" || return 1
  run_doctor "$STAGE_VERSION" config || return 1
  install_matrix_plugin "$STAGE_VERSION" || return 1
  run_doctor "$STAGE_VERSION" matrix || return 1
  run_stage_gateway || return 1
  STEP_DETAIL="ran $STAGE_VERSION (doctor, matrix plugin, one gateway start) to migrate the flat Matrix store ($FLAT_MATRIX_STORE)"
}

step_upgrade() {
  mark_touched upgrade
  install_version "$TARGET" || return 1
  STEP_DETAIL="installed openclaw@$TARGET into $NPM_PREFIX"
}

# Turns the installed tree into an npm-shrinkwrap.json without touching it:
# entries come from npm's hidden lockfile for the global prefix, re-rooted at
# the openclaw package and checked against what is actually on disk.
# shellcheck disable=SC2016
SHRINKWRAP_JS='
const fs = require("node:fs");
const path = require("node:path");
const [pkgDir, out] = process.argv.slice(1);
const prefixLib = path.dirname(path.dirname(pkgDir));
const hidden = path.join(prefixLib, "node_modules", ".package-lock.json");
const rootPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const root = { name: rootPkg.name, version: rootPkg.version };
for (const k of ["license", "dependencies", "optionalDependencies", "peerDependencies", "bin", "engines"]) {
  if (rootPkg[k] !== undefined) root[k] = rootPkg[k];
}
const packages = { "": root };
let source = "installed-tree";
let lock = null;
try { lock = JSON.parse(fs.readFileSync(hidden, "utf8")); } catch {}
const stem = "node_modules/" + rootPkg.name + "/";
if (lock && lock.packages) {
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith(stem)) continue;
    packages[key.slice(stem.length)] = entry;
  }
  if (Object.keys(packages).length > 1) source = "npm-hidden-lockfile";
}
// Walk the real tree: fills gaps the hidden lockfile does not cover and
// rejects a lockfile that disagrees with what is installed.
const walk = (dir, rel) => {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, "node_modules")); } catch { return; }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const scoped = name.startsWith("@") ? fs.readdirSync(path.join(dir, "node_modules", name)).map((n) => name + "/" + n) : [name];
    for (const full of scoped) {
      const abs = path.join(dir, "node_modules", full);
      const key = (rel ? rel + "/" : "") + "node_modules/" + full;
      let pj;
      try { pj = JSON.parse(fs.readFileSync(path.join(abs, "package.json"), "utf8")); } catch { continue; }
      const known = packages[key];
      if (known && known.version && known.version !== pj.version) {
        console.error("mismatch " + key + ": lockfile " + known.version + ", installed " + pj.version);
        process.exit(3);
      }
      if (!known) {
        const e = { version: pj.version };
        if (pj.license) e.license = pj.license;
        if (pj.dependencies) e.dependencies = pj.dependencies;
        if (pj.optionalDependencies) e.optionalDependencies = pj.optionalDependencies;
        if (pj.engines) e.engines = pj.engines;
        if (pj.bin) e.bin = pj.bin;
        packages[key] = e;
        if (source === "npm-hidden-lockfile") source = "npm-hidden-lockfile+installed-tree";
      }
      walk(abs, key);
    }
  }
};
walk(pkgDir, "");
const doc = { name: rootPkg.name, version: rootPkg.version, lockfileVersion: 3, requires: true, packages };
fs.writeFileSync(out + ".tmp", JSON.stringify(doc, null, 2) + "\n");
fs.renameSync(out + ".tmp", out);
process.stdout.write(source + "\t" + (Object.keys(packages).length - 1) + "\n");
'

step_shrinkwrap() {
  local summary
  if ! summary="$("$NODE_BIN" -e "$SHRINKWRAP_JS" "$PKG_DIR" "$OUT_DIR/npm-shrinkwrap.json" 2>"$WORK_DIR/shrinkwrap.err")"; then
    log_output "$WORK_DIR/shrinkwrap.err"
    STEP_DETAIL="could not build npm-shrinkwrap.json from $PKG_DIR"
    return 1
  fi
  SHRINKWRAP_SOURCE="${summary%%$'\t'*}"
  SHRINKWRAP_PACKAGES="${summary##*$'\t'}"
  STEP_DETAIL="$SHRINKWRAP_PACKAGES packages from $SHRINKWRAP_SOURCE"
}

step_doctor() {
  mark_touched doctor
  run_doctor "$TARGET" config
}

step_matrix_plugin() {
  mark_touched matrix-plugin
  install_matrix_plugin "$TARGET"
}

# Second pass: migrations owned by the freshly installed Matrix plugin (room
# allow -> enabled, sidecar state into SQLite) only run once it is present.
step_doctor_matrix() {
  run_doctor "$TARGET" matrix
}

run_cli_check() {
  local args="$2" out="$WORK_DIR/$1.out" rc
  # shellcheck disable=SC2086
  openclaw_cli "$CMD_TIMEOUT" $args >"$out" 2>&1
  rc=$?
  log_output "$out"
  if ((rc != 0)); then
    STEP_DETAIL="openclaw $args exited $rc"
    return 1
  fi
  STEP_DETAIL="openclaw $args ok"
}

step_validate() { run_cli_check config-validate "$VALIDATE_ARGS"; }
step_matrix_verify() { run_cli_check matrix-verify "$MATRIX_VERIFY_ARGS"; }

step_start() {
  if ! start_units; then
    STEP_DETAIL="systemctl start failed"
    return 1
  fi
  STEP_DETAIL="started $GATEWAY_UNIT"
}

gateway_restarts() {
  systemctl show -p NRestarts --value "$GATEWAY_UNIT" 2>/dev/null || echo 0
}

# Healthy = the unit is active, has not restart-looped since start, and the
# gateway answers HTTP on its loopback port (any status code counts: the
# root path may require auth, but a transport error means it is not up).
step_health() {
  local deadline baseline code now
  baseline="$(gateway_restarts)"
  deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  while :; do
    if systemctl_quiet is-active "$GATEWAY_UNIT"; then
      code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$GATEWAY_URL" 2>/dev/null || true)"
      if [[ -n "$code" && "$code" != "000" ]]; then
        STEP_DETAIL="gateway answered HTTP $code at $GATEWAY_URL"
        return 0
      fi
    fi
    if [[ "$(gateway_restarts)" != "$baseline" ]]; then
      STEP_DETAIL="$GATEWAY_UNIT restarted while starting"
      return 1
    fi
    now="$(date +%s)"
    if ((now >= deadline)); then
      STEP_DETAIL="gateway not healthy after ${HEALTH_TIMEOUT}s (last HTTP code '${code:-none}')"
      return 1
    fi
    sleep "$HEALTH_POLL"
  done
}

# Calls /tools/invoke through lobster the way the bots do (token via the
# environment, never argv) and prints the HTTP status it got, or nothing
# when the gateway was not reachable at all.
lobster_invoke_status() {
  local token="$1" tool="$2" out="$3" session="${4:-}" rc
  as_user "$SERVICE_USER" env -i HOME="$SERVICE_HOME" PATH="$UNIT_PATH" \
    CLAWD_URL="${GATEWAY_URL%/}" CLAWD_TOKEN="$token" \
    timeout -k 5 "$CMD_TIMEOUT" "$LOBSTER_BIN" \
    "clawd.invoke --tool $tool --action json --args-json {}${session:+ --session-key $session}" </dev/null >"$out" 2>&1
  rc=$?
  log_output "$out"
  if ((rc == 0)); then
    echo 200
    return
  fi
  sed -n 's/.*clawd\.invoke failed (\([0-9]\{3\}\)).*/\1/p' "$out" | head -n 1
}

# Does the pinned lobster still work against this OpenClaw? It must run, list
# the commands the bots use, and reach /tools/invoke with the gateway token.
# A tool that does not exist proves transport and auth without side effects:
# 404 is the expected answer, 401/403/429 means the gateway refuses this
# caller. llm-task with empty arguments is probed on the mail review session
# too; it is recorded, not gated on, because its answer depends on that
# agent's tool policy (400 = present and validating input, 404 = not exposed).
step_lobster() {
  local out="$WORK_DIR/lobster.out" token pkg rc status llm
  if [[ -z "$LOBSTER_BIN" ]]; then
    LOBSTER_DETAIL="lobster not installed"
    STEP_DETAIL="$LOBSTER_DETAIL"
    return 1
  fi
  pkg="$(dirname "$(dirname "$(readlink -f "$LOBSTER_BIN")")")"
  LOBSTER_VERSION="$(json_field "$pkg/package.json" version)"
  as_user "$SERVICE_USER" env -i HOME="$SERVICE_HOME" PATH="$UNIT_PATH" \
    timeout -k 5 "$CMD_TIMEOUT" "$LOBSTER_BIN" 'commands.list | json' </dev/null >"$out" 2>&1
  rc=$?
  if ((rc != 0)) || ! grep -q 'clawd.invoke' "$out" || ! grep -q 'llm_task.invoke' "$out"; then
    log_output "$out"
    LOBSTER_DETAIL="lobster commands.list failed or lacks clawd.invoke/llm_task.invoke (exit $rc)"
    STEP_DETAIL="$LOBSTER_DETAIL"
    return 1
  fi
  token="$(openclaw_cli "$CMD_TIMEOUT" config get gateway.auth.token 2>/dev/null | tail -n 1 | tr -d '"[:space:]')"
  if [[ -z "$token" || "$token" == *undefined* || "$token" == *null* || "$token" == *redacted* ]]; then
    token="$(json_field "$CONFIG_PATH" gateway.auth.token)"
  fi
  status="$(lobster_invoke_status "$token" sovereign_migrate_probe "$out")"
  llm="$(lobster_invoke_status "$token" llm-task "$WORK_DIR/lobster-llm.out" "$LLM_TASK_SESSION")"
  case "$status" in
    200 | 400 | 404)
      LOBSTER_OK=true
      LOBSTER_DETAIL="commands ok; /tools/invoke accepts the gateway token (HTTP $status)"
      ;;
    401 | 403 | 429)
      LOBSTER_DETAIL="/tools/invoke refused the gateway token (HTTP $status)"
      ;;
    "")
      LOBSTER_DETAIL="/tools/invoke not reachable"
      ;;
    *)
      LOBSTER_DETAIL="/tools/invoke answered HTTP $status"
      ;;
  esac
  LOBSTER_DETAIL+="; llm-task on $LLM_TASK_SESSION: HTTP ${llm:-none}"
  STEP_DETAIL="lobster ${LOBSTER_VERSION:-unknown}: $LOBSTER_DETAIL"
  [[ "$LOBSTER_OK" == true ]]
}

# ---------------------------------------------------------------------------
# Plan / main.
# ---------------------------------------------------------------------------
print_plan() {
  cat <<EOF
OpenClaw migration plan (dry run; nothing is changed)
  target:            $TARGET
  installed:         ${FROM_VERSION:-unknown} at ${PKG_DIR:-unknown}
  npm prefix:        ${NPM_PREFIX:-unknown} (owner ${NPM_OWNER:-unknown})
  service user/home: ${SERVICE_USER:-unknown} ${SERVICE_HOME:-unknown}
  state dir:         ${STATE_DIR:-unknown}
  node:              ${NODE_VERSION:-unknown} (${NODE_BIN:-not found}); required >=$NODE_MIN <$NODE_MAX_EXCLUSIVE
  units:             $GATEWAY_UNIT ${SCAN_UNITS[*]:-}
  flat matrix store: ${FLAT_MATRIX_STORE:-none}
  lobster:           ${LOBSTER_BIN:-not found}
  backup root:       $BACKUP_ROOT
EOF
  if [[ -n "$DISCOVERY_ERROR" ]]; then
    printf '  discovery error:   %s\n' "$DISCOVERY_ERROR"
  fi
  local n=1
  plan_line() { printf '  %2d. %s\n' "$n" "$*"; n=$((n + 1)); }
  echo "Steps:"
  if [[ -n "$FROM_VERSION" && "$FROM_VERSION" == "$TARGET" && -n "$NODE_BIN" && "$(marker_field status)" == "completed" ]]; then
    plan_line "preflight; already migrated to $TARGET: verify health, shrinkwrap, lobster only"
    return
  fi
  plan_line "preflight: versions, node range, disk space, unit state"
  plan_line "stop: $(units_in_stop_order | tr '\n' ' ')"
  plan_line "backup: tar $STATE_DIR and $PKG_DIR into $BACKUP_ROOT/<timestamp>-${FROM_VERSION:-unknown}/"
  if [[ -n "$NODE_VERSION" ]] && node_in_range "$NODE_VERSION"; then
    plan_line "node: skip ($NODE_VERSION in range)"
  else
    plan_line "node: apt-get install --only-upgrade nodejs"
  fi
  if [[ -n "$FLAT_MATRIX_STORE" ]] && version_lt "${FROM_VERSION:-0}" "$STAGE_VERSION"; then
    plan_line "stage: npm install -g openclaw@$STAGE_VERSION; openclaw $DOCTOR_ARGS; openclaw ${MATRIX_PLUGIN_ARGS//%VERSION%/$STAGE_VERSION}; doctor again; start the gateway once (${STAGE_SETTLE}s) and stop it"
  else
    plan_line "stage: skip (no flat Matrix store)"
  fi
  plan_line "upgrade: npm install -g openclaw@$TARGET (prefix ${NPM_PREFIX:-unknown})"
  plan_line "shrinkwrap: write $OUT_DIR/npm-shrinkwrap.json from the installed tree"
  plan_line "doctor: openclaw $DOCTOR_ARGS (stdin closed, ${DOCTOR_TIMEOUT}s; a prompt fails the run)"
  plan_line "matrix-plugin: openclaw ${MATRIX_PLUGIN_ARGS//%VERSION%/$TARGET}; private homeserver opt-in: $ALLOW_PRIVATE_MATRIX"
  plan_line "doctor-matrix: openclaw $DOCTOR_ARGS again for the plugin's own migrations"
  plan_line "config-validate: openclaw $VALIDATE_ARGS"
  plan_line "matrix-verify: openclaw $MATRIX_VERIFY_ARGS"
  plan_line "start: $GATEWAY_UNIT and previously active scan units"
  plan_line "health: wait up to ${HEALTH_TIMEOUT}s for $GATEWAY_URL"
  plan_line "lobster: commands.list and /tools/invoke probe"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --target)
        [[ $# -ge 2 ]] || die_usage "--target needs a value"
        TARGET="$2"
        shift 2
        ;;
      --target=*)
        TARGET="${1#*=}"
        shift
        ;;
      --out)
        [[ $# -ge 2 ]] || die_usage "--out needs a value"
        OUT_DIR="$2"
        shift 2
        ;;
      --out=*)
        OUT_DIR="${1#*=}"
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die_usage "unknown argument: $1"
        ;;
    esac
  done
  [[ -n "$TARGET" ]] || die_usage "--target is required"
  [[ "$TARGET" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,3}(-[0-9A-Za-z.]+)?$ ]] ||
    die_usage "--target must be an OpenClaw release version such as 2026.8.35"
  [[ -n "$OUT_DIR" ]] || die_usage "--out is required"
}

main() {
  parse_args "$@"

  if ((DRY_RUN == 1)); then
    discover || true
    print_plan
    exit 0
  fi

  if [[ "$(id -u)" -ne 0 && "${OPENCLAW_MIGRATE_ALLOW_NON_ROOT:-0}" != "1" ]]; then
    printf '[%s] ERROR: run as root\n' "$SCRIPT_NAME" >&2
    exit 2
  fi

  mkdir -p "$OUT_DIR" || {
    printf '[%s] ERROR: cannot create %s\n' "$SCRIPT_NAME" "$OUT_DIR" >&2
    exit 2
  }
  OUT_DIR="$(cd "$OUT_DIR" && pwd)"
  rm -f "$OUT_DIR/result.json" "$OUT_DIR/npm-shrinkwrap.json"
  LOG_FILE="$OUT_DIR/migration.log"
  : >"$LOG_FILE"
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-migrate.XXXXXX")"
  STEPS_FILE="$WORK_DIR/steps.tsv"
  DOCTOR_RUNS_FILE="$WORK_DIR/doctor-runs.tsv"
  : >"$STEPS_FILE"
  : >"$DOCTOR_RUNS_FILE"

  # Provisional JSON writer for failures before discovery; discover() replaces
  # it with the node on the gateway's own PATH.
  NODE_BIN="$(command -v node || true)"

  exec 9>"$LOCK_FILE" || {
    FAILED_STEP=lock
    FINAL_MESSAGE="cannot open lock file $LOCK_FILE"
    log "$FINAL_MESSAGE"
    finish 1
  }
  if ! flock -n 9; then
    FAILED_STEP=lock
    FINAL_MESSAGE="another migration holds $LOCK_FILE"
    log "$FINAL_MESSAGE"
    finish 1
  fi

  log "OpenClaw migration to $TARGET started"
  discover || true

  if [[ -z "$DISCOVERY_ERROR" && "$FROM_VERSION" == "$TARGET" ]]; then
    if [[ "$(marker_field status)" == "completed" && "$(marker_field target)" == "$TARGET" ]]; then
      ALREADY_DONE=1
      FROM_VERSION="$(marker_field from)"
      BACKUP_PATH="$(marker_field backup.path)"
      PKG_BACKUP_PATH="$(marker_field backup.package)"
      BACKUP_BYTES="$(marker_field backup.bytes)"
      log "OpenClaw is already at $TARGET (migrated from ${FROM_VERSION:-unknown}); verifying only"
    else
      # The package is already the target but the migration never completed
      # (an earlier run failed after npm install). Resume from doctor on.
      RESUMING=1
      local prev_from
      prev_from="$(marker_field from)"
      [[ -n "$prev_from" ]] && FROM_VERSION="$prev_from"
      BACKUP_PATH="$(marker_field backup.path)"
      PKG_BACKUP_PATH="$(marker_field backup.package)"
      BACKUP_BYTES="$(marker_field backup.bytes)"
      TOUCHED=1
      TOUCHED_BY="an earlier run"
      log "OpenClaw is already at $TARGET but no completed migration is recorded; resuming"
    fi
  fi

  run_step preflight step_preflight

  if ((ALREADY_DONE == 1)); then
    local s
    for s in stop backup node stage upgrade; do skip_step "$s" "already migrated to $TARGET"; done
    run_step shrinkwrap step_shrinkwrap
    for s in doctor matrix-plugin doctor-matrix config-validate matrix-verify start; do skip_step "$s" "already migrated to $TARGET"; done
    run_step health step_health
    run_step lobster step_lobster
    FINAL_MESSAGE="already migrated to $TARGET; nothing changed"
    log "$FINAL_MESSAGE"
    finish 0
  fi

  run_step stop step_stop
  if ((RESUMING == 1)); then
    skip_step backup "resuming; backup from the first run: ${BACKUP_PATH:-none recorded}"
    skip_step node "resuming"
    skip_step stage "resuming"
    skip_step upgrade "openclaw@$TARGET already installed"
  else
    run_step backup step_backup
    write_marker in-progress
    if ((NODE_NEEDS_UPGRADE == 1)); then
      run_step node step_node
    else
      skip_step node "node $NODE_VERSION already in range"
    fi
    if [[ -n "$FLAT_MATRIX_STORE" ]] && version_lt "$FROM_VERSION" "$STAGE_VERSION"; then
      run_step stage step_stage
    else
      skip_step stage "no flat Matrix store to migrate"
    fi
    run_step upgrade step_upgrade
  fi
  run_step shrinkwrap step_shrinkwrap
  run_step doctor step_doctor
  run_step matrix-plugin step_matrix_plugin
  run_step doctor-matrix step_doctor_matrix
  run_step config-validate step_validate
  run_step matrix-verify step_matrix_verify
  run_step start step_start
  run_step health step_health
  write_marker completed
  run_step lobster step_lobster

  FINAL_MESSAGE="migrated OpenClaw ${FROM_VERSION} -> ${TARGET}"
  log "$FINAL_MESSAGE"
  finish 0
}

main "$@"
