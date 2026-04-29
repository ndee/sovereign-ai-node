import { describe, expect, it } from "vitest";

import { createApp } from "../app/create-app.js";
import { buildApiServer } from "./server.js";

describe("API scaffold", () => {
  it("serves /healthz without auth and gates /api/status behind auth", async () => {
    const server = await buildApiServer(createApp());

    try {
      const health = await server.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });

      const status = await server.inject({ method: "GET", url: "/api/status" });
      expect(status.statusCode).toBe(401);
      expect(status.json().error.code).toBe("UNAUTHENTICATED");
    } finally {
      await server.close();
    }
  });

  it("wires the setup UI, auth, and onboarding routes", async () => {
    const server = await buildApiServer(createApp());
    try {
      const root = await server.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(302);
      expect(root.headers.location).toBe("/setup-ui/");

      const setupUi = await server.inject({ method: "GET", url: "/setup-ui/" });
      expect(setupUi.statusCode).toBe(200);
      expect(setupUi.headers["content-type"]).toMatch(/text\/html/);

      const authState = await server.inject({ method: "GET", url: "/api/auth/state" });
      expect(authState.statusCode).toBe(200);
      const body = authState.json();
      expect(body.ok).toBe(true);
      expect(body.result.authenticated).toBe(false);
      expect(["needs-bootstrap", "needs-password"]).toContain(body.result.stage);

      const onboardingState = await server.inject({
        method: "GET",
        url: "/api/onboarding/state",
      });
      expect(onboardingState.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});
