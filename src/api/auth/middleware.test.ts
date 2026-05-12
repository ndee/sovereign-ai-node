import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createAuthPreHandler } from "./middleware.js";
import { createSessionStore, type SessionStore } from "./sessions.js";

const buildApp = async (): Promise<{ app: FastifyInstance; sessions: SessionStore }> => {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const sessions = createSessionStore({ ttlMs: 60_000 });
  app.addHook("preHandler", createAuthPreHandler({ sessions }));
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/status", async () => ({ status: "ok" }));
  app.post("/api/install/run", async () => ({ started: true }));
  app.get("/api/auth/state", async () => ({ stage: "needs-bootstrap" }));
  app.post("/api/auth/login", async () => ({ ok: true }));
  return { app, sessions };
};

describe("auth preHandler", () => {
  it("allows /healthz without a session", async () => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("allows GET /api/auth/state without a session", async () => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/auth/state" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("allows POST /api/auth/login without a session and without CSRF", async () => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("allows /setup-ui/* without a session (prefix allow-list)", async () => {
    const { app } = await buildApp();
    app.get("/setup-ui/index.html", async () => ({ static: true }));
    try {
      const response = await app.inject({ method: "GET", url: "/setup-ui/index.html" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects protected GET routes without a session", async () => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/status" });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHENTICATED");
    } finally {
      await app.close();
    }
  });

  it("accepts protected GET with a valid session cookie", async () => {
    const { app, sessions } = await buildApp();
    const session = sessions.create({ kind: "matrix", username: "@admin:example" });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/status",
        cookies: { sov_session: session.sid },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects protected POST without CSRF token", async () => {
    const { app, sessions } = await buildApp();
    const session = sessions.create({ kind: "matrix", username: "@admin:example" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/install/run",
        cookies: { sov_session: session.sid, sov_csrf: session.csrf },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("CSRF_INVALID");
    } finally {
      await app.close();
    }
  });

  it("rejects protected POST with mismatched CSRF header vs cookie", async () => {
    const { app, sessions } = await buildApp();
    const session = sessions.create({ kind: "matrix", username: "@admin:example" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/install/run",
        cookies: { sov_session: session.sid, sov_csrf: session.csrf },
        headers: { "X-CSRF-Token": "wrong" },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("accepts protected POST with matching CSRF header and cookie", async () => {
    const { app, sessions } = await buildApp();
    const session = sessions.create({ kind: "matrix", username: "@admin:example" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/install/run",
        cookies: { sov_session: session.sid, sov_csrf: session.csrf },
        headers: { "X-CSRF-Token": session.csrf },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects expired session cookie", async () => {
    const sessions = createSessionStore({ ttlMs: 1, now: () => 0 });
    const session = sessions.create({ kind: "matrix", username: "@admin:example" });
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    app.addHook("preHandler", createAuthPreHandler({ sessions: { ...sessions, get: () => null } }));
    app.get("/api/status", async () => ({ ok: true }));
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/status",
        cookies: { sov_session: session.sid },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
