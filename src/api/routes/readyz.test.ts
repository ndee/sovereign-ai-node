import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { createApp } from "../../app/create-app.js";
import type { CheckResult, DoctorReport } from "../../contracts/index.js";
import { buildApiServer } from "../server.js";
import { READYZ_TIMEOUT_MS, registerReadyzRoutes } from "./readyz.js";

const check = (id: string, status: CheckResult["status"]): CheckResult => ({
  id,
  name: `${id} display name`,
  status,
  message: `detailed message for ${id} at /etc/sovereign-node/config.json`,
  details: { mountPoint: "/", detectedVersion: "1.2.3" },
});

const report = (overall: DoctorReport["overall"], checks: CheckResult[]): DoctorReport => ({
  overall,
  checks,
  suggestedCommands: ["sudo systemctl restart openclaw-gateway"],
});

/** Mounts /readyz over a fake installerService — no real host probing. */
const buildTestServer = (getDoctorReport: () => Promise<DoctorReport>): FastifyInstance => {
  const server = Fastify({ logger: false });
  registerReadyzRoutes(server, {
    installerService: { getDoctorReport: vi.fn(getDoctorReport) },
  } as unknown as AppContainer);
  return server;
};

describe("GET /readyz", () => {
  it("returns 200 when the doctor report passes", async () => {
    const server = buildTestServer(async () =>
      report("pass", [check("openclaw-cli", "pass"), check("gateway-service-install", "pass")]),
    );
    try {
      const response = await server.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        status: "pass",
        passing: 2,
        failing: [],
      });
    } finally {
      await server.close();
    }
  });

  it("returns 200 but marks degraded when the doctor report warns", async () => {
    const server = buildTestServer(async () =>
      report("warn", [check("openclaw-cli", "pass"), check("disk-space-root", "warn")]),
    );
    try {
      const response = await server.inject({ method: "GET", url: "/readyz" });
      // Degraded but still serving: stays in rotation.
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.status).toBe("warn");
      expect(body.passing).toBe(1);
      expect(body.failing).toEqual([{ id: "disk-space-root", status: "warn" }]);
    } finally {
      await server.close();
    }
  });

  it("returns 503 when the doctor report fails", async () => {
    const server = buildTestServer(async () =>
      report("fail", [
        check("openclaw-cli", "fail"),
        check("disk-space-root", "warn"),
        check("install-provenance", "pass"),
      ]),
    );
    try {
      const response = await server.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.status).toBe("fail");
      expect(body.passing).toBe(1);
      expect(body.failing).toEqual([
        { id: "openclaw-cli", status: "fail" },
        { id: "disk-space-root", status: "warn" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("never leaks check names, messages, details or suggested commands", async () => {
    const server = buildTestServer(async () =>
      report("fail", [check("openclaw-cli", "fail"), check("disk-space-root", "warn")]),
    );
    try {
      const response = await server.inject({ method: "GET", url: "/readyz" });
      const raw = response.body;
      expect(raw).not.toContain("display name");
      expect(raw).not.toContain("/etc/sovereign-node/config.json");
      expect(raw).not.toContain("mountPoint");
      expect(raw).not.toContain("detectedVersion");
      expect(raw).not.toContain("1.2.3");
      expect(raw).not.toContain("systemctl restart");
      expect(Object.keys(response.json()).sort()).toEqual(["failing", "ok", "passing", "status"]);
    } finally {
      await server.close();
    }
  });

  it("returns 503 without a stack trace when getDoctorReport throws", async () => {
    const server = buildTestServer(async () => {
      throw new Error("ENOENT: /etc/sovereign-node/install-request.json missing");
    });
    try {
      const response = await server.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        status: "unknown",
        passing: 0,
        failing: [],
        reason: "readiness check failed",
      });
      // No error text, path, or stack leaked to the caller.
      expect(response.body).not.toContain("ENOENT");
      expect(response.body).not.toContain("install-request.json");
      expect(response.body).not.toContain("at ");
    } finally {
      await server.close();
    }
  });

  it("returns 503 with a timeout reason when getDoctorReport hangs", async () => {
    vi.useFakeTimers();
    const server = buildTestServer(
      // Never settles — models a wedged host probe.
      async () => await new Promise<DoctorReport>(() => {}),
    );
    try {
      const pending = server.inject({ method: "GET", url: "/readyz" });
      await vi.advanceTimersByTimeAsync(READYZ_TIMEOUT_MS);
      const response = await pending;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        status: "unknown",
        passing: 0,
        failing: [],
        reason: "readiness check timed out",
      });
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });
});

describe("/healthz regression guard", () => {
  it("keeps answering an unconditional {ok:true} with status 200", async () => {
    // install-web.sh's wait_for_healthz depends on exactly this. /readyz must
    // never have changed it.
    const server = await buildApiServer(createApp());
    try {
      const response = await server.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });

  it("serves /readyz through the real server without a session", async () => {
    const server = await buildApiServer(createApp());
    try {
      const response = await server.inject({ method: "GET", url: "/readyz" });
      // Reachable (not 401) — the value depends on the host doctor sees.
      expect(response.statusCode).not.toBe(401);
      expect([200, 503]).toContain(response.statusCode);
    } finally {
      await server.close();
    }
  });
});
