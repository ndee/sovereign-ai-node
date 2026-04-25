import Fastify, { type FastifyInstance } from "fastify";

import type { AppContainer } from "../app/create-app.js";
import { registerInstallRoutes } from "./routes/install.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerReconfigureRoutes } from "./routes/reconfigure.js";
import { registerSetupUiRoutes } from "./routes/setup-ui.js";
import { registerStatusRoutes } from "./routes/status.js";

export const buildApiServer = async (app: AppContainer): Promise<FastifyInstance> => {
  const server = Fastify({
    logger: false,
  });

  registerInstallRoutes(server, app);
  registerStatusRoutes(server, app);
  registerReconfigureRoutes(server, app);
  registerOnboardingRoutes(server, app);
  await registerSetupUiRoutes(server);

  server.get("/healthz", async () => ({ ok: true }));

  return server;
};
