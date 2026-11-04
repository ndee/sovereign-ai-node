#!/usr/bin/env bash
# Unattended, staged migration of the OpenClaw runtime of an installed node to
# the version the node package pins, run as root. This file is the fixed-form
# entry point an update's root stage calls; its contract (arguments, exit
# codes, result.json) is documented in docs/OPENCLAW_MIGRATION.md.
#
#   bash openclaw-migrate.sh --target <version|pinned> --out <dir>
#        [--node-package <dir>] [--bots-dir <dir>] [--budget <seconds>] [--dry-run]
#
# Writes <out>/migration.log (secrets redacted), <out>/result.json and
# <out>/npm-shrinkwrap.json.
#
# The file is self-contained (its JSON/semver helpers are inline Node.js) so a
# caller can copy it to a root-owned path and run that copy.

# Steps are dispatched by name through run_step, which shellcheck cannot follow.
# shellcheck disable=SC2317
set -uo pipefail

SCRIPT_NAME="openclaw-migrate"
RESULT_SCHEMA=2

# ---------------------------------------------------------------------------
# Tunables. Defaults match a node installed by this repository's installer;
# every one can be overridden from the environment for a non-standard layout.
# ---------------------------------------------------------------------------
UNIT_DIR="${OPENCLAW_MIGRATE_UNIT_DIR:-/etc/systemd/system}"
GATEWAY_UNIT="${OPENCLAW_MIGRATE_GATEWAY_UNIT:-sovereign-openclaw-gateway.service}"
DEFAULT_SERVICE_USER="sovereign-node"
DEFAULT_SERVICE_HOME="/var/lib/sovereign-node/openclaw-home"
BACKUP_ROOT="${OPENCLAW_MIGRATE_BACKUP_ROOT:-/var/backups/sovereign-node/openclaw-migrate}"
# The node CLI's install step refuses to change the OpenClaw version unless a
# process holds this exact lock, so the default must stay in step with
# src/openclaw/staged-migration.ts.
LOCK_FILE="${OPENCLAW_MIGRATE_LOCK_FILE:-/run/sovereign-openclaw-migrate.lock}"
# While it exists, a drop-in keeps systemd from starting the gateway (at boot
# too) on a tree this script has only half migrated. It lives in the root-only
# backup root so the service user cannot lift it.
GUARD_FILE="${OPENCLAW_MIGRATE_GUARD_FILE:-$BACKUP_ROOT/gateway.guard}"
GUARD_DROPIN_NAME="zz-openclaw-migrate-guard.conf"
# Wall-clock budget for the whole run; a caller passes what is left of its own
# (an update stage runs under a service timeout). RESERVE is kept back from
# every step so a failure still has time to roll back and restart.
DEFAULT_BUDGET="${OPENCLAW_MIGRATE_BUDGET:-1500}"
RESERVE="${OPENCLAW_MIGRATE_RESERVE:-240}"
# Below this much budget left (after RESERVE) the run does not stop anything.
MIN_WINDOW="${OPENCLAW_MIGRATE_MIN_WINDOW:-600}"
GATEWAY_URL="${OPENCLAW_MIGRATE_GATEWAY_URL:-http://127.0.0.1:18789/}"
NODE_MIN="${OPENCLAW_MIGRATE_NODE_MIN:-22.22.3}"
NODE_MAX_EXCLUSIVE="${OPENCLAW_MIGRATE_NODE_MAX_EXCLUSIVE:-23.0.0}"
# The last 6.x patch. The Matrix plugin dropped its migration of the legacy
# flat store in 2026.8.1, so a node that still has one must pass through a
# 2026.6 release (doctor --fix, then one gateway start) first.
STAGE_VERSION="${OPENCLAW_MIGRATE_STAGE_VERSION:-2026.6.35}"
STAGE_SETTLE="${OPENCLAW_MIGRATE_STAGE_SETTLE:-30}"
# auto: stage only when a legacy Matrix store is found; always / never force it.
STAGE_MODE="${OPENCLAW_MIGRATE_STAGE:-auto}"
MIN_FREE_BYTES="${OPENCLAW_MIGRATE_MIN_FREE_BYTES:-1073741824}"
DOCTOR_TIMEOUT="${OPENCLAW_MIGRATE_DOCTOR_TIMEOUT:-600}"
CMD_TIMEOUT="${OPENCLAW_MIGRATE_CMD_TIMEOUT:-180}"
NPM_TIMEOUT="${OPENCLAW_MIGRATE_NPM_TIMEOUT:-1800}"
HEALTH_TIMEOUT="${OPENCLAW_MIGRATE_HEALTH_TIMEOUT:-240}"
# How long the node's runtime refresh may wait for the first gateway start on
# the new version (the node's own default for a first start).
REFRESH_READY_TIMEOUT="${OPENCLAW_MIGRATE_REFRESH_READY_TIMEOUT:-600}"
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
# Newer releases install a plugin only after consent to its declared
# capabilities, and without a TTY that consent can only be the
# --accept-capabilities flag. Older releases (the 6.x stage) reject the flag as
# unknown, so auto adds it only when `plugins install --help` lists it.
# always / never skip the probe.
MATRIX_PLUGIN_CONSENT="${OPENCLAW_MIGRATE_MATRIX_PLUGIN_CONSENT:-auto}"
# auto: opt in to a private/loopback homeserver only when the configured one is.
ALLOW_PRIVATE_MATRIX="${OPENCLAW_MIGRATE_ALLOW_PRIVATE_MATRIX:-auto}"
# OpenClaw treats a web-search provider as configured when one of its
# credential env vars is set, even with no provider chosen, and the Perplexity
# entry accepts OPENROUTER_API_KEY, which the gateway always has. From 2026.8
# the first gateway start after an upgrade installs every such plugin and exits
# 1 when it cannot (no TTY for capability consent, the newest release needs a
# newer host), so systemd restarts it forever. The managed agents deny
# web_search anyway. keep: leave tools.web.search as configured.
WEB_SEARCH_MODE="${OPENCLAW_MIGRATE_WEB_SEARCH:-disable}"
# What a failed start/health step records about the gateway unit.
JOURNALCTL="${OPENCLAW_MIGRATE_JOURNALCTL:-journalctl}"
GATEWAY_JOURNAL_LINES="${OPENCLAW_MIGRATE_GATEWAY_JOURNAL_LINES:-120}"
GATEWAY_SHOW_PROPS="NRestarts,Result,ActiveState,SubState,ExecMainCode,ExecMainStatus,ExecMainPID,MainPID,ExecMainStartTimestamp,ExecMainExitTimestamp"
# The /tools/invoke session the mail review uses. It is the scan agent's: the
# chat agent's closed tool list has no llm-task, so probing it proves nothing.
LLM_TASK_SESSION="${OPENCLAW_MIGRATE_LLM_TASK_SESSION:-agent:mail-sentinel-scan:main}"
LLM_TASK_ARGS='{"prompt":"Return the JSON object {\"ok\":true} and nothing else.","input":{}}'

# What a CLI prints when it wanted to ask something. Doctor does not prompt
# without a TTY upstream; this catches it if that ever changes.
PROMPT_REGEX="${OPENCLAW_MIGRATE_PROMPT_REGEX:-(\(y/n\)|\[y/n\]|\by/N\b|\bY/n\b|ExitPromptError|force closed the prompt|prompt was cancel|cancelled by user|not a tty|stdin is not a|use arrow keys|press (enter|space|return) to|^\s*[◆◇]\s.*\?\s*$|\?\s*›)}"

# ---------------------------------------------------------------------------
# Runtime state.
# ---------------------------------------------------------------------------
TARGET=""
TARGET_ARG=""
OUT_DIR=""
DRY_RUN=0
NODE_PACKAGE=""
NODE_CLI=""
BOTS_DIR=""
BUDGET=""
DEADLINE=0
OUTCOME=""
EXIT_CODE=0
PHASE=""
ROLLBACK_SAFE=1
RECOVERY=""
ORIG_PKG_DIR=""
ORIG_BIN_TARGET=""
BIN_LINK=""
UNIT_BACKUP_PATH=""
GUARD_ENGAGED=false
ROLLBACK_PERFORMED=false
ROLLBACK_OK=false
ROLLBACK_DETAIL=""
PREFETCH_DETAIL=""
STARTED_ON_TARGET=0
LLM_TASK_STATUS=""
FINISHED=0
CURRENT_STEP=""
STEP_STARTED=""
CONFIG_BACKUP_PATH=""
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
NODE_DISCOVERED=0
NODE_UPGRADED=false
LEGACY_MATRIX_STORE=""
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
GATEWAY_SINCE=""
GATEWAY_DIAG_SINCE=""
GATEWAY_SHOW_FILE=""
GATEWAY_JOURNAL_FILE=""
STEPS_FILE=""
LOG_FILE=""
WORK_DIR=""
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

usage() {
  cat <<'EOF'
Usage: bash openclaw-migrate.sh --target <version|pinned> --out <dir>
                                [--node-package <dir>] [--bots-dir <dir>] [--budget <seconds>] [--dry-run]

Unattended staged migration of the node's OpenClaw runtime. Run as root.

  --target <version>     OpenClaw release to migrate to, or "pinned" for the one
                         the node package locks (deploy/openclaw-runtime)
  --out <dir>            Directory for migration.log, result.json, npm-shrinkwrap.json
  --node-package <dir>   Installed node package whose CLI installs the runtime
                         (default: the package this script ships in)
  --bots-dir <dir>       Installed bot catalog the node CLI reconciles against
                         (default: sovereign-ai-bots next to the node package)
  --budget <seconds>     Wall-clock budget for the run (default 1500)
  --dry-run              Print the plan and exit; changes nothing, writes nothing
  -h, --help             Show this help

Exit status:
  0  migrated, or already on the target (nothing changed)
  1  not migrated; the node runs its previous OpenClaw (unchanged or rolled back)
  2  usage error or not root; nothing was done and no result.json was written
  3  needs attention: rollback failed, or the run stopped past the point of no
     return (fix-forward); result.json says which and a rerun resumes
  4  another migration holds the lock; nothing was done
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

# The last lines a failed command printed, redacted and joined into one line
# for result.json. The frames of the CLI's notes and its generic Debug/Try/Help
# footer carry nothing and go, so the tail is the actual reason.
failure_tail() {
  redact <"$1" |
    sed -E 's/(│|┌|└|◇|◆|├|╮|╯|─)+//g; s/[[:space:]]+/ /g; s/^ //; s/ $//' |
    grep -vE '^$|^\[openclaw\] (Debug|Try|Help):' |
    tail -n "${2:-2}" | awk 'NR > 1 { printf "; " } { printf "%s", $0 }' | cut -c1-600
}

# STEP_DETAIL for a command that failed: what ran, its exit code and the tail
# of what it printed, so result.json alone says why.
failed_detail() {
  local what="$1" rc="$2" out="$3" last=""
  [[ -s "$out" ]] && last="$(failure_tail "$out")"
  STEP_DETAIL="$what exited $rc${last:+: $last}"
}

# STEP_DETAIL for a failed node CLI call: its JSON error envelope (the last
# JSON object on stderr; the lines before it are its log) when there is one.
# shellcheck disable=SC2016
CLI_ERROR_JS='
const text = require("node:fs").readFileSync(process.argv[1], "utf8");
const starts = [];
for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
  if (i === 0 || text[i - 1] === "\n") starts.push(i);
}
for (const start of starts.reverse()) {
  try {
    const e = JSON.parse(text.slice(start)).error;
    if (e && e.code) { process.stdout.write(`${e.code}: ${e.message}`); break; }
  } catch {}
}
'
failed_cli_detail() {
  local what="$1" rc="$2" err="$3" envelope=""
  [[ -s "$err" ]] && envelope="$("$NODE_BIN" -e "$CLI_ERROR_JS" "$err" 2>/dev/null)"
  if [[ -n "$envelope" ]]; then
    STEP_DETAIL="$what exited $rc: $(printf '%s' "$envelope" | redact | cut -c1-600)"
  else
    failed_detail "$what" "$rc" "$err"
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
  # json_field <file> <dotted.path> — prints the value or nothing. JSON5 (the
  # OpenClaw config format) is read with the json5 copy OpenClaw ships.
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const parse = (text) => {
      try { return JSON.parse(text); } catch (err) {
        try { return require(require("node:path").join(process.argv[3], "node_modules", "json5")).parse(text); }
        catch { throw err; }
      }
    };
    try {
      let v = parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const k of process.argv[2].split(".")) v = v == null ? undefined : v[k];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    } catch {}
  ' "$1" "$2" "${PKG_DIR:-/nonexistent}"
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

# Runs a command as <user> from <dir>, keeping the caller's environment out of
# it. runuser keeps the caller's cwd, and a root caller's (a 0700 staging
# directory, /root) is one <user> cannot traverse. OpenClaw starts every child
# with an explicit cwd of process.cwd(), so each of its spawns then fails with
# EACCES: doctor --fix aborts halfway through its repairs.
as_user() {
  local user="$1" dir="$2"
  shift 2
  [[ -d "$dir" ]] || dir=/
  (
    cd -- "$dir" || exit 1
    if [[ "$(id -un)" == "$user" ]]; then
      exec "$@"
    else
      exec runuser -u "$user" -- "$@"
    fi
  )
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
  as_user "$SERVICE_USER" "$SERVICE_HOME" env -i \
    HOME="$SERVICE_HOME" \
    PATH="$UNIT_PATH" \
    OPENCLAW_HOME="$SERVICE_HOME" \
    OPENCLAW_CONFIG="$CONFIG_PATH" \
    OPENCLAW_CONFIG_PATH="$CONFIG_PATH" \
    CI=1 NO_COLOR=1 TERM=dumb \
    timeout -k 10 "$timeout_s" bash -c "$ENV_LOADER" _ "$ENV_FILE" "$OPENCLAW_BIN" "$@" </dev/null
}


# The legacy global npm install, used only for the intermediate stage release
# (the node CLI installs nothing but the version its package locks). Run as
# the owner of the existing tree so ownership does not change.
npm_install_openclaw() {
  local version="$1" out="$2" home
  home="$(owner_home)"
  as_user "$NPM_OWNER" "$home" env -i \
    HOME="$home" \
    PATH="$UNIT_PATH" \
    CI=1 \
    NPM_CONFIG_CACHE="$home/.npm" \
    npm_config_prefix="$NPM_PREFIX" \
    SOVEREIGN_NODE_APP_DIR="$NODE_PACKAGE" \
    SOVEREIGN_BOTS_REPO_DIR="$BOTS_DIR" \
    timeout -k 30 "$(clamp "$NPM_TIMEOUT")" npm install -g "openclaw@${version}" </dev/null >"$out" 2>&1
}

owner_home() {
  local home
  home="$(getent passwd "$NPM_OWNER" | cut -d: -f6)"
  printf '%s' "${home:-$SERVICE_HOME}"
}

pkg_version_of() {
  [[ -f "$1/package.json" ]] || return 0
  json_field "$1/package.json" version
}

installed_openclaw_version() {
  pkg_version_of "$PKG_DIR"
}

# The package directory a file inside an installed openclaw package belongs to.
package_root_of() {
  local dir
  dir="$(dirname "$1")"
  while [[ "$dir" != "/" && "$dir" != "." ]]; do
    if [[ "$(basename "$dir")" == openclaw && -f "$dir/package.json" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# The npm prefix an openclaw package lives in: the global layout of earlier
# releases (<prefix>/lib/node_modules/openclaw) or the node's locked runtime
# project (<prefix>/lib/sovereign-openclaw-runtime/node_modules/openclaw).
prefix_of_package() {
  case "$1" in
    */lib/node_modules/openclaw) printf '%s' "${1%/lib/node_modules/openclaw}" ;;
    */lib/sovereign-openclaw-runtime/node_modules/openclaw) printf '%s' "${1%/lib/sovereign-openclaw-runtime/node_modules/openclaw}" ;;
    *) return 1 ;;
  esac
}

# Points PKG_DIR at the package <prefix>/bin/openclaw resolves to.
resolve_pkg_from_bin() {
  local real
  [[ -e "$BIN_LINK" ]] || return 1
  real="$(readlink -f "$BIN_LINK")"
  PKG_DIR="$(package_root_of "$real")" || return 1
}

systemctl_quiet() {
  systemctl "$@" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Budget. Every step's timeout is clamped to what is left of the budget minus
# RESERVE, so a failure always leaves time to roll back and restart.
# ---------------------------------------------------------------------------
remaining() {
  printf '%s' $((DEADLINE - $(date +%s) - RESERVE))
}

clamp() {
  local want="$1" left
  left="$(remaining)"
  ((left < 1)) && left=1
  if ((want < left)); then printf '%s' "$want"; else printf '%s' "$left"; fi
}

# Timeouts for the recovery path may also spend the reserve.
clamp_reserve() {
  local want="$1" left
  left=$((DEADLINE - $(date +%s)))
  ((left < 5)) && left=5
  if ((want < left)); then printf '%s' "$want"; else printf '%s' "$left"; fi
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
  CURRENT_STEP="$name"
  STEP_STARTED="$(date +%s)"
  log "step $name: start"
  start="$STEP_STARTED"
  if (($(remaining) <= 0)); then
    STEP_DETAIL="the ${BUDGET}s budget is used up (${RESERVE}s are kept for recovery)"
    rc=1
  else
    "$fn"
    rc=$?
  fi
  local seconds=$(($(date +%s) - start))
  CURRENT_STEP=""
  if ((rc == 0)); then
    record_step "$name" true "$seconds" false "$STEP_DETAIL"
    log "step $name: ok (${seconds}s)${STEP_DETAIL:+ - $STEP_DETAIL}"
    return 0
  fi
  record_step "$name" false "$seconds" false "$STEP_DETAIL"
  log "step $name: FAILED (${seconds}s)${STEP_DETAIL:+ - $STEP_DETAIL}"
  FAILED_STEP="$name"
  fail_run
}

skip_step() {
  record_step "$1" true 0 true "$2"
  log "step $1: skipped - $2"
}

mark_touched() {
  if ((TOUCHED == 0)); then
    TOUCHED=1
    TOUCHED_BY="$1"
  fi
}

# ---------------------------------------------------------------------------
# Marker: what an interrupted run left behind, so the next run can tell
# "already migrated" from "half migrated" and knows whether restoring the
# backup is still safe.
# ---------------------------------------------------------------------------
marker_path() { printf '%s/state.json' "$BACKUP_ROOT"; }

write_marker() {
  local status="$1"
  mkdir -p "$BACKUP_ROOT" && chmod 0700 "$BACKUP_ROOT"
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [path, status, target, from, phase, rollbackSafe, backup, pkg, bytes, unit, config,
      pkgDir, binTarget] = process.argv.slice(1);
    const next = {
      status, target, from: from || null, phase: phase || null,
      rollback_safe: rollbackSafe === "1",
      backup: { path: backup || null, package: pkg || null, bytes: Number(bytes) || 0,
        unit: unit || null, config: config || null, package_dir: pkgDir || null,
        bin_target: binTarget || null },
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path + ".tmp", JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(path + ".tmp", path);
  ' "$(marker_path)" "$status" "$TARGET" "$FROM_VERSION" "$PHASE" "$ROLLBACK_SAFE" \
    "$BACKUP_PATH" "$PKG_BACKUP_PATH" "$BACKUP_BYTES" "$UNIT_BACKUP_PATH" "$CONFIG_BACKUP_PATH" \
    "$ORIG_PKG_DIR" "$ORIG_BIN_TARGET"
}

set_phase() {
  PHASE="$1"
  write_marker in-progress
}

marker_field() {
  [[ -f "$(marker_path)" ]] || return 0
  json_field "$(marker_path)" "$1"
}

load_marker_backup() {
  BACKUP_PATH="$(marker_field backup.path)"
  PKG_BACKUP_PATH="$(marker_field backup.package)"
  BACKUP_BYTES="$(marker_field backup.bytes)"
  UNIT_BACKUP_PATH="$(marker_field backup.unit)"
  CONFIG_BACKUP_PATH="$(marker_field backup.config)"
  local pkg bin
  pkg="$(marker_field backup.package_dir)"
  bin="$(marker_field backup.bin_target)"
  [[ -n "$pkg" ]] && ORIG_PKG_DIR="$pkg"
  [[ -n "$bin" ]] && ORIG_BIN_TARGET="$bin"
  return 0
}

# Decides how this run starts from what an earlier one left behind:
#   resume   the target is installed completely: carry on from doctor;
#   restore  nothing ran on a new version yet: restore the backup, then
#            migrate as if for the first time;
#   upgrade  the stage release already ran its gateway: carry on from the
#            target install (restoring would hand old state to a homeserver
#            that has seen newer state).
classify_run() {
  local status mtarget mphase msafe mfrom
  status="$(marker_field status)"
  if [[ "$status" != in-progress ]]; then
    if [[ -z "$DISCOVERY_ERROR" && "$FROM_VERSION" == "$TARGET" ]]; then
      ALREADY_DONE=1
      [[ "$(marker_field target)" == "$TARGET" && -n "$(marker_field from)" ]] && FROM_VERSION="$(marker_field from)"
      [[ "$(marker_field target)" == "$TARGET" ]] && load_marker_backup
      log "OpenClaw is already at $TARGET; nothing to migrate"
    fi
    return 0
  fi
  mtarget="$(marker_field target)"
  mphase="$(marker_field phase)"
  msafe="$(marker_field rollback_safe)"
  mfrom="$(marker_field from)"
  load_marker_backup
  [[ -n "$mfrom" ]] && FROM_VERSION="$mfrom"
  RESUMING=1
  TOUCHED=1
  TOUCHED_BY="an earlier run"
  if [[ "$mtarget" == "$TARGET" && ("$mphase" == upgraded || "$mphase" == started) ]] &&
    [[ "$(pkg_version_of "$PKG_DIR")" == "$TARGET" ]]; then
    RECOVERY=resume
    [[ "$mphase" == started || "$msafe" != true ]] && ROLLBACK_SAFE=0
    [[ "$mphase" == started ]] && STARTED_ON_TARGET=1
  elif [[ "$msafe" == true && -n "$BACKUP_PATH" ]]; then
    RECOVERY=restore
  elif [[ "$mtarget" == "$TARGET" && -n "$BACKUP_PATH" ]]; then
    RECOVERY=upgrade
    ROLLBACK_SAFE=0
  else
    ROLLBACK_SAFE=0
    DISCOVERY_ERROR="an unfinished migration to ${mtarget:-unknown} (phase ${mphase:-unknown}) cannot be restored and is not for $TARGET; rerun with --target ${mtarget:-<its target>}"
    return 0
  fi
  log "an earlier run to $mtarget stopped in phase ${mphase:-unknown}; recovery: $RECOVERY"
}

# ---------------------------------------------------------------------------
# Boot guard. A ConditionPathExists drop-in keeps every start of the gateway
# (systemctl, the node's helpers, boot) a no-op while GUARD_FILE exists, so a
# power loss mid-migration cannot boot a half-migrated tree.
# ---------------------------------------------------------------------------
guard_dropin_path() { printf '%s/%s.d/%s' "$UNIT_DIR" "$GATEWAY_UNIT" "$GUARD_DROPIN_NAME"; }

engage_guard() {
  local dropin
  dropin="$(guard_dropin_path)"
  mkdir -p "$BACKUP_ROOT" && chmod 0700 "$BACKUP_ROOT" || return 1
  : >"$GUARD_FILE" || return 1
  GUARD_ENGAGED=true
  if [[ ! -f "$dropin" ]]; then
    mkdir -p "$(dirname "$dropin")" || return 1
    printf '[Unit]\n# Written by openclaw-migrate.sh; removed when the migration ends.\nConditionPathExists=!%s\n' "$GUARD_FILE" >"$dropin.tmp" &&
      mv -f "$dropin.tmp" "$dropin" || return 1
    systemctl daemon-reload >>"$LOG_FILE" 2>&1 || return 1
  fi
}

release_guard() {
  local dropin
  dropin="$(guard_dropin_path)"
  rm -f "$GUARD_FILE"
  if [[ -e "$dropin" ]]; then
    rm -f "$dropin"
    rmdir "$(dirname "$dropin")" 2>/dev/null
    systemctl daemon-reload >>"$LOG_FILE" 2>&1
  fi
  GUARD_ENGAGED=false
  return 0
}

step_guard() {
  if ! engage_guard; then
    STEP_DETAIL="could not install the start guard $(guard_dropin_path)"
    return 1
  fi
  STEP_DETAIL="$GATEWAY_UNIT cannot start while $GUARD_FILE exists"
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

was_active() {
  [[ " ${ACTIVE_UNITS[*]} " == *" $1 "* ]]
}

# Starts every scan timer that ran before or is enabled (a recovering run
# finds them stopped by the earlier one), and a scan service without a timer
# that ran before. Runs on every exit path, whatever happened to the gateway:
# the scans carry the node's alerts and must not stay paused.
SCAN_UNITS_STARTED=false
start_scan_units() {
  local u rc=0
  for u in "${SCAN_UNITS[@]}"; do
    if [[ "$u" == *.timer ]]; then
      if was_active "$u" || systemctl_quiet is-enabled "$u"; then
        systemctl start "$u" >>"${LOG_FILE:-/dev/null}" 2>&1 || rc=1
      fi
    elif was_active "$u" && [[ ! -e "$UNIT_DIR/${u%.service}.timer" ]]; then
      systemctl start "$u" >>"${LOG_FILE:-/dev/null}" 2>&1 || rc=1
    fi
  done
  ((rc == 0)) && SCAN_UNITS_STARTED=true
  return "$rc"
}

start_gateway() {
  systemctl start "$GATEWAY_UNIT" >>"$LOG_FILE" 2>&1
}

# Changes whenever systemd starts the gateway's main process.
gateway_start_mark() {
  systemctl show -p ExecMainStartTimestampMonotonic --value "$GATEWAY_UNIT" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Rollback: put back exactly what the backup holds. Only valid while no new
# OpenClaw version has run its gateway (ROLLBACK_SAFE).
# ---------------------------------------------------------------------------
restore_backup() {
  local tmp
  if [[ -z "$BACKUP_PATH" || ! -f "$BACKUP_PATH" ]]; then
    ROLLBACK_DETAIL="no state backup to restore"
    return 1
  fi
  timeout "$(clamp_reserve "$STOP_TIMEOUT")" systemctl stop "$GATEWAY_UNIT" >>"$LOG_FILE" 2>&1
  if [[ -n "$ORIG_PKG_DIR" && "$(pkg_version_of "$ORIG_PKG_DIR")" != "$FROM_VERSION" ]]; then
    if [[ -z "$PKG_BACKUP_PATH" || ! -f "$PKG_BACKUP_PATH" ]] ||
      ! rm -rf "$ORIG_PKG_DIR" ||
      ! tar -xzpf "$PKG_BACKUP_PATH" -C "$(dirname "$ORIG_PKG_DIR")" 2>>"$LOG_FILE"; then
      ROLLBACK_DETAIL="restoring the OpenClaw package $ORIG_PKG_DIR from ${PKG_BACKUP_PATH:-nothing} failed"
      return 1
    fi
  fi
  if [[ -n "$ORIG_BIN_TARGET" && "$(readlink "$BIN_LINK" 2>/dev/null)" != "$ORIG_BIN_TARGET" ]]; then
    tmp="$BIN_LINK.openclaw-migrate.tmp"
    if ! ln -sfn "$ORIG_BIN_TARGET" "$tmp" || ! chown -h "$NPM_OWNER" "$tmp" 2>>"$LOG_FILE" || ! mv -fT "$tmp" "$BIN_LINK"; then
      ROLLBACK_DETAIL="relinking $BIN_LINK to $ORIG_BIN_TARGET failed"
      return 1
    fi
  fi
  if ! rm -rf "$STATE_DIR" || ! tar -xzpf "$BACKUP_PATH" -C "$(dirname "$STATE_DIR")" 2>>"$LOG_FILE"; then
    ROLLBACK_DETAIL="restoring $STATE_DIR from $BACKUP_PATH failed"
    return 1
  fi
  if [[ -n "$CONFIG_BACKUP_PATH" && -f "$CONFIG_BACKUP_PATH" ]] && ! cp -p "$CONFIG_BACKUP_PATH" "$CONFIG_PATH"; then
    ROLLBACK_DETAIL="restoring $CONFIG_PATH failed"
    return 1
  fi
  # The node's runtime refresh rewrites the unit for the new version (its
  # sandbox only lets the gateway execute the package it was rendered for).
  if [[ -n "$UNIT_BACKUP_PATH" && -f "$UNIT_BACKUP_PATH" ]] && ! cmp -s "$UNIT_BACKUP_PATH" "$UNIT_DIR/$GATEWAY_UNIT"; then
    if ! cp -p "$UNIT_BACKUP_PATH" "$UNIT_DIR/$GATEWAY_UNIT" || ! systemctl daemon-reload >>"$LOG_FILE" 2>&1; then
      ROLLBACK_DETAIL="restoring $UNIT_DIR/$GATEWAY_UNIT failed"
      return 1
    fi
  fi
  if ! resolve_pkg_from_bin || [[ "$(installed_openclaw_version)" != "$FROM_VERSION" ]]; then
    ROLLBACK_DETAIL="after the restore $BIN_LINK resolves to OpenClaw '$(installed_openclaw_version)', expected $FROM_VERSION"
    return 1
  fi
  ROLLBACK_DETAIL="restored OpenClaw $FROM_VERSION, its state and its unit from $(dirname "$BACKUP_PATH")"
}

# ---------------------------------------------------------------------------
# Failure handling. Which way out a failure takes:
#   nothing changed yet          -> restart what was stopped        (exit 1)
#   changed, no new gateway ran  -> roll back to the backup         (exit 1)
#   the new version's gateway ran-> fix forward: stay on the target (exit 3)
#   stage gateway ran, target not complete -> keep the guard; a rerun
#                                   resumes at the target install   (exit 3)
# ---------------------------------------------------------------------------
fail_run() {
  trap '' TERM INT HUP
  local failure="$STEP_DETAIL"
  if ((TOUCHED == 0)); then
    release_guard
    OUTCOME=unchanged
    EXIT_CODE=1
    if ((UNITS_STOPPED == 1)) && was_active "$GATEWAY_UNIT"; then
      if start_gateway; then
        UNITS_RESTARTED=true
        FINAL_MESSAGE="Step '$FAILED_STEP' failed before anything was changed; the units were restarted on the unchanged OpenClaw $FROM_VERSION."
      else
        EXIT_CODE=3
        FINAL_MESSAGE="Step '$FAILED_STEP' failed before anything was changed, but restarting $GATEWAY_UNIT on OpenClaw $FROM_VERSION failed too; check 'systemctl status $GATEWAY_UNIT'."
      fi
    else
      FINAL_MESSAGE="Step '$FAILED_STEP' failed before anything was changed; no unit was stopped and OpenClaw ${FROM_VERSION:-(unknown)} is untouched."
    fi
  elif ((ROLLBACK_SAFE == 1)); then
    ROLLBACK_PERFORMED=true
    log "rolling back to OpenClaw $FROM_VERSION"
    if restore_backup; then
      PHASE=rolled-back
      write_marker rolled-back
      release_guard
      OUTCOME=rolled-back
      EXIT_CODE=1
      if start_gateway && HEALTH_TIMEOUT="$(clamp_reserve "$HEALTH_TIMEOUT")" step_health; then
        ROLLBACK_OK=true
        UNITS_RESTARTED=true
        FINAL_MESSAGE="Step '$FAILED_STEP' failed after '$TOUCHED_BY' had changed the OpenClaw tree or state; rolled back to OpenClaw $FROM_VERSION and its state, and the gateway is healthy again."
      else
        EXIT_CODE=3
        FINAL_MESSAGE="Step '$FAILED_STEP' failed; rolled back to OpenClaw $FROM_VERSION, but the gateway did not come up healthy ($STEP_DETAIL)."
      fi
    else
      OUTCOME=rollback-failed
      EXIT_CODE=3
      FINAL_MESSAGE="Step '$FAILED_STEP' failed and the rollback failed too ($ROLLBACK_DETAIL). The gateway stays blocked by $(guard_dropin_path) until a rerun or a manual restore: systemctl stop $GATEWAY_UNIT; rm -rf '$STATE_DIR' && tar -xzpf '$BACKUP_PATH' -C '$(dirname "$STATE_DIR")'; ln -sfn '$ORIG_BIN_TARGET' '$BIN_LINK'; rm -f '$GUARD_FILE'; systemctl start $GATEWAY_UNIT."
    fi
    log "rollback: $ROLLBACK_DETAIL"
  elif ((STARTED_ON_TARGET == 1)); then
    OUTCOME=fix-forward
    EXIT_CODE=3
    release_guard
    systemctl_quiet is-active "$GATEWAY_UNIT" || start_gateway
    FINAL_MESSAGE="Step '$FAILED_STEP' failed after OpenClaw $TARGET had already run its gateway, so the node stays on $TARGET (its state cannot go back). A rerun resumes from doctor."
  else
    OUTCOME=resume-required
    EXIT_CODE=3
    FINAL_MESSAGE="Step '$FAILED_STEP' failed after the stage release had run its gateway; the target is not installed completely, so the gateway stays blocked by $(guard_dropin_path). A rerun with --target $TARGET resumes at the install."
  fi
  [[ -n "$failure" ]] && FINAL_MESSAGE+=" Failure: $failure"
  log "$FINAL_MESSAGE"
  finish "$EXIT_CODE"
}

on_signal() {
  trap '' TERM INT HUP
  local name="${CURRENT_STEP:-${FAILED_STEP:-startup}}"
  STEP_DETAIL="interrupted by SIG$1 during step $name"
  if [[ -n "$CURRENT_STEP" ]]; then
    record_step "$CURRENT_STEP" false $(($(date +%s) - ${STEP_STARTED:-$(date +%s)})) false "$STEP_DETAIL"
  fi
  FAILED_STEP="$name"
  log "$STEP_DETAIL"
  fail_run
}

on_exit() {
  ((FINISHED == 1)) && return
  start_scan_units
}

# shellcheck disable=SC2016
RESULT_JS='
const fs = require("node:fs");
const [stepsFile, out, ok, target, from, backupPath, backupBytes, backupSourceBytes, pkgBackup,
  promptSeen, runsFile, lobVersion, lobOk, lobDetail, swSource, swPackages, message, failedStep,
  unitsRestarted, startedAt, dryRun, alreadyDone, resumed, schema, nodeVersion, nodeOk,
  nodeUpgraded, gatewayUnit, gatewaySince, gatewayShowFile, gatewayJournalFile, outcome, exitCode,
  phase, recovery, rollbackPerformed, rollbackOk, rollbackDetail, guardEngaged, budget, remaining,
  prefetchDetail, llmSession, llmStatus, nodePackage, scanStarted, startedOnTarget] = process.argv.slice(1);
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
const readLines = (file) => {
  try { return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== ""); } catch { return []; }
};
let gateway = null;
if (gatewayShowFile || gatewayJournalFile) {
  const show = {};
  for (const line of readLines(gatewayShowFile)) {
    const i = line.indexOf("=");
    if (i > 0) show[line.slice(0, i)] = line.slice(i + 1);
  }
  gateway = { unit: gatewayUnit, since: gatewaySince ? new Date(Number(gatewaySince) * 1000).toISOString() : null,
    show, journal: readLines(gatewayJournalFile) };
}
const result = {
  ok: ok === "true",
  outcome,
  exit_code: Number(exitCode),
  target,
  from: from || null,
  steps,
  lobster: { version: lobVersion || null, ok: lobOk === "true", ...(lobDetail ? { detail: lobDetail } : {}) },
  llm_task: { session: llmSession, status: llmStatus ? Number(llmStatus) : null, ok: llmStatus === "200" },
  doctor: { interactive_prompt_seen: promptSeen === "true", runs },
  node: { version: nodeVersion || null, ok: nodeOk === "true", upgraded: nodeUpgraded === "true" },
  backup: { path: backupPath || null, bytes: Number(backupBytes) || 0,
    source_bytes: Number(backupSourceBytes) || 0, package_path: pkgBackup || null },
  rollback: { performed: rollbackPerformed === "true", ok: rollbackOk === "true", detail: rollbackDetail || null },
  recovery: recovery || null,
  phase: phase || null,
  started_on_target: startedOnTarget === "1",
  guard_engaged: guardEngaged === "true",
  scan_units_started: scanStarted === "true",
  prefetch: prefetchDetail || null,
  budget: { seconds: Number(budget) || 0, remaining_seconds: Number(remaining) },
  node_package: nodePackage || null,
  shrinkwrap: { source: swSource || null, packages: Number(swPackages) || 0 },
  already_migrated: alreadyDone === "true",
  resumed: resumed === "true",
  failed_step: failedStep || null,
  units_restarted_on_old_version: unitsRestarted === "true",
  message: message || null,
  gateway,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  schema: Number(schema),
};
fs.writeFileSync(out + ".tmp", JSON.stringify(result, null, 2) + "\n");
fs.renameSync(out + ".tmp", out);
'

write_result() {
  local ok="$1" node_version="" node_ok=false
  # Read again so the result reflects the runtime the gateway is left on. The
  # provisional writer before discovery is not the gateway's node.
  if ((NODE_DISCOVERED == 1)); then
    node_version="$("$NODE_BIN" -v 2>/dev/null)"
    node_version="${node_version#v}"
    node_in_range "$node_version" && node_ok=true
  fi
  "$NODE_BIN" -e "$RESULT_JS" \
    "$STEPS_FILE" "$OUT_DIR/result.json" "$ok" "$TARGET" "$FROM_VERSION" \
    "$BACKUP_PATH" "$BACKUP_BYTES" "$BACKUP_SOURCE_BYTES" "$PKG_BACKUP_PATH" \
    "$DOCTOR_PROMPT_SEEN" "$DOCTOR_RUNS_FILE" "$LOBSTER_VERSION" "$LOBSTER_OK" "$LOBSTER_DETAIL" \
    "$SHRINKWRAP_SOURCE" "$SHRINKWRAP_PACKAGES" "$FINAL_MESSAGE" "$FAILED_STEP" \
    "$UNITS_RESTARTED" "$STARTED_AT" "$DRY_RUN" \
    "$([[ $ALREADY_DONE == 1 ]] && echo true || echo false)" \
    "$([[ $RESUMING == 1 ]] && echo true || echo false)" "$RESULT_SCHEMA" \
    "$node_version" "$node_ok" "$NODE_UPGRADED" \
    "$GATEWAY_UNIT" "$GATEWAY_DIAG_SINCE" "$GATEWAY_SHOW_FILE" "$GATEWAY_JOURNAL_FILE" \
    "$OUTCOME" "$EXIT_CODE" "$PHASE" "$RECOVERY" "$ROLLBACK_PERFORMED" "$ROLLBACK_OK" "$ROLLBACK_DETAIL" \
    "$GUARD_ENGAGED" "$BUDGET" "$((DEADLINE - $(date +%s)))" "$PREFETCH_DETAIL" \
    "$LLM_TASK_SESSION" "$LLM_TASK_STATUS" "$NODE_PACKAGE" "$SCAN_UNITS_STARTED" "$STARTED_ON_TARGET"
}

finish() {
  local rc="$1"
  EXIT_CODE="$rc"
  [[ -n "$OUTCOME" ]] || OUTCOME="$([[ $rc == 0 ]] && echo migrated || echo unchanged)"
  start_scan_units || log "could not start every scan unit again"
  FINISHED=1
  if [[ -n "$NODE_BIN" ]]; then
    write_result "$([[ $rc == 0 ]] && echo true || echo false)" ||
      log "could not write $OUT_DIR/result.json"
  else
    # Without a usable node there is no JSON writer; emit a minimal result.
    # TARGET is validated against a version pattern, so it needs no escaping.
    printf '{"ok":false,"outcome":"%s","exit_code":%s,"target":"%s","from":null,"steps":[],"lobster":{"version":null,"ok":false},"node":{"version":null,"ok":false,"upgraded":false},"doctor":{"interactive_prompt_seen":false},"backup":{"path":null,"bytes":0},"failed_step":"%s","message":"no node runtime found to write the full result","schema":%s}\n' \
      "$OUTCOME" "$rc" "$TARGET" "${FAILED_STEP:-preflight}" "$RESULT_SCHEMA" >"$OUT_DIR/result.json"
  fi
  [[ -n "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
  log "result: $OUT_DIR/result.json (exit $rc, outcome $OUTCOME)"
  exit "$rc"
}

# ---------------------------------------------------------------------------
# Discovery (read-only; shared by --dry-run and the real run).
# ---------------------------------------------------------------------------
DISCOVERY_ERROR=""
discover() {
  local unit_file="$UNIT_DIR/$GATEWAY_UNIT" exec_start real exec_pkg
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
  if ! exec_pkg="$(package_root_of "$real")" || ! NPM_PREFIX="$(prefix_of_package "$exec_pkg")"; then
    DISCOVERY_ERROR="openclaw resolves to $real, which is not inside an npm prefix (<prefix>/lib/node_modules/openclaw or <prefix>/lib/sovereign-openclaw-runtime/node_modules/openclaw)"
    return 1
  fi
  # The prefix's bin link is what the node installs and relinks; the unit's
  # ExecStart may name a package path directly.
  BIN_LINK="$NPM_PREFIX/bin/openclaw"
  PKG_DIR="$exec_pkg"
  resolve_pkg_from_bin || PKG_DIR="$exec_pkg"
  # The CLI the gateway runs is a launcher; the service user runs it the same
  # way the unit does, through the prefix's bin link when there is one.
  [[ -e "$BIN_LINK" ]] && OPENCLAW_BIN="$BIN_LINK"
  ORIG_PKG_DIR="$PKG_DIR"
  ORIG_BIN_TARGET="$(readlink "$BIN_LINK" 2>/dev/null || true)"
  NPM_OWNER="$(stat -c %U "$PKG_DIR")"

  NODE_BIN="${OPENCLAW_MIGRATE_NODE_BIN:-$(PATH="$UNIT_PATH" command -v node || true)}"
  if [[ -z "$NODE_BIN" ]]; then
    DISCOVERY_ERROR="no node executable on the gateway PATH ($UNIT_PATH)"
    return 1
  fi
  NODE_DISCOVERED=1
  NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null)"
  NODE_VERSION="${NODE_VERSION#v}"
  FROM_VERSION="$(installed_openclaw_version)"
  if [[ -z "$FROM_VERSION" ]]; then
    DISCOVERY_ERROR="cannot read the installed OpenClaw version from $PKG_DIR/package.json"
    return 1
  fi

  discover_scan_units
  detect_legacy_matrix_store
  discover_lobster
  resolve_target || return 1
  return 0
}

# The node package whose CLI installs the locked runtime and refreshes the
# gateway. By default the package this script ships in.
resolve_node_package() {
  local self
  if [[ -z "$NODE_PACKAGE" ]]; then
    self="$(readlink -f "${BASH_SOURCE[0]}")"
    NODE_PACKAGE="$(dirname "$(dirname "$self")")"
  fi
  NODE_CLI="$NODE_PACKAGE/dist/sovereign-node.js"
  # The installer puts the catalog beside the app (<root>/app, <root>/sovereign-ai-bots).
  BOTS_DIR="${BOTS_DIR:-$(dirname "$NODE_PACKAGE")/sovereign-ai-bots}"
}

runtime_template() { printf '%s/deploy/openclaw-runtime' "$NODE_PACKAGE"; }

LOCKED_VERSION=""
resolve_target() {
  LOCKED_VERSION="$(json_field "$(runtime_template)/package.json" dependencies.openclaw)"
  if [[ "$TARGET_ARG" == pinned ]]; then
    TARGET="$LOCKED_VERSION"
    if [[ -z "$TARGET" ]]; then
      DISCOVERY_ERROR="--target pinned: no OpenClaw version in $(runtime_template)/package.json"
      return 1
    fi
  fi
  return 0
}

# Matrix state only the 2026.6/2026.7 plugin still migrates: the original
# flat layout (<state>/matrix/bot-storage.json, <state>/matrix/crypto) and the
# rust crypto store of the old bot SDK (bot-sdk.json or
# matrix-sdk-crypto.sqlite3 in any account's crypto dir), whose room keys the
# 2026.6 plugin prepares for recovery. Later plugins carry neither migration.
detect_legacy_matrix_store() {
  local m="$STATE_DIR/matrix" candidate
  LEGACY_MATRIX_STORE=""
  for candidate in "$m/bot-storage.json" "$m/crypto"; do
    if [[ -e "$candidate" ]]; then
      LEGACY_MATRIX_STORE="$candidate"
      return 0
    fi
  done
  [[ -d "$m" ]] || return 0
  LEGACY_MATRIX_STORE="$(find "$m" -maxdepth 8 \( -name bot-sdk.json -o -name matrix-sdk-crypto.sqlite3 \) -print -quit 2>/dev/null)"
}

# Whether this run passes through the stage release.
needs_stage() {
  case "$STAGE_MODE" in
    always) return 0 ;;
    never) return 1 ;;
  esac
  [[ -n "$LEGACY_MATRIX_STORE" ]] && version_lt "${FROM_VERSION:-0}" "$STAGE_VERSION"
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

path_is_within() {
  [[ "$1" == "$2" || "$1" == "$2"/* ]]
}

# ---------------------------------------------------------------------------
# Steps.
# ---------------------------------------------------------------------------
step_preflight() {
  if [[ -n "$DISCOVERY_ERROR" ]]; then
    STEP_DETAIL="$DISCOVERY_ERROR"
    return 1
  fi
  log "openclaw: $FROM_VERSION at $PKG_DIR (prefix $NPM_PREFIX, owner $NPM_OWNER, bin $BIN_LINK -> ${ORIG_BIN_TARGET:-none})"
  log "service: user $SERVICE_USER, home $SERVICE_HOME, state $STATE_DIR, config $CONFIG_PATH"
  log "node: $NODE_VERSION ($NODE_BIN); required >=$NODE_MIN <$NODE_MAX_EXCLUSIVE; node package $NODE_PACKAGE locks OpenClaw ${LOCKED_VERSION:-unknown}"
  log "scan units: ${SCAN_UNITS[*]:-none}; legacy matrix store: ${LEGACY_MATRIX_STORE:-none}; lobster: ${LOBSTER_BIN:-not found}"
  log "budget: ${BUDGET}s, $(remaining)s left after the ${RESERVE}s recovery reserve"

  if ! [[ -d "$STATE_DIR" ]]; then
    STEP_DETAIL="OpenClaw state dir $STATE_DIR does not exist"
    return 1
  fi
  if [[ "$NODE_VERSION" =~ ^[0-9]+ ]] && ! version_lt "$NODE_VERSION" "$NODE_MAX_EXCLUSIVE"; then
    STEP_DETAIL="node $NODE_VERSION is above the supported range (<$NODE_MAX_EXCLUSIVE); this script does not downgrade Node"
    return 1
  fi
  if ! node_in_range "$NODE_VERSION"; then
    NODE_NEEDS_UPGRADE=1
    log "node $NODE_VERSION is below $NODE_MIN; it will be upgraded before anything is stopped"
  fi
  local tool
  for tool in npm timeout tar systemctl curl flock; do
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
    STEP_DETAIL="already at $TARGET"
    return 0
  fi
  if version_lt "$TARGET" "$FROM_VERSION"; then
    STEP_DETAIL="target $TARGET is older than the installed $FROM_VERSION; this script does not downgrade"
    return 1
  fi
  if [[ ! -f "$NODE_CLI" || ! -f "$(runtime_template)/package-lock.json" ]]; then
    STEP_DETAIL="$NODE_PACKAGE is not a built node package (need dist/sovereign-node.js and deploy/openclaw-runtime/)"
    return 1
  fi
  if [[ ! -d "$BOTS_DIR/bots" ]]; then
    STEP_DETAIL="no bot catalog at $BOTS_DIR (pass --bots-dir); the node CLI reconciles the bots against it"
    return 1
  fi
  if [[ "$TARGET" != "$LOCKED_VERSION" ]]; then
    STEP_DETAIL="target $TARGET is not the OpenClaw version $NODE_PACKAGE locks (${LOCKED_VERSION:-none}); only that one can be installed"
    return 1
  fi
  # The node CLI installs into the prefix its own user resolves: npm's global
  # prefix for root, ~/.npm-global for anyone else.
  if [[ "$NPM_OWNER" != root && "$NPM_PREFIX" != "$(owner_home)/.npm-global" ]]; then
    STEP_DETAIL="OpenClaw is installed in $NPM_PREFIX, but its owner $NPM_OWNER installs into $(owner_home)/.npm-global; this layout is not supported"
    return 1
  fi
  if (($(remaining) < MIN_WINDOW)); then
    STEP_DETAIL="only $(remaining)s of the ${BUDGET}s budget are left after the ${RESERVE}s reserve; need at least ${MIN_WINDOW}s before stopping anything"
    return 1
  fi
  local state_bytes pkg_bytes need_backup need_prefix free_backup free_prefix
  state_bytes="$(bytes_of "$STATE_DIR")"
  pkg_bytes="$(bytes_of "$PKG_DIR")"
  need_backup=$((state_bytes + pkg_bytes + MIN_FREE_BYTES))
  # The new runtime, plus its prefetch copy while that runs.
  need_prefix=$((2 * pkg_bytes + MIN_FREE_BYTES))
  free_backup="$(free_bytes "$BACKUP_ROOT")"
  free_prefix="$(free_bytes "$NPM_PREFIX")"
  if [[ "$(device_of "$BACKUP_ROOT")" == "$(device_of "$NPM_PREFIX")" ]]; then
    need_backup=$((need_backup + 2 * pkg_bytes))
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
  STEP_DETAIL="from $FROM_VERSION to $TARGET; node $NODE_VERSION${RECOVERY:+; recovering an earlier run ($RECOVERY)}"
}

# A newer Node 22 still runs the installed OpenClaw, so this runs while the
# gateway is up and does not count as touching the tree. Node is never
# downgraded, not even by a rollback.
step_node() {
  local out="$WORK_DIR/apt.out" before="$NODE_VERSION" candidate
  {
    DEBIAN_FRONTEND=noninteractive timeout -k 10 "$(clamp 900)" apt-get -o DPkg::Lock::Timeout=300 update -y &&
      DEBIAN_FRONTEND=noninteractive timeout -k 10 "$(clamp 900)" apt-get -o DPkg::Lock::Timeout=300 install -y --only-upgrade nodejs
  } </dev/null >"$out" 2>&1
  local rc=$?
  log_output "$out"
  NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null)"
  NODE_VERSION="${NODE_VERSION#v}"
  [[ -n "$NODE_VERSION" && "$NODE_VERSION" != "$before" ]] && NODE_UPGRADED=true
  if ((rc != 0)); then
    STEP_DETAIL="apt-get upgrade of nodejs failed (exit $rc)"
    [[ -s "$out" ]] && STEP_DETAIL+=": $(failure_tail "$out")"
    return 1
  fi
  if ! node_in_range "$NODE_VERSION"; then
    candidate="$(apt-cache policy nodejs 2>/dev/null | sed -n 's/^ *Candidate: *//p' | head -n 1)"
    STEP_DETAIL="node is $NODE_VERSION after the upgrade (apt candidate ${candidate:-unknown}); need >=$NODE_MIN <$NODE_MAX_EXCLUSIVE (install it from a repository that carries it)"
    return 1
  fi
  STEP_DETAIL="node $NODE_VERSION"
}

# Downloads every package of the locked runtime into the npm cache of the
# prefix owner while the gateway still runs, so the install after the stop
# needs no network and the downtime is the install alone. Install scripts are
# skipped here; the real install runs them.
step_prefetch() {
  local home dir out t rc
  home="$(owner_home)"
  dir="$NPM_PREFIX/lib/.sovereign-openclaw-prefetch"
  out="$WORK_DIR/prefetch.out"
  # shellcheck disable=SC2016
  if ! as_user "$NPM_OWNER" "$home" bash -c 'rm -rf "$1" && mkdir -p "$1" && cp "$2/package.json" "$2/package-lock.json" "$1/"' _ "$dir" "$(runtime_template)" >"$out" 2>&1; then
    failed_detail "preparing $dir" 1 "$out"
    return 1
  fi
  t="$(clamp "$NPM_TIMEOUT")"
  as_user "$NPM_OWNER" "$dir" env -i \
    HOME="$home" \
    PATH="$UNIT_PATH" \
    CI=1 \
    NPM_CONFIG_CACHE="$home/.npm" \
    timeout -k 30 "$t" npm ci --omit=dev --ignore-scripts --no-audit --no-fund </dev/null >"$out" 2>&1
  rc=$?
  log_output "$out"
  as_user "$NPM_OWNER" "$home" rm -rf "$dir"
  if ((rc != 0)); then
    failed_detail "npm ci (prefetch of openclaw@$TARGET)" "$rc" "$out"
    PREFETCH_DETAIL="$STEP_DETAIL"
    return 1
  fi
  STEP_DETAIL="openclaw@$TARGET and its dependencies are in $home/.npm"
  PREFETCH_DETAIL="$STEP_DETAIL"
}

step_stop() {
  local u rc=0
  UNITS_STOPPED=1
  while IFS= read -r u; do
    if ! timeout "$(clamp "$STOP_TIMEOUT")" systemctl stop "$u" >>"$LOG_FILE" 2>&1; then
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
  if ! cp -p "$UNIT_DIR/$GATEWAY_UNIT" "$dir/gateway.service"; then
    STEP_DETAIL="copying $UNIT_DIR/$GATEWAY_UNIT failed"
    return 1
  fi
  UNIT_BACKUP_PATH="$dir/gateway.service"
  if [[ -f "$CONFIG_PATH" ]] && ! path_is_within "$CONFIG_PATH" "$STATE_DIR"; then
    if ! cp -p "$CONFIG_PATH" "$dir/openclaw-config"; then
      STEP_DETAIL="copying $CONFIG_PATH failed"
      return 1
    fi
    CONFIG_BACKUP_PATH="$dir/openclaw-config"
  fi
  chmod 0600 "$state_archive" "$pkg_archive"
  BACKUP_PATH="$state_archive"
  PKG_BACKUP_PATH="$pkg_archive"
  BACKUP_BYTES="$(stat -c %s "$state_archive")"
  ROLLBACK_SAFE=1
  set_phase backup
  STEP_DETAIL="$BACKUP_PATH (${BACKUP_BYTES} bytes from ${BACKUP_SOURCE_BYTES} bytes of state)"
}

# An earlier run stopped before any new version ran its gateway: put its
# backup back so this run starts from the original tree.
step_restore() {
  if ! restore_backup; then
    STEP_DETAIL="$ROLLBACK_DETAIL"
    return 1
  fi
  ROLLBACK_SAFE=1
  set_phase backup
  STEP_DETAIL="$ROLLBACK_DETAIL"
}

# Runs `openclaw doctor` with stdin at EOF and a hard timeout, and decides
# whether it tried to ask something. A prompt is a failure even when the CLI
# exits 0: the unattended path must not depend on a default answer.
run_doctor() {
  local version="$1" phase="$2" out="$WORK_DIR/doctor-$1-$2.out" rc timed_out=false seen=false t
  t="$(clamp "$DOCTOR_TIMEOUT")"
  # shellcheck disable=SC2086
  openclaw_cli "$t" $DOCTOR_ARGS >"$out" 2>&1
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
      STEP_DETAIL="doctor ($version, $phase) did not finish within ${t}s with stdin closed (waiting for input)"
    else
      STEP_DETAIL="doctor ($version, $phase) asked an interactive question (exit $rc)"
    fi
    return 1
  fi
  if ((rc != 0)); then
    failed_detail "doctor ($version, $phase)" "$rc" "$out"
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
    failed_detail "npm install -g openclaw@$version" "$rc" "$out"
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

# Does the installed CLI need (and accept) --accept-capabilities on
# `plugins install`? See MATRIX_PLUGIN_CONSENT.
plugin_install_takes_consent() {
  local help="$WORK_DIR/plugins-install-help.out"
  case "$MATRIX_PLUGIN_CONSENT" in
    always) return 0 ;;
    never) return 1 ;;
  esac
  openclaw_cli "$(clamp "$CMD_TIMEOUT")" plugins install --help >"$help" 2>&1
  grep -q -e '--accept-capabilities' "$help"
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
  # The plugin is the first-party channel at the host's own version, and the
  # node already ran Matrix enabled before the migration.
  if [[ " $args " != *" --accept-capabilities "* ]] && plugin_install_takes_consent; then
    args+=" --accept-capabilities"
  fi
  # shellcheck disable=SC2086
  openclaw_cli "$(clamp "$NPM_TIMEOUT")" $args >"$out" 2>&1
  rc=$?
  log_output "$out"
  if ((rc != 0)); then
    failed_detail "openclaw $args" "$rc" "$out"
    return 1
  fi
  allow="$ALLOW_PRIVATE_MATRIX"
  if [[ "$allow" == auto ]]; then
    if matrix_homeserver_is_private; then allow=1; else allow=0; fi
  fi
  if [[ "$allow" == 1 ]]; then
    openclaw_cli "$(clamp "$CMD_TIMEOUT")" config set channels.matrix.network.dangerouslyAllowPrivateNetwork true --strict-json >"$out" 2>&1
    rc=$?
    log_output "$out"
    if ((rc != 0)); then
      failed_detail "enabling channels.matrix.network.dangerouslyAllowPrivateNetwork" "$rc" "$out"
      return 1
    fi
    STEP_DETAIL="installed $args; private homeserver opt-in set"
    return 0
  fi
  STEP_DETAIL="installed $args"
}

# See WEB_SEARCH_MODE. Runs after the first doctor pass: the newer CLI may
# refuse to edit a config that still has keys only doctor migrates.
disable_web_search() {
  local version="$1" out="$WORK_DIR/web-search-$1.out" rc current
  if [[ "$WEB_SEARCH_MODE" == keep ]]; then
    STEP_DETAIL="tools.web.search left as configured"
    return 0
  fi
  current="$(json_field "$CONFIG_PATH" tools.web.search.enabled)"
  if [[ "$current" == false ]]; then
    STEP_DETAIL="tools.web.search.enabled already false"
    return 0
  fi
  openclaw_cli "$(clamp "$CMD_TIMEOUT")" config set tools.web.search.enabled false --strict-json >"$out" 2>&1
  rc=$?
  log_output "$out"
  if ((rc != 0)); then
    failed_detail "disabling tools.web.search.enabled" "$rc" "$out"
    return 1
  fi
  STEP_DETAIL="set tools.web.search.enabled=false (was ${current:-unset})"
}

# Records why the gateway did not come up: the unit's restart/exit state and
# the redacted tail of its journal since it was started, in migration.log and
# result.json.
capture_gateway_diagnostics() {
  local since="${GATEWAY_SINCE:-$1}" show_raw="$WORK_DIR/gateway-show.raw" journal_raw="$WORK_DIR/gateway-journal.raw"
  GATEWAY_DIAG_SINCE="$since"
  GATEWAY_SHOW_FILE="$WORK_DIR/gateway-show.txt"
  GATEWAY_JOURNAL_FILE="$WORK_DIR/gateway-journal.txt"
  systemctl show -p "$GATEWAY_SHOW_PROPS" "$GATEWAY_UNIT" >"$show_raw" 2>&1
  if command -v "$JOURNALCTL" >/dev/null 2>&1; then
    "$JOURNALCTL" -u "$GATEWAY_UNIT" --since "@$since" --no-pager -n "$GATEWAY_JOURNAL_LINES" -o short-iso >"$journal_raw" 2>&1
  else
    printf 'journalctl unavailable (%s)\n' "$JOURNALCTL" >"$journal_raw"
  fi
  # 203/EXEC means the unit cannot execute what ExecStart names; record what
  # that is on disk.
  local exec_bin
  exec_bin="$(unit_value "$UNIT_DIR/$GATEWAY_UNIT" ExecStart)"
  exec_bin="${exec_bin%% *}"
  if [[ -n "$exec_bin" ]]; then
    printf 'ExecStartBinary=%s\nExecStartResolved=%s\nExecStartListing=%s\n' "$exec_bin" \
      "$(readlink -f "$exec_bin" 2>/dev/null || echo missing)" "$(stat -c '%A %U:%G %s %N' "$exec_bin" 2>&1)" >>"$show_raw"
  fi
  redact <"$show_raw" >"$GATEWAY_SHOW_FILE"
  redact <"$journal_raw" | tail -n "$GATEWAY_JOURNAL_LINES" >"$GATEWAY_JOURNAL_FILE"
  log "gateway diagnostics: systemctl show $GATEWAY_UNIT"
  log_output "$GATEWAY_SHOW_FILE"
  log "gateway diagnostics: journal of $GATEWAY_UNIT since @$since (last $GATEWAY_JOURNAL_LINES lines)"
  log_output "$GATEWAY_JOURNAL_FILE"
}

# Holds the gateway up once on the stage release: the 2026.6 Matrix plugin
# finishes moving the flat store and recoverable room keys at startup. From
# then on the homeserver has seen state the backup does not have, so the
# backup can no longer be restored.
run_stage_gateway() {
  GATEWAY_SINCE="$(date +%s)"
  rm -f "$GUARD_FILE"
  ROLLBACK_SAFE=0
  set_phase stage-started
  if ! start_gateway; then
    : >"$GUARD_FILE"
    STEP_DETAIL="starting $GATEWAY_UNIT on $STAGE_VERSION failed"
    capture_gateway_diagnostics "$GATEWAY_SINCE"
    return 1
  fi
  if ! HEALTH_TIMEOUT="$(clamp "$HEALTH_TIMEOUT")" step_health; then
    STEP_DETAIL="on $STAGE_VERSION: $STEP_DETAIL"
    timeout "$(clamp "$STOP_TIMEOUT")" systemctl stop "$GATEWAY_UNIT" >>"$LOG_FILE" 2>&1
    : >"$GUARD_FILE"
    return 1
  fi
  sleep "$STAGE_SETTLE"
  if ! timeout "$(clamp "$STOP_TIMEOUT")" systemctl stop "$GATEWAY_UNIT" >>"$LOG_FILE" 2>&1; then
    : >"$GUARD_FILE"
    STEP_DETAIL="stopping $GATEWAY_UNIT after the $STAGE_VERSION start failed"
    return 1
  fi
  : >"$GUARD_FILE"
}

step_stage() {
  mark_touched stage
  set_phase stage
  install_version "$STAGE_VERSION" || return 1
  run_doctor "$STAGE_VERSION" config || return 1
  disable_web_search "$STAGE_VERSION" || return 1
  install_matrix_plugin "$STAGE_VERSION" || return 1
  run_doctor "$STAGE_VERSION" matrix || return 1
  run_stage_gateway || return 1
  STEP_DETAIL="ran $STAGE_VERSION (doctor, matrix plugin, one gateway start) to migrate the legacy Matrix store (${LEGACY_MATRIX_STORE:-forced})"
}

# The node CLI installs the runtime its package locks. As root it installs
# into `npm prefix -g`, which for another PATH's npm is another prefix than
# the gateway's; npm_config_prefix pins it to the one discovered here (an
# unprivileged owner always uses ~/.npm-global, checked in preflight).
# Its install step keeps
# an installed OpenClaw of another version on every other path; this command
# lifts that hold only while this script holds LOCK_FILE and the gateway is
# stopped, which is the state this step runs in.
step_upgrade() {
  local out="$WORK_DIR/install-runtime.out" err="$WORK_DIR/install-runtime.err" home rc got
  mark_touched upgrade
  set_phase upgrade
  home="$(owner_home)"
  # The CLI checks the install by running `openclaw` from PATH; the unit's
  # PATH need not hold the prefix's bin (its ExecStart is absolute).
  as_user "$NPM_OWNER" "$home" env -i \
    HOME="$home" \
    PATH="$NPM_PREFIX/bin:$UNIT_PATH" \
    CI=1 NO_COLOR=1 \
    NPM_CONFIG_CACHE="$home/.npm" \
    npm_config_prefer_offline=true \
    npm_config_prefix="$NPM_PREFIX" \
    timeout -k 30 "$(clamp "$NPM_TIMEOUT")" "$NODE_BIN" "$NODE_CLI" openclaw-migration install-runtime --target "$TARGET" --json \
    </dev/null >"$out" 2>"$err"
  rc=$?
  log_output "$out"
  log_output "$err"
  if ((rc != 0)); then
    failed_cli_detail "sovereign-node openclaw-migration install-runtime --target $TARGET" "$rc" "$err"
    return 1
  fi
  if ! resolve_pkg_from_bin; then
    STEP_DETAIL="after the install $BIN_LINK does not resolve to an openclaw package"
    return 1
  fi
  got="$(installed_openclaw_version)"
  if [[ "$got" != "$TARGET" ]]; then
    STEP_DETAIL="after the install $BIN_LINK resolves to OpenClaw '$got' at $PKG_DIR, expected $TARGET"
    return 1
  fi
  set_phase upgraded
  STEP_DETAIL="installed openclaw@$TARGET at $PKG_DIR"
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
    [[ -s "$WORK_DIR/shrinkwrap.err" ]] && STEP_DETAIL+=": $(failure_tail "$WORK_DIR/shrinkwrap.err")"
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

step_web_search() {
  disable_web_search "$TARGET"
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
  openclaw_cli "$(clamp "$CMD_TIMEOUT")" $args >"$out" 2>&1
  rc=$?
  log_output "$out"
  if ((rc != 0)); then
    failed_detail "openclaw $args" "$rc" "$out"
    return 1
  fi
  STEP_DETAIL="openclaw $args ok"
}

step_validate() { run_cli_check config-validate "$VALIDATE_ARGS"; }
step_matrix_verify() { run_cli_check matrix-verify "$MATRIX_VERIFY_ARGS"; }

# The node CLI gets the app and bot catalog dirs the installed wrapper would
# export; without them it clones a catalog of its own. It runs as the
# identity the node was installed with, the owner of the OpenClaw prefix:
# root on a root install, whose trusted extension tree only root may write,
# and the service user on an unprivileged one.
# The node renders the config and the gateway unit for the version now
# installed and starts the gateway (the unit's sandbox lets it execute only
# the package it was rendered for, so a bare restart would not do). This is
# the point of no return: once the new gateway ran, state it wrote has
# reached the homeserver and the backup is stale.
step_start() {
  local out="$WORK_DIR/refresh.out" err="$WORK_DIR/refresh.err" home before rc wait_s
  release_guard
  home="$(owner_home)"
  before="$(gateway_start_mark)"
  GATEWAY_SINCE="$(date +%s)"
  wait_s="$(clamp "$REFRESH_READY_TIMEOUT")"
  # The node resolves openclaw and npm from PATH when it renders the unit;
  # the unit's own PATH need not hold the prefix's bin.
  as_user "$NPM_OWNER" "$home" env -i \
    HOME="$home" \
    PATH="$NPM_PREFIX/bin:$UNIT_PATH" \
    CI=1 NO_COLOR=1 \
    SOVEREIGN_NODE_GATEWAY_READY_TIMEOUT_MS="$((wait_s * 1000))" \
    SOVEREIGN_NODE_APP_DIR="$NODE_PACKAGE" \
    SOVEREIGN_BOTS_REPO_DIR="$BOTS_DIR" \
    timeout -k 30 "$(clamp $((wait_s + 300)))" "$NODE_BIN" "$NODE_CLI" reconcile --refresh-runtime --json \
    </dev/null >"$out" 2>"$err"
  rc=$?
  log_output "$out"
  log_output "$err"
  if [[ "$(gateway_start_mark)" != "$before" ]] || systemctl_quiet is-active "$GATEWAY_UNIT"; then
    STARTED_ON_TARGET=1
    ROLLBACK_SAFE=0
    set_phase started
  fi
  if ((rc != 0)); then
    failed_cli_detail "sovereign-node reconcile --refresh-runtime" "$rc" "$err"
    capture_gateway_diagnostics "$GATEWAY_SINCE"
    return 1
  fi
  STEP_DETAIL="the node rendered the runtime for $TARGET and started $GATEWAY_UNIT"
}

gateway_restarts() {
  systemctl show -p NRestarts --value "$GATEWAY_UNIT" 2>/dev/null || echo 0
}

# Healthy = the unit is active, has not restart-looped since start, and the
# gateway answers HTTP on its loopback port (any status code counts: the
# root path may require auth, but a transport error means it is not up).
step_health() {
  local deadline baseline code now started
  started="$(date +%s)"
  baseline="$(gateway_restarts)"
  deadline=$((started + HEALTH_TIMEOUT))
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
      capture_gateway_diagnostics "$started"
      return 1
    fi
    now="$(date +%s)"
    if ((now >= deadline)); then
      STEP_DETAIL="gateway not healthy after ${HEALTH_TIMEOUT}s (last HTTP code '${code:-none}')"
      capture_gateway_diagnostics "$started"
      return 1
    fi
    sleep "$HEALTH_POLL"
  done
}

# Calls /tools/invoke through lobster the way the bots do (token in
# CLAWD_TOKEN, arguments as one JSON-quoted lobster argument) and prints the
# HTTP status it got, or nothing when the gateway was not reachable at all.
lobster_invoke_status() {
  local token="$1" tool="$2" out="$3" session="${4:-}" args="${5:-}" rc command
  [[ -n "$args" ]] || args='{}'
  command="clawd.invoke --tool $tool --action json --args-json $(printf '%s' "$args" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>process.stdout.write(JSON.stringify(s)))')${session:+ --session-key $session}"
  # The token arrives on stdin and is exported inside the service user's
  # shell, so it is never part of an argument list visible in /proc.
  # shellcheck disable=SC2016
  as_user "$SERVICE_USER" "$SERVICE_HOME" env -i HOME="$SERVICE_HOME" PATH="$UNIT_PATH" CLAWD_URL="${GATEWAY_URL%/}" \
    timeout -k 5 "$(clamp "$CMD_TIMEOUT")" bash -c 'IFS= read -r CLAWD_TOKEN; export CLAWD_TOKEN; exec "$@" </dev/null' _ \
    "$LOBSTER_BIN" "$command" \
    <<<"$token" >"$out" 2>&1
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
# caller. llm-task is then called the way the mail review calls it, on the
# scan agent's session, with a trivial prompt; its answer (200 = the model
# answered) is recorded but not gated on, because it depends on the model
# provider being reachable, not on the migration.
step_lobster() {
  local out="$WORK_DIR/lobster.out" token pkg rc status
  if [[ -z "$LOBSTER_BIN" ]]; then
    LOBSTER_DETAIL="lobster not installed"
    STEP_DETAIL="$LOBSTER_DETAIL"
    return 1
  fi
  pkg="$(dirname "$(dirname "$(readlink -f "$LOBSTER_BIN")")")"
  LOBSTER_VERSION="$(json_field "$pkg/package.json" version)"
  as_user "$SERVICE_USER" "$SERVICE_HOME" env -i HOME="$SERVICE_HOME" PATH="$UNIT_PATH" \
    timeout -k 5 "$(clamp "$CMD_TIMEOUT")" "$LOBSTER_BIN" 'commands.list | json' </dev/null >"$out" 2>&1
  rc=$?
  if ((rc != 0)) || ! grep -q 'clawd.invoke' "$out" || ! grep -q 'llm_task.invoke' "$out"; then
    log_output "$out"
    LOBSTER_DETAIL="lobster commands.list failed or lacks clawd.invoke/llm_task.invoke (exit $rc)"
    [[ -s "$out" ]] && LOBSTER_DETAIL+=": $(failure_tail "$out")"
    STEP_DETAIL="$LOBSTER_DETAIL"
    return 1
  fi
  token="$(openclaw_cli "$(clamp "$CMD_TIMEOUT")" config get gateway.auth.token 2>/dev/null | tail -n 1 | tr -d '"[:space:]')"
  if [[ -z "$token" || "$token" == *undefined* || "$token" == *null* || "${token,,}" == *redacted* ]]; then
    token="$(json_field "$CONFIG_PATH" gateway.auth.token)"
  fi
  status="$(lobster_invoke_status "$token" sovereign_migrate_probe "$out")"
  LLM_TASK_STATUS="$(lobster_invoke_status "$token" llm-task "$WORK_DIR/lobster-llm.out" "$LLM_TASK_SESSION" "$LLM_TASK_ARGS")"
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
  LOBSTER_DETAIL+="; llm-task on $LLM_TASK_SESSION: HTTP ${LLM_TASK_STATUS:-none}"
  STEP_DETAIL="lobster ${LOBSTER_VERSION:-unknown}: $LOBSTER_DETAIL"
  [[ "$LOBSTER_OK" == true ]]
}

# ---------------------------------------------------------------------------
# Plan / main.
# ---------------------------------------------------------------------------
print_plan() {
  cat <<EOF
OpenClaw migration plan (dry run; nothing is changed)
  target:            ${TARGET:-unknown} (node package ${NODE_PACKAGE:-unknown} locks ${LOCKED_VERSION:-unknown})
  bot catalog:       ${BOTS_DIR:-unknown}
  installed:         ${FROM_VERSION:-unknown} at ${PKG_DIR:-unknown}
  npm prefix:        ${NPM_PREFIX:-unknown} (owner ${NPM_OWNER:-unknown})
  service user/home: ${SERVICE_USER:-unknown} ${SERVICE_HOME:-unknown}
  state dir:         ${STATE_DIR:-unknown}
  node:              ${NODE_VERSION:-unknown} (${NODE_BIN:-not found}); required >=$NODE_MIN <$NODE_MAX_EXCLUSIVE
  units:             $GATEWAY_UNIT ${SCAN_UNITS[*]:-}
  legacy matrix:     ${LEGACY_MATRIX_STORE:-none} (stage mode $STAGE_MODE)
  lobster:           ${LOBSTER_BIN:-not found}
  backup root:       $BACKUP_ROOT
  budget:            ${BUDGET}s (${RESERVE}s kept for recovery)
EOF
  if [[ -n "$DISCOVERY_ERROR" ]]; then
    printf '  discovery error:   %s\n' "$DISCOVERY_ERROR"
  fi
  local n=1
  plan_line() { printf '  %2d. %s\n' "$n" "$*"; n=$((n + 1)); }
  echo "Steps:"
  if [[ -n "$FROM_VERSION" && "$FROM_VERSION" == "$TARGET" && -n "$NODE_BIN" && "$(marker_field status)" != "in-progress" ]]; then
    plan_line "preflight; already at $TARGET: nothing to migrate"
    return
  fi
  plan_line "preflight: versions, node range, node package, budget, disk space, unit state"
  if [[ -n "$NODE_VERSION" ]] && node_in_range "$NODE_VERSION"; then
    plan_line "node: skip ($NODE_VERSION in range)"
  else
    plan_line "node: apt-get install --only-upgrade nodejs (gateway still running)"
  fi
  plan_line "prefetch: npm ci --ignore-scripts of $(runtime_template) into the npm cache (gateway still running)"
  plan_line "guard: $(guard_dropin_path) blocks gateway starts while $GUARD_FILE exists"
  plan_line "stop: $(units_in_stop_order | tr '\n' ' ')"
  plan_line "backup: tar $STATE_DIR and $PKG_DIR, copy the gateway unit, into $BACKUP_ROOT/<timestamp>-${FROM_VERSION:-unknown}/"
  if needs_stage; then
    plan_line "stage: npm install -g openclaw@$STAGE_VERSION; openclaw $DOCTOR_ARGS; web search off; openclaw ${MATRIX_PLUGIN_ARGS//%VERSION%/$STAGE_VERSION}; doctor again; start the gateway once (${STAGE_SETTLE}s) and stop it"
  else
    plan_line "stage: skip (no legacy Matrix store; stage mode $STAGE_MODE)"
  fi
  plan_line "upgrade: sovereign-node openclaw-migration install-runtime --target ${TARGET:-unknown} (prefix ${NPM_PREFIX:-unknown})"
  plan_line "shrinkwrap: write $OUT_DIR/npm-shrinkwrap.json from the installed tree"
  plan_line "doctor: openclaw $DOCTOR_ARGS (stdin closed, ${DOCTOR_TIMEOUT}s; a prompt fails the run)"
  plan_line "web-search: openclaw config set tools.web.search.enabled false (mode $WEB_SEARCH_MODE)"
  plan_line "matrix-plugin: openclaw ${MATRIX_PLUGIN_ARGS//%VERSION%/${TARGET:-unknown}} (--accept-capabilities: $MATRIX_PLUGIN_CONSENT); private homeserver opt-in: $ALLOW_PRIVATE_MATRIX"
  plan_line "doctor-matrix: openclaw $DOCTOR_ARGS again for the plugin's own migrations"
  plan_line "config-validate: openclaw $VALIDATE_ARGS"
  plan_line "matrix-verify: openclaw $MATRIX_VERIFY_ARGS"
  plan_line "start: lift the guard; sovereign-node reconcile --refresh-runtime (renders config and unit, starts the gateway)"
  plan_line "health: wait up to ${HEALTH_TIMEOUT}s for $GATEWAY_URL"
  plan_line "lobster: commands.list, /tools/invoke probe, llm-task on $LLM_TASK_SESSION"
  plan_line "on failure: restart (nothing changed), roll back (no new gateway ran yet) or fix forward"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --target | --out | --node-package | --bots-dir | --budget)
        [[ $# -ge 2 ]] || die_usage "$1 needs a value"
        set_arg "${1#--}" "$2"
        shift 2
        ;;
      --target=* | --out=* | --node-package=* | --bots-dir=* | --budget=*)
        local key="${1%%=*}"
        set_arg "${key#--}" "${1#*=}"
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
  [[ -n "$TARGET_ARG" ]] || die_usage "--target is required"
  if [[ "$TARGET_ARG" != pinned ]]; then
    [[ "$TARGET_ARG" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,3}(-[0-9A-Za-z.]+)?$ ]] ||
      die_usage "--target must be an OpenClaw release version such as 2026.8.35, or pinned"
    TARGET="$TARGET_ARG"
  fi
  [[ -n "$OUT_DIR" ]] || die_usage "--out is required"
  BUDGET="${BUDGET:-$DEFAULT_BUDGET}"
  [[ "$BUDGET" =~ ^[0-9]{1,6}$ ]] || die_usage "--budget must be a whole number of seconds"
}

set_arg() {
  case "$1" in
    target) TARGET_ARG="$2" ;;
    out) OUT_DIR="$2" ;;
    node-package) NODE_PACKAGE="$2" ;;
    bots-dir) BOTS_DIR="$2" ;;
    budget) BUDGET="$2" ;;
  esac
}

main() {
  parse_args "$@"
  resolve_node_package
  DEADLINE=$(($(date +%s) + BUDGET))

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
  trap on_exit EXIT

  exec 9>"$LOCK_FILE" || {
    FAILED_STEP=lock
    OUTCOME=busy
    FINAL_MESSAGE="cannot open lock file $LOCK_FILE"
    log "$FINAL_MESSAGE"
    finish 4
  }
  if ! flock -n 9; then
    FAILED_STEP=lock
    OUTCOME=busy
    FINAL_MESSAGE="another migration holds $LOCK_FILE"
    log "$FINAL_MESSAGE"
    finish 4
  fi
  # The node CLI's install step, which runs as the prefix owner, probes this
  # lock and needs to open it.
  chmod 0644 "$LOCK_FILE" 2>/dev/null
  trap 'on_signal TERM' TERM
  trap 'on_signal INT' INT
  trap 'on_signal HUP' HUP

  log "OpenClaw migration to ${TARGET:-$TARGET_ARG} started (budget ${BUDGET}s)"
  discover || true
  [[ -n "$NODE_BIN" ]] && classify_run

  run_step preflight step_preflight

  if ((ALREADY_DONE == 1)); then
    local s
    for s in node prefetch guard stop backup stage upgrade; do skip_step "$s" "already at $TARGET"; done
    run_step shrinkwrap step_shrinkwrap
    for s in doctor web-search matrix-plugin doctor-matrix config-validate matrix-verify start health lobster; do
      skip_step "$s" "already at $TARGET"
    done
    OUTCOME=already-current
    FINAL_MESSAGE="already at OpenClaw $TARGET; nothing changed"
    log "$FINAL_MESSAGE"
    finish 0
  fi

  if ((NODE_NEEDS_UPGRADE == 1)); then
    run_step node step_node
  else
    skip_step node "node $NODE_VERSION already in range"
  fi
  if [[ "$RECOVERY" == resume ]]; then
    skip_step prefetch "openclaw@$TARGET already installed"
  else
    run_step prefetch step_prefetch
  fi
  run_step guard step_guard
  run_step stop step_stop
  case "$RECOVERY" in
    resume | upgrade) skip_step backup "backup from the unfinished run: $BACKUP_PATH" ;;
    restore) run_step backup step_restore ;;
    *) run_step backup step_backup ;;
  esac
  if [[ "$RECOVERY" == resume || "$RECOVERY" == upgrade ]]; then
    skip_step stage "resuming ($RECOVERY)"
  elif needs_stage; then
    run_step stage step_stage
  else
    skip_step stage "no legacy Matrix store to migrate (stage mode $STAGE_MODE)"
  fi
  if [[ "$RECOVERY" == resume ]]; then
    skip_step upgrade "openclaw@$TARGET already installed"
  else
    run_step upgrade step_upgrade
  fi
  run_step shrinkwrap step_shrinkwrap
  run_step doctor step_doctor
  run_step web-search step_web_search
  run_step matrix-plugin step_matrix_plugin
  run_step doctor-matrix step_doctor_matrix
  run_step config-validate step_validate
  run_step matrix-verify step_matrix_verify
  run_step start step_start
  run_step health step_health
  run_step lobster step_lobster
  PHASE=completed
  write_marker completed

  OUTCOME=migrated
  FINAL_MESSAGE="migrated OpenClaw ${FROM_VERSION} -> ${TARGET}"
  log "$FINAL_MESSAGE"
  finish 0
}

main "$@"
