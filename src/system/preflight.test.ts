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
import type { ServiceNodeResolution } from "./service-node.js";

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
      case GATEWAY_NODE:
        return okResult("v22.23.4\n");
      default:
        throw new Error(`unexpected command: ${key}`);
    }
  };

const GATEWAY_NODE = "/usr/bin/node";
const gatewayNodeFound = async (): Promise<ServiceNodeResolution> => ({
  ok: true,
  path: GATEWAY_NODE,
});
const newChecker = (
  runner: ExecRunner,
  resolveGatewayNode: () => Promise<ServiceNodeResolution> = gatewayNodeFound,
) => new ShellHostPreflightChecker(runner, createLogger(), resolveGatewayNode);

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
  let versionsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue({ address: "203.0.113.10", family: 4 });
    setPlatform("linux");
    versionsSpy = vi
      .spyOn(process, "versions", "get")
      .mockReturnValue({ ...process.versions, node: "22.22.3" });
  });

  afterEach(() => {
    versionsSpy.mockRestore();
    setPlatform(originalPlatform);
    Object.defineProperty(process, "getuid", { value: originalGetuid, configurable: true });
  });

  it("returns an all-pass result on a healthy Linux host", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

    const result = await checker.run();

    expect(findCheck(result, "sudo-access")?.status).toBe("pass");
    expect(runner.calls.some((c) => c.command === "sudo")).toBe(false);
  });

  it("warns about sudo when passwordless sudo fails", async () => {
    setGetuid(1000);
    const runner = new ScriptedExecRunner(
      healthyResponder({ sudo: exitResult(1, "", "a password is required") }),
    );
    const checker = newChecker(runner);

    const result = await checker.run();

    expect(findCheck(result, "sudo-access")?.status).toBe("warn");
    expect(result.recommendedActions).toContain(
      "Run the installer as root or with sudo privileges on the target VM.",
    );
  });

  it("falls back to the sudo probe when getuid is unavailable on the host", async () => {
    setGetuid(undefined);
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

    const result = await checker.run();
    const disk = findCheck(result, "disk-space-root");
    expect(disk?.status).toBe("warn");
    expect(disk?.message).toContain("Could not inspect free disk space");
  });

  it("warns when df exits non-zero", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ df: exitResult(1, "", "df: permission denied") }),
    );
    const checker = newChecker(runner);

    const result = await checker.run();
    const disk = findCheck(result, "disk-space-root");
    expect(disk?.status).toBe("warn");
    expect(disk?.message).toContain("non-zero exit code");
  });

  it("warns when df output cannot be parsed", async () => {
    const runner = new ScriptedExecRunner(healthyResponder({ df: okResult("garbage only") }));
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

    const result = await checker.run();
    expect(findCheck(result, "docker-cli")?.status).toBe("warn");
    expect(result.recommendedActions.some((a) => a.includes("Docker is missing"))).toBe(true);
  });

  it("warns when the docker CLI is present but errors", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ "docker --version": exitResult(1, "", "cannot connect to daemon") }),
    );
    const checker = newChecker(runner);

    const result = await checker.run();
    expect(findCheck(result, "docker-cli")?.status).toBe("warn");
  });

  it("detects the docker compose plugin", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ "docker compose version": okResult("Docker Compose version v2.29") }),
    );
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

    const result = await checker.run();
    expect(findCheck(result, "docker-compose")?.status).toBe("warn");
  });

  it("flags a port conflict on 80/443 detected via ss", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({
        ss: okResult("LISTEN 0 128 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 128 [::]:443 [::]:*"),
      }),
    );
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

    const result = await checker.run();
    const ports = findCheck(result, "ports-80-443");
    expect(ports?.status).toBe("warn");
    expect(ports?.message).toContain("Could not inspect listening TCP ports");
  });

  it("warns when the OpenClaw DNS lookup fails", async () => {
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = newChecker(runner);

    const result = await checker.run();
    const dns = findCheck(result, "openclaw-dns");
    expect(dns?.status).toBe("warn");
    expect(dns?.details?.error).toBe("ENOTFOUND");
  });

  it("handles a non-Error thrown from the DNS lookup", async () => {
    lookupMock.mockRejectedValueOnce("string failure");
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = newChecker(runner);

    const result = await checker.run();
    expect(findCheck(result, "openclaw-dns")?.details?.error).toBe("string failure");
  });

  it("resolves the matrix domain DNS from an explicit homeserver domain", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

    const result = await checker.run(
      matrixReq({ homeserverDomain: "   ", publicBaseUrl: "https://chat.example.org:8448" }),
    );
    expect(findCheck(result, "matrix-domain-dns")?.status).toBe("pass");
    expect(lookupMock).toHaveBeenCalledWith("chat.example.org");
  });

  it("skips the matrix domain DNS check when publicBaseUrl is not a valid URL", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = newChecker(runner);

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
    const checker = newChecker(runner);

    const result = await checker.run();
    const clock = findCheck(result, "clock-sync");
    expect(clock?.status).toBe("warn");
    expect(clock?.details?.error).toBe("timedatectl missing");
  });

  it("warns when timedatectl exits non-zero", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ timedatectl: exitResult(1, "", "no NTP service") }),
    );
    const checker = newChecker(runner);

    const result = await checker.run();
    expect(findCheck(result, "clock-sync")?.status).toBe("warn");
  });

  it("warns when NTP synchronization is reported as not confirmed", async () => {
    const runner = new ScriptedExecRunner(healthyResponder({ timedatectl: okResult("no") }));
    const checker = newChecker(runner);

    const result = await checker.run();
    const clock = findCheck(result, "clock-sync");
    expect(clock?.status).toBe("warn");
    expect(clock?.details?.timedatectlValue).toBe("no");
  });

  it("reports an empty timedatectl value as '(empty)'", async () => {
    const runner = new ScriptedExecRunner(healthyResponder({ timedatectl: okResult("   ") }));
    const checker = newChecker(runner);

    const result = await checker.run();
    expect(findCheck(result, "clock-sync")?.details?.timedatectlValue).toBe("(empty)");
  });

  it.each([
    ["18.19.0"],
    ["22.22.2"],
    ["24.15.0"],
  ])("fails overall and recommends a Node upgrade when sovereign-node runs on %s", async (node) => {
    versionsSpy.mockReturnValue({ ...process.versions, node });
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = newChecker(runner);

    const result = await checker.run();
    expect(findCheck(result, "node-version")).toMatchObject({
      status: "fail",
      message: `Node ${node} running sovereign-node is outside the supported range >=22.22.3 <23`,
      details: { nodeVersion: node, requiredRange: ">=22.22.3 <23" },
    });
    expect(result.overall).toBe("fail");
    expect(result.recommendedActions).toEqual([
      `Node ${node} running sovereign-node is outside the supported range >=22.22.3 <23. Upgrade the host's Node.js to >=22.22.3 <23. This step cannot install packages; as root, rerun install.sh (it upgrades the NodeSource nodejs package) or run 'apt-get update && apt-get install --only-upgrade nodejs', then retry.`,
    ]);
  });

  it("checks the gateway's own system Node, which can differ from the running one", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());

    const result = await newChecker(runner).run();

    expect(findCheck(result, "gateway-node-version")).toMatchObject({
      status: "pass",
      message: "Gateway Node 22.23.4 at /usr/bin/node detected",
      details: { nodePath: GATEWAY_NODE, nodeVersion: "22.23.4" },
    });
    expect(runner.calls).toContainEqual({ command: GATEWAY_NODE, args: ["--version"] });
  });

  it("fails when the gateway's Node is below the floor even though this process is fine", async () => {
    const runner = new ScriptedExecRunner(
      healthyResponder({ [GATEWAY_NODE]: okResult("v22.22.2\n") }),
    );

    const result = await newChecker(runner).run();

    expect(findCheck(result, "node-version")?.status).toBe("pass");
    expect(findCheck(result, "gateway-node-version")).toMatchObject({
      status: "fail",
      message: "Gateway Node 22.22.2 at /usr/bin/node is outside the supported range >=22.22.3 <23",
      details: { requiredRange: ">=22.22.3 <23" },
    });
    expect(result.overall).toBe("fail");
    expect(result.recommendedActions).toHaveLength(1);
    expect(result.recommendedActions[0]).toMatch(
      /^Gateway Node 22\.22\.2 at \/usr\/bin\/node is outside .*cannot install packages/,
    );
  });

  it("warns when no system Node usable by the service user exists", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());
    const checker = newChecker(runner, async () => ({
      ok: false,
      searchPath: "/usr/bin:/bin",
      problems: ["/usr/bin/node is not executable by the service user"],
    }));

    const result = await checker.run();

    expect(findCheck(result, "gateway-node-version")).toMatchObject({
      status: "warn",
      message: "No system Node.js usable by the gateway service user was found on /usr/bin:/bin",
      details: { problems: ["/usr/bin/node is not executable by the service user"] },
    });
  });

  it("warns when the gateway's Node version cannot be read", async () => {
    const exits = new ScriptedExecRunner(
      healthyResponder({ [GATEWAY_NODE]: exitResult(1, "", "broken") }),
    );
    const throws = new ScriptedExecRunner(async (input) => {
      if (input.command === GATEWAY_NODE) {
        throw new Error("spawn EACCES");
      }
      return healthyResponder()(input);
    });

    const exited = findCheck(await newChecker(exits).run(), "gateway-node-version");
    const threw = findCheck(await newChecker(throws).run(), "gateway-node-version");

    expect(exited).toMatchObject({
      status: "warn",
      message: "Could not read the version of the gateway's Node.js at /usr/bin/node",
      details: { nodePath: GATEWAY_NODE, exitCode: 1, output: "" },
    });
    expect(threw).toMatchObject({ status: "warn", details: { error: "spawn EACCES" } });
  });

  it("resolves the gateway's Node from the system search path by default", async () => {
    const runner = new ScriptedExecRunner(async (input) =>
      input.command.endsWith("/node") ? okResult("v22.23.4") : healthyResponder()(input),
    );

    const result = await new ShellHostPreflightChecker(runner, createLogger()).run();

    expect(findCheck(result, "gateway-node-version")).toBeDefined();
  });

  it("checks DNS for the npm registry OpenClaw is installed from", async () => {
    const runner = new ScriptedExecRunner(healthyResponder());

    await newChecker(runner).run();

    expect(lookupMock).toHaveBeenCalledWith("registry.npmjs.org");
  });

  it("truncates very long command output in summaries", async () => {
    const longOutput = "x".repeat(500);
    const runner = new ScriptedExecRunner(
      healthyResponder({ "docker --version": okResult(longOutput) }),
    );
    const checker = newChecker(runner);

    const result = await checker.run();
    const docker = findCheck(result, "docker-cli");
    expect(String(docker?.details?.versionOutput)).toContain("...(truncated)");
  });
});
