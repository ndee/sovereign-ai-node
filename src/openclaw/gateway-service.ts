import type { Logger } from "../logging/logger.js";
import type { ExecRunner } from "../system/exec.js";

export type GatewayInstallOptions = {
  force?: boolean;
};

export interface OpenClawGatewayServiceManager {
  install(options?: GatewayInstallOptions): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
}

export class ShellOpenClawGatewayServiceManager
  implements OpenClawGatewayServiceManager
{
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
  ) {}

  async install(options?: GatewayInstallOptions): Promise<void> {
    const args = ["gateway", "install"];
    if (options?.force) {
      args.push("--force");
    }
    this.logger.info({ args }, "OpenClaw gateway service install scaffold invoked");
    // TODO: Execute `openclaw gateway install` after Sovereign writes config.
    await this.execRunner.run({ command: "openclaw", args });
  }

  async start(): Promise<void> {
    this.logger.info("OpenClaw gateway service start scaffold invoked");
    await this.execRunner.run({ command: "openclaw", args: ["gateway", "start"] });
  }

  async restart(): Promise<void> {
    this.logger.info("OpenClaw gateway service restart scaffold invoked");
    await this.execRunner.run({ command: "openclaw", args: ["gateway", "restart"] });
  }
}

