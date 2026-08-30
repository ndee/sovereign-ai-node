import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import type { PreflightRequest } from "../contracts/api.js";
import type { PreflightResult } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import { formatGiB, parseDfAvailableBytes, ShellHostPreflightChecker } from "./preflight.js";

const okResult = (stdout = "", stderr = ""): ExecResult => ({
  command: "stub",
  exitCode: 0,
  stdout,
  stderr,
});

const exitResult = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({
  command: "stub",
  exitCode,
  stdout,
  stderr,
});

type Responder = (input: ExecInput) => Promise<ExecResult>;

class ScriptedExecRunner implements ExecRunner {
  public calls: ExecInput[] = [];

  constructor(private readonly responder: Responder) {}

  async run(input: ExecInput): Promise<ExecResult> {
    this.calls.push(input);
    return this.responder(input);
  }
}

const GiB = 1024 * 1024 * 1024;

// A "happy path" responder: every external probe succeeds and reports healthy
// state. Individual tests override single commands to exercise warn/fail paths.
const healthyResponder =
  (overrides: Record<string, ExecResult> = {}): Responder =>
  async (input) => {
    const key = `${input.command} ${(input.args ?? []).join(" ")}`.trim();
    for (const [prefix, result] of Object.entries(overrides)) {
      if (key === prefix || key.startsWith(`${prefix} `)) {
        return result;
      }
    }
    switch (input.command) {
      case "sudo":
        return okResult();
      case "df":
        // 20 GiB available (column index 3 in -Pk output is in KiB).
        return okResult(
          [
            "Filesystem 1024-blocks Used Available Capacity Mounted on",
            `/dev/sda1 100 50 ${20 * 1024 * 1024} 33% /`,
          ].join("\n"),
        );
      case "docker":
        return okResult("Docker version 27");
      case "docker-compose":
        return okResult("docker-compose 1.29");
      case "ss":
        return okResult("LISTEN 0 128 0.0.0.0:22 0.0.0.0:*");
      case "netstat":
        return okResult("tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN");
      case "timedatectl":
        return okResult("yes");
      default:
        throw new Error(`unexpected command: ${key}`);
    }
  };

const findCheck = (result: PreflightResult, id: string) => result.checks.find((c) => c.id === id);

const matrixReq = (matrix: NonNullable<PreflightRequest["matrix"]>): PreflightRequest => ({
  matrix,
});

const originalPlatform = process.platform;

const setPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
};

const originalGetuid = process.getuid;

// process.getuid is optionally typed (absent on Windows), so vi.spyOn infers
// `never`. Assign it directly and restore afterwards.
const setGetuid = (uid: number | undefined) => {
  if (uid === undefined) {
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    return;
  }
  Object.defineProperty(process, "getuid", { value: () => uid, configurable: true });
};

describe("preflight pure helpers", () => {
  it("parseDfAvailableBytes parses a standard df -Pk body row", () => {
    const parsed = parseDfAvailableBytes(
      [
        "Filesystem 1024-blocks Used Available Capacity Mounted on",
        "/dev/sda1 100 50 50 50% /data",
      ].join("\n"),
    );
    expect(parsed).toEqual({ availableBytes: 50 * 1024, mountPoint: "/data" });
  });

  it("parseDfAvailableBytes returns null when there is no body row", () => {
    expect(
      parseDfAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on"),
    ).toBeNull();
    expect(parseDfAvailableBytes("")).toBeNull();
  });

  it("parseDfAvailableBytes returns null when the body row has too few fields", () => {
    expect(parseDfAvailableBytes("header line here\n/dev/sda1 100 50")).toBeNull();
  });

  it("parseDfAvailableBytes returns null when the available column is not numeric", () => {
    expect(parseDfAvailableBytes("header line here\n/dev/sda1 100 50 notanumber 50% /")).toBeNull();
  });

  it("parseDfAvailableBytes clamps a negative available column to zero", () => {
    const parsed = parseDfAvailableBytes("header line here\n/dev/sda1 100 50 -5 50% /");
    expect(parsed).toEqual({ availableBytes: 0, mountPoint: "/" });
  });

  it("formatGiB renders bytes as a one-decimal GiB string", () => {
    expect(formatGiB(10 * GiB)).toBe("10.0");
    expect(formatGiB(0)).toBe("0.0");
  });
});

describe("ShellHostPreflightChecker.run", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue({ address: "203.0.113.10", family: 4 });
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    Object.defineProperty(process, "getuid", { value: originalGetuid, configurable: true });
  });

  it("returns an all-pass result on a healthy Linux host", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();

    expect(result.mode).toBe("bundled_matrix");
    expect(result.overall).toBe("pass");
    expect(result.recommendedActions).toEqual([]);
    expect(findCheck(result, "host-os")?.status).toBe("pass");
    expect(findCheck(result, "node-version")?.status).toBe("pass");
    expect(findCheck(result, "disk-space-root")?.status).toBe("pass");
    expect(findCheck(result, "docker-cli")?.status).toBe("pass");
    expect(findCheck(result, "docker-compose")?.status).toBe("pass");
    expect(findCheck(result, "ports-80-443")?.status).toBe("pass");
    expect(findCheck(result, "clock-sync")?.status).toBe("pass");
    // No matrix domain supplied -> skip.
    expect(findCheck(result, "matrix-domain-dns")?.status).toBe("skip");
  });

  it("warns on a non-Linux host and skips the clock-sync probe", async () => {
    setPlatform("darwin");
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();

    expect(findCheck(result, "host-os")?.status).toBe("warn");
    expect(findCheck(result, "clock-sync")?.status).toBe("skip");
    expect(result.overall).toBe("warn");
    expect(result.recommendedActions).toContain(
      "Use a Linux VM (Ubuntu LTS recommended) for the bundled_matrix install path.",
    );
  });

  it("passes the sudo check when running as root without invoking sudo", async () => {
    setGetuid(0);
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();

    expect(findCheck(result, "sudo-access")?.status).toBe("pass");
    expect(runner.calls.some((c) => c.command === "sudo")).toBe(false);
  });

  it("warns about sudo when passwordless sudo fails", async () => {
    setGetuid(1000);
    const runner = new ScriptedExecRunner(
      healthyResponder({ sudo: exitResult(1, "", "a password is required") }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();

    expect(findCheck(result, "sudo-access")?.status).toBe("warn");
    expect(result.recommendedActions).toContain(
      "Run the installer as root or with sudo privileges on the target VM.",
    );
  });

  it("falls back to the sudo probe when getuid is unavailable on the host", async () => {
    setGetuid(undefined);
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();

    // No getuid -> the checker must shell out to `sudo -n true` and trust it.
    expect(findCheck(result, "sudo-access")?.status).toBe("pass");
    expect(runner.calls.some((c) => c.command === "sudo")).toBe(true);
  });

  it("warns about sudo when the sudo probe throws", async () => {
    setGetuid(1000);
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "sudo") throw new Error("sudo: command not found");
      return healthyResponder()(input);
    });
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();

    const sudoCheck = findCheck(result, "sudo-access");
    expect(sudoCheck?.status).toBe("warn");
    expect(sudoCheck?.details?.stderr).toBe("sudo: command not found");
  });

  it("warns on low disk space below the recommended minimum", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({
        df: okResult("header line here\n/dev/sda1 100 50 1048576 99% /"),
      }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();

    const disk = findCheck(result, "disk-space-root");
    expect(disk?.status).toBe("warn");
    expect(disk?.message).toContain("Low disk space");
  });

  it("warns when df cannot be executed", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "df") throw new Error("df missing");
      return healthyResponder()(input);
    });
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const disk = findCheck(result, "disk-space-root");
    expect(disk?.status).toBe("warn");
    expect(disk?.message).toContain("Could not inspect free disk space");
  });

  it("warns when df exits non-zero", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ df: exitResult(1, "", "df: permission denied") }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const disk = findCheck(result, "disk-space-root");
    expect(disk?.status).toBe("warn");
    expect(disk?.message).toContain("non-zero exit code");
  });

  it("warns when df output cannot be parsed", async () => {
    const runner = new ScriptedExecRunner(healthyResponder({ df: okResult("garbage only") }));
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const disk = findCheck(result, "disk-space-root");
    expect(disk?.status).toBe("warn");
    expect(disk?.message).toContain("Unable to parse");
  });

  it("warns when the docker CLI is missing", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "docker") throw new Error("docker not found");
      return healthyResponder()(input);
    });
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    expect(findCheck(result, "docker-cli")?.status).toBe("warn");
    expect(result.recommendedActions.some((a) => a.includes("Docker is missing"))).toBe(true);
  });

  it("warns when the docker CLI is present but errors", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ "docker --version": exitResult(1, "", "cannot connect to daemon") }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    expect(findCheck(result, "docker-cli")?.status).toBe("warn");
  });

  it("detects the docker compose plugin", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ "docker compose version": okResult("Docker Compose version v2.29") }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const compose = findCheck(result, "docker-compose");
    expect(compose?.status).toBe("pass");
    expect(compose?.details?.mode).toBe("docker compose");
  });

  it("falls back to the standalone docker-compose binary", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({
        "docker compose version": exitResult(127, "", "no such subcommand"),
        "docker-compose --version": okResult("docker-compose version 1.29"),
      }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const compose = findCheck(result, "docker-compose");
    expect(compose?.status).toBe("pass");
    expect(compose?.details?.mode).toBe("docker-compose");
  });

  it("warns when neither compose flavour is available (probes throw)", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "docker" && input.args?.[0] === "compose")
        throw new Error("plugin missing");
      if (input.command === "docker-compose") throw new Error("binary missing");
      return healthyResponder()(input);
    });
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const compose = findCheck(result, "docker-compose");
    expect(compose?.status).toBe("warn");
    expect(compose?.details?.dockerComposePluginError).toBe("plugin missing");
    expect(compose?.details?.dockerComposeBinaryError).toBe("binary missing");
  });

  it("warns when neither compose flavour is available (probes exit non-zero)", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({
        "docker compose version": exitResult(1, "plugin stdout", "plugin err"),
        "docker-compose --version": exitResult(1, "binary stdout", "binary err"),
      }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    expect(findCheck(result, "docker-compose")?.status).toBe("warn");
  });

  it("flags a port conflict on 80/443 detected via ss", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({
        ss: okResult("LISTEN 0 128 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 128 [::]:443 [::]:*"),
      }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const ports = findCheck(result, "ports-80-443");
    expect(ports?.status).toBe("warn");
    expect(ports?.details?.busyPorts).toEqual([80, 443]);
  });

  it("falls back to netstat when ss is unavailable", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "ss") throw new Error("ss missing");
      if (input.command === "netstat") return okResult("tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN");
      return healthyResponder()(input);
    });
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const ports = findCheck(result, "ports-80-443");
    expect(ports?.status).toBe("warn");
    expect(ports?.details?.busyPorts).toEqual([80]);
  });

  it("reports unknown port state when both probes fail", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "ss") return exitResult(1, "", "ss denied");
      if (input.command === "netstat") throw new Error("netstat missing");
      return healthyResponder()(input);
    });
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const ports = findCheck(result, "ports-80-443");
    expect(ports?.status).toBe("warn");
    expect(ports?.message).toContain("Could not inspect listening TCP ports");
  });

  it("warns when the OpenClaw DNS lookup fails", async () => {
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const dns = findCheck(result, "openclaw-dns");
    expect(dns?.status).toBe("warn");
    expect(dns?.details?.error).toBe("ENOTFOUND");
  });

  it("handles a non-Error thrown from the DNS lookup", async () => {
    lookupMock.mockRejectedValueOnce("string failure");
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    expect(findCheck(result, "openclaw-dns")?.details?.error).toBe("string failure");
  });

  it("resolves the matrix domain DNS from an explicit homeserver domain", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run(
      matrixReq({ homeserverDomain: "matrix.example.com", publicBaseUrl: "https://ignored.test" }),
    );
    const matrixDns = findCheck(result, "matrix-domain-dns");
    expect(matrixDns?.status).toBe("pass");
    // The explicit domain wins over the publicBaseUrl host.
    expect(lookupMock).toHaveBeenCalledWith("matrix.example.com");
  });

  it("derives the matrix domain from publicBaseUrl when no domain is set", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run(
      matrixReq({ homeserverDomain: "   ", publicBaseUrl: "https://chat.example.org:8448" }),
    );
    expect(findCheck(result, "matrix-domain-dns")?.status).toBe("pass");
    expect(lookupMock).toHaveBeenCalledWith("chat.example.org");
  });

  it("skips the matrix domain DNS check when publicBaseUrl is not a valid URL", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run(
      matrixReq({ homeserverDomain: "   ", publicBaseUrl: "not a url" }),
    );
    expect(findCheck(result, "matrix-domain-dns")?.status).toBe("skip");
  });

  it("warns when timedatectl cannot be executed", async () => {
    const runner = new ScriptedExecRunner(async (input) => {
      if (input.command === "timedatectl") throw new Error("timedatectl missing");
      return healthyResponder()(input);
    });
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const clock = findCheck(result, "clock-sync");
    expect(clock?.status).toBe("warn");
    expect(clock?.details?.error).toBe("timedatectl missing");
  });

  it("warns when timedatectl exits non-zero", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ timedatectl: exitResult(1, "", "no NTP service") }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    expect(findCheck(result, "clock-sync")?.status).toBe("warn");
  });

  it("warns when NTP synchronization is reported as not confirmed", async () => {
    const runner = new ScriptedExecRunner(healthyResponder({ timedatectl: okResult("no") }));
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const clock = findCheck(result, "clock-sync");
    expect(clock?.status).toBe("warn");
    expect(clock?.details?.timedatectlValue).toBe("no");
  });

  it("reports an empty timedatectl value as '(empty)'", async () => {
    const runner = new ScriptedExecRunner(healthyResponder({ timedatectl: okResult("   ") }));
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    expect(findCheck(result, "clock-sync")?.details?.timedatectlValue).toBe("(empty)");
  });

  it("fails overall and recommends a Node upgrade when the runtime is too old", async () => {
    const versionsSpy = vi
      .spyOn(process, "versions", "get")
      .mockReturnValue({ ...process.versions, node: "18.19.0" });
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    expect(findCheck(result, "node-version")?.status).toBe("fail");
    expect(result.overall).toBe("fail");
    expect(result.recommendedActions).toContain(
      "Install Node.js 22+ on the host before running sovereign-node.",
    );
    versionsSpy.mockRestore();
  });

  it("truncates very long command output in summaries", async () => {
    const longOutput = "x".repeat(500);
    const runner = new ScriptedExecRunner(
      healthyResponder({ "docker --version": okResult(longOutput) }),
    );
    const checker = new ShellHostPreflightChecker(runner, createLogger());

    const result = await checker.run();
    const docker = findCheck(result, "docker-cli");
    expect(String(docker?.details?.versionOutput)).toContain("...(truncated)");
  });
});
