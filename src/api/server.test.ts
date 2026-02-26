import { describe, expect, it } from "vitest";

import { createApp } from "../app/create-app.js";
import { buildApiServer } from "./server.js";

describe("API scaffold", () => {
  it("serves health and status endpoints", async () => {
    const server = buildApiServer(createApp());

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
});
