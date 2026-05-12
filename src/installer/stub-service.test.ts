import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import { StubInstallerService } from "./stub-service.js";

describe("StubInstallerService.getMatrixOnboardingState", () => {
  it("returns a deterministic public state without secrets", async () => {
    const service = new StubInstallerService(createLogger());
    const state = await service.getMatrixOnboardingState();
    expect(state).not.toBeNull();
    expect(state).toMatchObject({
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
      failedAttempts: expect.any(Number),
      maxAttempts: expect.any(Number),
      username: expect.any(String),
      homeserverUrl: expect.any(String),
    });
    expect(state).not.toHaveProperty("codeHash");
    expect(state).not.toHaveProperty("codeSalt");
    expect(state).not.toHaveProperty("passwordSecretRef");
  });
});
