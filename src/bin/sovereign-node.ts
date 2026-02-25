#!/usr/bin/env node

import { createApp } from "../app/create-app.js";
import { createCliProgram } from "../cli/command-factory.js";

const main = async (): Promise<void> => {
  const app = createApp();
  const program = createCliProgram(app);
  await program.parseAsync(process.argv);
};

main().catch((error) => {
  process.stderr.write(
    `sovereign-node bootstrap failure: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});

