import { describe, expect, it } from "vitest";

import { createApp } from "../app/create-app.js";
import { buildApiServer } from "./server.js";

describe("API scaffold", () => {
  it("serves health and status endpoints", async () => {
    const server = await buildApiServer(createApp());

    try {
      const health = await server.inject({
        method: "GET",
        url: "/healthz",
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });

      const status = await server.inject({
        method: "GET",
        url: "/api/status",
      });
      expect(status.statusCode).toBe(200);

      const body = status.json();
      expect(body.ok).toBe(true);
      expect(body.result.mode).toBe("bundled_matrix");
      expect(body.result.services[0]?.name).toBe("sovereign-node");
    } finally {
      await server.close();
    }
  });

  it("wires the setup UI and onboarding routes", async () => {
    const server = await buildApiServer(createApp());
    try {
      const root = await server.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(302);
      expect(root.headers.location).toBe("/setup-ui/");

      const setupUi = await server.inject({ method: "GET", url: "/setup-ui/" });
      expect(setupUi.statusCode).toBe(200);
      expect(setupUi.headers["content-type"]).toMatch(/text\/html/);

      const onboardingState = await server.inject({
        method: "GET",
        url: "/api/onboarding/state",
      });
      expect(onboardingState.statusCode).toBe(200);
      const stateBody = onboardingState.json();
      expect(stateBody.ok).toBe(true);
    } finally {
      await server.close();
    }
  });
});
