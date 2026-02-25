import type { Logger } from "../logging/logger.js";
import type { ExecRunner } from "../system/exec.js";

export type OpenClawInstallOptions = {
  version: string;
  noPrompt?: boolean;
  noOnboard?: boolean;
  forceReinstall?: boolean;
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
    const result = await this.execRunner.run({
      command: "openclaw",
      args: ["--version"],
    });
    if (result.exitCode !== 0) {
      return null;
    }
    return {
      binaryPath: "openclaw",
      version: result.stdout.trim() || "unknown",
    };
  }

  async ensureInstalled(opts: OpenClawInstallOptions): Promise<OpenClawInstallInfo> {
    this.logger.info(
      {
        openclawVersion: opts.version,
        noPrompt: opts.noPrompt ?? true,
        noOnboard: opts.noOnboard ?? true,
      },
      "OpenClaw bootstrap scaffold invoked (implementation pending)",
    );

    // TODO: Execute official OpenClaw install.sh with pinned version and --no-onboard.
    return {
      binaryPath: "openclaw",
      version: opts.version,
      installMethod: "install_sh",
    };
  }
}

