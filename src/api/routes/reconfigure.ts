import type { FastifyInstance } from "fastify";

import type { AppContainer } from "../../app/create-app.js";
import {
  reconfigureImapRequestSchema,
  reconfigureMatrixRequestSchema,
  reconfigureOpenrouterRequestSchema,
} from "../../contracts/api.js";
import { reconfigureResultSchema, settingsSummarySchema } from "../../contracts/index.js";
import { sendApiError, sendApiSuccess } from "../response.js";

export const registerReconfigureRoutes = (server: FastifyInstance, app: AppContainer): void => {
  // Non-secret snapshot of the installer-entered settings that a post-install
  // UI can edit. Secrets are reported as presence flags only.
  server.get("/api/reconfigure/settings", async (_request, reply) => {
    try {
      const result = await app.installerService.getSettings();
      reply.header("Cache-Control", "no-store");
      return sendApiSuccess(reply, result, settingsSummarySchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.post("/api/reconfigure/imap", async (request, reply) => {
    try {
      const body = reconfigureImapRequestSchema.parse(request.body);
      const result = await app.installerService.reconfigureImap(body);
      return sendApiSuccess(reply, result, reconfigureResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.post("/api/reconfigure/matrix", async (request, reply) => {
    try {
      const body = reconfigureMatrixRequestSchema.parse(request.body);
      const result = await app.installerService.reconfigureMatrix(body);
      return sendApiSuccess(reply, result, reconfigureResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.post("/api/reconfigure/openrouter", async (request, reply) => {
    try {
      const body = reconfigureOpenrouterRequestSchema.parse(request.body);
      const result = await app.installerService.reconfigureOpenrouter(body);
      return sendApiSuccess(reply, result, reconfigureResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });
};
