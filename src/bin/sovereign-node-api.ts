#!/usr/bin/env node

import { createApp } from "../app/create-app.js";
import { buildApiServer } from "../api/server.js";

const main = async (): Promise<void> => {
  const app = createApp();
  const server = buildApiServer(app);
  const host = process.env.SOVEREIGN_NODE_API_HOST ?? "127.0.0.1";
  const port = Number(process.env.SOVEREIGN_NODE_API_PORT ?? "8787");

  await server.listen({ host, port });
  app.logger.info({ host, port }, "sovereign-node-api scaffold listening");
};

main().catch((error) => {
  process.stderr.write(
    `sovereign-node-api bootstrap failure: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});

