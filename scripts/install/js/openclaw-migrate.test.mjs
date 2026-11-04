// Hermetic tests for scripts/openclaw-migrate.sh. Every external program the
// script drives (systemctl, journalctl, npm, apt-get, apt-cache, curl, getent,
// runuser, the node CLI, the OpenClaw CLI and lobster) is a stub whose
// behaviour is switched by files in the fixture's state directory: the script
// runs those programs under `env -i`, so environment variables would not
// reach the stubs.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

// Each case runs the real script end to end (a few seconds on a busy runner).
vi.setConfig({ testTimeout: 90_000 });

// Asynchronous on purpose: a synchronous spawn blocks the worker's event loop
// long enough for vitest's own RPC to time out. Detached, so the script leads
// its own process group and a stub can kill that group like a power loss.
const exec = (command, args, options, onSpawn) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "openclaw-migrate.sh");
const FROM = "2026.3.13";
const TARGET = "2026.8.35";
const STAGE = "2026.6.35";
const GATEWAY = "sovereign-openclaw-gateway.service";
const SCAN_TIMER = "sovereign-mail-sentinel-scan.timer";
const SCAN_SERVICE = "sovereign-mail-sentinel-scan.service";
const GUARD_DROPIN = "zz-openclaw-migrate-guard.conf";
const RUNTIME = join("lib", "sovereign-openclaw-runtime", "node_modules", "openclaw");
const SECRETS = {
  openrouter: "sk-or-v1-0123456789abcdefSECRET",
  matrix: "syt_bWF0cml4_SECRETmatrixtoken_1a2b3c",
  gateway: "gw-token-SECRET-4f5e6d7c",
};

const fixtures = [];
afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop(), { recursive: true, force: true });
  }
});

const write = (path, content, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

const stub = (dir, name, body) =>
  write(join(dir, name), `#!/usr/bin/env bash\nS=${JSON.stringify(dir.replace(/\/bin$/, "/state"))}\n${body}\n`, 0o755);

const packageJson = (name, version) =>
  `${JSON.stringify({ name, version, bin: { openclaw: "openclaw.mjs" }, engines: { node: ">=22" }, dependencies: { dep: "^1.0.0" } }, null, 2)}\n`;

const hiddenLockfile = (stem, version, depVersion = "1.0.0", extra = {}) =>
  `${JSON.stringify(
    {
      name: "lib",
      lockfileVersion: 3,
      requires: true,
      packages: {
        [stem]: { version, resolved: `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`, integrity: "sha512-openclaw" },
        [`${stem}/node_modules/dep`]: {
          version: depVersion,
          resolved: `https://registry.npmjs.org/dep/-/dep-${depVersion}.tgz`,
          integrity: "sha512-dep",
        },
        ...extra,
      },
    },
    null,
    2,
  )}\n`;

// The node CLI: `openclaw-migration install-runtime` installs the locked
// runtime and relinks <prefix>/bin/openclaw; `reconcile --refresh-runtime`
// re-renders the gateway unit and starts the gateway.
const nodeCliStub = ({ state, units, backup, lock }) => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const S = ${JSON.stringify(state)};
const has = (f) => fs.existsSync(path.join(S, f));
const log = (line) => fs.appendFileSync(path.join(S, "calls.log"), line + "\\n");
const args = process.argv.slice(2);
const scriptGroup = () => Number(fs.readFileSync(path.join(S, "script-pgid"), "utf8"));
const fail = (command, code, message) => {
  process.stderr.write('{"level":30,"msg":"working"}\\n');
  process.stderr.write(JSON.stringify({ ok: false, command, error: { code, message, retryable: false } }) + "\\n");
  process.exit(1);
};
const succeed = (command, result) => {
  process.stdout.write(JSON.stringify({ ok: true, command, result }) + "\\n");
  process.exit(0);
};
const countBackups = (dir) => {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "openclaw-state.tar.gz"))) n += 1;
    }
  } catch {}
  return n;
};
if (args[0] === "openclaw-migration" && args[1] === "install-runtime") {
  const command = "openclaw-migration install-runtime";
  const target = args[args.indexOf("--target") + 1];
  const gateway = fs.existsSync(path.join(S, "active", ${JSON.stringify(GATEWAY)})) ? "active" : "inactive";
  const lock = cp.spawnSync("flock", ["-n", "-s", ${JSON.stringify(lock)}, "true"]).status === 0 ? "free" : "held";
  log(\`sovereign-node install-runtime target=\${target} gateway=\${gateway} lock=\${lock} backups=\${countBackups(${JSON.stringify(backup)})} prefer_offline=\${process.env.npm_config_prefer_offline ?? "unset"} user_home=\${process.env.HOME}\`);
  // A power loss: the script and this command die together.
  if (has("install-kill")) {
    process.kill(-scriptGroup(), "SIGKILL");
    process.kill(process.pid, "SIGKILL");
  }
  if (has("install-term")) {
    process.kill(-scriptGroup(), "SIGTERM");
    setTimeout(() => process.exit(143), 300);
    return;
  }
  if (has("install-fail")) fail(command, "OPENCLAW_INSTALL_FAILED", "OpenClaw locked runtime install (npm ci) exited with a non-zero status token=${SECRETS.gateway}");
  if (has("offline") && !has("prefetched")) fail(command, "OPENCLAW_INSTALL_FAILED", "npm ci: getaddrinfo EAI_AGAIN registry.npmjs.org");
  const prefix = path.join(process.env.HOME, ".npm-global");
  const legacy = path.join(prefix, "lib", "node_modules", "openclaw");
  const runtimeProject = path.join(prefix, "lib", "sovereign-openclaw-runtime");
  const pkg = path.join(runtimeProject, "node_modules", "openclaw");
  fs.rmSync(runtimeProject, { recursive: true, force: true });
  fs.mkdirSync(pkg, { recursive: true });
  const version = has("install-wrong-version") ? "2026.1.1" : target;
  fs.writeFileSync(path.join(pkg, "package.json"), fs.readFileSync(path.join(legacy, "package.json"), "utf8").replace(/"version": "[^"]*"/, \`"version": "\${version}"\`));
  fs.copyFileSync(path.join(legacy, "openclaw.mjs"), path.join(pkg, "openclaw.mjs"));
  fs.chmodSync(path.join(pkg, "openclaw.mjs"), 0o755);
  fs.cpSync(path.join(legacy, "node_modules"), path.join(pkg, "node_modules"), { recursive: true });
  const dep = has("lockfile-mismatch") ? "0.9.0" : "1.0.0";
  fs.writeFileSync(path.join(runtimeProject, "node_modules", ".package-lock.json"),
    fs.readFileSync(path.join(S, "lock.template"), "utf8").replaceAll("@V@", version).replaceAll("@DEP@", dep));
  const link = path.join(prefix, "bin", "openclaw");
  fs.rmSync(link + ".tmp", { force: true });
  fs.symlinkSync(path.join(pkg, "openclaw.mjs"), link + ".tmp");
  fs.renameSync(link + ".tmp", link);
  succeed(command, { version, binaryPath: link, installMethod: "locked_project", reinstalled: true });
}
if (args[0] === "reconcile") {
  const command = "reconcile";
  log(\`sovereign-node reconcile \${args.slice(1).join(" ")} ready_ms=\${process.env.SOVEREIGN_NODE_GATEWAY_READY_TIMEOUT_MS} user_home=\${process.env.HOME}\`);
  fs.appendFileSync(path.join(${JSON.stringify(units)}, ${JSON.stringify(GATEWAY)}), "# rendered by the node for the installed OpenClaw\\n");
  if (has("refresh-fail")) fail(command, "GATEWAY_REFRESH_FAILED", "Runtime refresh step openclaw-runtime failed: template pin mismatch");
  cp.spawnSync("systemctl", ["start", ${JSON.stringify(GATEWAY)}], { stdio: "ignore" });
  if (has("refresh-fail-after-start")) fail(command, "GATEWAY_REFRESH_FAILED", "gateway not ready by its deadline");
  succeed(command, { reconciled: [], runtimeRefresh: { rendered: true, restarted: true, ready: true } });
}
process.stderr.write("unexpected sovereign-node call: " + args.join(" ") + "\\n");
process.exit(64);
`;

const makeFixture = ({
  flatMatrixStore = false,
  legacyCrypto = false,
  nodeVersion = "22.22.3",
  scanActive = true,
  homeserver = "http://127.0.0.1:8008",
  lockedVersion = TARGET,
  configOutside = false,
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-migrate-test-"));
  fixtures.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const units = join(root, "units");
  const home = join(root, "home");
  const prefix = join(home, ".npm-global");
  const pkg = join(prefix, "lib", "node_modules", "openclaw");
  const backup = join(root, "backup");
  const lock = join(root, "migrate.lock");
  const nodePackage = join(root, "nodepkg");
  const user = userInfo().username;
  mkdirSync(join(state, "active"), { recursive: true });
  writeFileSync(join(state, "node-version"), nodeVersion);
  writeFileSync(join(state, "calls.log"), "");

  // The node package: its CLI and the locked runtime project it ships.
  write(join(nodePackage, "package.json"), `${JSON.stringify({ name: "sovereign-ai-node", version: "2.14.0" })}\n`);
  write(
    join(nodePackage, "deploy", "openclaw-runtime", "package.json"),
    `${JSON.stringify({ name: "sovereign-openclaw-runtime", private: true, dependencies: { openclaw: lockedVersion }, overrides: { zod: "4.6.6" } }, null, 2)}\n`,
  );
  write(join(nodePackage, "deploy", "openclaw-runtime", "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  write(join(nodePackage, "dist", "sovereign-node.js"), nodeCliStub({ state, units, backup, lock }), 0o755);

  // The installed OpenClaw: the global layout of earlier releases.
  write(join(pkg, "package.json"), packageJson("openclaw", FROM));
  write(join(pkg, "node_modules", "dep", "package.json"), `${JSON.stringify({ name: "dep", version: "1.0.0" })}\n`);
  write(join(pkg, "node_modules", "@scope", "util", "package.json"), `${JSON.stringify({ name: "@scope/util", version: "2.0.0", license: "MIT" })}\n`);
  write(join(prefix, "lib", "node_modules", ".package-lock.json"), hiddenLockfile("node_modules/openclaw", FROM, "1.0.0", { "node_modules/npm": { version: "10.9.0" } }));
  writeFileSync(join(state, "lock.template"), hiddenLockfile("node_modules/openclaw", "@V@", "@DEP@", { "node_modules/peer": { version: "1.0.0" } }));
  stub(
    pkg,
    "openclaw.mjs",
    `S=${JSON.stringify(state)}
v="$(sed -n 's/.*"version": "\\(.*\\)".*/\\1/p' "$(dirname "$(readlink -f "$0")")/package.json" | head -n 1)"
printf 'openclaw@%s %s home=%s tty=%s key=%s\\n' "$v" "$*" "$HOME" "$([ -t 0 ] && echo yes || echo no)" "$([ -n "\${OPENROUTER_API_KEY:-}" ] && echo set || echo unset)" >>"$S/calls.log"
case "$1 \${2:-}" in
  "doctor --fix")
    echo "$PWD" >>"$S/doctor-cwd"
    [ -e "$S/doctor-kill" ] && [ "$v" = "${TARGET}" ] && { kill -KILL -- "-$(cat "$S/script-pgid")"; kill -KILL $$; }
    if [ -e "$S/doctor-try-start" ]; then
      systemctl start ${GATEWAY}
      [ -e "$S/active/${GATEWAY}" ] && echo started >"$S/guard-probe" || echo blocked >"$S/guard-probe"
    fi
    if [ -e "$S/doctor-delete-backup" ]; then
      find ${JSON.stringify(backup)} -name openclaw-state.tar.gz -delete
      echo "doctor failed"; exit 3
    fi
    # OpenClaw (through execa) starts every child with an explicit cwd of
    # process.cwd(); in a directory this user cannot traverse that chdir fails.
    if [ -e "$S/doctor-eacces" ] || ! node -e 'require("node:child_process").execFileSync("true", { cwd: process.cwd(), stdio: "ignore" })' 2>/dev/null; then
      echo "│  - Moved plugins.entries.llm-task.config.allowedModels to llm.allowedCompletionModels.  │"
      echo "├──────────────────────────────────────────────╯"
      echo "Doctor could not complete maintenance. Check the reported service state, resolve the failure, and rerun doctor --fix."
      echo "Command failed during launch or output capture (EACCES)"
      exit 1
    fi
    [ -e "$S/plugin-installed" ] || echo "Config warnings: plugins.entries.matrix: plugin not installed: matrix — install the official external plugin with: openclaw plugins install clawhub:@openclaw/matrix"
    [ -e "$S/doctor-secret-fail" ] && { echo "Error: provider rejected key $OPENROUTER_API_KEY"; exit 2; }
    if [ -e "$S/doctor-prompt" ]; then
      printf '◆  Migrate heartbeat to automations?\\n'
      if read -r answer; then echo "answered $answer"; fi
      echo "ExitPromptError: User force closed the prompt with 0 null"
      exit 1
    fi
    [ -e "$S/doctor-hang" ] && sleep 30
    [ -e "$S/doctor-fail-$v" ] && { echo "doctor failed"; exit 3; }
    [ -e "$S/doctor-matrix-fail" ] && [ -e "$S/plugin-installed" ] && { echo "matrix migration failed"; exit 4; }
    echo "doctor: migrated config (token=$OPENROUTER_API_KEY)"
    mkdir -p "$HOME/.openclaw/state" && echo "$v" >"$HOME/.openclaw/state/openclaw.sqlite"
    exit 0 ;;
  "config validate")
    [ -e "$S/validate-fail" ] && { echo "config invalid"; exit 1; }
    echo "config ok"; exit 0 ;;
  "config get") [ -e "$S/config-get-redacted" ] && { echo "__OPENCLAW_REDACTED__"; exit 0; }; echo "\\"${SECRETS.gateway}\\""; exit 0 ;;
  "config set")
    [ -e "$S/config-set-fail-$3" ] && { echo "config set $3 refused"; exit 1; }
    printf '%s=%s\\n' "$3" "$4" >>"$OPENCLAW_CONFIG_PATH"
    echo "updated $3"; exit 0 ;;
  "plugins install")
    # The stage release predates capability consent and rejects the flag;
    # the target refuses an enabled plugin without it when there is no TTY.
    consent=yes; [ "$v" = "${STAGE}" ] && consent=no
    case " $* " in *" --accept-capabilities "*) accepted=yes ;; *) accepted=no ;; esac
    if [ "$3" = "--help" ]; then
      echo "Usage: openclaw plugins install [options] <path-or-spec-or-plugin>"
      echo "  --force                  Confirm non-ClawHub sources and overwrite an existing plugin"
      [ "$consent" = yes ] && echo "  --accept-capabilities    Accept the plugin's declared capabilities"
      exit 0
    fi
    [ "$consent$accepted" = noyes ] && { echo "error: unknown option '--accept-capabilities'"; exit 1; }
    [ -e "$S/plugin-fail" ] && { echo "npm ERR! 404 Not Found - GET https://registry.npmjs.org/@openclaw%2fmatrix (auth $MATRIX_ACCESS_TOKEN)"; echo "[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace."; exit 1; }
    echo "Installing $3 into $HOME/.openclaw/npm/projects/openclaw-matrix"
    if [ "$consent$accepted" = yesno ]; then
      echo "[openclaw] Could not start the CLI."
      echo "[openclaw] Reason: Plugin \\"matrix\\" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry."
      echo "[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace."
      echo "[openclaw] Try: openclaw doctor"
      echo "[openclaw] Help: openclaw --help"
      exit 1
    fi
    mkdir -p "$HOME/.openclaw/npm/projects/openclaw-matrix" && echo "$v" >"$HOME/.openclaw/npm/projects/openclaw-matrix/version"
    touch "$S/plugin-installed"; echo "installed $3"; exit 0 ;;
  "matrix verify") [ -e "$S/matrix-fail" ] && { echo "matrix: server device unknown"; exit 1; }; echo "matrix: verified"; exit 0 ;;
esac
echo "unexpected openclaw call: $*" >&2
exit 64`,
  );
  chmodSync(join(pkg, "openclaw.mjs"), 0o755);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", join(prefix, "bin", "openclaw"));

  // Service home with state, the gateway env file and the pinned lobster.
  const configPath = configOutside ? join(home, "openclaw.json5") : join(home, ".openclaw", "openclaw.json5");
  write(configPath, `${JSON.stringify({ gateway: { auth: { token: SECRETS.gateway } }, agents: { list: [] } }, null, 2)}\n`);
  write(join(home, ".openclaw", "agents", "main", "sessions.json"), "{}\n");
  if (flatMatrixStore) {
    write(join(home, ".openclaw", "matrix", "bot-storage.json"), "{}\n");
  }
  const accountDir = join(home, ".openclaw", "matrix", "accounts", "default", "127.0.0.1__bot", "0123456789abcdef");
  write(join(accountDir, "bot-storage.json"), "{}\n");
  if (legacyCrypto) {
    write(join(accountDir, "crypto", "bot-sdk.json"), "{}\n");
  }
  write(
    join(home, "gateway.env"),
    [
      `HOME=${home}`,
      `OPENCLAW_CONFIG_PATH=${configPath}`,
      `OPENROUTER_API_KEY=${SECRETS.openrouter}`,
      `MATRIX_ACCESS_TOKEN=${SECRETS.matrix}`,
      `MATRIX_HOMESERVER=${homeserver}`,
      "",
    ].join("\n"),
    0o600,
  );
  const lobsterPkg = join(prefix, "lib", "node_modules", "@clawdbot", "lobster");
  write(join(lobsterPkg, "package.json"), `${JSON.stringify({ name: "@clawdbot/lobster", version: "2026.1.24" })}\n`);
  stub(
    join(lobsterPkg, "bin"),
    "lobster.js",
    `S=${JSON.stringify(state)}
printf 'lobster %s\\n' "$*" >>"$S/calls.log"
# The token must reach lobster in its environment, never in a command line.
ps -o args= -p "$PPID" 2>/dev/null | grep -qF "${SECRETS.gateway}" && echo leaked >>"$S/token-in-argv"
case "$1" in
  "commands.list | json")
    [ -e "$S/lobster-broken" ] && { echo "SyntaxError"; exit 1; }
    echo '["exec","json","clawd.invoke","llm_task.invoke"]'; exit 0 ;;
  clawd.invoke*)
    if [ -e "$S/lobster-status" ]; then code="$(cat "$S/lobster-status")";
    elif [ "\${CLAWD_TOKEN:-}" != "${SECRETS.gateway}" ]; then code=401;
    else
      case "$1" in
        *'--tool llm-task --action json --args-json "{\\"prompt\\":'*'--session-key agent:mail-sentinel-scan:main') echo '{"ok":true}'; exit 0 ;;
        *"--tool llm-task"*) code=404 ;;
        *) code=404 ;;
      esac
    fi
    echo "Error: clawd.invoke failed ($code): {\\"error\\":\\"x\\"}" >&2; exit 1 ;;
esac
exit 64`,
  );
  symlinkSync("../lib/node_modules/@clawdbot/lobster/bin/lobster.js", join(prefix, "bin", "lobster"));

  // systemd units.
  const unitPath = [bin, join(prefix, "bin"), process.env.PATH].join(":");
  const unitText = [
    "[Service]",
    `User=${user}`,
    `WorkingDirectory=${home}`,
    `Environment=HOME=${home}`,
    `Environment=PATH=${unitPath}`,
    `EnvironmentFile=-${join(home, "gateway.env")}`,
    `ExecStart=${join(prefix, "bin", "openclaw")} gateway run --allow-unconfigured --bind loopback`,
    "",
  ].join("\n");
  write(join(units, GATEWAY), unitText);
  write(join(units, SCAN_TIMER), "[Timer]\nOnUnitActiveSec=5m\n");
  write(join(units, SCAN_SERVICE), "[Service]\nType=oneshot\n");
  writeFileSync(join(state, "active", GATEWAY), "");
  if (scanActive) writeFileSync(join(state, "active", SCAN_TIMER), "");
  mkdirSync(join(state, "enabled"), { recursive: true });
  writeFileSync(join(state, "enabled", SCAN_TIMER), "");

  // Host tool stubs. A start of the gateway is a no-op while the migration's
  // drop-in names a guard file that exists, as ConditionPathExists=! makes it.
  stub(
    bin,
    "systemctl",
    `printf 'systemctl %s\\n' "$*" >>"$S/calls.log"
unit="\${@: -1}"
case "$1" in
  is-active) [ -e "$S/active/$unit" ]; exit ;;
  is-enabled) [ -e "$S/enabled/$unit" ]; exit ;;
  stop) [ -e "$S/stop-fail" ] && exit 1; rm -f "$S/active/$unit"; exit 0 ;;
  start)
    [ -e "$S/start-fail" ] && exit 1
    dropin=${JSON.stringify(units)}/"$unit.d/${GUARD_DROPIN}"
    if [ -f "$dropin" ]; then
      guard="$(sed -n 's/^ConditionPathExists=!//p' "$dropin")"
      [ -e "$guard" ] && { echo "skipped $unit: condition" >>"$S/calls.log"; exit 0; }
    fi
    touch "$S/active/$unit"
    [ "$unit" = ${GATEWAY} ] && echo $(($(cat "$S/starts" 2>/dev/null || echo 0) + 1)) >"$S/starts"
    exit 0 ;;
  cat) [ -e ${JSON.stringify(units)}/"$unit" ]; exit ;;
  daemon-reload) exit 0 ;;
  show)
    case " $* " in
      *" ExecMainStartTimestampMonotonic "*) cat "$S/starts" 2>/dev/null || echo 0; exit 0 ;;
      *" --value "*) ;;
      *)
        if [ -e "$S/show-props" ]; then cat "$S/show-props"; else printf 'NRestarts=%s\nResult=success\nActiveState=active\nSubState=running\n' "$(cat "$S/nrestarts" 2>/dev/null || echo 0)"; fi
        exit 0 ;;
    esac
    n="$(cat "$S/nrestarts" 2>/dev/null || echo 0)"; echo "$n"
    [ -e "$S/health-restart" ] && echo $((n + 1)) >"$S/nrestarts"
    exit 0 ;;
esac
exit 0`,
  );
  stub(
    bin,
    "npm",
    `echo "$PWD" >>"$S/npm-cwd"
printf 'npm %s backups=%s gateway=%s\\n' "$*" "$(find ${JSON.stringify(backup)} -name 'openclaw-state.tar.gz' 2>/dev/null | wc -l)" "$([ -e "$S/active/${GATEWAY}" ] && echo active || echo inactive)" >>"$S/calls.log"
if [ "$1" = ci ]; then
  { [ -e "$S/npm-fail-prefetch" ] || [ -e "$S/offline" ]; } && { echo "npm ERR! code EAI_AGAIN"; echo "npm ERR! request to https://registry.npmjs.org/openclaw failed"; exit 1; }
  [ -f package-lock.json ] || { echo "npm ERR! no package-lock.json"; exit 1; }
  touch "$S/prefetched"; mkdir -p node_modules/openclaw; echo "added 531 packages"; exit 0
fi
[ "$1 $2" = "install -g" ] || exit 64
spec="$3"; version="\${spec#openclaw@}"
[ -e "$S/npm-fail-$version" ] && { echo "npm ERR! network"; exit 1; }
pkg="$npm_config_prefix/lib/node_modules/openclaw"
sed -i "s/\\"version\\": \\"[^\\"]*\\"/\\"version\\": \\"$version\\"/" "$pkg/package.json"
sed -e "s/@V@/$version/g" -e "s/@DEP@/1.0.0/g" ${JSON.stringify(join(state, "lock.template"))} >"$npm_config_prefix/lib/node_modules/.package-lock.json"
echo "added 531 packages"; exit 0`,
  );
  stub(
    bin,
    "apt-get",
    `printf 'apt-get %s gateway=%s\\n' "$*" "$([ -e "$S/active/${GATEWAY}" ] && echo active || echo inactive)" >>"$S/calls.log"
[ -e "$S/apt-fail" ] && exit 100
case " $* " in *" install "*) [ -e "$S/node-upgrade-to" ] && cp "$S/node-upgrade-to" "$S/node-version" ;; esac
exit 0`,
  );
  stub(bin, "apt-cache", `printf 'nodejs:\\n  Installed: %s\\n  Candidate: %s\\n' "$(cat "$S/node-version")" "$(cat "$S/node-version")-1nodesource1"`);
  stub(
    bin,
    "curl",
    `printf 'curl %s\\n' "$*" >>"$S/calls.log"
if [ -e "$S/active/${GATEWAY}" ] && [ ! -e "$S/health-fail" ] && [ ! -e "$S/health-restart" ]; then
  if [ ! -e "$S/stage-health-fail" ] || ! grep -q '"version": "${STAGE}"' ${JSON.stringify(join(pkg, "package.json"))}; then printf '401'; exit 0; fi
fi
printf '000'; exit 7`,
  );
  stub(
    bin,
    "journalctl",
    `printf 'journalctl %s\\n' "$*" >>"$S/calls.log"
[ -e "$S/journal" ] && cat "$S/journal"
exit 0`,
  );
  stub(bin, "getent", `printf '%s:x:1000:1000::%s:/bin/bash\\n' "$2" ${JSON.stringify(home)}`);
  stub(bin, "runuser", `printf 'runuser %s\\n' "$*" >>"$S/calls.log"; shift 3; exec "$@"`);
  stub(
    bin,
    "node",
    `if [ "\${1:-}" = "-v" ]; then printf 'v%s\\n' "$(cat "$S/node-version")"; exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"`,
  );

  return { root, bin, state, units, home, prefix, pkg, nodePackage, lock, configPath, unitText, out: join(root, "out"), backup };
};

const flag = (fx, name, content = "") => writeFileSync(join(fx.state, name), content);
const unflag = (fx, name) => rmSync(join(fx.state, name), { force: true });

const baseEnv = (fx, extraEnv = {}) => ({
  PATH: `${fx.bin}:${process.env.PATH}`,
  HOME: fx.root,
  TMPDIR: fx.root,
  OPENCLAW_MIGRATE_ALLOW_NON_ROOT: "1",
  OPENCLAW_MIGRATE_UNIT_DIR: fx.units,
  OPENCLAW_MIGRATE_BACKUP_ROOT: fx.backup,
  OPENCLAW_MIGRATE_LOCK_FILE: fx.lock,
  OPENCLAW_MIGRATE_MIN_FREE_BYTES: "0",
  OPENCLAW_MIGRATE_HEALTH_TIMEOUT: "2",
  OPENCLAW_MIGRATE_HEALTH_POLL: "0.2",
  OPENCLAW_MIGRATE_DOCTOR_TIMEOUT: "20",
  OPENCLAW_MIGRATE_STAGE_SETTLE: "0",
  ...extraEnv,
});

const defaultArgs = (fx) => ["--target", TARGET, "--out", fx.out, "--node-package", fx.nodePackage];

// `cwd` starts the script from that directory after making it untraversable,
// the way a root caller's 0700 staging directory is for the service user.
const run = async (fx, args = defaultArgs(fx), extraEnv = {}, { cwd } = {}) => {
  writeFileSync(join(fx.state, "calls.log"), "");
  const argv =
    cwd === undefined ? [SCRIPT, ...args] : ["-c", 'cd "$1" && chmod 000 . && shift && exec bash "$@"', "_", cwd, SCRIPT, ...args];
  const result = await exec("bash", argv, { env: baseEnv(fx, extraEnv) }, (child) => {
    writeFileSync(join(fx.state, "script-pgid"), String(child.pid));
  });
  if (cwd !== undefined) chmodSync(cwd, 0o700);
  const resultPath = join(fx.out, "result.json");
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: readFileSync(join(fx.state, "calls.log"), "utf8").split("\n").filter(Boolean),
    result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null,
    log: existsSync(join(fx.out, "migration.log")) ? readFileSync(join(fx.out, "migration.log"), "utf8") : "",
  };
};

// What <prefix>/bin/openclaw, the gateway's CLI, resolves to.
const installedPackage = (fx) => dirname(realpathSync(join(fx.prefix, "bin", "openclaw")));
const installedVersion = (fx) => JSON.parse(readFileSync(join(installedPackage(fx), "package.json"), "utf8")).version;
const isActive = (fx, unit) => existsSync(join(fx.state, "active", unit));
const guardDropin = (fx) => join(fx.units, `${GATEWAY}.d`, GUARD_DROPIN);
const guardFile = (fx) => join(fx.backup, "gateway.guard");
const marker = (fx) => JSON.parse(readFileSync(join(fx.backup, "state.json"), "utf8"));
const stepNames = (r) => r.result.steps.map((s) => s.name);
const step = (r, name) => r.result.steps.find((s) => s.name === name);
const callIndex = (r, re) => r.calls.findIndex((c) => re.test(c));
const installCalls = (r) => r.calls.filter((c) => c.startsWith("sovereign-node install-runtime"));
// A boot, as far as the gateway is concerned: systemd starts the enabled unit.
const boot = (fx) => spawnSync(join(fx.bin, "systemctl"), ["start", GATEWAY]);
const ALL_STEPS = [
  "preflight",
  "node",
  "prefetch",
  "guard",
  "stop",
  "backup",
  "stage",
  "upgrade",
  "shrinkwrap",
  "doctor",
  "web-search",
  "matrix-plugin",
  "doctor-matrix",
  "config-validate",
  "matrix-verify",
  "start",
  "health",
  "lobster",
];

// The node runs its previous OpenClaw exactly as before the run.
const expectRolledBack = (fx, r) => {
  expect(r.status).toBe(1);
  expect(r.result).toMatchObject({ ok: false, outcome: "rolled-back", exit_code: 1, rollback: { performed: true, ok: true } });
  expect(installedVersion(fx)).toBe(FROM);
  expect(installedPackage(fx)).toBe(fx.pkg);
  expect(readFileSync(join(fx.units, GATEWAY), "utf8")).toBe(fx.unitText);
  expect(existsSync(join(fx.home, ".openclaw", "state", "openclaw.sqlite"))).toBe(false);
  expect(existsSync(join(fx.home, ".openclaw", "npm"))).toBe(false);
  expect(isActive(fx, GATEWAY)).toBe(true);
  expect(isActive(fx, SCAN_TIMER)).toBe(true);
  expect(existsSync(guardDropin(fx))).toBe(false);
  expect(existsSync(guardFile(fx))).toBe(false);
  expect(marker(fx)).toMatchObject({ status: "rolled-back", target: TARGET, from: FROM });
  expect(r.result.units_restarted_on_old_version).toBe(true);
};

describe("openclaw-migrate.sh happy path", () => {
  it("migrates, writes the contracted result.json and leaves the units running", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({
      ok: true,
      outcome: "migrated",
      exit_code: 0,
      target: TARGET,
      from: FROM,
      lobster: { version: "2026.1.24", ok: true },
      doctor: { interactive_prompt_seen: false },
      rollback: { performed: false, ok: false, detail: null },
      phase: "completed",
      started_on_target: true,
      guard_engaged: false,
      scan_units_started: true,
      node_package: fx.nodePackage,
      already_migrated: false,
      failed_step: null,
      schema: 2,
    });
    expect(r.result.node).toEqual({ version: "22.22.3", ok: true, upgraded: false });
    expect(r.result.budget.seconds).toBe(1500);
    expect(r.result.budget.remaining_seconds).toBeGreaterThan(1400);
    expect(stepNames(r)).toEqual(ALL_STEPS);
    for (const s of r.result.steps) {
      expect(s).toEqual(expect.objectContaining({ ok: true, seconds: expect.any(Number) }));
    }
    expect(step(r, "stage")).toMatchObject({ skipped: true });
    expect(step(r, "node")).toMatchObject({ skipped: true });
    expect(r.result.backup.path).toMatch(/openclaw-state\.tar\.gz$/);
    expect(r.result.backup.bytes).toBe(statSync(r.result.backup.path).size);
    expect(installedVersion(fx)).toBe(TARGET);
    expect(installedPackage(fx)).toBe(join(fx.prefix, RUNTIME));
    expect(isActive(fx, GATEWAY)).toBe(true);
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
    expect(existsSync(guardDropin(fx))).toBe(false);
    expect(existsSync(guardFile(fx))).toBe(false);
    expect(marker(fx)).toMatchObject({ status: "completed", target: TARGET, from: FROM, phase: "completed" });
    expect(r.result.lobster.detail).toContain("HTTP 404");
    expect(existsSync(join(fx.state, "token-in-argv"))).toBe(false);
    expect(r.result.doctor.runs.map((d) => `${d.version}/${d.phase}`)).toEqual([`${TARGET}/config`, `${TARGET}/matrix`]);
  });

  it("probes llm-task on the scan agent's session with a real prompt and records the answer", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result.llm_task).toEqual({ session: "agent:mail-sentinel-scan:main", status: 200, ok: true });
    expect(r.result.lobster.detail).toContain("llm-task on agent:mail-sentinel-scan:main: HTTP 200");
    const probe = r.calls.find((c) => c.startsWith("lobster clawd.invoke --tool llm-task"));
    expect(probe).toContain('--args-json "{\\"prompt\\":');
    expect(probe).toContain("--session-key agent:mail-sentinel-scan:main");
  });

  it("records an llm-task that does not answer without failing the run", async () => {
    const fx = makeFixture();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_LLM_TASK_SESSION: "agent:mail-sentinel:main" });
    expect(r.status).toBe(0);
    expect(r.result.llm_task).toEqual({ session: "agent:mail-sentinel:main", status: 404, ok: false });
  });

  it("installs through the node CLI only after the stop and the backup, holding the lock", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(installCalls(r)).toEqual([
      `sovereign-node install-runtime target=${TARGET} gateway=inactive lock=held backups=1 prefer_offline=true user_home=${fx.home}`,
    ]);
    const install = callIndex(r, /^sovereign-node install-runtime/);
    expect(callIndex(r, new RegExp(`^systemctl stop ${GATEWAY}`))).toBeLessThan(install);
    expect(r.calls.some((c) => c.startsWith("npm install"))).toBe(false);
  });

  it("prefetches the locked runtime into the npm cache while the gateway still runs", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    const prefetch = callIndex(r, /^npm ci --omit=dev --ignore-scripts --no-audit --no-fund backups=0 gateway=active$/);
    expect(prefetch).toBeGreaterThan(-1);
    expect(prefetch).toBeLessThan(callIndex(r, new RegExp(`^systemctl stop ${SCAN_TIMER}`)));
    expect(step(r, "prefetch").detail).toBe(`openclaw@${TARGET} and its dependencies are in ${join(fx.home, ".npm")}`);
    expect(r.result.prefetch).toBe(step(r, "prefetch").detail);
    expect(existsSync(join(fx.prefix, "lib", ".sovereign-openclaw-prefetch"))).toBe(false);
  });

  it("installs from the prefetched cache when the registry is gone after the stop", async () => {
    const fx = makeFixture();
    const original = readFileSync(join(fx.bin, "npm"), "utf8");
    // The registry answers the prefetch, then disappears.
    writeFileSync(join(fx.bin, "npm"), original.replace('touch "$S/prefetched";', 'touch "$S/prefetched" "$S/offline";'));
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(installCalls(r)[0]).toContain("prefer_offline=true");
    expect(installedVersion(fx)).toBe(TARGET);
  });

  it("starts the gateway through the node's runtime refresh, which renders the unit for the new package", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("sovereign-node reconcile"))).toEqual([`sovereign-node reconcile --refresh-runtime --json ready_ms=600000 user_home=${fx.home}`]);
    const refresh = callIndex(r, /^sovereign-node reconcile/);
    expect(refresh).toBeGreaterThan(callIndex(r, / matrix verify status /));
    expect(readFileSync(join(fx.units, GATEWAY), "utf8")).toContain("# rendered by the node");
    expect(step(r, "start").detail).toBe(`the node rendered the runtime for ${TARGET} and started ${GATEWAY}`);
  });

  it("blocks every gateway start while the tree is half migrated", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-try-start");
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(readFileSync(join(fx.state, "guard-probe"), "utf8").trim()).toBe("blocked");
    expect(r.calls).toContain(`skipped ${GATEWAY}: condition`);
    expect(step(r, "guard").detail).toBe(`${GATEWAY} cannot start while ${guardFile(fx)} exists`);
    expect(callIndex(r, /^systemctl daemon-reload/)).toBeLessThan(callIndex(r, new RegExp(`^systemctl stop ${SCAN_TIMER}`)));
  });

  it("leaves a public homeserver without the private-network opt-in", async () => {
    const fx = makeFixture({ homeserver: "https://matrix.example.org" });
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes("dangerouslyAllowPrivateNetwork"))).toBe(false);
    expect(r.calls.some((c) => c.includes("plugins install"))).toBe(true);
  });

  it("can skip the Matrix plugin install and force the private-network opt-in", async () => {
    const fx = makeFixture({ homeserver: "https://matrix.example.org" });
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_MATRIX_PLUGIN_ARGS: "" });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes("plugins install") || c.includes("dangerouslyAllowPrivateNetwork"))).toBe(false);
    expect(step(r, "matrix-plugin").detail).toBe("matrix plugin install disabled");
  });

  for (const homeserver of ["http://matrix-synapse:8008", "http://[::1]:8008", "http://172.20.0.2:8008", "https://synapse.local"]) {
    it(`treats ${homeserver} as a private homeserver`, async () => {
      const fx = makeFixture({ homeserver });
      const r = await run(fx);
      expect(r.status).toBe(0);
      expect(r.calls.some((c) => c.includes("dangerouslyAllowPrivateNetwork"))).toBe(true);
    });
  }

  it("runs every OpenClaw command with stdin closed, as the gateway's user and environment", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    const openclawCalls = r.calls.filter((c) => c.startsWith("openclaw@"));
    expect(openclawCalls.length).toBeGreaterThan(0);
    for (const call of openclawCalls) {
      expect(call).toContain(`home=${fx.home}`);
      expect(call).toContain("tty=no");
      expect(call).toContain("key=set");
    }
    expect(openclawCalls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^openclaw@${TARGET} doctor --fix`)),
        expect.stringMatching(new RegExp(`^openclaw@${TARGET} config validate`)),
        expect.stringMatching(new RegExp(`^openclaw@${TARGET} matrix verify status`)),
        expect.stringMatching(
          new RegExp(`^openclaw@${TARGET} plugins install npm:@openclaw/matrix@${TARGET} --force --accept-capabilities home=`),
        ),
        expect.stringMatching(new RegExp(`^openclaw@${TARGET} config set tools\\.web\\.search\\.enabled false --strict-json`)),
      ]),
    );
  });

  it("keeps secrets out of migration.log and result.json", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.log).toContain("<redacted>");
    const resultText = readFileSync(join(fx.out, "result.json"), "utf8");
    for (const secret of Object.values(SECRETS)) {
      expect(r.log).not.toContain(secret);
      expect(r.stdout).not.toContain(secret);
      expect(resultText).not.toContain(secret);
    }
  });

  it("takes the backup before any change and the archive holds the pre-migration state", async () => {
    const fx = makeFixture();
    const before = readFileSync(fx.configPath, "utf8");
    const r = await run(fx);
    const extract = join(fx.root, "extract");
    mkdirSync(extract);
    expect(spawnSync("tar", ["-xzf", r.result.backup.path, "-C", extract]).status).toBe(0);
    expect(readFileSync(join(extract, ".openclaw", "openclaw.json5"), "utf8")).toBe(before);
    expect(existsSync(join(extract, ".openclaw", "agents", "main", "sessions.json"))).toBe(true);
    expect(existsSync(join(extract, ".openclaw", "state", "openclaw.sqlite"))).toBe(false);
    expect(existsSync(join(fx.home, ".openclaw", "state", "openclaw.sqlite"))).toBe(true);
    expect(existsSync(r.result.backup.package_path)).toBe(true);
    expect(readFileSync(join(dirname(r.result.backup.path), "gateway.service"), "utf8")).toBe(fx.unitText);
    expect(statSync(dirname(r.result.backup.path)).mode & 0o777).toBe(0o700);
    expect(statSync(r.result.backup.path).mode & 0o777).toBe(0o600);
    expect(marker(fx).backup).toMatchObject({
      unit: join(dirname(r.result.backup.path), "gateway.service"),
      package_dir: fx.pkg,
      bin_target: "../lib/node_modules/openclaw/openclaw.mjs",
      config: null,
    });
  });

  it("writes npm-shrinkwrap.json from the installed runtime", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    const shrinkwrap = JSON.parse(readFileSync(join(fx.out, "npm-shrinkwrap.json"), "utf8"));
    expect(shrinkwrap).toMatchObject({ name: "openclaw", version: TARGET, lockfileVersion: 3 });
    expect(shrinkwrap.packages[""]).toMatchObject({ name: "openclaw", version: TARGET, dependencies: { dep: "^1.0.0" } });
    expect(shrinkwrap.packages["node_modules/dep"]).toMatchObject({ version: "1.0.0", integrity: "sha512-dep" });
    expect(shrinkwrap.packages["node_modules/@scope/util"]).toMatchObject({ version: "2.0.0", license: "MIT" });
    expect(shrinkwrap.packages["node_modules/peer"]).toBeUndefined();
    expect(r.result.shrinkwrap).toEqual({ source: "npm-hidden-lockfile+installed-tree", packages: 2 });
  });

  it("resolves --target pinned from the node package's locked runtime", async () => {
    const fx = makeFixture();
    const r = await run(fx, ["--target", "pinned", "--out", fx.out, "--node-package", fx.nodePackage]);
    expect(r.status).toBe(0);
    expect(r.result.target).toBe(TARGET);
    expect(installCalls(r)[0]).toContain(`target=${TARGET}`);
  });

  it("finds the node package it ships in when none is named", async () => {
    const fx = makeFixture();
    const shipped = join(fx.nodePackage, "scripts", "openclaw-migrate.sh");
    write(shipped, readFileSync(SCRIPT, "utf8"), 0o755);
    writeFileSync(join(fx.state, "calls.log"), "");
    const out = await exec("bash", [shipped, "--target", "pinned", "--out", fx.out], { env: baseEnv(fx) }, (child) =>
      writeFileSync(join(fx.state, "script-pgid"), String(child.pid)),
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(readFileSync(join(fx.out, "result.json"), "utf8"))).toMatchObject({ ok: true, node_package: fx.nodePackage });
  });

  it("stops at 6.x and runs doctor there when the legacy flat Matrix store exists", async () => {
    const fx = makeFixture({ flatMatrixStore: true });
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("npm install")).map((c) => c.split(" ")[3])).toEqual([`openclaw@${STAGE}`]);
    expect(installCalls(r)).toHaveLength(1);
    const doctors = r.calls.filter((c) => / doctor --fix/.test(c)).map((c) => c.split(" ")[0]);
    expect(doctors).toEqual([`openclaw@${STAGE}`, `openclaw@${STAGE}`, `openclaw@${TARGET}`, `openclaw@${TARGET}`]);
    expect(step(r, "stage").skipped).toBeUndefined();
    // The stage release ran the gateway once, with the guard lifted for it,
    // and the units were stopped again before the target was installed.
    const stageStart = r.calls.indexOf(`systemctl start ${GATEWAY}`);
    const targetInstall = callIndex(r, /^sovereign-node install-runtime/);
    expect(stageStart).toBeGreaterThan(-1);
    expect(stageStart).toBeLessThan(targetInstall);
    expect(r.calls.slice(stageStart, targetInstall)).toContain(`systemctl stop ${GATEWAY}`);
    expect(r.calls.slice(stageStart, stageStart + 2)).not.toContain(`skipped ${GATEWAY}: condition`);
  });

  it("upgrades Node 22 first, while the gateway still runs, when it is below the minimum", async () => {
    const fx = makeFixture({ nodeVersion: "22.16.0" });
    flag(fx, "node-upgrade-to", "22.22.3");
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(step(r, "node")).toMatchObject({ ok: true, detail: "node 22.22.3" });
    expect(r.result.node).toEqual({ version: "22.22.3", ok: true, upgraded: true });
    const aptIndex = callIndex(r, /^apt-get .*install -y --only-upgrade nodejs gateway=active$/);
    expect(aptIndex).toBeGreaterThan(-1);
    expect(aptIndex).toBeLessThan(callIndex(r, /^systemctl stop /));
  });

  it("backs up an OpenClaw config that lives outside the state dir and restores it on rollback", async () => {
    const fx = makeFixture({ configOutside: true });
    const before = readFileSync(fx.configPath, "utf8");
    flag(fx, "validate-fail");
    const r = await run(fx);
    expectRolledBack(fx, r);
    expect(marker(fx).backup.config).toMatch(/openclaw-config$/);
    expect(readFileSync(fx.configPath, "utf8")).toBe(before);
  });
});

describe("openclaw-migrate.sh stage selection", () => {
  const stageRan = (r) => r.calls.some((c) => c.startsWith(`npm install -g openclaw@${STAGE}`));

  it("stops at 6.x for the old bot SDK crypto store in a per-account dir", async () => {
    const fx = makeFixture({ legacyCrypto: true });
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(stageRan(r)).toBe(true);
    expect(step(r, "stage").detail).toContain("crypto/bot-sdk.json");
  });

  it("skips the stage for a per-account store without legacy crypto", async () => {
    const fx = makeFixture();
    expect(stageRan(await run(fx))).toBe(false);
  });

  it("can force the stage on or off", async () => {
    const forced = makeFixture();
    const on = await run(forced, undefined, { OPENCLAW_MIGRATE_STAGE: "always" });
    expect(on.status).toBe(0);
    expect(stageRan(on)).toBe(true);
    expect(step(on, "stage").detail).toContain("forced");

    const skipped = makeFixture({ flatMatrixStore: true });
    const off = await run(skipped, undefined, { OPENCLAW_MIGRATE_STAGE: "never" });
    expect(off.status).toBe(0);
    expect(stageRan(off)).toBe(false);
  });
});

describe("openclaw-migrate.sh interactive doctor", () => {
  it("fails and rolls back on a prompt that met EOF on stdin", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-prompt");
    const r = await run(fx);
    expectRolledBack(fx, r);
    expect(r.result).toMatchObject({ failed_step: "doctor", doctor: { interactive_prompt_seen: true } });
    expect(r.result.doctor.runs).toEqual([{ version: TARGET, phase: "config", exit: 1, timed_out: false, interactive_prompt_seen: true }]);
    expect(r.log).not.toContain("answered");
  });

  it("fails on a doctor that hangs instead of waiting for it", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-hang");
    const started = Date.now();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_DOCTOR_TIMEOUT: "1" });
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.status).toBe(1);
    expect(r.result.doctor).toMatchObject({ interactive_prompt_seen: true });
    expect(r.result.doctor.runs[0]).toMatchObject({ timed_out: true, exit: 124 });
    expect(r.result.failed_step).toBe("doctor");
  });

  it("fails on a prompt even when doctor exits 0", async () => {
    const fx = makeFixture();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_DOCTOR_ARGS: "doctor --fix", OPENCLAW_MIGRATE_PROMPT_REGEX: "doctor: migrated" });
    expect(r.status).toBe(1);
    expect(r.result.doctor.runs[0]).toMatchObject({ exit: 0, interactive_prompt_seen: true });
  });
});

describe("openclaw-migrate.sh failure handling", () => {
  // Nothing was changed: the units that were stopped run again on the old tree.
  const unchanged = [
    { step: "preflight", setup: (fx) => rmSync(join(fx.home, ".openclaw"), { recursive: true }), stopped: false },
    { step: "preflight", name: "node above range", fixture: { nodeVersion: "24.1.0" }, node: { version: "24.1.0", ok: false, upgraded: false }, stopped: false },
    { step: "preflight", name: "no gateway unit", setup: (fx) => rmSync(join(fx.units, GATEWAY)), node: { version: null, ok: false, upgraded: false }, stopped: false },
    { step: "preflight", name: "downgrade", args: (fx) => ["--target", "2026.3.1", "--out", fx.out, "--node-package", fx.nodePackage], stopped: false },
    {
      step: "preflight",
      name: "target the node package does not lock",
      fixture: { lockedVersion: "2026.9.1" },
      detail: (fx) => `target ${TARGET} is not the OpenClaw version ${fx.nodePackage} locks (2026.9.1); only that one can be installed`,
      stopped: false,
    },
    {
      step: "preflight",
      name: "not a built node package",
      setup: (fx) => rmSync(join(fx.nodePackage, "dist"), { recursive: true }),
      detail: (fx) => `${fx.nodePackage} is not a built node package (need dist/sovereign-node.js and deploy/openclaw-runtime/)`,
      stopped: false,
    },
    {
      step: "preflight",
      name: "budget too small",
      args: (fx) => [...defaultArgs(fx), "--budget", "700"],
      detail: /^only -?\d+s of the 700s budget are left after the 240s reserve; need at least 600s before stopping anything$/,
      stopped: false,
    },
    { step: "node", fixture: { nodeVersion: "22.16.0" }, setup: (fx) => flag(fx, "apt-fail"), node: { version: "22.16.0", ok: false, upgraded: false }, stopped: false },
    {
      step: "node",
      name: "node still too old",
      fixture: { nodeVersion: "22.16.0" },
      node: { version: "22.16.0", ok: false, upgraded: false },
      detail: "node is 22.16.0 after the upgrade (apt candidate 22.16.0-1nodesource1); need >=22.22.3 <23.0.0 (install it from a repository that carries it)",
      stopped: false,
    },
    {
      step: "node",
      name: "upgraded but still too old",
      fixture: { nodeVersion: "22.16.0" },
      setup: (fx) => flag(fx, "node-upgrade-to", "22.22.2"),
      node: { version: "22.22.2", ok: false, upgraded: true },
      stopped: false,
    },
    {
      step: "prefetch",
      name: "registry unreachable",
      setup: (fx) => flag(fx, "npm-fail-prefetch"),
      detail: `npm ci (prefetch of openclaw@${TARGET}) exited 1: npm ERR! code EAI_AGAIN; npm ERR! request to https://registry.npmjs.org/openclaw failed`,
      stopped: false,
    },
    { step: "stop", setup: (fx) => flag(fx, "stop-fail"), stopped: true },
    { step: "backup", env: (fx) => ({ OPENCLAW_MIGRATE_BACKUP_ROOT: join(fx.home, "gateway.env", "x") }), stopped: false, guardFails: true },
  ];

  for (const c of unchanged) {
    it(`leaves the node unchanged when ${c.step} fails${c.name ? ` (${c.name})` : ""}`, async () => {
      const fx = makeFixture(c.fixture);
      c.setup?.(fx);
      const r = await run(fx, c.args?.(fx) ?? defaultArgs(fx), c.env?.(fx) ?? {});
      expect(r.status).toBe(1);
      const failed = c.guardFails ? "guard" : c.step;
      expect(r.result).toMatchObject({ ok: false, outcome: "unchanged", exit_code: 1, failed_step: failed });
      expect(r.result.steps.at(-1)).toMatchObject({ name: failed, ok: false });
      if (c.detail !== undefined) {
        const expected = typeof c.detail === "function" ? c.detail(fx) : c.detail;
        if (expected instanceof RegExp) expect(r.result.steps.at(-1).detail).toMatch(expected);
        else expect(r.result.steps.at(-1).detail).toBe(expected);
        expect(r.result.message).toContain(`Failure: ${r.result.steps.at(-1).detail}`);
      }
      expect(r.result.node).toEqual(c.node ?? { version: c.fixture?.nodeVersion ?? "22.22.3", ok: true, upgraded: false });
      expect(installCalls(r)).toEqual([]);
      if (existsSync(join(fx.prefix, "bin", "openclaw"))) expect(installedVersion(fx)).toBe(FROM);
      expect(r.result.units_restarted_on_old_version).toBe(c.stopped);
      expect(r.calls.some((call) => call.startsWith("systemctl stop")) ).toBe(c.stopped);
      expect(isActive(fx, GATEWAY)).toBe(true);
      expect(isActive(fx, SCAN_TIMER)).toBe(true);
      expect(existsSync(guardDropin(fx))).toBe(false);
      expect(r.result.rollback.performed).toBe(false);
    });
  }

  // Changed, but no new version ran its gateway: restore the backup.
  const rollback = [
    { step: "upgrade", setup: (fx) => flag(fx, "install-fail"), detail: `sovereign-node openclaw-migration install-runtime --target ${TARGET} exited 1: OPENCLAW_INSTALL_FAILED: OpenClaw locked runtime install (npm ci) exited with a non-zero status token=<redacted>` },
    { step: "upgrade", name: "wrong version installed", setup: (fx) => flag(fx, "install-wrong-version"), detail: (fx) => `after the install ${join(fx.prefix, "bin", "openclaw")} resolves to OpenClaw '2026.1.1' at ${join(fx.prefix, RUNTIME)}, expected ${TARGET}` },
    { step: "stage", fixture: { flatMatrixStore: true }, setup: (fx) => flag(fx, `npm-fail-${STAGE}`), detail: `npm install -g openclaw@${STAGE} exited 1: npm ERR! network` },
    { step: "stage", name: "6.x doctor fails", fixture: { flatMatrixStore: true }, setup: (fx) => flag(fx, `doctor-fail-${STAGE}`) },
    { step: "stage", name: "6.x matrix plugin fails", fixture: { flatMatrixStore: true }, setup: (fx) => flag(fx, "plugin-fail") },
    { step: "shrinkwrap", setup: (fx) => flag(fx, "lockfile-mismatch"), detail: /: mismatch node_modules\/dep: lockfile 0\.9\.0, installed 1\.0\.0$/ },
    { step: "doctor", setup: (fx) => flag(fx, `doctor-fail-${TARGET}`) },
    { step: "doctor", name: "cannot spawn", setup: (fx) => flag(fx, "doctor-eacces"), detail: `doctor (${TARGET}, config) exited 1: Doctor could not complete maintenance. Check the reported service state, resolve the failure, and rerun doctor --fix.; Command failed during launch or output capture (EACCES)` },
    { step: "web-search", setup: (fx) => flag(fx, "config-set-fail-tools.web.search.enabled"), detail: "disabling tools.web.search.enabled exited 1: config set tools.web.search.enabled refused" },
    { step: "matrix-plugin", setup: (fx) => flag(fx, "plugin-fail"), detail: `openclaw plugins install npm:@openclaw/matrix@${TARGET} --force --accept-capabilities exited 1: npm ERR! 404 Not Found - GET https://registry.npmjs.org/@openclaw%2fmatrix (auth <redacted>)` },
    { step: "matrix-plugin", name: "capability consent refused", env: () => ({ OPENCLAW_MIGRATE_MATRIX_PLUGIN_CONSENT: "never" }) },
    { step: "matrix-plugin", name: "opt-in fails", setup: (fx) => flag(fx, "config-set-fail-channels.matrix.network.dangerouslyAllowPrivateNetwork") },
    { step: "doctor-matrix", setup: (fx) => flag(fx, "doctor-matrix-fail") },
    { step: "config-validate", setup: (fx) => flag(fx, "validate-fail"), detail: "openclaw config validate exited 1: config invalid" },
    { step: "matrix-verify", setup: (fx) => flag(fx, "matrix-fail"), detail: "openclaw matrix verify status exited 1: matrix: server device unknown" },
    { step: "start", name: "refresh fails before the gateway starts", setup: (fx) => flag(fx, "refresh-fail"), detail: "sovereign-node reconcile --refresh-runtime exited 1: GATEWAY_REFRESH_FAILED: Runtime refresh step openclaw-runtime failed: template pin mismatch" },
  ];

  for (const c of rollback) {
    it(`rolls back when ${c.step} fails${c.name ? ` (${c.name})` : ""}`, async () => {
      const fx = makeFixture(c.fixture);
      const config = readFileSync(fx.configPath, "utf8");
      c.setup?.(fx);
      const r = await run(fx, defaultArgs(fx), c.env?.(fx) ?? {});
      expectRolledBack(fx, r);
      expect(r.result.failed_step).toBe(c.step);
      expect(readFileSync(fx.configPath, "utf8")).toBe(config);
      expect(r.result.rollback.detail).toBe(`restored OpenClaw ${FROM}, its state and its unit from ${dirname(r.result.backup.path)}`);
      if (c.detail !== undefined) {
        const s = r.result.steps.find((x) => x.name === c.step && !x.ok);
        const expected = typeof c.detail === "function" ? c.detail(fx) : c.detail;
        if (expected instanceof RegExp) expect(s.detail).toMatch(expected);
        else expect(s.detail).toBe(expected);
        expect(r.result.message).toContain(`Failure: ${s.detail}`);
      }
      const resultText = readFileSync(join(fx.out, "result.json"), "utf8");
      for (const secret of Object.values(SECRETS)) expect(resultText).not.toContain(secret);
      // The node package keeps holding the restored version; a rerun migrates again.
      for (const f of ["install-fail", "install-wrong-version", `npm-fail-${STAGE}`, `doctor-fail-${STAGE}`, "plugin-fail", "lockfile-mismatch", `doctor-fail-${TARGET}`, "doctor-eacces", "config-set-fail-tools.web.search.enabled", "config-set-fail-channels.matrix.network.dangerouslyAllowPrivateNetwork", "doctor-matrix-fail", "validate-fail", "matrix-fail", "refresh-fail"]) {
        unflag(fx, f);
      }
      unflag(fx, "plugin-installed");
      const again = await run(fx);
      expect(again.status).toBe(0);
      expect(again.result).toMatchObject({ outcome: "migrated", recovery: null });
      expect(installedVersion(fx)).toBe(TARGET);
    });
  }

  it("reports a rollback that leaves the old gateway unhealthy as needing attention", async () => {
    const fx = makeFixture();
    flag(fx, "validate-fail");
    flag(fx, "health-fail");
    const r = await run(fx);
    expect(r.status).toBe(3);
    expect(r.result).toMatchObject({ outcome: "rolled-back", exit_code: 3, rollback: { performed: true, ok: false } });
    expect(installedVersion(fx)).toBe(FROM);
    expect(r.result.message).toContain(`rolled back to OpenClaw ${FROM}, but the gateway did not come up healthy`);
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
  });

  it("keeps the gateway blocked when the rollback itself fails", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-delete-backup");
    const r = await run(fx);
    expect(r.status).toBe(3);
    expect(r.result).toMatchObject({ outcome: "rollback-failed", exit_code: 3, failed_step: "doctor", rollback: { performed: true, ok: false } });
    expect(r.result.rollback.detail).toBe("no state backup to restore");
    expect(r.result.message).toContain("The gateway stays blocked by");
    expect(existsSync(guardDropin(fx))).toBe(true);
    expect(existsSync(guardFile(fx))).toBe(true);
    expect(isActive(fx, GATEWAY)).toBe(false);
    boot(fx);
    expect(isActive(fx, GATEWAY)).toBe(false);
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
  });

  // The new version's gateway ran: its state reached the homeserver, so the
  // node stays on the target and a rerun resumes.
  const fixForward = [
    { step: "start", name: "refresh fails after the gateway started", flag: "refresh-fail-after-start" },
    { step: "health", flag: "health-fail" },
    { step: "health", name: "restart loop", flag: "health-restart" },
    { step: "lobster", flag: "lobster-broken" },
    { step: "lobster", name: "token refused", flag: "lobster-status", content: "401" },
    { step: "lobster", name: "gateway unreachable", flag: "lobster-status", content: "" },
    { step: "lobster", name: "unexpected status", flag: "lobster-status", content: "500" },
  ];

  for (const c of fixForward) {
    it(`fixes forward when ${c.step} fails${c.name ? ` (${c.name})` : ""} and a rerun resumes`, async () => {
      const fx = makeFixture();
      flag(fx, c.flag, c.content);
      const r = await run(fx);
      expect(r.status).toBe(3);
      expect(r.result).toMatchObject({ ok: false, outcome: "fix-forward", exit_code: 3, failed_step: c.step, started_on_target: true, rollback: { performed: false } });
      expect(r.result.message).toContain(`the node stays on ${TARGET}`);
      expect(installedVersion(fx)).toBe(TARGET);
      expect(existsSync(guardDropin(fx))).toBe(false);
      expect(isActive(fx, SCAN_TIMER)).toBe(true);
      expect(marker(fx)).toMatchObject({ status: "in-progress", phase: "started", rollback_safe: false });
      if (!c.flag.startsWith("health")) expect(isActive(fx, GATEWAY)).toBe(true);

      unflag(fx, c.flag);
      writeFileSync(join(fx.state, "nrestarts"), "0");
      const again = await run(fx);
      expect(again.status).toBe(0);
      expect(again.result).toMatchObject({ outcome: "migrated", recovery: "resume", resumed: true, from: FROM });
      expect(installCalls(again)).toEqual([]);
      expect(step(again, "upgrade")).toMatchObject({ skipped: true });
      expect(step(again, "prefetch")).toMatchObject({ skipped: true });
      expect(step(again, "backup").detail).toBe(`backup from the unfinished run: ${r.result.backup.path}`);
      expect(marker(fx)).toMatchObject({ status: "completed" });
    });
  }

  it("keeps the guard and resumes at the install when it fails after the stage gateway ran", async () => {
    const fx = makeFixture({ flatMatrixStore: true });
    flag(fx, "install-fail");
    const r = await run(fx);
    expect(r.status).toBe(3);
    expect(r.result).toMatchObject({ outcome: "resume-required", exit_code: 3, failed_step: "upgrade", rollback: { performed: false } });
    expect(existsSync(guardFile(fx))).toBe(true);
    expect(isActive(fx, GATEWAY)).toBe(false);
    boot(fx);
    expect(isActive(fx, GATEWAY)).toBe(false);
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
    expect(marker(fx)).toMatchObject({ status: "in-progress", phase: "upgrade", rollback_safe: false });

    unflag(fx, "install-fail");
    const again = await run(fx);
    expect(again.status).toBe(0);
    expect(again.result).toMatchObject({ outcome: "migrated", recovery: "upgrade", from: FROM });
    expect(step(again, "stage")).toMatchObject({ skipped: true, detail: "resuming (upgrade)" });
    expect(again.calls.some((c) => c.startsWith(`npm install -g openclaw@${STAGE}`))).toBe(false);
    expect(installCalls(again)).toHaveLength(1);
  });

  it("does not roll back once the stage gateway has run, even when its health fails", async () => {
    const fx = makeFixture({ flatMatrixStore: true });
    flag(fx, "stage-health-fail");
    const r = await run(fx);
    expect(r.status).toBe(3);
    expect(r.result).toMatchObject({ outcome: "resume-required", failed_step: "stage" });
    expect(existsSync(guardFile(fx))).toBe(true);
    expect(isActive(fx, GATEWAY)).toBe(false);
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
  });
});

describe("openclaw-migrate.sh interrupted runs", () => {
  it("never boots a half-migrated tree after a power loss mid-install, and the rerun restores and migrates", async () => {
    const fx = makeFixture();
    flag(fx, "install-kill");
    const r = await run(fx);
    expect(r.signal).toBe("SIGKILL");
    expect(marker(fx)).toMatchObject({ status: "in-progress", phase: "upgrade", rollback_safe: true });
    expect(existsSync(guardDropin(fx))).toBe(true);
    expect(isActive(fx, GATEWAY)).toBe(false);
    boot(fx);
    expect(isActive(fx, GATEWAY)).toBe(false);

    unflag(fx, "install-kill");
    const again = await run(fx);
    expect(again.status).toBe(0);
    expect(again.result).toMatchObject({ outcome: "migrated", recovery: "restore", resumed: true, from: FROM });
    expect(step(again, "backup").detail).toMatch(/^restored OpenClaw 2026\.3\.13, its state and its unit from /);
    expect(installCalls(again)).toEqual([
      `sovereign-node install-runtime target=${TARGET} gateway=inactive lock=held backups=1 prefer_offline=true user_home=${fx.home}`,
    ]);
    expect(installedVersion(fx)).toBe(TARGET);
    expect(isActive(fx, GATEWAY)).toBe(true);
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
    expect(existsSync(guardDropin(fx))).toBe(false);
  });

  it("resumes from doctor after a power loss once the target is installed", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-kill");
    const r = await run(fx);
    expect(r.signal).toBe("SIGKILL");
    expect(marker(fx)).toMatchObject({ phase: "upgraded", rollback_safe: true });
    boot(fx);
    expect(isActive(fx, GATEWAY)).toBe(false);

    unflag(fx, "doctor-kill");
    const again = await run(fx);
    expect(again.status).toBe(0);
    expect(again.result).toMatchObject({ outcome: "migrated", recovery: "resume" });
    expect(installCalls(again)).toEqual([]);
  });

  it("rolls back a resumed run that fails before its gateway started", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-kill");
    expect((await run(fx)).signal).toBe("SIGKILL");
    unflag(fx, "doctor-kill");
    flag(fx, "validate-fail");
    const r = await run(fx);
    expectRolledBack(fx, r);
    expect(r.result.recovery).toBe("resume");
  });

  it("rolls back when the run is told to stop (a service timeout) mid-install", async () => {
    const fx = makeFixture();
    flag(fx, "install-term");
    const r = await run(fx);
    expectRolledBack(fx, r);
    expect(r.result.failed_step).toBe("upgrade");
    expect(r.result.message).toContain("interrupted by SIGTERM during step upgrade");
  });

  it("refuses an unfinished migration it can neither restore nor resume", async () => {
    const fx = makeFixture();
    write(join(fx.backup, "state.json"), `${JSON.stringify({ status: "in-progress", target: "2026.7.1", from: FROM, phase: "started", rollback_safe: false, backup: {} })}\n`);
    flag(fx, "doctor-try-start");
    const r = await run(fx);
    expect(r.status).toBe(3);
    expect(r.result).toMatchObject({ outcome: "resume-required", failed_step: "preflight" });
    expect(r.result.steps.at(-1).detail).toContain("an unfinished migration to 2026.7.1 (phase started) cannot be restored");
    expect(r.calls.some((c) => c.startsWith("systemctl stop"))).toBe(false);
  });

  it("refuses to run while another migration holds the lock", async () => {
    const fx = makeFixture();
    const holder = await exec("flock", ["-n", fx.lock, "bash", SCRIPT, ...defaultArgs(fx)], { env: baseEnv(fx) });
    expect(holder.status).toBe(4);
    const result = JSON.parse(readFileSync(join(fx.out, "result.json"), "utf8"));
    expect(result).toMatchObject({ ok: false, outcome: "busy", exit_code: 4, failed_step: "lock" });
    expect(result.node).toEqual({ version: null, ok: false, upgraded: false });
    expect(installedVersion(fx)).toBe(FROM);
  });
});

describe("openclaw-migrate.sh budget", () => {
  it("clamps every step to the budget so a hang leaves time to roll back", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-hang");
    const started = Date.now();
    const r = await run(fx, [...defaultArgs(fx), "--budget", "25"], {
      OPENCLAW_MIGRATE_RESERVE: "8",
      OPENCLAW_MIGRATE_MIN_WINDOW: "0",
      OPENCLAW_MIGRATE_DOCTOR_TIMEOUT: "60",
    });
    // Unclamped, doctor would sleep its 30 s and then succeed.
    expect(Date.now() - started).toBeLessThan(28_000);
    expect(r.result.failed_step).toBe("doctor");
    expect(r.result.doctor.runs[0]).toMatchObject({ timed_out: true });
    expect(r.result.budget.seconds).toBe(25);
    expect(r.result.rollback.performed).toBe(true);
    expect(installedVersion(fx)).toBe(FROM);
  });

  it("fails a step that would start after the budget is used up", async () => {
    const fx = makeFixture();
    const r = await run(fx, [...defaultArgs(fx), "--budget", "0"], { OPENCLAW_MIGRATE_RESERVE: "0", OPENCLAW_MIGRATE_MIN_WINDOW: "0" });
    expect(r.status).toBe(1);
    expect(r.result.steps.at(-1)).toMatchObject({ name: "preflight", ok: false, detail: "the 0s budget is used up (0s are kept for recovery)" });
  });
});

describe("openclaw-migrate.sh doctor", () => {
  const EACCES_LINE = "Command failed during launch or output capture (EACCES)";

  it("runs OpenClaw and npm from a directory their user can traverse, not the caller's", async () => {
    const fx = makeFixture();
    const locked = join(fx.root, "staging");
    mkdirSync(locked, { mode: 0o700 });
    const r = await run(fx, undefined, {}, { cwd: locked });
    expect(r.log).not.toContain(EACCES_LINE);
    expect(r.status).toBe(0);
    expect(step(r, "doctor")).toMatchObject({ ok: true, detail: `doctor (${TARGET}, config) ok` });
    const cwds = (name) => readFileSync(join(fx.state, name), "utf8").split("\n").filter(Boolean);
    expect(cwds("doctor-cwd")).toEqual([fx.home, fx.home]);
    expect(cwds("npm-cwd")).toEqual([join(fx.prefix, "lib", ".sovereign-openclaw-prefetch")]);
  });

  it("keeps secrets out of a failed doctor's detail", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-secret-fail");
    const r = await run(fx);
    expect(r.status).toBe(1);
    const detail = step(r, "doctor").detail;
    expect(detail).toBe(
      `doctor (${TARGET}, config) exited 2: Config warnings: plugins.entries.matrix: plugin not installed: matrix — install the official external plugin with: openclaw plugins install clawhub:@openclaw/matrix; Error: provider rejected key <redacted>`,
    );
    expect(readFileSync(join(fx.out, "result.json"), "utf8")).not.toContain(SECRETS.openrouter);
    expect(r.log).not.toContain(SECRETS.openrouter);
  });

  it("accepts the first pass's missing-Matrix-plugin warning, which the next step resolves", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    const warning = "plugin not installed: matrix";
    expect(r.log.slice(r.log.indexOf("step doctor: start"), r.log.indexOf("step doctor: ok"))).toContain(warning);
    expect(r.log.slice(r.log.indexOf("step doctor-matrix: start"), r.log.indexOf("step doctor-matrix: ok"))).not.toContain(warning);
  });
});

describe("openclaw-migrate.sh matrix plugin", () => {
  const CONSENT_REASON =
    '[openclaw] Reason: Plugin "matrix" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.';
  const installs = (r) => r.calls.filter((c) => / plugins install npm:/.test(c)).map((c) => c.replace(/ home=.*/, ""));

  it("accepts the declared capabilities only on a release whose CLI offers the flag", async () => {
    const fx = makeFixture({ flatMatrixStore: true });
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(installs(r)).toEqual([
      `openclaw@${STAGE} plugins install npm:@openclaw/matrix@${STAGE} --force`,
      `openclaw@${TARGET} plugins install npm:@openclaw/matrix@${TARGET} --force --accept-capabilities`,
    ]);
    expect(step(r, "matrix-plugin").detail).toBe(
      `installed plugins install npm:@openclaw/matrix@${TARGET} --force --accept-capabilities; private homeserver opt-in set`,
    );
  });

  it("can force the consent flag without probing, or take it from the configured arguments", async () => {
    const fx = makeFixture();
    const forced = await run(fx, undefined, { OPENCLAW_MIGRATE_MATRIX_PLUGIN_CONSENT: "always" });
    expect(forced.status).toBe(0);
    expect(forced.calls.some((c) => c.includes("plugins install --help"))).toBe(false);

    const custom = makeFixture();
    const given = await run(custom, undefined, {
      OPENCLAW_MIGRATE_MATRIX_PLUGIN_ARGS: "plugins install npm:@openclaw/matrix@%VERSION% --accept-capabilities --force",
    });
    expect(given.status).toBe(0);
    expect(installs(given)).toEqual([`openclaw@${TARGET} plugins install npm:@openclaw/matrix@${TARGET} --accept-capabilities --force`]);
  });

  it("reports a refused capability consent in migration.log and result.json", async () => {
    const fx = makeFixture();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_MATRIX_PLUGIN_CONSENT: "never" });
    expect(r.status).toBe(1);
    const s = step(r, "matrix-plugin");
    expect(s.detail).toBe(`openclaw plugins install npm:@openclaw/matrix@${TARGET} --force exited 1: [openclaw] Could not start the CLI.; ${CONSENT_REASON}`);
    expect(r.result.message).toContain(CONSENT_REASON);
    expect(r.log).toContain(`    | ${CONSENT_REASON}`);
  });
});

const WEB_SEARCH_SET = "config set tools.web.search.enabled false --strict-json";

describe("openclaw-migrate.sh web search", () => {
  it("turns web search off after the first doctor pass and before the plugin install", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    const set = callIndex(r, new RegExp(`^openclaw@${TARGET} ${WEB_SEARCH_SET.replaceAll(".", "\\.")}`));
    expect(set).toBeGreaterThan(callIndex(r, / doctor --fix/));
    expect(set).toBeLessThan(callIndex(r, / plugins install npm:/));
    expect(step(r, "web-search").detail).toBe("set tools.web.search.enabled=false (was unset)");
  });

  it("leaves a config that already has web search off alone", async () => {
    const fx = makeFixture();
    writeFileSync(fx.configPath, JSON.stringify({ ...JSON.parse(readFileSync(fx.configPath, "utf8")), tools: { web: { search: { enabled: false } } } }));
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes("tools.web.search"))).toBe(false);
    expect(step(r, "web-search").detail).toBe("tools.web.search.enabled already false");
  });

  it("can leave web search as configured", async () => {
    const fx = makeFixture();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_WEB_SEARCH: "keep" });
    expect(r.status).toBe(0);
    expect(step(r, "web-search").detail).toBe("tools.web.search left as configured");
  });

  it("turns web search off on the 6.x stage too, before its gateway start", async () => {
    const fx = makeFixture({ flatMatrixStore: true });
    const r = await run(fx);
    expect(r.status).toBe(0);
    const set = callIndex(r, new RegExp(`^openclaw@${STAGE} ${WEB_SEARCH_SET.replaceAll(".", "\\.")}`));
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(callIndex(r, new RegExp(`^systemctl start ${GATEWAY}`)));
  });
});

describe("openclaw-migrate.sh gateway diagnostics", () => {
  const SHOW_PROPS = ["NRestarts=1", "Result=exit-code", "ActiveState=activating", "SubState=auto-restart", "ExecMainCode=1", "ExecMainStatus=1", "MainPID=0", ""].join("\n");
  const JOURNAL = [
    "2026-11-03T11:31:44+00:00 node openclaw[64474]: Doctor warnings",
    `2026-11-03T11:31:45+00:00 node openclaw[64474]: Failed to install missing configured plugin "perplexity": key ${SECRETS.openrouter} token=${SECRETS.gateway}`,
    "2026-11-03T11:31:46+00:00 node systemd[1]: sovereign-openclaw-gateway.service: Main process exited, code=exited, status=1/FAILURE",
    "",
  ].join("\n");

  const restartLoop = () => {
    const fx = makeFixture();
    flag(fx, "health-restart");
    flag(fx, "show-props", SHOW_PROPS);
    flag(fx, "journal", JOURNAL);
    return fx;
  };

  it("puts the unit's state and journal into migration.log and result.json when health fails", async () => {
    const fx = restartLoop();
    const before = Math.floor(Date.now() / 1000);
    const r = await run(fx);
    expect(r.result.failed_step).toBe("health");
    const journalCall = r.calls.find((c) => c.startsWith("journalctl "));
    expect(journalCall).toMatch(new RegExp(`^journalctl -u ${GATEWAY} --since @(\\d+) --no-pager -n 120 -o short-iso$`));
    const since = Number(/@(\d+)/.exec(journalCall)[1]);
    expect(since).toBeGreaterThanOrEqual(before);
    expect(r.result.gateway).toEqual({
      unit: GATEWAY,
      since: new Date(since * 1000).toISOString(),
      show: { NRestarts: "1", Result: "exit-code", ActiveState: "activating", SubState: "auto-restart", ExecMainCode: "1", ExecMainStatus: "1", MainPID: "0" },
      journal: [
        "2026-11-03T11:31:44+00:00 node openclaw[64474]: Doctor warnings",
        '2026-11-03T11:31:45+00:00 node openclaw[64474]: Failed to install missing configured plugin "perplexity": key <redacted> token=<redacted>',
        "2026-11-03T11:31:46+00:00 node systemd[1]: sovereign-openclaw-gateway.service: Main process exited, code=exited, status=1/FAILURE",
      ],
    });
    const resultText = readFileSync(join(fx.out, "result.json"), "utf8");
    for (const secret of Object.values(SECRETS)) {
      expect(resultText).not.toContain(secret);
      expect(r.log).not.toContain(secret);
    }
  });

  it("keeps only the last lines of a long journal", async () => {
    const fx = restartLoop();
    flag(fx, "journal", `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\n`);
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_GATEWAY_JOURNAL_LINES: "5" });
    expect(r.result.gateway.journal).toEqual(["line 25", "line 26", "line 27", "line 28", "line 29"]);
  });

  it("captures them when the node's refresh fails", async () => {
    const fx = makeFixture();
    flag(fx, "refresh-fail-after-start");
    flag(fx, "journal", "not ready\n");
    const r = await run(fx);
    expect(r.result.failed_step).toBe("start");
    expect(r.result.gateway.journal).toEqual(["not ready"]);
  });

  it("says so when journalctl is missing instead of failing differently", async () => {
    const fx = restartLoop();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_JOURNALCTL: join(fx.root, "no-journalctl") });
    expect(r.result.failed_step).toBe("health");
    expect(r.result.gateway.journal).toEqual([`journalctl unavailable (${join(fx.root, "no-journalctl")})`]);
  });

  it("leaves gateway null when every step succeeded", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result.gateway).toBeNull();
  });
});

describe("openclaw-migrate.sh re-runs", () => {
  it("is a no-op success on an already migrated node", async () => {
    const fx = makeFixture();
    expect((await run(fx)).status).toBe(0);
    const before = readFileSync(fx.configPath, "utf8");
    const backups = readdirSync(fx.backup);
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ ok: true, outcome: "already-current", already_migrated: true, from: FROM, target: TARGET });
    expect(r.result.backup.path).toMatch(/openclaw-state\.tar\.gz$/);
    expect(stepNames(r)).toEqual(ALL_STEPS);
    for (const name of ALL_STEPS.filter((n) => n !== "preflight" && n !== "shrinkwrap")) {
      expect(step(r, name)).toMatchObject({ ok: true, skipped: true });
    }
    expect(r.calls.filter((c) => /^npm |^sovereign-node |systemctl (stop|daemon-reload)|systemctl start sovereign-openclaw| doctor /.test(c))).toEqual([]);
    expect(readFileSync(fx.configPath, "utf8")).toBe(before);
    expect(readdirSync(fx.backup)).toEqual(backups);
    expect(existsSync(join(fx.out, "npm-shrinkwrap.json"))).toBe(true);
  });

  it("does nothing on a node that is already on the target without any earlier run", async () => {
    const fx = makeFixture();
    writeFileSync(join(fx.pkg, "package.json"), packageJson("openclaw", TARGET));
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ outcome: "already-current", from: TARGET });
    expect(r.calls.some((c) => c.startsWith("systemctl stop") || c.startsWith("sovereign-node "))).toBe(false);
    expect(existsSync(fx.backup)).toBe(false);
  });

  it("starts the scan timer an interrupted run left stopped, even when there is nothing to migrate", async () => {
    const fx = makeFixture();
    expect((await run(fx)).status).toBe(0);
    rmSync(join(fx.state, "active", SCAN_TIMER));
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
    expect(r.result.scan_units_started).toBe(true);
  });

  it("upgrades a Node below the minimum before resuming", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-kill");
    expect((await run(fx)).signal).toBe("SIGKILL");
    unflag(fx, "doctor-kill");
    flag(fx, "node-version", "22.16.0");
    flag(fx, "node-upgrade-to", "22.22.3");
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ outcome: "migrated", recovery: "resume" });
    expect(step(r, "node")).toMatchObject({ ok: true, detail: "node 22.22.3" });
    expect(r.result.node).toEqual({ version: "22.22.3", ok: true, upgraded: true });
    expect(callIndex(r, /^apt-get .* install /)).toBeLessThan(callIndex(r, / doctor /));
  });

  it("rolls back a resumed run whose Node is below the minimum and cannot be upgraded", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-kill");
    expect((await run(fx)).signal).toBe("SIGKILL");
    unflag(fx, "doctor-kill");
    flag(fx, "node-version", "22.16.0");
    const r = await run(fx);
    expect(r.result).toMatchObject({ ok: false, outcome: "rolled-back", resumed: true, failed_step: "node" });
    expect(r.result.node).toEqual({ version: "22.16.0", ok: false, upgraded: false });
    expect(r.calls.some((c) => c.includes(" doctor "))).toBe(false);
    expect(installedVersion(fx)).toBe(FROM);
  });
});

describe("openclaw-migrate.sh preflight layout", () => {
  it("refuses an OpenClaw outside the prefix its owner installs into", async () => {
    const fx = makeFixture();
    const elsewhere = join(fx.root, "other-prefix");
    mkdirSync(join(elsewhere, "lib", "node_modules"), { recursive: true });
    spawnSync("cp", ["-a", fx.pkg, join(elsewhere, "lib", "node_modules", "openclaw")]);
    writeFileSync(join(fx.units, GATEWAY), fx.unitText.replace(join(fx.prefix, "bin", "openclaw"), join(elsewhere, "lib", "node_modules", "openclaw", "openclaw.mjs")));
    const r = await run(fx);
    expect(r.status).toBe(1);
    expect(r.result.steps.at(-1).detail).toBe(
      `OpenClaw is installed in ${elsewhere}, but its owner ${userInfo().username} installs into ${fx.prefix}; this layout is not supported`,
    );
  });

  it("refuses a binary that is not inside an npm prefix", async () => {
    const fx = makeFixture();
    const loose = join(fx.root, "loose", "openclaw");
    write(loose, "#!/usr/bin/env bash\n", 0o755);
    writeFileSync(join(fx.units, GATEWAY), fx.unitText.replace(join(fx.prefix, "bin", "openclaw"), loose));
    const r = await run(fx);
    expect(r.status).toBe(1);
    expect(r.result.steps.at(-1).detail).toContain("which is not inside an npm prefix");
  });
});

describe("openclaw-migrate.sh gateway token", () => {
  it("reads a JSON5 config with OpenClaw's json5 when the CLI hides the token", async () => {
    const fx = makeFixture();
    const json5 = dirname(dirname(createRequire(import.meta.url).resolve("json5")));
    const original = readFileSync(join(fx.nodePackage, "dist", "sovereign-node.js"), "utf8");
    // The installed runtime carries OpenClaw's own json5.
    writeFileSync(
      join(fx.nodePackage, "dist", "sovereign-node.js"),
      original.replace('fs.cpSync(path.join(legacy, "node_modules"), path.join(pkg, "node_modules"), { recursive: true });', `fs.cpSync(path.join(legacy, "node_modules"), path.join(pkg, "node_modules"), { recursive: true }); fs.symlinkSync(${JSON.stringify(json5)}, path.join(pkg, "node_modules", "json5"));`),
    );
    writeFileSync(fx.configPath, `// managed\n{ gateway: { auth: { token: "${SECRETS.gateway}", }, }, }\n`);
    flag(fx, "config-get-redacted");
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_STAGE: "never", OPENCLAW_MIGRATE_MATRIX_PLUGIN_ARGS: "", OPENCLAW_MIGRATE_WEB_SEARCH: "keep" });
    expect(r.status).toBe(0);
    expect(r.result.lobster).toMatchObject({ ok: true });
    expect(r.result.lobster.detail).toContain("HTTP 404");
  });
});

describe("openclaw-migrate.sh --dry-run", () => {
  it("prints the plan and touches nothing", async () => {
    const fx = makeFixture({ flatMatrixStore: true, nodeVersion: "22.16.0" });
    const before = readFileSync(fx.configPath, "utf8");
    const r = await run(fx, [...defaultArgs(fx), "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry run");
    expect(r.stdout).toContain(`installed:         ${FROM}`);
    expect(r.stdout).toContain(`target:            ${TARGET} (node package ${fx.nodePackage} locks ${TARGET})`);
    expect(r.stdout).toContain(`npm install -g openclaw@${STAGE}`);
    expect(r.stdout).toContain(`sovereign-node openclaw-migration install-runtime --target ${TARGET}`);
    expect(r.stdout).toContain("apt-get install --only-upgrade nodejs (gateway still running)");
    expect(r.stdout).toContain("on failure: restart (nothing changed), roll back (no new gateway ran yet) or fix forward");
    expect(r.calls).toEqual([]);
    expect(existsSync(fx.out)).toBe(false);
    expect(existsSync(fx.backup)).toBe(false);
    expect(installedVersion(fx)).toBe(FROM);
    expect(readFileSync(fx.configPath, "utf8")).toBe(before);
  });

  it("reports a node it cannot inspect without failing", async () => {
    const fx = makeFixture();
    rmSync(join(fx.units, GATEWAY));
    const r = await run(fx, [...defaultArgs(fx), "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("discovery error");
    expect(r.calls).toEqual([]);
  });

  it("reports a pinned target the node package does not name", async () => {
    const fx = makeFixture();
    writeFileSync(join(fx.nodePackage, "deploy", "openclaw-runtime", "package.json"), "{}\n");
    const r = await run(fx, ["--target", "pinned", "--out", fx.out, "--node-package", fx.nodePackage, "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`discovery error:   --target pinned: no OpenClaw version in ${join(fx.nodePackage, "deploy", "openclaw-runtime")}/package.json`);
  });

  it("plans nothing on an already migrated node", async () => {
    const fx = makeFixture();
    expect((await run(fx)).status).toBe(0);
    const r = await run(fx, [...defaultArgs(fx), "--dry-run"]);
    expect(r.stdout).toContain("already at");
    expect(r.calls).toEqual([]);
  });
});

describe("openclaw-migrate.sh arguments", () => {
  const usage = [
    ["no target", ["--out", "/tmp/x"]],
    ["no out", ["--target", TARGET]],
    ["bad target", ["--target", "latest", "--out", "/tmp/x"]],
    ["bad budget", ["--target", TARGET, "--out", "/tmp/x", "--budget", "soon"]],
    ["unknown flag", ["--target", TARGET, "--out", "/tmp/x", "--force"]],
    ["dangling --target", ["--target"]],
  ];
  for (const [name, args] of usage) {
    it(`exits 2 on ${name}`, async () => {
      const fx = makeFixture();
      const r = await run(fx, args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Usage:");
      expect(r.calls).toEqual([]);
    });
  }

  it("accepts --key=value forms and prints help with the exit codes", async () => {
    const fx = makeFixture();
    const help = (await run(fx, ["--help"])).stdout;
    expect(help).toContain("--target <version>");
    expect(help).toContain("4  another migration holds the lock");
    const r = await run(fx, [`--target=${TARGET}`, `--out=${fx.out}`, `--node-package=${fx.nodePackage}`, "--budget=900", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("budget:            900s");
  });

  it("refuses to run as a non-root user unless told it is a test", async () => {
    const fx = makeFixture();
    if (process.getuid?.() === 0) return;
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_ALLOW_NON_ROOT: "0" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run as root");
  });
});
