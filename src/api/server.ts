import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import type { AppContainer } from "../app/create-app.js";
import { createAuthPreHandler } from "./auth/middleware.js";
import { createIpLimiter } from "./auth/rate-limit.js";
import { createSessionStore } from "./auth/sessions.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerInstallRoutes } from "./routes/install.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerReconfigureRoutes } from "./routes/reconfigure.js";
import { registerSetupUiRoutes } from "./routes/setup-ui.js";
import { registerStatusRoutes } from "./routes/status.js";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

export const buildApiServer = async (app: AppContainer): Promise<FastifyInstance> => {
  const server = Fastify({
    logger: false,
  });

  await server.register(fastifyCookie);

  const sessions = createSessionStore({ ttlMs: SESSION_TTL_MS });
  const rateLimiter = createIpLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
  });

  server.addHook("preHandler", createAuthPreHandler({ sessions }));

  registerAuthRoutes(server, app, { sessions, rateLimiter });
  registerInstallRoutes(server, app);
  registerStatusRoutes(server, app);
  registerReconfigureRoutes(server, app);
  registerOnboardingRoutes(server, app);
  await registerSetupUiRoutes(server);

  server.get("/healthz", async () => ({ ok: true }));

  return server;
};
