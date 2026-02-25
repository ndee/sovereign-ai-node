import Fastify, { type FastifyInstance } from "fastify";

import type { AppContainer } from "../app/create-app.js";
import { registerInstallRoutes } from "./routes/install.js";
import { registerReconfigureRoutes } from "./routes/reconfigure.js";
import { registerStatusRoutes } from "./routes/status.js";

export const buildApiServer = (app: AppContainer): FastifyInstance => {
  const server = Fastify({
    logger: false,
  });

  registerInstallRoutes(server, app);
  registerStatusRoutes(server, app);
  registerReconfigureRoutes(server, app);

  server.get("/healthz", async () => ({ ok: true }));

  return server;
};

