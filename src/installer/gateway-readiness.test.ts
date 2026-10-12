import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeGatewayNotReady,
  GATEWAY_READY_DEADLINE_MAX_MS,
  GATEWAY_READY_DEADLINE_MIN_MS,
  GATEWAY_READY_DEADLINE_MS,
  GATEWAY_READY_POLL_MS,
  GATEWAY_READY_TIMEOUT_ENV,
  type GatewayPortProbe,
  type GatewayUnitSnapshot,
  parseSystemctlShow,
  probeGatewayHttp,
  resolveGatewayReadyDeadlineMs,
  waitForGatewayReady,
} from "./gateway-readiness.js";

/** A fake clock that only advances when the code under test sleeps. */
const createHarness = (input: {
  probes: (attempt: number) => GatewayPortProbe;
  units?: (inspection: number) => GatewayUnitSnapshot;
  probeCostMs?: number;
}) => {
  let clock = 1_000_000;
  let probeCalls = 0;
  let unitCalls = 0;
  const sleeps: number[] = [];
  return {
    deps: {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      probe: async () => {
        probeCalls += 1;
        clock += input.probeCostMs ?? 0;
        return input.probes(probeCalls);
      },
      inspectUnit: async () => {
        unitCalls += 1;
        return input.units?.(unitCalls) ?? { activeState: "activating", restarts: 0 };
      },
    },
    sleeps,
    probeCalls: () => probeCalls,
  };
};

const refused: GatewayPortProbe = { ok: false, reason: "ECONNREFUSED" };
const listening: GatewayPortProbe = { ok: true, reason: "HTTP 200" };

describe("waitForGatewayReady", () => {
  it("returns as soon as the gateway answers", async () => {
    const harness = createHarness({ probes: () => listening });

    const outcome = await waitForGatewayReady(GATEWAY_READY_DEADLINE_MS, harness.deps);

    expect(outcome).toEqual({
      unitStarted: true,
      ready: true,
      waitedMs: 0,
      deadlineMs: GATEWAY_READY_DEADLINE_MS,
      readyAt: new Date(1_000_000).toISOString(),
    });
    expect(harness.sleeps).toEqual([]);
  });

  it("keeps polling until the gateway answers and reports the time waited", async () => {
    const harness = createHarness({ probes: (attempt) => (attempt <= 70 ? refused : listening) });

    const outcome = await waitForGatewayReady(GATEWAY_READY_DEADLINE_MS, harness.deps);

    expect(outcome.ready).toBe(true);
    expect(outcome.waitedMs).toBe(70 * GATEWAY_READY_POLL_MS);
    expect(harness.probeCalls()).toBe(71);
  });

  it("gives up exactly at the deadline when the gateway never answers", async () => {
    const harness = createHarness({ probes: () => refused, probeCostMs: 300 });

    const outcome = await waitForGatewayReady(GATEWAY_READY_DEADLINE_MS, harness.deps);

    expect(outcome).toMatchObject({
      unitStarted: true,
      ready: false,
      deadlineMs: GATEWAY_READY_DEADLINE_MS,
      lastProbe: "ECONNREFUSED",
    });
    // The last probe starts at the deadline; only its own cost runs past it.
    expect(outcome.waitedMs).toBe(GATEWAY_READY_DEADLINE_MS + 300);
    expect(harness.sleeps.every((ms) => ms <= GATEWAY_READY_POLL_MS)).toBe(true);
    expect(describeGatewayNotReady({ ...outcome, waitedMs: GATEWAY_READY_DEADLINE_MS })).toBe(
      "OpenClaw gateway unit is running but not listening after 300 s (deadline 300 s); last probe: ECONNREFUSED",
    );
  });

  it("fails fast when systemd reports the unit failed", async () => {
    const harness = createHarness({
      probes: () => refused,
      units: (inspection) => ({ activeState: inspection < 4 ? "activating" : "failed" }),
    });

    const outcome = await waitForGatewayReady(GATEWAY_READY_DEADLINE_MS, harness.deps);

    expect(outcome.unitStarted).toBe(false);
    expect(outcome.ready).toBe(false);
    expect(outcome.waitedMs).toBe(2 * GATEWAY_READY_POLL_MS);
    expect(outcome.lastProbe).toBe("unit failed; last probe: ECONNREFUSED");
    expect(describeGatewayNotReady(outcome)).toBe(
      "OpenClaw gateway unit failed to start; last probe: unit failed; last probe: ECONNREFUSED",
    );
  });

  it("fails fast when systemd keeps restarting the unit", async () => {
    const harness = createHarness({
      probes: () => refused,
      units: (inspection) => ({ activeState: "activating", restarts: inspection < 3 ? 2 : 3 }),
    });

    const outcome = await waitForGatewayReady(GATEWAY_READY_DEADLINE_MS, harness.deps);

    expect(outcome.unitStarted).toBe(false);
    expect(outcome.waitedMs).toBe(GATEWAY_READY_POLL_MS);
    expect(outcome.lastProbe).toBe(
      "unit restarted 1 time(s) while starting; last probe: ECONNREFUSED",
    );
  });

  it("does not treat an unknown restart count as a crash loop", async () => {
    const harness = createHarness({
      probes: (attempt) => (attempt < 3 ? refused : listening),
      units: (inspection) => (inspection === 1 ? {} : { restarts: 5 }),
    });

    expect((await waitForGatewayReady(30_000, harness.deps)).ready).toBe(true);
  });

  it("describes a not-ready outcome without a probe reason", () => {
    expect(
      describeGatewayNotReady({
        unitStarted: true,
        ready: false,
        waitedMs: 30_400,
        deadlineMs: 30_000,
      }),
    ).toBe("OpenClaw gateway unit is running but not listening after 30 s (deadline 30 s)");
  });
});

describe("resolveGatewayReadyDeadlineMs", () => {
  it("defaults to five minutes", () => {
    expect(resolveGatewayReadyDeadlineMs({})).toBe(300_000);
    expect(resolveGatewayReadyDeadlineMs({ [GATEWAY_READY_TIMEOUT_ENV]: "  " })).toBe(300_000);
    expect(resolveGatewayReadyDeadlineMs({ [GATEWAY_READY_TIMEOUT_ENV]: "soon" })).toBe(300_000);
  });

  it("accepts an override inside the bounds", () => {
    expect(resolveGatewayReadyDeadlineMs({ [GATEWAY_READY_TIMEOUT_ENV]: "120000" })).toBe(120_000);
  });

  it("clamps an override to [30 s, 900 s]", () => {
    expect(resolveGatewayReadyDeadlineMs({ [GATEWAY_READY_TIMEOUT_ENV]: "1000" })).toBe(
      GATEWAY_READY_DEADLINE_MIN_MS,
    );
    expect(resolveGatewayReadyDeadlineMs({ [GATEWAY_READY_TIMEOUT_ENV]: "-5" })).toBe(
      GATEWAY_READY_DEADLINE_MIN_MS,
    );
    expect(resolveGatewayReadyDeadlineMs({ [GATEWAY_READY_TIMEOUT_ENV]: "3600000" })).toBe(
      GATEWAY_READY_DEADLINE_MAX_MS,
    );
  });

  it("reads the process environment by default", () => {
    const prior = process.env[GATEWAY_READY_TIMEOUT_ENV];
    process.env[GATEWAY_READY_TIMEOUT_ENV] = "45000";
    try {
      expect(resolveGatewayReadyDeadlineMs()).toBe(45_000);
    } finally {
      if (prior === undefined) {
        delete process.env[GATEWAY_READY_TIMEOUT_ENV];
      } else {
        process.env[GATEWAY_READY_TIMEOUT_ENV] = prior;
      }
    }
  });
});

describe("probeGatewayHttp", () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === null) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    server = null;
  });

  const listen = async (status: number): Promise<string> => {
    server = createServer((_req, res) => {
      res.statusCode = status;
      res.end("not found");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/`;
  };

  it("counts any HTTP response as listening", async () => {
    const url = await listen(404);
    expect(await probeGatewayHttp(fetch, url)).toEqual({ ok: true, reason: "HTTP 404" });
  });

  it("reports the transport error code when nothing listens", async () => {
    const url = await listen(200);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    expect(await probeGatewayHttp(fetch, url)).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });

  it("reports a timeout", async () => {
    const hang = async (_url: string, init?: RequestInit): Promise<Response> =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    expect(await probeGatewayHttp(hang, "http://127.0.0.1:1/", 10)).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("reports other errors by message", async () => {
    expect(
      await probeGatewayHttp(async () => {
        throw new Error("boom");
      }),
    ).toEqual({ ok: false, reason: "boom" });
    expect(
      await probeGatewayHttp(async () => {
        throw "plain";
      }),
    ).toEqual({ ok: false, reason: "plain" });
  });

  it("tolerates a response without a body", async () => {
    expect(await probeGatewayHttp(async () => new Response(null, { status: 204 }))).toEqual({
      ok: true,
      reason: "HTTP 204",
    });
  });
});

describe("parseSystemctlShow", () => {
  it("reads state, restart count and the unix activation time", () => {
    expect(
      parseSystemctlShow("ActiveState=active\nNRestarts=2\nActiveEnterTimestamp=@1790000000\n"),
    ).toEqual({
      activeState: "active",
      restarts: 2,
      activeEnterTimestamp: new Date(1_790_000_000_000).toISOString(),
    });
  });

  it("accepts a plain timestamp and ignores empty or malformed fields", () => {
    expect(
      parseSystemctlShow(
        "ActiveState=\nNRestarts=n/a\nActiveEnterTimestamp=2026-10-01T16:53:25Z\nnoise",
      ),
    ).toEqual({ activeEnterTimestamp: "2026-10-01T16:53:25.000Z" });
    expect(parseSystemctlShow("ActiveEnterTimestamp=\n")).toEqual({});
    expect(parseSystemctlShow("ActiveEnterTimestamp=not a date\n")).toEqual({});
  });
});
