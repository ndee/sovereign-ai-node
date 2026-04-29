import type { FastifyInstance } from "fastify";

import type { AppContainer } from "../../app/create-app.js";
import { onboardingIssueRequestSchema } from "../../contracts/api.js";
import {
  matrixOnboardingIssueResultSchema,
  matrixOnboardingPublicStateSchema,
} from "../../contracts/install.js";
import { sendApiError, sendApiSuccess } from "../response.js";

export const registerOnboardingRoutes = (server: FastifyInstance, app: AppContainer): void => {
  server.post("/api/onboarding/issue", async (request, reply) => {
    try {
      const body =
        request.body === undefined || request.body === null
          ? undefined
          : onboardingIssueRequestSchema.parse(request.body);
      const issueRequest =
        body?.ttlMinutes === undefined ? undefined : { ttlMinutes: body.ttlMinutes };
      const result = await app.installerService.issueMatrixOnboardingCode(issueRequest);
      return sendApiSuccess(reply, result, matrixOnboardingIssueResultSchema);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }
  });

  server.get("/api/onboarding/state", async (_request, reply) => {
    try {
      const result = await app.installerService.getMatrixOnboardingState();
      return sendApiSuccess(reply, result, matrixOnboardingPublicStateSchema.nullable());
    } catch (error) {
      return sendApiError(reply, 500, error);
    }
  });
};
