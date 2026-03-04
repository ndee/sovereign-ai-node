import type { Logger } from "../logging/logger.js";
import type { ExecRunner } from "../system/exec.js";

const OPENCLAW_DETECT_TIMEOUT_MS = 20_000;
const OPENCLAW_INSTALL_TIMEOUT_MS = 15 * 60_000;

export type OpenClawInstallOptions = {
  version: string;
  noPrompt?: boolean;
  noOnboard?: boolean;
  forceReinstall?: boolean;
  skipIfCompatibleInstalled?: boolean;
};

export type DetectedOpenClaw = {
  binaryPath: string;
  version: string;
};

export type OpenClawInstallInfo = {
  binaryPath: string;
  version: string;
  installMethod: "install_sh";
};

export interface OpenClawBootstrapper {
  detectInstalled(): Promise<DetectedOpenClaw | null>;
  ensureInstalled(opts: OpenClawInstallOptions): Promise<OpenClawInstallInfo>;
}

export class ShellOpenClawBootstrapper implements OpenClawBootstrapper {
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
  ) {}

  async detectInstalled(): Promise<DetectedOpenClaw | null> {
    let result;
    try {
      result = await this.execRunner.run({
        command: "openclaw",
        args: ["--version"],
        options: {
          timeout: OPENCLAW_DETECT_TIMEOUT_MS,
          env: {
            CI: "1",
          },
        },
      });
    } catch {
      return null;
    }
    if (result.exitCode !== 0) {
      return null;
    }
    const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
    const parsedVersion = parseVersionToken(versionOutput);
    if (parsedVersion === null) {
      return null;
    }
    return {
      binaryPath: "openclaw",
      version: parsedVersion,
    };
  }

  async ensureInstalled(opts: OpenClawInstallOptions): Promise<OpenClawInstallInfo> {
    const desiredVersion = opts.version.trim();
    const installVersion = resolveInstallVersion(desiredVersion);
    const detected = await this.detectInstalled();
    if (
      detected !== null
      && !Boolean(opts.forceReinstall)
      && (opts.skipIfCompatibleInstalled ?? true)
      && versionsMatch(detected.version, desiredVersion)
    ) {
      this.logger.info(
        {
          openclawVersion: detected.version,
          binaryPath: detected.binaryPath,
        },
        "OpenClaw already installed with compatible version; skipping reinstall",
      );
      return {
        binaryPath: detected.binaryPath,
        version: detected.version,
        installMethod: "install_sh",
      };
    }

    const shellScript = buildInstallShellScript({
      noPrompt: opts.noPrompt ?? true,
      noOnboard: opts.noOnboard ?? true,
      ...(installVersion === undefined ? {} : { version: installVersion }),
    });
    this.logger.info(
      {
        openclawVersion: installVersion ?? "default-channel",
        noPrompt: opts.noPrompt ?? true,
        noOnboard: opts.noOnboard ?? true,
        forceReinstall: opts.forceReinstall ?? false,
        skipIfCompatibleInstalled: opts.skipIfCompatibleInstalled ?? true,
      },
      "Installing OpenClaw via official install.sh",
    );

    const installResult = await this.execRunner.run({
      command: "bash",
      args: ["-lc", shellScript],
      options: {
        timeout: OPENCLAW_INSTALL_TIMEOUT_MS,
        env: {
          CI: "1",
        },
      },
    });
    if (installResult.exitCode !== 0) {
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw install.sh exited with a non-zero status",
        retryable: true,
        details: {
          command: installResult.command,
          exitCode: installResult.exitCode,
          stderr: truncateText(installResult.stderr, 4000),
          stdout: truncateText(installResult.stdout, 2000),
        },
      };
    }

    const installed = await this.detectInstalled();
    if (installed === null) {
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw installer completed but the openclaw CLI was not detected",
        retryable: true,
      };
    }

    if (!versionsMatch(installed.version, desiredVersion)) {
      this.logger.warn(
        {
          expectedVersion: desiredVersion,
          detectedVersion: installed.version,
        },
        "OpenClaw install completed but detected version does not match requested version",
      );
    }

    return {
      binaryPath: installed.binaryPath,
      version: installed.version,
      installMethod: "install_sh",
    };
  }
}

type InstallShellArgs = {
  version?: string;
  noPrompt: boolean;
  noOnboard: boolean;
};

const buildInstallShellScript = (args: InstallShellArgs): string => {
  const installArgs = ["-s", "--"];
  if (args.version !== undefined) {
    installArgs.push("--version", args.version);
  }
  if (args.noOnboard) {
    installArgs.push("--no-onboard");
  }
  if (args.noPrompt) {
    installArgs.push("--no-prompt");
  }

  return [
    "set -euo pipefail",
    "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh \\",
    `  | bash ${installArgs.map(shellQuote).join(" ")}`,
  ].join("\n");
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\"'\"'`)}'`;

const parseVersionToken = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const semverMatch = trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return semverMatch?.[0] ?? trimmed.split(/\s+/)[0] ?? null;
};

const versionsMatch = (detectedVersion: string, requestedVersion: string): boolean => {
  if (isAbstractSovereignPin(requestedVersion)) {
    return true;
  }
  const normalizedDetected = normalizeVersion(detectedVersion);
  const normalizedRequested = normalizeVersion(requestedVersion);
  return normalizedDetected === normalizedRequested;
};

const resolveInstallVersion = (requestedVersion: string): string | undefined => {
  const trimmed = requestedVersion.trim();
  if (trimmed.length === 0 || isAbstractSovereignPin(trimmed)) {
    return undefined;
  }
  return trimmed;
};

const isAbstractSovereignPin = (value: string): boolean =>
  value.trim().toLowerCase() === "pinned-by-sovereign";

const normalizeVersion = (value: string): string => parseVersionToken(value) ?? value.trim();

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};
