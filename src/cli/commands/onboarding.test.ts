import { describe, expect, it, vi } from "vitest";

import type { MatrixOnboardingReadiness } from "../../contracts/index.js";
import { awaitOnboardingReady } from "./onboarding.js";

const reading = (overrides: Partial<MatrixOnboardingReadiness>): MatrixOnboardingReadiness => ({
  ready: false,
  url: "https://node.relay.example.com/onboard",
  mode: "relay-passthrough",
  ...overrides,
});

describe("awaitOnboardingReady", () => {
  const noopSleep = async () => {};

  it("returns immediately when the first reading is ready", async () => {
    const poll = vi.fn().mockResolvedValue(reading({ ready: true, reason: "public-200" }));

    const outcome = await awaitOnboardingReady(poll, { sleepFn: noopSleep });

    expect(outcome.ready).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("polls until the page becomes reachable", async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(reading({ ready: false, reason: "config-not-found" }))
      .mockResolvedValueOnce(reading({ ready: false, reason: "http-404" }))
      .mockResolvedValueOnce(reading({ ready: true, reason: "public-200" }));

    const outcome = await awaitOnboardingReady(poll, { sleepFn: noopSleep, deadlineMs: 10_000 });

    expect(outcome.ready).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("reports timedOut (not an error) when the deadline expires while never ready", async () => {
    const poll = vi.fn().mockResolvedValue(reading({ ready: false, reason: "http-503" }));

    const outcome = await awaitOnboardingReady(poll, { sleepFn: noopSleep, deadlineMs: 0 });

    expect(outcome.ready).toBe(false);
    expect(outcome.timedOut).toBe(true);
    // The deadline-of-zero still polls once up front before giving up.
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("defaults to a long deadline for relay-passthrough mode", async () => {
    // Never ready; with deadlineMs unset it must derive ~12min from the mode,
    // so it keeps polling rather than bailing after the first reading. We cap
    // the run by making sleep throw after a couple of ticks.
    let ticks = 0;
    const poll = vi.fn().mockResolvedValue(reading({ ready: false, mode: "relay-passthrough" }));
    const sleepFn = async () => {
      ticks += 1;
      if (ticks >= 3) throw new Error("stop");
    };

    await expect(awaitOnboardingReady(poll, { sleepFn })).rejects.toThrow("stop");
    expect(poll.mock.calls.length).toBeGreaterThan(1);
  });

  it("grows the deadline once a real passthrough mode follows a config-not-found reading", async () => {
    // The first reading is the config-not-found placeholder (mode "direct"). If
    // the deadline were locked from it, the loop would bail at the 60s default
    // before the relay-passthrough cert issues. It must instead grow to the
    // passthrough ceiling once a real reading arrives. We let it run a few ticks
    // (proving it did not bail at the default) then stop via a throwing sleep.
    let ticks = 0;
    const poll = vi
      .fn()
      .mockResolvedValueOnce(reading({ ready: false, mode: "direct", reason: "config-not-found" }))
      .mockResolvedValue(reading({ ready: false, mode: "relay-passthrough" }));
    const sleepFn = async () => {
      ticks += 1;
      if (ticks >= 4) throw new Error("stop");
    };

    await expect(awaitOnboardingReady(poll, { sleepFn })).rejects.toThrow("stop");
    expect(poll.mock.calls.length).toBeGreaterThan(2);
  });
});
