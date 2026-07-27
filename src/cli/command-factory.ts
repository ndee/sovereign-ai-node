import { Command } from "commander";

import type { AppContainer } from "../app/create-app.js";
import { getNodeBuildInfo } from "../build-info.js";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerBackupCommand } from "./commands/backup.js";
import { registerBotsCommand } from "./commands/bots.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerMailSentinelsCommand } from "./commands/mail-sentinels.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerOnboardingCommand } from "./commands/onboarding.js";
import { registerReconfigureCommand } from "./commands/reconfigure.js";
import { registerSetupUiCommand } from "./commands/setup-ui.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSupportBundleCommand } from "./commands/support-bundle.js";
import { registerTemplatesCommand } from "./commands/templates.js";
import { registerTestAlertCommand } from "./commands/test-alert.js";
import { registerToolsCommand } from "./commands/tools.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerUsersCommand } from "./commands/users.js";

export const createCliProgram = (app: AppContainer): Command => {
  const program = new Command();

  program
    .name("sovereign-node")
    .description("Sovereign Node operator CLI (TypeScript scaffold)")
    // Resolved from build identity, not hardcoded: this string was previously
    // pinned at "2.0.0" and had drifted three minor versions behind the actual
    // package, so `sovereign-node --version` confidently reported the wrong
    // answer to anyone diagnosing a node.
    .version(getNodeBuildInfo().version)
    .option("--config <path>", "Path to sovereign-node config")
    .option("--verbose", "Enable verbose output");

  registerInstallCommand(program, app);
  registerStatusCommand(program, app);
  registerOnboardingCommand(program, app);
  registerBackupCommand(program, app);
  registerBotsCommand(program, app);
  registerMailSentinelsCommand(program, app);
  registerMigrateCommand(program, app);
  registerAgentsCommand(program, app);
  registerUsersCommand(program, app);
  registerTemplatesCommand(program, app);
  registerToolsCommand(program, app);
  registerDoctorCommand(program, app);
  registerLogsCommand(program);
  registerTestAlertCommand(program, app);
  registerReconfigureCommand(program, app);
  registerSetupUiCommand(program, app);
  registerUpdateCommand(program, app);
  registerSupportBundleCommand(program, app);

  return program;
};
