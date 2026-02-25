import type { JobStepId } from "../contracts/install.js";

export type InstallContext = {
  installationId: string;
};

export interface InstallStep {
  id: JobStepId;
  run(ctx: InstallContext): Promise<void>;
}

export class JobRunner {
  async run(_ctx: InstallContext, _steps: InstallStep[]): Promise<void> {
    // TODO: Implement persisted step execution + retries + error mapping.
  }
}

