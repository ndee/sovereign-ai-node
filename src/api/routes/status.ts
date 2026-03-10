import type { FastifyInstance } from "fastify";

import type { AppContainer } from "../../app/create-app.js";
import { sovereignStatusSchema } from "../../contracts/index.js";
import { sendApiError, sendApiSuccess } from "../response.js";

export const registerStatusRoutes = (server: FastifyInstance, app: AppContainer): void => {
  server.get("/api/status", async (_request, reply) => {
    try {
      const result = await app.installerService.getStatus();
      return sendApiSuccess(reply, result, sovereignStatusSchema);
    } catch (error) {
      return sendApiError(reply, 500, error);
    }
  });
};
