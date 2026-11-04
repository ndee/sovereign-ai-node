import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib-runtime-deps.sh");
const which = (tool) => execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
const BASH = which("bash");

/**
 * Run install_node22_if_needed against a fake `node` whose version lives in a
 * state file, with apt and the NodeSource repo setup replaced by recorders.
 * `upgradeTo` / `installTo` set the version the fake apt leaves behind.
 */
const runNodeStep = ({ initial, upgradeTo, installTo }) => {
  const work = mkdtempSync(join(tmpdir(), "node-floor-"));
  const bin = join(work, "bin");
  const state = join(work, "node-version");
  const log = join(work, "calls.log");
  const tools = join(work, "tools");
  execFileSync("mkdir", ["-p", bin, tools]);
  // Only these tools are reachable, so the host's own node can never answer.
  for (const tool of ["cat", "chmod"]) {
    symlinkSync(which(tool), join(tools, tool));
  }
  writeFileSync(log, "");
  if (initial !== undefined) {
    writeFileSync(state, initial);
    writeFileSync(join(bin, "node"), `#!/bin/sh\ncat "${state}"\n`);
    chmodSync(join(bin, "node"), 0o755);
  }
  const script = `
set -euo pipefail
log() { printf 'LOG %s\\n' "$*" >> "${log}"; }
die() { printf 'DIE %s\\n' "$*" >> "${log}"; exit 1; }
source "${LIB}"
configure_nodesource_node22_repo() { printf 'REPO nodesource\\n' >> "${log}"; }
apt_get_locked() {
  printf 'APT %s\\n' "$*" >> "${log}"
  case "$*" in
    "install -y --only-upgrade nodejs") [[ -z "${upgradeTo ?? ""}" ]] || printf '%s' "${upgradeTo ?? ""}" > "${state}" ;;
    "install -y nodejs")
      if [[ -n "${installTo ?? ""}" ]]; then
        printf '%s' "${installTo ?? ""}" > "${state}"
        printf '#!/bin/sh\\ncat "${state}"\\n' > "${bin}/node"
        chmod 0755 "${bin}/node"
      fi ;;
  esac
}
install_node22_if_needed
`;
  const result = spawnSync(BASH, ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${bin}:${tools}` },
  });
  return {
    status: result.status,
    calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
  };
};

describe("install_node22_if_needed enforces the Node.js runtime floor", () => {
  it("keeps a Node.js inside the supported range", () => {
    const { status, calls } = runNodeStep({ initial: "v22.22.3" });
    expect(status).toBe(0);
    expect(calls.some((line) => line.startsWith("APT"))).toBe(false);
    expect(calls).toContain("LOG Node.js v22.22.3 detected (>=22.22.3 <23), skipping Node install");
  });

  it("upgrades a 22.x below the floor in place and stops there when that suffices", () => {
    const { status, calls } = runNodeStep({ initial: "v22.22.2", upgradeTo: "v22.23.4" });
    expect(status).toBe(0);
    expect(calls).toContain("APT install -y --only-upgrade nodejs");
    expect(calls).not.toContain("REPO nodesource");
    expect(calls).toContain("LOG Node.js upgraded to v22.23.4");
  });

  it("points apt at NodeSource when the in-place upgrade stays below the floor", () => {
    const { status, calls } = runNodeStep({
      initial: "v22.12.0",
      upgradeTo: "v22.14.0",
      installTo: "v22.22.5",
    });
    expect(status).toBe(0);
    expect(calls).toEqual(
      expect.arrayContaining([
        "APT install -y --only-upgrade nodejs",
        "REPO nodesource",
        "APT install -y nodejs",
        "LOG Node.js v22.22.5 installed",
      ]),
    );
  });

  it("installs Node.js 22 from NodeSource when no node is present", () => {
    const { status, calls } = runNodeStep({ installTo: "v22.22.3" });
    expect(status).toBe(0);
    expect(calls).not.toContain("APT install -y --only-upgrade nodejs");
    expect(calls).toContain("REPO nodesource");
    expect(calls).toContain("LOG Node.js v22.22.3 installed");
  });

  it("installs from NodeSource for an older major without trying an in-place upgrade", () => {
    const { status, calls } = runNodeStep({ initial: "v20.19.5", installTo: "v22.22.4" });
    expect(status).toBe(0);
    expect(calls).not.toContain("APT install -y --only-upgrade nodejs");
    expect(calls).toContain("APT install -y nodejs");
  });

  it("refuses a newer major instead of downgrading it", () => {
    const { status, calls } = runNodeStep({ initial: "v24.15.0" });
    expect(status).toBe(1);
    expect(calls.some((line) => line.startsWith("APT"))).toBe(false);
    expect(calls.at(-1)).toMatch(
      /^DIE Node\.js v24\.15\.0 \(.*\/node\) is not supported; Sovereign requires Node\.js >=22\.22\.3 <23/,
    );
  });

  it("fails with the offending node when the PATH node stays below the floor", () => {
    const { status, calls } = runNodeStep({ initial: "v22.1.0" });
    expect(status).toBe(1);
    expect(calls.at(-1)).toMatch(
      /^DIE Node\.js >=22\.22\.3 <23 is required, but the node on PATH \(.*\/node\) reports 22\.1\.0 after the install/,
    );
  });

  it("treats an unparsable node version like a missing node", () => {
    const { status, calls } = runNodeStep({ initial: "garbage", installTo: "v22.22.3" });
    expect(status).toBe(0);
    expect(calls).not.toContain("APT install -y --only-upgrade nodejs");
    expect(calls).toContain("LOG Node.js v22.22.3 installed");
  });
});
