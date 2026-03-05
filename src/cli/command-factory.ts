import { Command } from "commander";

import type { AppContainer } from "../app/create-app.js";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerReconfigureCommand } from "./commands/reconfigure.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTestAlertCommand } from "./commands/test-alert.js";

export const createCliProgram = (app: AppContainer): Command => {
  const program = new Command();

  program
    .name("sovereign-node")
    .description("Sovereign Node operator CLI (TypeScript scaffold)")
    .version("0.1.0")
    .option("--config <path>", "Path to sovereign-node config")
    .option("--verbose", "Enable verbose output");

  registerInstallCommand(program, app);
  registerStatusCommand(program, app);
  registerAgentsCommand(program, app);
  registerDoctorCommand(program, app);
  registerLogsCommand(program);
  registerTestAlertCommand(program, app);
  registerReconfigureCommand(program, app);

  return program;
};
