import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerSetupUiRoutes, resolveSetupUiRoot } from "./setup-ui.js";

const buildTestApp = async () => {
  const server = Fastify({ logger: false });
  await registerSetupUiRoutes(server);
  return server;
};

describe("resolveSetupUiRoot", () => {
  const baseUrl = "file:///srv/dist/sovereign-node-api.js";

  it("returns the dev candidate when it exists on disk", () => {
    const root = resolveSetupUiRoot(baseUrl, () => true);
    expect(root).toMatch(/public\/setup-ui\/$/);
    // Three URL segments up from /srv/dist/sovereign-node-api.js → above /srv.
    expect(root.startsWith("/")).toBe(true);
  });

  it("falls back to the built layout when the dev candidate is missing", () => {
    const root = resolveSetupUiRoot(baseUrl, () => false);
    expect(root).toBe("/srv/dist/public/setup-ui/");
  });
});

describe("setup-ui routes", () => {
  it("serves the SPA shell at /setup-ui/", async () => {
    const server = await buildTestApp();
    try {
      const response = await server.inject({ method: "GET", url: "/setup-ui/" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.body).toContain('<div id="root"></div>');
    } finally {
      await server.close();
    }
  });

  it("serves application JavaScript with no-cache headers", async () => {
    const server = await buildTestApp();
    try {
      const response = await server.inject({ method: "GET", url: "/setup-ui/app.js" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/javascript/);
      expect(response.headers["cache-control"]).toBe("no-cache");
    } finally {
      await server.close();
    }
  });

  it("serves vendor files with immutable cache headers", async () => {
    const server = await buildTestApp();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/setup-ui/vendor/preact.module.js",
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/javascript/);
      expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    } finally {
      await server.close();
    }
  });

  it("serves the stylesheet", async () => {
    const server = await buildTestApp();
    try {
      const response = await server.inject({ method: "GET", url: "/setup-ui/app.css" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/css/);
      expect(response.headers["cache-control"]).toBe("no-cache");
    } finally {
      await server.close();
    }
  });

  it("rejects path-traversal attempts", async () => {
    const server = await buildTestApp();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/setup-ui/../package.json",
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("redirects GET / to /setup-ui/", async () => {
    const server = await buildTestApp();
    try {
      const response = await server.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/setup-ui/");
    } finally {
      await server.close();
    }
  });
});
