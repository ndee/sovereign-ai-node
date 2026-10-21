// Contract tests for what the installer grants the runtime API's service
// user: the exact sudoers rules and the container-runtime group handling.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const INSTALL_LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const bash = (script, env = {}) =>
  spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

const H = "/usr/local/lib/sovereign-node";
const GOLDEN_RULES = [
  `sovereign-node ALL=(root) NOPASSWD: ${H}/install-systemd-unit`,
  `sovereign-node ALL=(root) NOPASSWD: ${H}/bundled-matrix-docker`,
  `sovereign-node ALL=(root) NOPASSWD: ${H}/reclaim-ownership`,
  `sovereign-node ALL=(root) NOPASSWD: ${H}/install-docker.sh`,
  "sovereign-node ALL=(root) NOPASSWD: /bin/systemctl daemon-reload",
  ...["sovereign-openclaw-gateway", "sovereign-matrix-relay-tunnel"].flatMap((unit) => [
    `sovereign-node ALL=(root) NOPASSWD: /bin/systemctl restart ${unit}, /bin/systemctl restart ${unit}.service`,
    `sovereign-node ALL=(root) NOPASSWD: /bin/systemctl enable --now ${unit}, /bin/systemctl enable --now ${unit}.service`,
    `sovereign-node ALL=(root) NOPASSWD: /bin/systemctl is-active ${unit}, /bin/systemctl is-active ${unit}.service`,
    `sovereign-node ALL=(root) NOPASSWD: /bin/systemctl status ${unit}, /bin/systemctl status ${unit}.service`,
  ]),
  ...["enable", "restart", "is-active", "is-enabled"].map(
    (verb) =>
      `sovereign-node ALL=(root) NOPASSWD: /bin/systemctl ${verb} sovereign-mail-sentinel-scan.service, /bin/systemctl ${verb} sovereign-mail-sentinel-scan.timer`,
  ),
];

describe("render_service_sudoers", () => {
  const rendered = bash(
    `source "${INSTALL_LIB_DIR}/lib-build.sh"; render_service_sudoers sovereign-node`,
  );
  const rules = rendered.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.startsWith("#"));

  it("renders exactly the golden list of rules", () => {
    expect(rendered.status).toBe(0);
    expect(rules).toEqual(GOLDEN_RULES);
  });

  it("has no argument wildcards and only runs the helpers or systemctl", () => {
    const binaries = new Set([
      `${H}/install-systemd-unit`,
      `${H}/bundled-matrix-docker`,
      `${H}/reclaim-ownership`,
      `${H}/install-docker.sh`,
      "/bin/systemctl",
    ]);
    for (const rule of rules) {
      expect(rule).not.toMatch(/[*?[\]\\]/);
      const [, commands] = rule.split(" NOPASSWD: ");
      for (const command of commands.split(", ")) {
        expect(binaries.has(command.split(" ")[0])).toBe(true);
      }
    }
  });

  it("renders for the configured service user", () => {
    const other = bash(`source "${INSTALL_LIB_DIR}/lib-build.sh"; render_service_sudoers svc`);
    expect(other.stdout).not.toContain("sovereign-node ALL");
    expect(other.stdout).toContain(`svc ALL=(root) NOPASSWD: ${H}/install-systemd-unit`);
  });

  it.skipIf(!existsSync("/usr/sbin/visudo"))("is valid sudoers syntax", () => {
    const dir = mkdtempSync(join(tmpdir(), "sudoers-contract-"));
    try {
      const file = join(dir, "fragment");
      writeFileSync(file, rendered.stdout);
      const check = spawnSync("/usr/sbin/visudo", ["-cf", file], { encoding: "utf8" });
      expect(check.status, check.stdout + check.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensure_service_account container-runtime group", () => {
  // Stubs every account tool the function calls and records gpasswd calls.
  const run = (groups) => {
    const dir = mkdtempSync(join(tmpdir(), "service-account-"));
    try {
      const log = join(dir, "calls.log");
      const result = bash(
        `
        source "${INSTALL_LIB_DIR}/lib-runtime-paths.sh"
        SERVICE_USER=sovereign-node
        SERVICE_GROUP=sovereign-node
        getent() { return 0; }
        id() {
          if [[ "$1" == "-nG" ]]; then printf '%s\\n' "$GROUPS_OF_USER"; fi
          return 0
        }
        gpasswd() { printf 'gpasswd %s\\n' "$*" >> "${log}"; }
        groupadd() { :; }
        useradd() { :; }
        ensure_service_account
        cat "${log}" 2>/dev/null || true
        `,
        { GROUPS_OF_USER: groups },
      );
      return result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("removes the service user from the docker group", () => {
    const result = run("sovereign-node docker");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("gpasswd -d sovereign-node docker");
  });

  it("leaves a user without the group alone, so updates are idempotent", () => {
    for (const groups of ["sovereign-node", "sovereign-node docker-users"]) {
      const result = run(groups);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("");
    }
  });
});
