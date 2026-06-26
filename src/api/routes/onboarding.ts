import type { FastifyInstance } from "fastify";

import type { AppContainer } from "../../app/create-app.js";
import { onboardingIssueRequestSchema } from "../../contracts/api.js";
import {
  matrixOnboardingIssueResultSchema,
  matrixOnboardingPublicStateSchema,
  matrixOnboardingReadinessSchema,
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

  // Reachability of the public onboarding page. The CLI and web installers poll
  // this to gate the reveal of the onboarding URL/QR until the page is serving
  // (the readiness method never throws for the not-ready cases — config still
  // writing, page not exposed, network/TLS error — so the catch is a safety net).
  server.get("/api/onboarding/ready", async (_request, reply) => {
    try {
      const result = await app.installerService.getMatrixOnboardingReadiness();
      return sendApiSuccess(reply, result, matrixOnboardingReadinessSchema);
    } catch (error) {
      return sendApiError(reply, 500, error);
    }
  });
};
