import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { StubInstallerService } from "../../installer/stub-service.js";
import { createLogger } from "../../logging/logger.js";
import { createIpLimiter } from "../auth/rate-limit.js";
import { createSessionStore } from "../auth/sessions.js";
import { registerAuthRoutes } from "./auth.js";

type Harness = {
  app: FastifyInstance;
  service: StubInstallerService;
};

const buildHarness = async (
  override?: Partial<StubInstallerService>,
  rateLimiterOptions?: { windowMs?: number; max?: number; now?: () => number },
): Promise<Harness> => {
  const logger = createLogger();
  const service = new StubInstallerService(logger);
  if (override !== undefined) {
    Object.assign(service, override);
  }
  const sessions = createSessionStore({ ttlMs: 60_000 });
  const rateLimiter = createIpLimiter({
    windowMs: rateLimiterOptions?.windowMs ?? 60_000,
    max: rateLimiterOptions?.max ?? 5,
    ...(rateLimiterOptions?.now !== undefined ? { now: rateLimiterOptions.now } : {}),
  });
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerAuthRoutes(app, { logger, installerService: service } as unknown as AppContainer, {
    sessions,
    rateLimiter,
  });
  return { app, service };
};

describe("auth routes", () => {
  it("GET /api/auth/state reports stage and unauthenticated when no cookie", async () => {
    const { app } = await buildHarness();
    try {
      const response = await app.inject({ method: "GET", url: "/api/auth/state" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.result.authenticated).toBe(false);
      expect(body.result.stage).toBe("needs-password");
      expect(body.result.username).toBe("@admin:matrix.example.org");
    } finally {
      await app.close();
    }
  });

  it("logs in with a valid bootstrap token and sets session+csrf cookies", async () => {
    const { app, service } = await buildHarness();
    service.getAuthStage = async () => ({ stage: "needs-bootstrap" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { token: "ABCD-EFGH-JKLM" },
      });
      expect(response.statusCode).toBe(200);
      const setCookies = response.headers["set-cookie"];
      const cookieList = Array.isArray(setCookies) ? setCookies : [setCookies ?? ""];
      expect(cookieList.some((c) => c.includes("sov_session="))).toBe(true);
      expect(cookieList.some((c) => c.includes("sov_csrf="))).toBe(true);
      expect(cookieList.some((c) => /HttpOnly/i.test(c) && /sov_session/.test(c))).toBe(true);
      expect(response.json().result.csrf).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("rejects invalid bootstrap token with 401 and BOOTSTRAP_TOKEN_INVALID", async () => {
    const { app, service } = await buildHarness();
    service.getAuthStage = async () => ({ stage: "needs-bootstrap" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { token: "WRNG-TOKE-NXYZ" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("BOOTSTRAP_TOKEN_INVALID");
    } finally {
      await app.close();
    }
  });

  it("returns 400 when bootstrap stage and no token sent", async () => {
    const { app, service } = await buildHarness();
    service.getAuthStage = async () => ({ stage: "needs-bootstrap" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "irrelevant" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("BOOTSTRAP_TOKEN_REQUIRED");
    } finally {
      await app.close();
    }
  });

  it("logs in with the operator Matrix password (post-install stage)", async () => {
    const { app } = await buildHarness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "scaffold-operator-password" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result.username).toBe("@admin:matrix.example.org");
    } finally {
      await app.close();
    }
  });

  it("rejects an incorrect password with 401 INVALID_CREDENTIALS", async () => {
    const { app } = await buildHarness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("INVALID_CREDENTIALS");
    } finally {
      await app.close();
    }
  });

  it("returns 503 HOMESERVER_UNREACHABLE when verifyOperatorPassword reports unreachable", async () => {
    const { app, service } = await buildHarness();
    service.verifyOperatorPassword = async () => ({ ok: false, reason: "homeserver-unreachable" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "anything" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("HOMESERVER_UNREACHABLE");
    } finally {
      await app.close();
    }
  });

  it("returns 409 OPERATOR_NOT_CONFIGURED when verifyOperatorPassword reports not-configured", async () => {
    const { app, service } = await buildHarness();
    service.verifyOperatorPassword = async () => ({ ok: false, reason: "not-configured" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "anything" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("OPERATOR_NOT_CONFIGURED");
    } finally {
      await app.close();
    }
  });

  it("locks out an IP after max failures and returns 429 with Retry-After", async () => {
    let now = 0;
    const { app } = await buildHarness(undefined, {
      windowMs: 60_000,
      max: 2,
      now: () => now,
    });
    try {
      const bad = async () =>
        app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: "wrong" },
        });
      now = 100;
      expect((await bad()).statusCode).toBe(401);
      now = 200;
      expect((await bad()).statusCode).toBe(401);
      now = 300;
      const locked = await bad();
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.code).toBe("RATE_LIMITED");
      expect(locked.headers["retry-after"]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("logs out, clears cookies, and the session no longer authenticates state", async () => {
    const { app, service } = await buildHarness();
    service.getAuthStage = async () => ({ stage: "needs-bootstrap" });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { token: "ABCD-EFGH-JKLM" },
      });
      const setCookies = login.headers["set-cookie"];
      const cookieList = Array.isArray(setCookies) ? setCookies : [setCookies ?? ""];
      const sidMatch = cookieList
        .find((c) => c.includes("sov_session="))
        ?.match(/sov_session=([^;]+)/);
      const csrfMatch = cookieList.find((c) => c.includes("sov_csrf="))?.match(/sov_csrf=([^;]+)/);
      expect(sidMatch?.[1]).toBeTruthy();
      expect(csrfMatch?.[1]).toBeTruthy();

      const stateAuthed = await app.inject({
        method: "GET",
        url: "/api/auth/state",
        cookies: { sov_session: sidMatch?.[1] ?? "" },
      });
      expect(stateAuthed.json().result.authenticated).toBe(true);
      expect(stateAuthed.json().result.csrf).toBeTruthy();

      const logout = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        cookies: { sov_session: sidMatch?.[1] ?? "" },
      });
      expect(logout.statusCode).toBe(200);
      const clears = logout.headers["set-cookie"];
      const clearList = Array.isArray(clears) ? clears : [clears ?? ""];
      expect(clearList.some((c) => /sov_session=;/.test(c))).toBe(true);

      const stateAfter = await app.inject({
        method: "GET",
        url: "/api/auth/state",
        cookies: { sov_session: sidMatch?.[1] ?? "" },
      });
      expect(stateAfter.json().result.authenticated).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns 500 from /api/auth/state when getAuthStage throws", async () => {
    const { app, service } = await buildHarness();
    service.getAuthStage = async () => {
      throw new Error("boom");
    };
    try {
      const response = await app.inject({ method: "GET", url: "/api/auth/state" });
      expect(response.statusCode).toBe(500);
      expect(response.json().ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns 500 from /api/auth/login when getAuthStage throws", async () => {
    const { app, service } = await buildHarness();
    service.getAuthStage = async () => {
      throw new Error("boom");
    };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { token: "ABCD-EFGH-JKLM" },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("returns 400 PASSWORD_REQUIRED when needs-password stage and only token sent", async () => {
    const { app } = await buildHarness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { token: "ABCD-EFGH-JKLM" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("PASSWORD_REQUIRED");
    } finally {
      await app.close();
    }
  });

  it("returns 410 when bootstrap token has already been consumed", async () => {
    const { app, service } = await buildHarness();
    service.getAuthStage = async () => ({ stage: "needs-bootstrap" });
    service.consumeSetupUiBootstrapToken = async () => ({ ok: false, reason: "consumed" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { token: "ABCD-EFGH-JKLM" },
      });
      expect(response.statusCode).toBe(410);
      expect(response.json().error.code).toBe("BOOTSTRAP_TOKEN_CONSUMED");
    } finally {
      await app.close();
    }
  });

  it("returns 410 when no bootstrap token has been issued", async () => {
    const { app, service } = await buildHarness();
    service.getAuthStage = async () => ({ stage: "needs-bootstrap" });
    service.consumeSetupUiBootstrapToken = async () => ({ ok: false, reason: "not-issued" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { token: "ABCD-EFGH-JKLM" },
      });
      expect(response.statusCode).toBe(410);
      expect(response.json().error.code).toBe("BOOTSTRAP_TOKEN_NOT_ISSUED");
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid login body with 400", async () => {
    const { app } = await buildHarness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
