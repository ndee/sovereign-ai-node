import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_MATRIX_DOCKER_HELPER_PATH,
  bundledMatrixComposeInvocation,
  bundledMatrixDockerInvocation,
  RECLAIM_OWNERSHIP_HELPER_PATH,
  reclaimOwnershipInvocation,
  resolveDockerAccess,
  SYSTEMD_UNIT_HELPER_PATH,
  systemdUnitInstallInvocation,
} from "./privileged-helpers.js";

type MutableProcess = { getuid: (() => number) | undefined };

describe("resolveDockerAccess", () => {
  const mutableProcess = process as unknown as MutableProcess;
  const originalGetuid = mutableProcess.getuid;
  afterEach(() => {
    mutableProcess.getuid = originalGetuid;
  });

  it("runs docker directly as root", () => {
    expect(resolveDockerAccess({ getuid: () => 0, helperInstalled: () => true })).toBe("direct");
  });

  it("uses the helper when unprivileged and the helper is installed", () => {
    expect(resolveDockerAccess({ getuid: () => 1000, helperInstalled: () => true })).toBe("helper");
  });

  it("runs docker directly when unprivileged without the helper", () => {
    expect(resolveDockerAccess({ getuid: () => 1000, helperInstalled: () => false })).toBe(
      "direct",
    );
  });

  it("probes the real process and helper path by default", () => {
    mutableProcess.getuid = () => 1000;
    // The helper is never installed on a test runner.
    expect(resolveDockerAccess()).toBe("direct");
  });

  it("treats a platform without getuid as privileged", () => {
    mutableProcess.getuid = undefined;
    expect(resolveDockerAccess({ helperInstalled: () => true })).toBe("direct");
  });
});

describe("helper invocations", () => {
  it("routes compose commands through the helper or runs docker compose directly", () => {
    const input = {
      projectDir: "/var/lib/sovereign-node/bundled-matrix/matrix-example-org",
      composeFilePath: "/var/lib/sovereign-node/bundled-matrix/matrix-example-org/compose.yaml",
      args: ["ps", "-a"],
    };
    expect(bundledMatrixComposeInvocation({ ...input, access: "helper" })).toEqual({
      command: "sudo",
      args: ["-n", BUNDLED_MATRIX_DOCKER_HELPER_PATH, input.projectDir, "compose", "ps", "-a"],
    });
    expect(bundledMatrixComposeInvocation({ ...input, access: "direct" })).toEqual({
      command: "docker",
      args: [
        "compose",
        "-f",
        input.composeFilePath,
        "--project-directory",
        input.projectDir,
        "ps",
        "-a",
      ],
    });
  });

  it("routes raw docker queries through the helper or runs docker directly", () => {
    const args = ["inspect", "--format", "{{.State.Error}}", "proj-synapse-1"];
    expect(bundledMatrixDockerInvocation({ access: "helper", projectDir: "/p", args })).toEqual({
      command: "sudo",
      args: ["-n", BUNDLED_MATRIX_DOCKER_HELPER_PATH, "/p", ...args],
    });
    expect(bundledMatrixDockerInvocation({ access: "direct", projectDir: "/p", args })).toEqual({
      command: "docker",
      args,
    });
  });

  it("builds the ownership and unit helper invocations", () => {
    expect(reclaimOwnershipInvocation("/etc/sovereign-node/secrets")).toEqual({
      command: "sudo",
      args: ["-n", RECLAIM_OWNERSHIP_HELPER_PATH, "/etc/sovereign-node/secrets"],
    });
    expect(systemdUnitInstallInvocation("sovereign-openclaw-gateway.service")).toEqual({
      command: "sudo",
      args: ["-n", SYSTEMD_UNIT_HELPER_PATH, "sovereign-openclaw-gateway.service"],
    });
  });
});
