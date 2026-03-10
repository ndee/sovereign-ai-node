import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const toolSchema = z.object({
  id: z.string().min(1),
  templateRef: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  config: z.record(z.string(), z.string()),
  secretRefs: z.record(z.string(), z.string()),
});

const listToolsResultSchema = z.object({
  tools: z.array(toolSchema),
});

const upsertToolResultSchema = z.object({
  tool: toolSchema,
  changed: z.boolean(),
});

const deleteToolResultSchema = z.object({
  id: z.string().min(1),
  deleted: z.boolean(),
});

type ToolOptions = {
  template?: string;
  config?: string[];
  secretRef?: string[];
  json?: boolean;
};

const parseKeyValueEntries = (
  values: string[] | undefined,
  field: "config" | "secretRef",
): Record<string, string> => {
  if (values === undefined || values.length === 0) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const raw of values) {
    const idx = raw.indexOf("=");
    if (idx <= 0 || idx === raw.length - 1) {
      throw new Error(`${field} entries must be in key=value form`);
    }
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new Error(`${field} entries must be in key=value form`);
    }
    parsed[key] = value;
  }
  return parsed;
};

export const registerToolsCommand = (program: Command, app: AppContainer): void => {
  const tools = program
    .command("tools")
    .description("Manage Sovereign tool instances used by agent templates");

  tools
    .command("list")
    .description("List tool instances")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "tools list";
      try {
        const result = await app.installerService.listSovereignToolInstances();
        writeCliSuccess(command, result, listToolsResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  tools
    .command("create")
    .description("Create a tool instance")
    .argument("<id>", "Tool instance ID")
    .requiredOption("--template <ref>", "Template ref (<id>@<version>)")
    .option("--config <key=value>", "Config binding (repeatable)", (value, prev: string[] = []) => [
      ...prev,
      value,
    ])
    .option(
      "--secret-ref <key=value>",
      "Secret ref binding (repeatable)",
      (value, prev: string[] = []) => [...prev, value],
    )
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: ToolOptions) => {
      const command = "tools create";
      try {
        const result = await app.installerService.createSovereignToolInstance({
          id,
          templateRef: opts.template!,
          config: parseKeyValueEntries(opts.config, "config"),
          secretRefs: parseKeyValueEntries(opts.secretRef, "secretRef"),
        });
        writeCliSuccess(command, result, upsertToolResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  tools
    .command("update")
    .description("Update a tool instance")
    .argument("<id>", "Tool instance ID")
    .option("--template <ref>", "Template ref (<id>@<version>)")
    .option("--config <key=value>", "Config binding (repeatable)", (value, prev: string[] = []) => [
      ...prev,
      value,
    ])
    .option(
      "--secret-ref <key=value>",
      "Secret ref binding (repeatable)",
      (value, prev: string[] = []) => [...prev, value],
    )
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: ToolOptions) => {
      const command = "tools update";
      try {
        const result = await app.installerService.updateSovereignToolInstance({
          id,
          ...(opts.template === undefined ? {} : { templateRef: opts.template }),
          ...(opts.config === undefined
            ? {}
            : { config: parseKeyValueEntries(opts.config, "config") }),
          ...(opts.secretRef === undefined
            ? {}
            : { secretRefs: parseKeyValueEntries(opts.secretRef, "secretRef") }),
        });
        writeCliSuccess(command, result, upsertToolResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  tools
    .command("delete")
    .description("Delete a tool instance")
    .argument("<id>", "Tool instance ID")
    .option("--json", "Emit JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const command = "tools delete";
      try {
        const result = await app.installerService.deleteSovereignToolInstance({ id });
        writeCliSuccess(command, result, deleteToolResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
