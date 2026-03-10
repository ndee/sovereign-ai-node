import type { FastifyInstance } from "fastify";
import type { AppContainer } from "../../app/create-app.js";
import {
  installJobParamsSchema,
  preflightRequestSchema,
  testAlertRequestSchema,
  testImapRequestSchema,
  testMatrixRequestSchema,
} from "../../contracts/api.js";
import {
  installJobStatusResponseSchema,
  installRequestSchema,
  preflightResultSchema,
  startInstallResultSchema,
  testAlertResultSchema,
  testImapResultSchema,
  testMatrixResultSchema,
} from "../../contracts/index.js";
import { sendApiError, sendApiSuccess } from "../response.js";

export const registerInstallRoutes = (server: FastifyInstance, app: AppContainer): void => {
  server.post("/api/install/preflight", async (request, reply) => {
    try {
      const body =
        request.body === undefined ? undefined : preflightRequestSchema.parse(request.body);
      const result = await app.installerService.preflight(body);
      return sendApiSuccess(reply, result, preflightResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.post("/api/install/test-imap", async (request, reply) => {
    try {
      const body = testImapRequestSchema.parse(request.body);
      const result = await app.installerService.testImap(body);
      return sendApiSuccess(reply, result, testImapResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.post("/api/install/test-matrix", async (request, reply) => {
    try {
      const body = testMatrixRequestSchema.parse(request.body);
      const result = await app.installerService.testMatrix(body);
      return sendApiSuccess(reply, result, testMatrixResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.post("/api/install/run", async (request, reply) => {
    try {
      const body = installRequestSchema.parse(request.body);
      const result = await app.installerService.startInstall(body);
      return sendApiSuccess(reply, result, startInstallResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.get("/api/install/jobs/:jobId", async (request, reply) => {
    try {
      const params = installJobParamsSchema.parse(request.params);
      const result = await app.installerService.getInstallJob(params.jobId);
      return sendApiSuccess(reply, result, installJobStatusResponseSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.post("/api/install/test-alert", async (request, reply) => {
    try {
      const body = testAlertRequestSchema.parse(request.body);
      const result = await app.installerService.testAlert(body);
      return sendApiSuccess(reply, result, testAlertResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });
};
