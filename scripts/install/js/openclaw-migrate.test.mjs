// Hermetic tests for scripts/openclaw-migrate.sh. Every external program the
// script drives (systemctl, journalctl, npm, apt-get, curl, getent, runuser,
// the OpenClaw CLI and lobster) is a stub whose behaviour is switched by files in the
// fixture's state directory: the script runs OpenClaw under `env -i`, so
// environment variables would not reach the stubs.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
// long enough for vitest's own RPC to time out.
const exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "openclaw-migrate.sh");
const FROM = "2026.3.13";
const TARGET = "2026.8.35";
const STAGE = "2026.6.35";
const GATEWAY = "sovereign-openclaw-gateway.service";
const SCAN_TIMER = "sovereign-mail-sentinel-scan.timer";
const SCAN_SERVICE = "sovereign-mail-sentinel-scan.service";
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

const hiddenLockfile = (version, depVersion = "1.0.0") =>
  `${JSON.stringify(
    {
      name: "lib",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "node_modules/openclaw": { version, resolved: `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`, integrity: "sha512-openclaw" },
        "node_modules/openclaw/node_modules/dep": {
          version: depVersion,
          resolved: `https://registry.npmjs.org/dep/-/dep-${depVersion}.tgz`,
          integrity: "sha512-dep",
        },
        "node_modules/npm": { version: "10.9.0" },
      },
    },
    null,
    2,
  )}\n`;

const makeFixture = ({
  flatMatrixStore = false,
  legacyCrypto = false,
  nodeVersion = "22.22.3",
  scanActive = true,
  homeserver = "http://127.0.0.1:8008",
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-migrate-test-"));
  fixtures.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const units = join(root, "units");
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const pkg = join(prefix, "lib", "node_modules", "openclaw");
  const user = userInfo().username;
  mkdirSync(join(state, "active"), { recursive: true });
  writeFileSync(join(state, "node-version"), nodeVersion);
  writeFileSync(join(state, "calls.log"), "");

  // OpenClaw package tree, its bin link and npm's hidden lockfile.
  write(join(pkg, "package.json"), packageJson("openclaw", FROM));
  write(join(pkg, "node_modules", "dep", "package.json"), `${JSON.stringify({ name: "dep", version: "1.0.0" })}\n`);
  write(join(pkg, "node_modules", "@scope", "util", "package.json"), `${JSON.stringify({ name: "@scope/util", version: "2.0.0", license: "MIT" })}\n`);
  write(join(prefix, "lib", "node_modules", ".package-lock.json"), hiddenLockfile(FROM));
  stub(
    pkg,
    "openclaw.mjs",
    `S=${JSON.stringify(state)}
v="$(sed -n 's/.*"version": "\\(.*\\)".*/\\1/p' "$(dirname "$(readlink -f "$0")")/package.json" | head -n 1)"
printf 'openclaw@%s %s home=%s tty=%s key=%s\\n' "$v" "$*" "$HOME" "$([ -t 0 ] && echo yes || echo no)" "$([ -n "\${OPENROUTER_API_KEY:-}" ] && echo set || echo unset)" >>"$S/calls.log"
case "$1 \${2:-}" in
  "doctor --fix")
    echo "$PWD" >>"$S/doctor-cwd"
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
  "config set") [ -e "$S/config-set-fail-$3" ] && { echo "config set $3 refused"; exit 1; }; echo "updated $3"; exit 0 ;;
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
  write(
    join(home, ".openclaw", "openclaw.json5"),
    `${JSON.stringify({ gateway: { auth: { token: SECRETS.gateway } }, agents: { list: [] } }, null, 2)}\n`,
  );
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
      `OPENCLAW_CONFIG_PATH=${join(home, ".openclaw", "openclaw.json5")}`,
      `OPENROUTER_API_KEY=${SECRETS.openrouter}`,
      `MATRIX_ACCESS_TOKEN=${SECRETS.matrix}`,
      `MATRIX_HOMESERVER=${homeserver}`,
      "",
    ].join("\n"),
    0o600,
  );
  const lobsterPkg = join(home, ".npm-global", "lib", "node_modules", "@clawdbot", "lobster");
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
    else case "$1" in *"--tool llm-task"*) code=400 ;; *) code=404 ;; esac; fi
    echo "Error: clawd.invoke failed ($code): {\\"error\\":\\"x\\"}" >&2; exit 1 ;;
esac
exit 64`,
  );
  mkdirSync(join(home, ".npm-global", "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/@clawdbot/lobster/bin/lobster.js", join(home, ".npm-global", "bin", "lobster"));

  // systemd units.
  const unitPath = [bin, join(prefix, "bin"), process.env.PATH].join(":");
  write(
    join(units, GATEWAY),
    [
      "[Service]",
      `User=${user}`,
      `WorkingDirectory=${home}`,
      `Environment=HOME=${home}`,
      `Environment=PATH=${unitPath}`,
      `EnvironmentFile=-${join(home, "gateway.env")}`,
      `ExecStart=${join(prefix, "bin", "openclaw")} gateway run --allow-unconfigured --bind loopback`,
      "",
    ].join("\n"),
  );
  write(join(units, SCAN_TIMER), "[Timer]\nOnUnitActiveSec=5m\n");
  write(join(units, SCAN_SERVICE), "[Service]\nType=oneshot\n");
  writeFileSync(join(state, "active", GATEWAY), "");
  if (scanActive) writeFileSync(join(state, "active", SCAN_TIMER), "");
  mkdirSync(join(state, "enabled"), { recursive: true });
  writeFileSync(join(state, "enabled", SCAN_TIMER), "");

  // Host tool stubs.
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
    touch "$S/active/$unit"; exit 0 ;;
  cat) [ -e ${JSON.stringify(units)}/"$unit" ]; exit ;;
  show)
    case " $* " in
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
printf 'npm %s backups=%s\\n' "$*" "$(find ${JSON.stringify(join(root, "backup"))} -name 'openclaw-state.tar.gz' 2>/dev/null | wc -l)" >>"$S/calls.log"
[ "$1 $2" = "install -g" ] || exit 64
spec="$3"; version="\${spec#openclaw@}"
[ -e "$S/npm-fail-$version" ] && { echo "npm ERR! network"; exit 1; }
pkg="$npm_config_prefix/lib/node_modules/openclaw"
sed -i "s/\\"version\\": \\"[^\\"]*\\"/\\"version\\": \\"$version\\"/" "$pkg/package.json"
dep=1.0.0
[ -e "$S/lockfile-mismatch" ] && dep=0.9.0
sed -e "s/@V@/$version/g" -e "s/@DEP@/$dep/g" ${JSON.stringify(join(state, "lock.template"))} >"$npm_config_prefix/lib/node_modules/.package-lock.json"
echo "added 531 packages"; exit 0`,
  );
  writeFileSync(join(state, "lock.template"), hiddenLockfile("@V@", "@DEP@"));
  stub(
    bin,
    "apt-get",
    `printf 'apt-get %s\\n' "$*" >>"$S/calls.log"
[ -e "$S/apt-fail" ] && exit 100
case " $* " in *" install "*) [ -e "$S/node-upgrade-to" ] && cp "$S/node-upgrade-to" "$S/node-version" ;; esac
exit 0`,
  );
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

  return { root, bin, state, units, home, prefix, pkg, out: join(root, "out"), backup: join(root, "backup") };
};

const flag = (fx, name, content = "") => writeFileSync(join(fx.state, name), content);

// `cwd` starts the script from that directory after making it untraversable,
// the way a root caller's 0700 staging directory is for the service user.
const run = async (fx, args = ["--target", TARGET, "--out", fx.out], extraEnv = {}, { cwd } = {}) => {
  writeFileSync(join(fx.state, "calls.log"), "");
  const argv =
    cwd === undefined ? [SCRIPT, ...args] : ["-c", 'cd "$1" && chmod 000 . && shift && exec bash "$@"', "_", cwd, SCRIPT, ...args];
  const result = await exec("bash", argv, {
    env: {
      PATH: `${fx.bin}:${process.env.PATH}`,
      HOME: fx.root,
      TMPDIR: fx.root,
      OPENCLAW_MIGRATE_ALLOW_NON_ROOT: "1",
      OPENCLAW_MIGRATE_UNIT_DIR: fx.units,
      OPENCLAW_MIGRATE_BACKUP_ROOT: fx.backup,
      OPENCLAW_MIGRATE_LOCK_FILE: join(fx.root, "migrate.lock"),
      OPENCLAW_MIGRATE_MIN_FREE_BYTES: "0",
      OPENCLAW_MIGRATE_HEALTH_TIMEOUT: "2",
      OPENCLAW_MIGRATE_HEALTH_POLL: "0.2",
      OPENCLAW_MIGRATE_DOCTOR_TIMEOUT: "20",
      OPENCLAW_MIGRATE_STAGE_SETTLE: "0",
      ...extraEnv,
    },
  });
  if (cwd !== undefined) chmodSync(cwd, 0o700);
  const resultPath = join(fx.out, "result.json");
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: readFileSync(join(fx.state, "calls.log"), "utf8").split("\n").filter(Boolean),
    result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null,
    log: existsSync(join(fx.out, "migration.log")) ? readFileSync(join(fx.out, "migration.log"), "utf8") : "",
  };
};

const installedVersion = (fx) => JSON.parse(readFileSync(join(fx.pkg, "package.json"), "utf8")).version;
const isActive = (fx, unit) => existsSync(join(fx.state, "active", unit));
const stepNames = (r) => r.result.steps.map((s) => s.name);
const ALL_STEPS = [
  "preflight",
  "stop",
  "backup",
  "node",
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

describe("openclaw-migrate.sh happy path", () => {
  it("migrates, writes the contracted result.json and leaves the units running", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({
      ok: true,
      target: TARGET,
      from: FROM,
      lobster: { version: "2026.1.24", ok: true },
      doctor: { interactive_prompt_seen: false },
      already_migrated: false,
      failed_step: null,
    });
    expect(r.result.node).toEqual({ version: "22.22.3", ok: true, upgraded: false });
    expect(stepNames(r)).toEqual(ALL_STEPS);
    for (const step of r.result.steps) {
      expect(step).toEqual(expect.objectContaining({ ok: true, seconds: expect.any(Number) }));
      expect(typeof step.name).toBe("string");
    }
    expect(r.result.steps.find((s) => s.name === "stage")).toMatchObject({ skipped: true });
    expect(r.result.steps.find((s) => s.name === "node")).toMatchObject({ skipped: true });
    expect(r.result.backup.path).toMatch(/openclaw-state\.tar\.gz$/);
    expect(r.result.backup.bytes).toBe(statSync(r.result.backup.path).size);
    expect(r.result.backup.bytes).toBeGreaterThan(0);
    expect(installedVersion(fx)).toBe(TARGET);
    expect(isActive(fx, GATEWAY)).toBe(true);
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
    expect(r.result.lobster.detail).toContain("HTTP 404");
    expect(r.result.lobster.detail).toContain("llm-task on agent:mail-sentinel:main: HTTP 400");
    expect(existsSync(join(fx.state, "token-in-argv"))).toBe(false);
    expect(r.result.doctor.runs.map((d) => `${d.version}/${d.phase}`)).toEqual([`${TARGET}/config`, `${TARGET}/matrix`]);
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
    expect(r.result.steps.find((s) => s.name === "matrix-plugin").detail).toBe("matrix plugin install disabled");
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
        expect.stringMatching(
          new RegExp(`^openclaw@${TARGET} config set channels\\.matrix\\.network\\.dangerouslyAllowPrivateNetwork true --strict-json`),
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
    const before = readFileSync(join(fx.home, ".openclaw", "openclaw.json5"), "utf8");
    const r = await run(fx);
    const firstChange = r.calls.findIndex((c) => c.startsWith("npm ") || / doctor /.test(c));
    expect(firstChange).toBeGreaterThan(-1);
    expect(r.calls[firstChange]).toMatch(/^npm install -g openclaw@2026\.8\.35 backups=1$/);
    const stopIndex = r.calls.indexOf(`systemctl stop ${GATEWAY}`);
    expect(stopIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeLessThan(firstChange);

    const extract = join(fx.root, "extract");
    mkdirSync(extract);
    const tar = spawnSync("tar", ["-xzf", r.result.backup.path, "-C", extract]);
    expect(tar.status).toBe(0);
    expect(readFileSync(join(extract, ".openclaw", "openclaw.json5"), "utf8")).toBe(before);
    expect(existsSync(join(extract, ".openclaw", "agents", "main", "sessions.json"))).toBe(true);
    // doctor migrated state after the backup was taken, so only the live tree has it.
    expect(existsSync(join(extract, ".openclaw", "state", "openclaw.sqlite"))).toBe(false);
    expect(existsSync(join(fx.home, ".openclaw", "state", "openclaw.sqlite"))).toBe(true);
    expect(existsSync(r.result.backup.package_path)).toBe(true);
    expect(statSync(dirname(r.result.backup.path)).mode & 0o777).toBe(0o700);
    expect(statSync(r.result.backup.path).mode & 0o777).toBe(0o600);
  });

  it("writes npm-shrinkwrap.json from the installed tree", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    const shrinkwrap = JSON.parse(readFileSync(join(fx.out, "npm-shrinkwrap.json"), "utf8"));
    expect(shrinkwrap).toMatchObject({ name: "openclaw", version: TARGET, lockfileVersion: 3 });
    expect(shrinkwrap.packages[""]).toMatchObject({ name: "openclaw", version: TARGET, dependencies: { dep: "^1.0.0" } });
    expect(shrinkwrap.packages["node_modules/dep"]).toMatchObject({ version: "1.0.0", integrity: "sha512-dep" });
    expect(shrinkwrap.packages["node_modules/@scope/util"]).toMatchObject({ version: "2.0.0", license: "MIT" });
    expect(shrinkwrap.packages["node_modules/npm"]).toBeUndefined();
    expect(r.result.shrinkwrap).toEqual({ source: "npm-hidden-lockfile+installed-tree", packages: 2 });
  });

  it("stops at 6.x and runs doctor there when the legacy flat Matrix store exists", async () => {
    const fx = makeFixture({ flatMatrixStore: true });
    const r = await run(fx);
    expect(r.status).toBe(0);
    const installs = r.calls.filter((c) => c.startsWith("npm install"));
    expect(installs.map((c) => c.split(" ")[3])).toEqual([`openclaw@${STAGE}`, `openclaw@${TARGET}`]);
    const doctors = r.calls.filter((c) => / doctor --fix/.test(c)).map((c) => c.split(" ")[0]);
    expect(doctors).toEqual([`openclaw@${STAGE}`, `openclaw@${STAGE}`, `openclaw@${TARGET}`, `openclaw@${TARGET}`]);
    expect(r.calls).toContain(`openclaw@${STAGE} plugins install npm:@openclaw/matrix@${STAGE} --force home=${fx.home} tty=no key=set`);
    expect(r.result.steps.find((s) => s.name === "stage")).toMatchObject({ ok: true });
    expect(r.result.steps.find((s) => s.name === "stage").skipped).toBeUndefined();
    expect(r.result.doctor.runs.map((d) => `${d.version}/${d.phase}`)).toEqual([
      `${STAGE}/config`,
      `${STAGE}/matrix`,
      `${TARGET}/config`,
      `${TARGET}/matrix`,
    ]);
    // The stage release ran the gateway once, then the units were stopped
    // again before the target was installed.
    const stageStart = r.calls.indexOf(`systemctl start ${GATEWAY}`);
    const targetInstall = r.calls.findIndex((c) => c.startsWith(`npm install -g openclaw@${TARGET}`));
    expect(stageStart).toBeGreaterThan(-1);
    expect(stageStart).toBeLessThan(targetInstall);
    expect(r.calls.slice(stageStart, targetInstall)).toContain(`systemctl stop ${GATEWAY}`);
  });

  it("upgrades Node 22 first when it is below the required minimum", async () => {
    const fx = makeFixture({ nodeVersion: "22.16.0" });
    flag(fx, "node-upgrade-to", "22.22.3");
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result.steps.find((s) => s.name === "node")).toMatchObject({ ok: true, detail: "node 22.22.3" });
    expect(r.result.node).toEqual({ version: "22.22.3", ok: true, upgraded: true });
    const aptIndex = r.calls.findIndex((c) => c.startsWith("apt-get") && c.includes("install"));
    const npmIndex = r.calls.findIndex((c) => c.startsWith("npm install"));
    expect(aptIndex).toBeGreaterThan(-1);
    expect(aptIndex).toBeLessThan(npmIndex);
  });
});

describe("openclaw-migrate.sh stage selection", () => {
  const stageRan = (r) => r.calls.some((c) => c.startsWith(`npm install -g openclaw@${STAGE}`));

  it("stops at 6.x for the old bot SDK crypto store in a per-account dir", async () => {
    const fx = makeFixture({ legacyCrypto: true });
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(stageRan(r)).toBe(true);
    expect(r.result.steps.find((s) => s.name === "stage").detail).toContain("crypto/bot-sdk.json");
  });

  it("skips the stage for a per-account store without legacy crypto", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(stageRan(r)).toBe(false);
  });

  it("can force the stage on or off", async () => {
    const forced = makeFixture();
    const on = await run(forced, undefined, { OPENCLAW_MIGRATE_STAGE: "always" });
    expect(on.status).toBe(0);
    expect(stageRan(on)).toBe(true);
    expect(on.result.steps.find((s) => s.name === "stage").detail).toContain("forced");

    const skipped = makeFixture({ flatMatrixStore: true });
    const off = await run(skipped, undefined, { OPENCLAW_MIGRATE_STAGE: "never" });
    expect(off.status).toBe(0);
    expect(stageRan(off)).toBe(false);
  });
});

describe("openclaw-migrate.sh interactive doctor", () => {
  it("fails and reports a prompt that met EOF on stdin", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-prompt");
    const r = await run(fx);
    expect(r.status).toBe(1);
    expect(r.result).toMatchObject({ ok: false, failed_step: "doctor", doctor: { interactive_prompt_seen: true } });
    expect(r.result.doctor.runs).toEqual([
      { version: TARGET, phase: "config", exit: 1, timed_out: false, interactive_prompt_seen: true },
    ]);
    expect(r.calls.some((c) => c.includes("doctor --fix") && c.includes("tty=no"))).toBe(true);
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
    expect(r.result.steps.at(-1)).toMatchObject({ name: "doctor", ok: false });
  });

  it("fails on a prompt even when doctor exits 0", async () => {
    const fx = makeFixture();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_DOCTOR_ARGS: "doctor --fix", OPENCLAW_MIGRATE_PROMPT_REGEX: "doctor: migrated" });
    expect(r.status).toBe(1);
    expect(r.result.doctor.interactive_prompt_seen).toBe(true);
    expect(r.result.doctor.runs[0]).toMatchObject({ exit: 0, interactive_prompt_seen: true });
  });
});

describe("openclaw-migrate.sh failing steps", () => {
  const cases = [
    { step: "preflight", setup: (fx) => rmSync(join(fx.home, ".openclaw"), { recursive: true }), touched: false, stopped: false },
    { step: "preflight", name: "node above range", fixture: { nodeVersion: "24.1.0" }, node: { version: "24.1.0", ok: false, upgraded: false }, touched: false, stopped: false },
    { step: "preflight", name: "no gateway unit", setup: (fx) => rmSync(join(fx.units, GATEWAY)), node: { version: null, ok: false, upgraded: false }, touched: false, stopped: false },
    { step: "preflight", name: "downgrade", args: ["--target", "2026.3.1"], touched: false, stopped: false },
    { step: "stop", setup: (fx) => flag(fx, "stop-fail"), touched: false, stopped: true },
    { step: "backup", env: (fx) => ({ OPENCLAW_MIGRATE_BACKUP_ROOT: join(fx.home, "gateway.env", "x") }), touched: false, stopped: true },
    { step: "node", fixture: { nodeVersion: "22.16.0" }, setup: (fx) => flag(fx, "apt-fail"), node: { version: "22.16.0", ok: false, upgraded: false }, touched: false, stopped: true },
    { step: "node", name: "node still too old", fixture: { nodeVersion: "22.16.0" }, node: { version: "22.16.0", ok: false, upgraded: false }, touched: false, stopped: true },
    {
      step: "node",
      name: "upgraded but still too old",
      fixture: { nodeVersion: "22.16.0" },
      setup: (fx) => flag(fx, "node-upgrade-to", "22.22.2"),
      node: { version: "22.22.2", ok: false, upgraded: true },
      touched: false,
      stopped: true,
    },
    { step: "stage", fixture: { flatMatrixStore: true }, setup: (fx) => flag(fx, `npm-fail-${STAGE}`), touched: true, detail: `npm install -g openclaw@${STAGE} exited 1: npm ERR! network` },
    { step: "stage", name: "6.x doctor fails", fixture: { flatMatrixStore: true }, setup: (fx) => flag(fx, `doctor-fail-${STAGE}`), touched: true },
    {
      step: "stage",
      name: "6.x matrix plugin fails",
      fixture: { flatMatrixStore: true },
      setup: (fx) => flag(fx, "plugin-fail"),
      touched: true,
      detail: `openclaw plugins install npm:@openclaw/matrix@${STAGE} --force exited 1: npm ERR! 404 Not Found - GET https://registry.npmjs.org/@openclaw%2fmatrix (auth <redacted>)`,
    },
    { step: "stage", name: "6.x matrix doctor fails", fixture: { flatMatrixStore: true }, setup: (fx) => flag(fx, "doctor-matrix-fail"), touched: true },
    { step: "stage", name: "6.x gateway never healthy", fixture: { flatMatrixStore: true }, setup: (fx) => flag(fx, "stage-health-fail"), touched: true },
    { step: "upgrade", setup: (fx) => flag(fx, `npm-fail-${TARGET}`), touched: true, detail: `npm install -g openclaw@${TARGET} exited 1: npm ERR! network` },
    { step: "shrinkwrap", setup: (fx) => flag(fx, "lockfile-mismatch"), touched: true, detail: /: mismatch node_modules\/dep: lockfile 0\.9\.0, installed 1\.0\.0$/ },
    { step: "doctor", setup: (fx) => flag(fx, `doctor-fail-${TARGET}`), touched: true },
    {
      step: "web-search",
      setup: (fx) => flag(fx, "config-set-fail-tools.web.search.enabled"),
      touched: true,
      detail: "disabling tools.web.search.enabled exited 1: config set tools.web.search.enabled refused",
    },
    {
      step: "matrix-plugin",
      setup: (fx) => flag(fx, "plugin-fail"),
      touched: true,
      detail: `openclaw plugins install npm:@openclaw/matrix@${TARGET} --force --accept-capabilities exited 1: npm ERR! 404 Not Found - GET https://registry.npmjs.org/@openclaw%2fmatrix (auth <redacted>)`,
    },
    {
      step: "matrix-plugin",
      name: "opt-in fails",
      setup: (fx) => flag(fx, "config-set-fail-channels.matrix.network.dangerouslyAllowPrivateNetwork"),
      touched: true,
      detail: "enabling channels.matrix.network.dangerouslyAllowPrivateNetwork exited 1: config set channels.matrix.network.dangerouslyAllowPrivateNetwork refused",
    },
    { step: "doctor-matrix", setup: (fx) => flag(fx, "doctor-matrix-fail"), touched: true },
    { step: "config-validate", setup: (fx) => flag(fx, "validate-fail"), touched: true, detail: "openclaw config validate exited 1: config invalid" },
    { step: "matrix-verify", setup: (fx) => flag(fx, "matrix-fail"), touched: true, detail: "openclaw matrix verify status exited 1: matrix: server device unknown" },
    { step: "start", setup: (fx) => flag(fx, "start-fail"), touched: true },
    { step: "health", setup: (fx) => flag(fx, "health-fail"), touched: true },
    { step: "health", name: "restart loop", setup: (fx) => flag(fx, "health-restart"), touched: true },
    {
      step: "lobster",
      setup: (fx) => flag(fx, "lobster-broken"),
      touched: true,
      detail: "lobster commands.list failed or lacks clawd.invoke/llm_task.invoke (exit 1): SyntaxError",
    },
    { step: "lobster", name: "token refused", setup: (fx) => flag(fx, "lobster-status", "401"), touched: true },
    { step: "lobster", name: "gateway unreachable", setup: (fx) => flag(fx, "lobster-status", ""), touched: true },
    { step: "lobster", name: "unexpected status", setup: (fx) => flag(fx, "lobster-status", "500"), touched: true },
  ];

  for (const c of cases) {
    it(`stops at a failing ${c.step}${c.name ? ` (${c.name})` : ""} and fails closed`, async () => {
      const fx = makeFixture(c.fixture);
      c.setup?.(fx);
      const args = ["--out", fx.out, ...(c.args ?? ["--target", TARGET])];
      const r = await run(fx, args, c.env?.(fx) ?? {});
      expect(r.status).toBe(1);
      expect(r.result.ok).toBe(false);
      expect(r.result.failed_step).toBe(c.step);
      expect(r.result.steps.at(-1)).toMatchObject({ name: c.step, ok: false });
      expect(r.result.message).toBeTruthy();
      if (c.detail !== undefined) {
        const { detail } = r.result.steps.at(-1);
        if (typeof c.detail === "string") {
          expect(detail).toBe(c.detail);
        } else {
          expect(detail).toMatch(c.detail);
        }
        expect(r.result.message).toContain(`Failure: ${detail}`);
      }
      expect(r.result.node).toEqual(c.node ?? { version: c.fixture?.nodeVersion ?? "22.22.3", ok: true, upgraded: false });
      if (!c.touched) {
        expect(installedVersion(fx)).toBe(FROM);
        expect(r.calls.some((call) => call.startsWith("npm install"))).toBe(false);
        expect(r.result.units_restarted_on_old_version).toBe(c.stopped);
        if (c.step !== "stop") expect(isActive(fx, GATEWAY)).toBe(true);
      } else if (!["start", "health", "lobster"].includes(c.step)) {
        expect(r.result.units_restarted_on_old_version).toBe(false);
        expect(isActive(fx, GATEWAY)).toBe(false);
        expect(r.result.message).toContain("NOT restarted");
        expect(r.result.message).toContain("To roll back");
      }
    });
  }
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
    expect(r.result.steps.find((s) => s.name === "doctor")).toMatchObject({ ok: true, detail: `doctor (${TARGET}, config) ok` });
    const cwds = (name) => readFileSync(join(fx.state, name), "utf8").split("\n").filter(Boolean);
    expect(cwds("doctor-cwd")).toEqual([fx.home, fx.home]);
    expect(cwds("npm-cwd")).toEqual([fx.home]);
  });

  it("fails closed on a doctor that cannot spawn and records why in result.json", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-eacces");
    const r = await run(fx);
    expect(r.status).toBe(1);
    expect(r.result).toMatchObject({ ok: false, failed_step: "doctor", units_restarted_on_old_version: false });
    const step = r.result.steps.at(-1);
    expect(step).toMatchObject({ name: "doctor", ok: false });
    expect(step.detail).toBe(
      `doctor (${TARGET}, config) exited 1: Doctor could not complete maintenance. Check the reported service state, resolve the failure, and rerun doctor --fix.; ${EACCES_LINE}`,
    );
    expect(r.result.message).toContain(EACCES_LINE);
    expect(r.result.message).toContain("NOT restarted");
    expect(r.result.doctor.runs).toEqual([
      { version: TARGET, phase: "config", exit: 1, timed_out: false, interactive_prompt_seen: false },
    ]);
    // The full output stays in the log, frames included.
    expect(r.log).toContain("    | ├──");
    expect(r.log).toContain(`    | ${EACCES_LINE}`);
    expect(isActive(fx, GATEWAY)).toBe(false);
    expect(r.calls.some((c) => c.includes("plugins install"))).toBe(false);
  });

  it("keeps secrets out of a failed doctor's detail", async () => {
    const fx = makeFixture();
    flag(fx, "doctor-secret-fail");
    const r = await run(fx);
    expect(r.status).toBe(1);
    const detail = r.result.steps.at(-1).detail;
    expect(detail).toBe(`doctor (${TARGET}, config) exited 2: Config warnings: plugins.entries.matrix: plugin not installed: matrix — install the official external plugin with: openclaw plugins install clawhub:@openclaw/matrix; Error: provider rejected key <redacted>`);
    const resultText = readFileSync(join(fx.out, "result.json"), "utf8");
    expect(resultText).not.toContain(SECRETS.openrouter);
    expect(r.log).not.toContain(SECRETS.openrouter);
  });

  it("accepts the first pass's missing-Matrix-plugin warning, which the next step resolves", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    const warning = "plugin not installed: matrix";
    const doctorLog = r.log.slice(r.log.indexOf("step doctor: start"), r.log.indexOf("step doctor: ok"));
    expect(doctorLog).toContain(warning);
    const secondPass = r.log.slice(r.log.indexOf("step doctor-matrix: start"), r.log.indexOf("step doctor-matrix: ok"));
    expect(secondPass).not.toContain(warning);
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
    expect(r.result.steps.find((s) => s.name === "matrix-plugin").detail).toBe(
      `installed plugins install npm:@openclaw/matrix@${TARGET} --force --accept-capabilities; private homeserver opt-in set`,
    );
  });

  it("can force the consent flag without probing, or leave it out", async () => {
    const fx = makeFixture();
    const forced = await run(fx, undefined, { OPENCLAW_MIGRATE_MATRIX_PLUGIN_CONSENT: "always" });
    expect(forced.status).toBe(0);
    expect(forced.calls.some((c) => c.includes("plugins install --help"))).toBe(false);
    expect(installs(forced)).toEqual([`openclaw@${TARGET} plugins install npm:@openclaw/matrix@${TARGET} --force --accept-capabilities`]);

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
    expect(r.result).toMatchObject({ ok: false, failed_step: "matrix-plugin", units_restarted_on_old_version: false });
    const step = r.result.steps.at(-1);
    expect(step).toMatchObject({ name: "matrix-plugin", ok: false });
    expect(step.detail).toBe(
      `openclaw plugins install npm:@openclaw/matrix@${TARGET} --force exited 1: [openclaw] Could not start the CLI.; ${CONSENT_REASON}`,
    );
    expect(r.result.message).toContain(CONSENT_REASON);
    expect(r.log).toContain(`    | ${CONSENT_REASON}`);
    expect(isActive(fx, GATEWAY)).toBe(false);
  });

  it("puts a failed install's output into migration.log and result.json with secrets redacted", async () => {
    const fx = makeFixture();
    flag(fx, "plugin-fail");
    const r = await run(fx);
    expect(r.status).toBe(1);
    const error = "npm ERR! 404 Not Found - GET https://registry.npmjs.org/@openclaw%2fmatrix (auth <redacted>)";
    expect(r.result.steps.at(-1).detail).toContain(error);
    expect(r.result.message).toContain(error);
    expect(r.log).toContain(`    | ${error}`);
    const resultText = readFileSync(join(fx.out, "result.json"), "utf8");
    for (const secret of Object.values(SECRETS)) {
      expect(resultText).not.toContain(secret);
      expect(r.log).not.toContain(secret);
    }
  });
});

const WEB_SEARCH_SET = "config set tools.web.search.enabled false --strict-json";

describe("openclaw-migrate.sh web search", () => {
  const callIndex = (r, re) => r.calls.findIndex((c) => re.test(c));

  it("turns web search off after the first doctor pass and before the plugin install", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    const set = callIndex(r, new RegExp(`^openclaw@${TARGET} ${WEB_SEARCH_SET.replaceAll(".", "\\.")}`));
    expect(set).toBeGreaterThan(callIndex(r, / doctor --fix/));
    expect(set).toBeLessThan(callIndex(r, / plugins install npm:/));
    expect(r.result.steps.find((s) => s.name === "web-search").detail).toBe("set tools.web.search.enabled=false (was unset)");
  });

  it("leaves a config that already has web search off alone", async () => {
    const fx = makeFixture();
    const config = join(fx.home, ".openclaw", "openclaw.json5");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), tools: { web: { search: { enabled: false } } } }));
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes("tools.web.search"))).toBe(false);
    expect(r.result.steps.find((s) => s.name === "web-search").detail).toBe("tools.web.search.enabled already false");
  });

  it("can leave web search as configured", async () => {
    const fx = makeFixture();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_WEB_SEARCH: "keep" });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes("tools.web.search"))).toBe(false);
    expect(r.result.steps.find((s) => s.name === "web-search").detail).toBe("tools.web.search left as configured");
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
    "2026-11-03T11:31:45+00:00 node openclaw[64474]: OpenClaw plugin verification failed; refusing to report the gateway ready.",
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
    expect(r.status).toBe(1);
    expect(r.result.failed_step).toBe("health");
    const journalCall = r.calls.find((c) => c.startsWith("journalctl "));
    expect(journalCall).toMatch(new RegExp(`^journalctl -u ${GATEWAY} --since @(\\d+) --no-pager -n 120 -o short-iso$`));
    const since = Number(/@(\d+)/.exec(journalCall)[1]);
    expect(since).toBeGreaterThanOrEqual(before);
    expect(r.calls).toContain(
      `systemctl show -p NRestarts,Result,ActiveState,SubState,ExecMainCode,ExecMainStatus,ExecMainPID,MainPID,ExecMainStartTimestamp,ExecMainExitTimestamp ${GATEWAY}`,
    );
    expect(r.result.gateway).toEqual({
      unit: GATEWAY,
      since: new Date(since * 1000).toISOString(),
      show: {
        NRestarts: "1",
        Result: "exit-code",
        ActiveState: "activating",
        SubState: "auto-restart",
        ExecMainCode: "1",
        ExecMainStatus: "1",
        MainPID: "0",
      },
      journal: [
        "2026-11-03T11:31:44+00:00 node openclaw[64474]: Doctor warnings",
        '2026-11-03T11:31:45+00:00 node openclaw[64474]: Failed to install missing configured plugin "perplexity": key <redacted> token=<redacted>',
        "2026-11-03T11:31:45+00:00 node openclaw[64474]: OpenClaw plugin verification failed; refusing to report the gateway ready.",
        "2026-11-03T11:31:46+00:00 node systemd[1]: sovereign-openclaw-gateway.service: Main process exited, code=exited, status=1/FAILURE",
      ],
    });
    expect(r.log).toContain("    | Result=exit-code");
    expect(r.log).toContain("    | 2026-11-03T11:31:45+00:00 node openclaw[64474]: OpenClaw plugin verification failed");
    const resultText = readFileSync(join(fx.out, "result.json"), "utf8");
    for (const secret of Object.values(SECRETS)) {
      expect(resultText).not.toContain(secret);
      expect(r.log).not.toContain(secret);
    }
  });

  it("keeps only the last lines of a long journal", async () => {
    const fx = restartLoop();
    flag(fx, "journal", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_GATEWAY_JOURNAL_LINES: "5" });
    expect(r.calls.find((c) => c.startsWith("journalctl "))).toContain(" -n 5 ");
    expect(r.result.gateway.journal).toEqual(["line 25", "line 26", "line 27", "line 28", "line 29"]);
  });

  it("captures them when the start itself fails", async () => {
    const fx = makeFixture();
    flag(fx, "start-fail");
    flag(fx, "journal", "start refused\n");
    const r = await run(fx);
    expect(r.result.failed_step).toBe("start");
    expect(r.result.gateway.journal).toEqual(["start refused"]);
    expect(r.result.gateway.show).toMatchObject({ Result: "success", ActiveState: "active" });
  });

  it("says so when journalctl is missing instead of failing differently", async () => {
    const fx = restartLoop();
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_JOURNALCTL: join(fx.root, "no-journalctl") });
    expect(r.result.failed_step).toBe("health");
    expect(r.result.gateway.journal).toEqual([`journalctl unavailable (${join(fx.root, "no-journalctl")})`]);
    expect(r.result.gateway.show.Result).toBe("exit-code");
  });

  it("leaves gateway null when every step succeeded", async () => {
    const fx = makeFixture();
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result.gateway).toBeNull();
    expect(r.calls.some((c) => c.startsWith("journalctl "))).toBe(false);
  });
});

describe("openclaw-migrate.sh re-runs", () => {
  it("is a no-op success on an already migrated node", async () => {
    const fx = makeFixture();
    expect((await run(fx)).status).toBe(0);
    const before = readFileSync(join(fx.home, ".openclaw", "openclaw.json5"), "utf8");
    const backups = readdirSync(fx.backup);
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ ok: true, already_migrated: true, from: FROM, target: TARGET });
    expect(r.result.node).toEqual({ version: "22.22.3", ok: true, upgraded: false });
    expect(r.result.backup.path).toMatch(/openclaw-state\.tar\.gz$/);
    expect(stepNames(r)).toEqual(ALL_STEPS);
    for (const name of ["stop", "backup", "node", "stage", "upgrade", "doctor", "web-search", "config-validate", "matrix-verify", "start"]) {
      expect(r.result.steps.find((s) => s.name === name)).toMatchObject({ ok: true, skipped: true });
    }
    expect(r.calls.filter((c) => /^npm |systemctl (stop|start)| doctor /.test(c))).toEqual([]);
    expect(readFileSync(join(fx.home, ".openclaw", "openclaw.json5"), "utf8")).toBe(before);
    expect(readdirSync(fx.backup)).toEqual(backups);
    expect(existsSync(join(fx.out, "npm-shrinkwrap.json"))).toBe(true);
  });

  it("resumes after a failure that happened past the package upgrade", async () => {
    const fx = makeFixture();
    flag(fx, "validate-fail");
    const first = await run(fx);
    expect(first.status).toBe(1);
    rmSync(join(fx.state, "validate-fail"));
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ ok: true, resumed: true, from: FROM });
    expect(r.result.backup.path).toBe(first.result.backup.path);
    // The failed run left the timer stopped; the resumed run starts it again.
    expect(isActive(fx, SCAN_TIMER)).toBe(true);
    expect(isActive(fx, GATEWAY)).toBe(true);
    expect(r.calls.some((c) => c.startsWith("npm install"))).toBe(false);
    expect(r.result.steps.find((s) => s.name === "upgrade")).toMatchObject({ skipped: true });
    expect(r.result.steps.find((s) => s.name === "node")).toMatchObject({ ok: true, skipped: true });
    expect(r.calls.some((c) => c.startsWith("apt-get"))).toBe(false);
    expect(r.result.node).toEqual({ version: "22.22.3", ok: true, upgraded: false });
  });

  it("upgrades a Node below the minimum before resuming", async () => {
    const fx = makeFixture();
    flag(fx, "validate-fail");
    expect((await run(fx)).status).toBe(1);
    rmSync(join(fx.state, "validate-fail"));
    flag(fx, "node-version", "22.16.0");
    flag(fx, "node-upgrade-to", "22.22.3");
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ ok: true, resumed: true });
    expect(r.result.steps.find((s) => s.name === "node")).toMatchObject({ ok: true, detail: "node 22.22.3" });
    expect(r.result.steps.find((s) => s.name === "node").skipped).toBeUndefined();
    expect(r.result.node).toEqual({ version: "22.22.3", ok: true, upgraded: true });
    const aptIndex = r.calls.findIndex((c) => c.startsWith("apt-get") && c.includes("install"));
    const doctorIndex = r.calls.findIndex((c) => c.includes(" doctor "));
    expect(aptIndex).toBeGreaterThan(-1);
    expect(aptIndex).toBeLessThan(doctorIndex);
  });

  it("fails closed when a resumed run finds Node below the minimum and cannot upgrade it", async () => {
    const fx = makeFixture();
    flag(fx, "validate-fail");
    expect((await run(fx)).status).toBe(1);
    rmSync(join(fx.state, "validate-fail"));
    flag(fx, "node-version", "22.16.0");
    const r = await run(fx);
    expect(r.status).toBe(1);
    expect(r.result).toMatchObject({ ok: false, resumed: true, failed_step: "node", units_restarted_on_old_version: false });
    expect(r.result.steps.at(-1)).toMatchObject({
      name: "node",
      ok: false,
      detail: "node is 22.16.0 after the upgrade; need >=22.22.3 <23.0.0 (install it from a repository that carries it)",
    });
    expect(r.result.node).toEqual({ version: "22.16.0", ok: false, upgraded: false });
    expect(r.calls.some((c) => c.includes(" doctor "))).toBe(false);
    expect(isActive(fx, GATEWAY)).toBe(false);
    expect(r.result.message).toContain("NOT restarted");
  });

  it("backs up first when the target is installed but no run recorded a backup", async () => {
    const fx = makeFixture();
    writeFileSync(join(fx.pkg, "package.json"), packageJson("openclaw", TARGET));
    const r = await run(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ ok: true, resumed: true, from: TARGET });
    expect(r.result.steps.find((s) => s.name === "backup").skipped).toBeUndefined();
    expect(existsSync(r.result.backup.path)).toBe(true);
    expect(r.calls.some((c) => c.startsWith("npm install"))).toBe(false);
    const listing = spawnSync("tar", ["-tzf", r.result.backup.path], { encoding: "utf8" }).stdout;
    expect(listing).toContain(".openclaw/openclaw.json5");
    expect(listing).not.toContain(".openclaw/state/openclaw.sqlite");
  });

  it("refuses to run while another migration holds the lock", async () => {
    const fx = makeFixture();
    const lock = join(fx.root, "migrate.lock");
    const holder = await exec("flock", ["-n", lock, "bash", SCRIPT, "--target", TARGET, "--out", fx.out], {
      env: {
        PATH: `${fx.bin}:${process.env.PATH}`,
        TMPDIR: fx.root,
        OPENCLAW_MIGRATE_ALLOW_NON_ROOT: "1",
        OPENCLAW_MIGRATE_UNIT_DIR: fx.units,
        OPENCLAW_MIGRATE_BACKUP_ROOT: fx.backup,
        OPENCLAW_MIGRATE_LOCK_FILE: lock,
      },
    });
    expect(holder.status).toBe(1);
    const result = JSON.parse(readFileSync(join(fx.out, "result.json"), "utf8"));
    expect(result).toMatchObject({ ok: false, failed_step: "lock" });
    expect(result.node).toEqual({ version: null, ok: false, upgraded: false });
    expect(installedVersion(fx)).toBe(FROM);
  });
});

describe("openclaw-migrate.sh gateway token", () => {
  it("reads a JSON5 config with OpenClaw's json5 when the CLI hides the token", async () => {
    const fx = makeFixture();
    const json5 = dirname(dirname(createRequire(import.meta.url).resolve("json5")));
    symlinkSync(json5, join(fx.pkg, "node_modules", "json5"));
    writeFileSync(
      join(fx.home, ".openclaw", "openclaw.json5"),
      `// managed\n{ gateway: { auth: { token: "${SECRETS.gateway}", }, }, }\n`,
    );
    flag(fx, "config-get-redacted");
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_STAGE: "never", OPENCLAW_MIGRATE_MATRIX_PLUGIN_ARGS: "" });
    expect(r.status).toBe(0);
    expect(r.result.lobster).toMatchObject({ ok: true });
    expect(r.result.lobster.detail).toContain("HTTP 404");
  });
});

describe("openclaw-migrate.sh --dry-run", () => {
  it("prints the plan and touches nothing", async () => {
    const fx = makeFixture({ flatMatrixStore: true, nodeVersion: "22.16.0" });
    const before = readFileSync(join(fx.home, ".openclaw", "openclaw.json5"), "utf8");
    const r = await run(fx, ["--target", TARGET, "--out", fx.out, "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry run");
    expect(r.stdout).toContain(`installed:         ${FROM}`);
    expect(r.stdout).toContain(`npm install -g openclaw@${STAGE}`);
    expect(r.stdout).toContain(`npm install -g openclaw@${TARGET}`);
    expect(r.stdout).toContain("apt-get install --only-upgrade nodejs");
    expect(r.calls).toEqual([]);
    expect(existsSync(fx.out)).toBe(false);
    expect(existsSync(fx.backup)).toBe(false);
    expect(installedVersion(fx)).toBe(FROM);
    expect(readFileSync(join(fx.home, ".openclaw", "openclaw.json5"), "utf8")).toBe(before);
    expect(isActive(fx, GATEWAY)).toBe(true);
  });

  it("reports a node it cannot inspect without failing", async () => {
    const fx = makeFixture();
    rmSync(join(fx.units, GATEWAY));
    const r = await run(fx, ["--dry-run", "--target", TARGET, "--out", fx.out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("discovery error");
    expect(r.calls).toEqual([]);
  });

  it("plans a verification-only run on an already migrated node", async () => {
    const fx = makeFixture();
    expect((await run(fx)).status).toBe(0);
    const r = await run(fx, ["--dry-run", "--target", TARGET, "--out", fx.out]);
    expect(r.stdout).toContain("already migrated");
    expect(r.calls).toEqual([]);
  });
});

describe("openclaw-migrate.sh arguments", () => {
  const usage = [
    ["no target", ["--out", "/tmp/x"]],
    ["no out", ["--target", TARGET]],
    ["bad target", ["--target", "latest", "--out", "/tmp/x"]],
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

  it("accepts --key=value forms and prints help", async () => {
    const fx = makeFixture();
    expect((await run(fx, ["--help"])).stdout).toContain("--target <version>");
    const r = await run(fx, [`--target=${TARGET}`, `--out=${fx.out}`, "--dry-run"]);
    expect(r.status).toBe(0);
  });

  it("refuses to run as a non-root user unless told it is a test", async () => {
    const fx = makeFixture();
    if (process.getuid?.() === 0) return;
    const r = await run(fx, undefined, { OPENCLAW_MIGRATE_ALLOW_NON_ROOT: "0" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run as root");
  });
});
