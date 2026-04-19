import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

const templateSchema = z.object({
  kind: z.enum(["agent", "tool"]),
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  trusted: z.boolean(),
  installed: z.boolean(),
  pinned: z.boolean(),
  keyId: z.string().min(1),
  manifestSha256: z.string().min(1),
});

const listTemplatesResultSchema = z.object({
  templates: z.array(templateSchema),
});

const installTemplateResultSchema = z.object({
  template: templateSchema,
  changed: z.boolean(),
});

export const registerTemplatesCommand = (program: Command, app: AppContainer): void => {
  const templates = program
    .command("templates")
    .description("Manage signed Sovereign agent/tool templates");

  templates
    .command("list")
    .description("List trusted templates and install status")
    .option("--json", "Emit JSON output")
    .action(async (opts: { json?: boolean }) => {
      const command = "templates list";
      try {
        const result = await app.installerService.listSovereignTemplates();
        writeCliSuccess(command, result, listTemplatesResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });

  templates
    .command("install")
    .description("Install a pinned signed template from the trusted catalog")
    .argument("<ref>", "Template ref (<id>@<version>)")
    .option("--json", "Emit JSON output")
    .action(async (ref: string, opts: { json?: boolean }) => {
      const command = "templates install";
      try {
        const result = await app.installerService.installSovereignTemplate({ ref });
        writeCliSuccess(command, result, installTemplateResultSchema, Boolean(opts.json));
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
