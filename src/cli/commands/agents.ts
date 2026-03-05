import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const managedAgentSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  matrixUserId: z.string().min(1).optional(),
});

const listManagedAgentsResultSchema = z.object({
  agents: z.array(managedAgentSchema),
});

const upsertManagedAgentResultSchema = z.object({
  agent: managedAgentSchema,
  changed: z.boolean(),
  restartRequiredServices: z.array(z.string().min(1)),
});

const deleteManagedAgentResultSchema = z.object({
  id: z.string().min(1),
  deleted: z.boolean(),
  restartRequiredServices: z.array(z.string().min(1)),
});

type AgentOptions = {
  workspace?: string;
  json?: boolean;
};

export const registerAgentsCommand = (program: Command, app: AppContainer): void => {
  const agents = program
    .command("agents")
    .description("Manage Sovereign/OpenClaw agents");

  agents
    .command("list")
    .description("List managed agents")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "agents list";
      try {
        const result = await app.installerService.listManagedAgents();
        writeCliSuccess(command, result, listManagedAgentsResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  agents
    .command("create")
    .description("Create a managed agent")
    .argument("<id>", "Agent ID")
    .option("--workspace <dir>", "Workspace directory")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: AgentOptions) => {
      const command = "agents create";
      try {
        const result = await app.installerService.createManagedAgent({
          id,
          ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
        });
        writeCliSuccess(command, result, upsertManagedAgentResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  agents
    .command("update")
    .description("Update a managed agent")
    .argument("<id>", "Agent ID")
    .option("--workspace <dir>", "Workspace directory")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: AgentOptions) => {
      const command = "agents update";
      try {
        const result = await app.installerService.updateManagedAgent({
          id,
          ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
        });
        writeCliSuccess(command, result, upsertManagedAgentResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  agents
    .command("delete")
    .description("Delete a managed agent")
    .argument("<id>", "Agent ID")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const command = "agents delete";
      try {
        const result = await app.installerService.deleteManagedAgent({ id });
        writeCliSuccess(command, result, deleteManagedAgentResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
