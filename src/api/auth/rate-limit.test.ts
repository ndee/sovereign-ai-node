import { describe, expect, it } from "vitest";

import { createIpLimiter } from "./rate-limit.js";

describe("createIpLimiter", () => {
  it("allows fresh IPs", () => {
    const limiter = createIpLimiter({ windowMs: 1000, max: 3 });
    expect(limiter.check("1.2.3.4")).toEqual({ ok: true });
  });

  it("locks the IP after max failures within the window", () => {
    const t = 1000;
    const limiter = createIpLimiter({ windowMs: 60_000, max: 3, now: () => t });
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.check("ip")).toEqual({ ok: true });
    limiter.recordFailure("ip");
    const blocked = limiter.check("ip");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBe(60);
    }
  });

  it("releases the lock after the window passes", () => {
    let t = 0;
    const limiter = createIpLimiter({ windowMs: 1000, max: 2, now: () => t });
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.check("ip").ok).toBe(false);
    t = 2500;
    expect(limiter.check("ip")).toEqual({ ok: true });
  });

  it("forgets failures older than the window when checking", () => {
    let t = 0;
    const limiter = createIpLimiter({ windowMs: 1000, max: 3, now: () => t });
    limiter.recordFailure("ip");
    t = 500;
    limiter.recordFailure("ip");
    t = 1600; // first failure now outside window
    expect(limiter.check("ip")).toEqual({ ok: true });
    limiter.recordFailure("ip");
    // Two within-window failures (at t=500, t=1600); fresh check still ok.
    expect(limiter.check("ip")).toEqual({ ok: true });
  });

  it("recordSuccess resets the bucket", () => {
    const t = 0;
    const limiter = createIpLimiter({ windowMs: 1000, max: 2, now: () => t });
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.check("ip").ok).toBe(false);
    limiter.recordSuccess("ip");
    expect(limiter.check("ip")).toEqual({ ok: true });
    expect(limiter.size()).toBe(0);
  });

  it("isolates buckets per IP", () => {
    const limiter = createIpLimiter({ windowMs: 1000, max: 2 });
    limiter.recordFailure("a");
    limiter.recordFailure("a");
    expect(limiter.check("a").ok).toBe(false);
    expect(limiter.check("b").ok).toBe(true);
  });

  it("uses Date.now when no now is injected", () => {
    const limiter = createIpLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.check("ip")).toEqual({ ok: true });
    limiter.recordFailure("ip");
    const result = limiter.check("ip");
    expect(result.ok).toBe(false);
  });
});
