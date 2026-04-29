import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { StubInstallerService } from "../../installer/stub-service.js";
import { createLogger } from "../../logging/logger.js";
import { registerOnboardingRoutes } from "./onboarding.js";

const buildTestApp = (override?: Partial<AppContainer["installerService"]>): FastifyInstance => {
  const logger = createLogger();
  const installerService = new StubInstallerService(logger);
  const merged = override
    ? Object.assign(
        Object.create(Object.getPrototypeOf(installerService)),
        installerService,
        override,
      )
    : installerService;
  const server = Fastify({ logger: false });
  registerOnboardingRoutes(server, {
    logger,
    installerService: merged,
  } as unknown as AppContainer);
  return server;
};

describe("onboarding routes", () => {
  it("issues a Matrix onboarding code on POST /api/onboarding/issue", async () => {
    const server = buildTestApp();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/onboarding/issue",
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.result).toMatchObject({
        code: expect.any(String),
        expiresAt: expect.any(String),
        onboardingUrl: expect.any(String),
        onboardingLink: expect.any(String),
        username: expect.any(String),
      });
    } finally {
      await server.close();
    }
  });

  it("forwards ttlMinutes when provided", async () => {
    const logger = createLogger();
    const stub = new StubInstallerService(logger);
    const spy = vi.spyOn(stub, "issueMatrixOnboardingCode");
    const server = Fastify({ logger: false });
    registerOnboardingRoutes(server, {
      logger,
      installerService: stub,
    } as unknown as AppContainer);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/onboarding/issue",
        payload: { ttlMinutes: 30 },
      });
      expect(response.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith({ ttlMinutes: 30 });
    } finally {
      await server.close();
    }
  });

  it("rejects invalid ttlMinutes with a 400 error envelope", async () => {
    const server = buildTestApp();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/onboarding/issue",
        payload: { ttlMinutes: "soon" },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatchObject({ code: expect.any(String) });
    } finally {
      await server.close();
    }
  });

  it("issues without a request body at all", async () => {
    const server = buildTestApp();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/onboarding/issue",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects unknown body keys (strict schema)", async () => {
    const server = buildTestApp();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/onboarding/issue",
        payload: { unexpectedField: 1 },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("returns the public onboarding state on GET /api/onboarding/state", async () => {
    const server = buildTestApp();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/onboarding/state",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.result).toMatchObject({
        issuedAt: expect.any(String),
        expiresAt: expect.any(String),
        failedAttempts: expect.any(Number),
        maxAttempts: expect.any(Number),
        username: expect.any(String),
        homeserverUrl: expect.any(String),
      });
      // Public state must not leak secrets.
      expect(body.result).not.toHaveProperty("codeHash");
      expect(body.result).not.toHaveProperty("codeSalt");
      expect(body.result).not.toHaveProperty("passwordSecretRef");
    } finally {
      await server.close();
    }
  });

  it("returns null result when no onboarding state exists", async () => {
    const logger = createLogger();
    const stub = new StubInstallerService(logger);
    stub.getMatrixOnboardingState = async () => null;
    const server = Fastify({ logger: false });
    registerOnboardingRoutes(server, {
      logger,
      installerService: stub,
    } as unknown as AppContainer);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/onboarding/state",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.result).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("returns a 500 envelope when getMatrixOnboardingState throws", async () => {
    const logger = createLogger();
    const stub = new StubInstallerService(logger);
    stub.getMatrixOnboardingState = async () => {
      throw new Error("boom");
    };
    const server = Fastify({ logger: false });
    registerOnboardingRoutes(server, {
      logger,
      installerService: stub,
    } as unknown as AppContainer);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/onboarding/state",
      });
      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.ok).toBe(false);
    } finally {
      await server.close();
    }
  });
});
