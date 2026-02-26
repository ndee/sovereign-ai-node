import { lookup } from "node:dns/promises";

import type { PreflightRequest } from "../contracts/api.js";
import type { CheckResult } from "../contracts/common.js";
import type { PreflightResult } from "../contracts/index.js";
import type { Logger } from "../logging/logger.js";
import type { ExecRunner, ExecResult } from "./exec.js";

const MIN_NODE_MAJOR = 22;
const MIN_DISK_FREE_BYTES = 10 * 1024 * 1024 * 1024;

type PreflightCheckStatus = CheckResult["status"];

export interface HostPreflightChecker {
  run(input?: PreflightRequest): Promise<PreflightResult>;
}

export class ShellHostPreflightChecker implements HostPreflightChecker {
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
  ) {}

  async run(input?: PreflightRequest): Promise<PreflightResult> {
    const checks = await Promise.all([
      this.checkPlatform(),
      this.checkNodeVersion(),
      this.checkPrivilegeAccess(),
      this.checkDiskSpace(),
      this.checkDockerCli(),
      this.checkDockerCompose(),
      this.checkPorts80And443(),
      this.checkDnsLookup("openclaw.ai", "openclaw-dns", "OpenClaw install domain DNS"),
      this.checkMatrixDomainDns(input),
      this.checkClockSync(),
    ]);

    return {
      mode: "bundled_matrix",
      overall: summarizeOverall(checks),
      checks,
      recommendedActions: buildRecommendedActions(checks),
    };
  }

  private async checkPlatform(): Promise<CheckResult> {
    if (process.platform === "linux") {
      return check("host-os", "Linux host detected", "pass", {
        platform: process.platform,
      });
    }

    return check(
      "host-os",
      "Non-Linux host detected; bundled_matrix install is intended for a Linux VM/server",
      "warn",
      { platform: process.platform },
    );
  }

  private async checkNodeVersion(): Promise<CheckResult> {
    const [majorText] = process.versions.node.split(".");
    const major = Number(majorText);
    if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
      return check("node-version", `Node ${process.versions.node} detected`, "pass", {
        nodeVersion: process.versions.node,
      });
    }

    return check(
      "node-version",
      `Node ${process.versions.node} is below the required major version ${MIN_NODE_MAJOR}`,
      "fail",
      {
        nodeVersion: process.versions.node,
        requiredMajor: MIN_NODE_MAJOR,
      },
    );
  }

  private async checkPrivilegeAccess(): Promise<CheckResult> {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return check("sudo-access", "Running as root", "pass");
    }

    const sudo = await this.safeExec("sudo", ["-n", "true"]);
    if (sudo.ok && sudo.result.exitCode === 0) {
      return check("sudo-access", "Passwordless sudo is available", "pass");
    }

    return check(
      "sudo-access",
      "Sudo/root access not confirmed (installer may require sudo on the target VM)",
      "warn",
      {
        stderr: sudo.ok ? summarizeText(sudo.result.stderr) : sudo.error,
      },
    );
  }

  private async checkDiskSpace(): Promise<CheckResult> {
    const df = await this.safeExec("df", ["-Pk", "/"]);
    if (!df.ok) {
      return check(
        "disk-space-root",
        "Could not inspect free disk space on /",
        "warn",
        { error: df.error },
      );
    }
    if (df.result.exitCode !== 0) {
      return check(
        "disk-space-root",
        "df returned a non-zero exit code while checking free disk space",
        "warn",
        {
          exitCode: df.result.exitCode,
          stderr: summarizeText(df.result.stderr),
        },
      );
    }

    const parsed = parseDfAvailableBytes(df.result.stdout);
    if (parsed === null) {
      return check(
        "disk-space-root",
        "Unable to parse free disk space from df output",
        "warn",
        {
          stdout: summarizeText(df.result.stdout),
        },
      );
    }

    const status: PreflightCheckStatus = parsed.availableBytes >= MIN_DISK_FREE_BYTES ? "pass" : "warn";
    const message =
      status === "pass"
        ? `Sufficient disk space detected on / (${formatGiB(parsed.availableBytes)} GiB free)`
        : `Low disk space on / (${formatGiB(parsed.availableBytes)} GiB free; recommended >= ${formatGiB(
            MIN_DISK_FREE_BYTES,
          )} GiB)`;

    return check("disk-space-root", message, status, {
      availableBytes: parsed.availableBytes,
      recommendedMinBytes: MIN_DISK_FREE_BYTES,
      mountPoint: parsed.mountPoint,
    });
  }

  private async checkDockerCli(): Promise<CheckResult> {
    const docker = await this.safeExec("docker", ["--version"]);
    if (!docker.ok) {
      return check(
        "docker-cli",
        "Docker CLI not detected (required for bundled_matrix profile)",
        "warn",
        { error: docker.error },
      );
    }
    if (docker.result.exitCode !== 0) {
      return check(
        "docker-cli",
        "Docker CLI is present but not working",
        "warn",
        {
          exitCode: docker.result.exitCode,
          stderr: summarizeText(docker.result.stderr),
        },
      );
    }
    return check("docker-cli", "Docker CLI detected", "pass", {
      versionOutput: summarizeText(docker.result.stdout),
    });
  }

  private async checkDockerCompose(): Promise<CheckResult> {
    const plugin = await this.safeExec("docker", ["compose", "version"]);
    if (plugin.ok && plugin.result.exitCode === 0) {
      return check("docker-compose", "Docker Compose plugin detected", "pass", {
        mode: "docker compose",
        versionOutput: summarizeText(plugin.result.stdout),
      });
    }

    const standalone = await this.safeExec("docker-compose", ["--version"]);
    if (standalone.ok && standalone.result.exitCode === 0) {
      return check("docker-compose", "docker-compose detected", "pass", {
        mode: "docker-compose",
        versionOutput: summarizeText(standalone.result.stdout),
      });
    }

    return check(
      "docker-compose",
      "Docker Compose not detected (bundled_matrix provisioning uses Docker Compose)",
      "warn",
      {
        dockerComposePluginError:
          plugin.ok ? summarizeText(plugin.result.stderr || plugin.result.stdout) : plugin.error,
        dockerComposeBinaryError:
          standalone.ok
            ? summarizeText(standalone.result.stderr || standalone.result.stdout)
            : standalone.error,
      },
    );
  }

  private async checkPorts80And443(): Promise<CheckResult> {
    const portScan = await this.listListeningTcpPorts();
    if (portScan.status === "unknown") {
      return check(
        "ports-80-443",
        "Could not inspect listening TCP ports 80/443",
        "warn",
        { error: portScan.message },
      );
    }

    const busy = [80, 443].filter((port) => portScan.ports.has(port));
    if (busy.length === 0) {
      return check("ports-80-443", "Ports 80 and 443 are not currently in use", "pass");
    }

    return check(
      "ports-80-443",
      `Port conflict detected on ${busy.join(", ")} (bundled Matrix reverse proxy typically needs 80/443)`,
      "warn",
      { busyPorts: busy },
    );
  }

  private async checkDnsLookup(
    hostname: string,
    id: string,
    label: string,
  ): Promise<CheckResult> {
    try {
      const resolved = await lookup(hostname);
      return check(id, `${label} resolved (${resolved.address})`, "pass", {
        hostname,
        address: resolved.address,
        family: resolved.family,
      });
    } catch (error) {
      return check(id, `${label} failed to resolve`, "warn", {
        hostname,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async checkMatrixDomainDns(input?: PreflightRequest): Promise<CheckResult> {
    const hostname = deriveMatrixHostname(input);
    if (hostname === null) {
      return check(
        "matrix-domain-dns",
        "Matrix homeserver domain not provided yet (will be checked during install)",
        "skip",
      );
    }

    return this.checkDnsLookup(hostname, "matrix-domain-dns", "Matrix homeserver domain DNS");
  }

  private async checkClockSync(): Promise<CheckResult> {
    if (process.platform !== "linux") {
      return check("clock-sync", "Clock sync check skipped on non-Linux host", "skip");
    }

    const timedatectl = await this.safeExec("timedatectl", [
      "show",
      "--property=NTPSynchronized",
      "--value",
    ]);

    if (!timedatectl.ok) {
      return check(
        "clock-sync",
        "Could not run timedatectl to verify NTP synchronization",
        "warn",
        { error: timedatectl.error },
      );
    }

    if (timedatectl.result.exitCode !== 0) {
      return check(
        "clock-sync",
        "timedatectl returned a non-zero exit code while checking NTP synchronization",
        "warn",
        {
          exitCode: timedatectl.result.exitCode,
          stderr: summarizeText(timedatectl.result.stderr),
        },
      );
    }

    const raw = timedatectl.result.stdout.trim().toLowerCase();
    if (raw === "yes") {
      return check("clock-sync", "System clock is synchronized (NTP)", "pass");
    }

    return check(
      "clock-sync",
      "System clock sync is not confirmed (NTP not synchronized)",
      "warn",
      { timedatectlValue: raw || "(empty)" },
    );
  }

  private async listListeningTcpPorts(): Promise<
    | { status: "ok"; ports: Set<number> }
    | { status: "unknown"; message: string }
  > {
    const ss = await this.safeExec("ss", ["-ltnH"]);
    if (ss.ok && ss.result.exitCode === 0) {
      return { status: "ok", ports: parseListeningPorts(ss.result.stdout) };
    }

    const netstat = await this.safeExec("netstat", ["-ltn"]);
    if (netstat.ok && netstat.result.exitCode === 0) {
      return { status: "ok", ports: parseListeningPorts(netstat.result.stdout) };
    }

    const details = [
      ss.ok
        ? `ss exit ${ss.result.exitCode}: ${summarizeText(ss.result.stderr || ss.result.stdout)}`
        : `ss error: ${ss.error}`,
      netstat.ok
        ? `netstat exit ${netstat.result.exitCode}: ${summarizeText(
            netstat.result.stderr || netstat.result.stdout,
          )}`
        : `netstat error: ${netstat.error}`,
    ].join(" | ");

    this.logger.debug({ details }, "Port preflight probe could not inspect listening sockets");
    return { status: "unknown", message: details };
  }

  private async safeExec(
    command: string,
    args: string[],
  ): Promise<{ ok: true; result: ExecResult } | { ok: false; error: string }> {
    try {
      const result = await this.execRunner.run({ command, args });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const check = (
  id: string,
  message: string,
  status: PreflightCheckStatus,
  details?: Record<string, unknown>,
): CheckResult => ({
  id,
  name: id,
  status,
  message,
  ...(details === undefined ? {} : { details }),
});

const summarizeOverall = (checks: CheckResult[]): PreflightResult["overall"] => {
  if (checks.some((candidate) => candidate.status === "fail")) {
    return "fail";
  }
  if (checks.some((candidate) => candidate.status === "warn")) {
    return "warn";
  }
  return "pass";
};

const buildRecommendedActions = (checks: CheckResult[]): string[] => {
  const actions: string[] = [];
  const add = (value: string) => {
    if (!actions.includes(value)) {
      actions.push(value);
    }
  };

  for (const item of checks) {
    if (item.status !== "warn" && item.status !== "fail") {
      continue;
    }

    switch (item.id) {
      case "host-os":
        add("Use a Linux VM (Ubuntu LTS recommended) for the bundled_matrix install path.");
        break;
      case "node-version":
        add("Install Node.js 22+ on the host before running sovereign-node.");
        break;
      case "sudo-access":
        add("Run the installer as root or with sudo privileges on the target VM.");
        break;
      case "disk-space-root":
        add("Ensure at least 10 GiB of free disk space on / for bundled services and logs.");
        break;
      case "docker-cli":
      case "docker-compose":
        add("Install Docker Engine and Docker Compose on the host for bundled Matrix provisioning.");
        break;
      case "ports-80-443":
        add("Free ports 80/443 or plan an alternate reverse-proxy setup before bundled Matrix install.");
        break;
      case "openclaw-dns":
        add("Confirm outbound DNS/network access to openclaw.ai from the host.");
        break;
      case "matrix-domain-dns":
        add("Point your Matrix domain/subdomain DNS to the VM before running the bundled install.");
        break;
      case "clock-sync":
        add("Enable NTP/time synchronization (timedatectl/systemd-timesyncd) on the host.");
        break;
      default:
        add(`Review preflight check '${item.id}' and fix the reported issue before installation.`);
        break;
    }
  }

  return actions;
};

const deriveMatrixHostname = (input?: PreflightRequest): string | null => {
  const direct = input?.matrix?.homeserverDomain?.trim();
  if (direct !== undefined && direct.length > 0) {
    return direct;
  }

  const baseUrl = input?.matrix?.publicBaseUrl;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return null;
  }

  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
};

const parseDfAvailableBytes = (
  stdout: string,
): { availableBytes: number; mountPoint: string } | null => {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return null;
  }

  const fields = lines[1]?.split(/\s+/) ?? [];
  if (fields.length < 6) {
    return null;
  }

  const availableKb = Number(fields[3]);
  const mountPoint = fields[5] ?? "/";
  if (!Number.isFinite(availableKb)) {
    return null;
  }

  return {
    availableBytes: Math.max(0, Math.trunc(availableKb * 1024)),
    mountPoint,
  };
};

const parseListeningPorts = (stdout: string): Set<number> => {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    for (const match of line.matchAll(/:(\d+)(?=\s|$)/g)) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        ports.add(port);
      }
    }
  }
  return ports;
};

const summarizeText = (value: string): string => {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 240 ? `${singleLine.slice(0, 240)}...(truncated)` : singleLine;
};

const formatGiB = (bytes: number): string => (bytes / (1024 ** 3)).toFixed(1);
