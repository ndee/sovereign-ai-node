import { describe, expect, it, vi } from "vitest";

import {
  COLLECTOR_TIMEOUT_MS,
  collectClockState,
  collectGatewaySyncOrdering,
  collectJournalTail,
  collectSystemResources,
  collectUnitStates,
  JOURNAL_LINE_LIMIT,
  MAX_ARTIFACT_BYTES,
  type RunCommand,
  SUPPORTED_UNITS,
  summarizeMailState,
} from "./collectors.js";
import { REDACTED, REDACTED_PII } from "./redact.js";

const EMAIL_BODY = "TEST_EMAIL_BODY_DO_NOT_LEAK";
const IMAP = "TEST_IMAP_PASSWORD_DO_NOT_LEAK";

/** A runner that always rejects — used to prove no collector ever throws. */
const alwaysFails: RunCommand = async () => {
  throw new Error("command not found");
};

/** A runner that returns fixed stdout for every call. */
const alwaysReturns =
  (stdout: string, stderr = ""): RunCommand =>
  async () => ({ stdout, stderr });

const serialize = (value: unknown): string => JSON.stringify(value);

describe("summarizeMailState — privacy", () => {
  /**
   * A realistic Mail Sentinel state. Every field that has ever held user content
   * is populated with something identifying, so the assertions below prove the
   * collector emits counters rather than redacting content it should not have
   * collected in the first place.
   */
  const realisticState = {
    messages: [
      {
        uid: 1,
        subject: `Re: quarterly numbers ${EMAIL_BODY}`,
        sender: "boss@example.com",
        snippet: `Here is the confidential figure ${EMAIL_BODY}`,
        receivedAt: "2026-07-25T09:00:00.000Z",
      },
      {
        uid: 2,
        subject: `Invoice ${EMAIL_BODY}`,
        sender: "billing@acme-competitor.com",
        snippet: EMAIL_BODY,
        receivedAt: "2026-07-25T10:00:00.000Z",
      },
    ],
    alerts: [
      { zone: "red", subject: EMAIL_BODY, sender: "boss@example.com" },
      { zone: "red", subject: EMAIL_BODY, sender: "hr@example.com" },
      { zone: "amber", subject: EMAIL_BODY, sender: "team@example.org" },
      { zone: "gray" },
      { notAnObject: true },
      null,
      "a bare string alert",
    ],
    feedback: [{ uid: 1, verdict: "useful" }],
    zoneHistory: [{ at: "2026-07-25T09:00:00.000Z", zone: "red" }],
    learning: {
      senderWeights: {
        "boss@example.com": 4,
        "hr@example.com": 2,
        "newsletter@marketing.example.org": -1,
      },
      domainWeights: { "example.com": 6, "acme-competitor.com": 3 },
    },
    lastPollAt: "2026-07-26T10:00:00.000Z",
    lastAlertAt: "2026-07-26T09:30:00.000Z",
    lastImapSuccessAt: "2026-07-26T10:00:00.000Z",
    consecutiveFailures: 0,
    lastScanLlmFailures: 2,
    degradationState: "classification-degraded",
    lastError: {
      code: "IMAP_AUTH_FAILED",
      retryable: false,
      message: `auth rejected for boss@example.com using password ${IMAP}`,
    },
  };

  it("emits only counts, timestamps and zones", () => {
    const result = summarizeMailState(realisticState);
    expect(result.status).toBe("collected");
    expect(result.privacy).toBe("safe");
    expect(result.content).toMatchObject({
      messageCount: 2,
      alertCount: 7,
      feedbackCount: 1,
      zoneHistoryCount: 1,
      scoredSenderCount: 3,
      scoredDomainCount: 2,
      consecutiveFailures: 0,
      lastScanLlmFailures: 2,
      degradationState: "classification-degraded",
    });
  });

  it("counts alert zones without carrying any alert content", () => {
    const content = summarizeMailState(realisticState).content as { zoneCounts: unknown };
    // The realistic fixture includes one alert with an out-of-vocabulary zone.
    // It is tallied under `other` rather than echoed as a key: an unrecognised
    // zone string is attacker-influenceable and has carried email body text.
    expect(content.zoneCounts).toEqual({ red: 2, amber: 1, gray: 1, other: 1 });
  });

  it("carries the diagnostic timestamps through", () => {
    const content = summarizeMailState(realisticState).content as Record<string, unknown>;
    expect(content.lastPollAt).toBe("2026-07-26T10:00:00.000Z");
    expect(content.lastAlertAt).toBe("2026-07-26T09:30:00.000Z");
    expect(content.lastImapSuccessAt).toBe("2026-07-26T10:00:00.000Z");
  });

  it("LEAK GUARD: no subject, snippet, sender or domain appears anywhere", () => {
    // The single most important assertion in this file. The whole serialized
    // result is searched, not individual fields, because a leak that appears in
    // a field nobody thought to check is exactly the failure mode.
    const serialized = serialize(summarizeMailState(realisticState).content);

    expect(serialized).not.toContain(EMAIL_BODY);
    expect(serialized).not.toContain(IMAP);
    expect(serialized).not.toContain("boss@example.com");
    expect(serialized).not.toContain("hr@example.com");
    expect(serialized).not.toContain("billing@acme-competitor.com");
    expect(serialized).not.toContain("acme-competitor.com");
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("example.org");
    expect(serialized).not.toContain("quarterly numbers");
    expect(serialized).not.toContain("Invoice");
    expect(serialized).not.toContain("confidential");
    // No address-shaped substring survives at all.
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
  });

  it("keeps the error CODE, which is the diagnostic value", () => {
    const content = summarizeMailState(realisticState).content as {
      lastError: { code: string; retryable: boolean; message: string };
    };
    expect(content.lastError.code).toBe("IMAP_AUTH_FAILED");
    expect(content.lastError.retryable).toBe(false);
  });

  it("redacts the error MESSAGE rather than dropping it", () => {
    const content = summarizeMailState(realisticState).content as {
      lastError: { message: string };
    };
    expect(content.lastError.message).not.toContain(IMAP);
    expect(content.lastError.message).not.toContain("boss@example.com");
    // Something survives so an operator error string stays useful.
    expect(content.lastError.message.length).toBeGreaterThan(0);
    expect(content.lastError.message).toContain(REDACTED_PII);
  });

  it("does not emit the weight maps themselves, only their cardinality", () => {
    const content = summarizeMailState(realisticState).content as Record<string, unknown>;
    expect(content.senderWeights).toBeUndefined();
    expect(content.domainWeights).toBeUndefined();
    expect(content.learning).toBeUndefined();
    expect(content.messages).toBeUndefined();
    expect(content.alerts).toBeUndefined();
    expect(content.scoredSenderCount).toBe(3);
    expect(content.scoredDomainCount).toBe(2);
  });
});

describe("summarizeMailState — degenerate inputs", () => {
  const degenerate: readonly [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "not an object"],
    ["a boolean", true],
  ];

  for (const [label, value] of degenerate) {
    it(`reports unavailable without throwing for ${label}`, () => {
      let result!: ReturnType<typeof summarizeMailState>;
      expect(() => {
        result = summarizeMailState(value);
      }).not.toThrow();
      expect(result.status).toBe("unavailable");
      expect(result.reason).toBe("state file absent or unreadable");
      expect(result.content).toBeUndefined();
    });
  }

  it("handles an empty object with zeroed counters", () => {
    const result = summarizeMailState({});
    expect(result.status).toBe("collected");
    expect(result.content).toMatchObject({
      messageCount: 0,
      alertCount: 0,
      feedbackCount: 0,
      zoneHistoryCount: 0,
      scoredSenderCount: 0,
      scoredDomainCount: 0,
      zoneCounts: {},
      lastError: null,
    });
  });

  it("treats object-shaped collections as countable", () => {
    const result = summarizeMailState({ messages: { a: 1, b: 2 }, alerts: {} });
    expect(result.content).toMatchObject({ messageCount: 2, alertCount: 0 });
  });

  it("counts non-array, non-object collections as zero", () => {
    const result = summarizeMailState({ messages: "not a collection", alerts: 7 });
    expect(result.content).toMatchObject({ messageCount: 0, alertCount: 0 });
  });

  it("nulls the timestamps that are absent rather than omitting them", () => {
    const content = summarizeMailState({}).content as Record<string, unknown>;
    expect(content.lastPollAt).toBeNull();
    expect(content.lastAlertAt).toBeNull();
    expect(content.lastImapSuccessAt).toBeNull();
    expect(content.degradationState).toBeNull();
  });

  it("handles a lastError with missing fields", () => {
    const content = summarizeMailState({ lastError: {} }).content as {
      lastError: { code: string; retryable: boolean; message: string };
    };
    expect(content.lastError.code).toBe("unknown");
    expect(content.lastError.retryable).toBe(false);
    expect(content.lastError.message).toBe("");
  });

  it("treats a non-object lastError as absent", () => {
    const content = summarizeMailState({ lastError: "boom" }).content as Record<string, unknown>;
    expect(content.lastError).toBeNull();
  });

  it("ignores alerts whose zone is not a string", () => {
    const content = summarizeMailState({
      alerts: [{ zone: 5 }, { zone: null }, { zone: "red" }],
    }).content as { zoneCounts: Record<string, number> };
    // Non-string zones are counted, not dropped. Dropping them would understate
    // the alert total and hide the fact that the state file is malformed —
    // which is itself the diagnostic signal a founder needs.
    expect(content.zoneCounts).toEqual({ red: 1, other: 2 });
  });

  it("names the artifact consistently in every branch", () => {
    expect(summarizeMailState(null).name).toBe("mail-sentinel-summary.json");
    expect(summarizeMailState({}).name).toBe("mail-sentinel-summary.json");
  });
});

describe("collectUnitStates", () => {
  it("parses key=value output for every supported unit", async () => {
    const run = vi.fn<RunCommand>(
      alwaysReturns(
        [
          "LoadState=loaded",
          "ActiveState=active",
          "SubState=running",
          "Result=success",
          "NRestarts=0",
          "ExecMainStatus=0",
          "UnitFileState=enabled",
        ].join("\n"),
      ),
    );
    const result = await collectUnitStates(run);

    expect(result.status).toBe("collected");
    expect(result.name).toBe("service-states.json");
    expect(result.privacy).toBe("safe");
    expect(run).toHaveBeenCalledTimes(SUPPORTED_UNITS.length);

    const content = result.content as Record<string, Record<string, string>>;
    for (const unit of SUPPORTED_UNITS) {
      expect(content[unit]).toMatchObject({ ActiveState: "active", NRestarts: "0" });
    }
  });

  it("invokes systemctl with constant argv and the collector timeout", async () => {
    const run = vi.fn<RunCommand>(alwaysReturns("ActiveState=active"));
    await collectUnitStates(run);
    const [file, args, timeout] = run.mock.calls[0] ?? [];
    expect(file).toBe("systemctl");
    expect(args?.[0]).toBe("show");
    expect(args?.[1]).toBe(SUPPORTED_UNITS[0]);
    expect(timeout).toBe(COLLECTOR_TIMEOUT_MS);
  });

  it("captures the restart counter that distinguishes stopped from crash-looping", async () => {
    const run = alwaysReturns("ActiveState=failed\nNRestarts=17\nResult=exit-code");
    const content = (await collectUnitStates(run)).content as Record<
      string,
      Record<string, string>
    >;
    expect(content[SUPPORTED_UNITS[0]]).toMatchObject({
      ActiveState: "failed",
      NRestarts: "17",
      Result: "exit-code",
    });
  });

  it("records a per-unit error but stays collected on partial failure", async () => {
    let call = 0;
    const run: RunCommand = async () => {
      call += 1;
      if (call === 2) {
        throw new Error("Unit sovereign-pro-api.service could not be found.");
      }
      return { stdout: "ActiveState=active", stderr: "" };
    };
    const result = await collectUnitStates(run);

    // One unit failing does not invalidate the others.
    expect(result.status).toBe("collected");
    const content = result.content as Record<string, Record<string, string>>;
    expect(content[SUPPORTED_UNITS[1]]?.error).toContain("could not be found");
    expect(content[SUPPORTED_UNITS[0]]).toMatchObject({ ActiveState: "active" });
  });

  it("reports unavailable when every unit fails", async () => {
    const result = await collectUnitStates(alwaysFails);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("systemctl unavailable or no units known");
  });

  it("redacts a secret that appears in a unit error message", async () => {
    const run: RunCommand = async () => {
      throw new Error(`spawn failed with password ${IMAP}`);
    };
    const result = await collectUnitStates(run);
    expect(serialize(result)).not.toContain(IMAP);
    expect(serialize(result)).toContain(REDACTED);
  });

  it("redacts a secret that appears in systemctl stdout", async () => {
    const run = alwaysReturns(`ActiveState=active\nEnvironment=api_key=${IMAP}`);
    const result = await collectUnitStates(run);
    expect(serialize(result)).not.toContain(IMAP);
  });

  it("ignores malformed output lines", async () => {
    const run = alwaysReturns("no-equals-sign\n=leading-equals\nActiveState=active\n");
    const content = (await collectUnitStates(run)).content as Record<
      string,
      Record<string, string>
    >;
    expect(content[SUPPORTED_UNITS[0]]).toEqual({ ActiveState: "active" });
  });

  it("never throws when the runner always rejects", async () => {
    await expect(collectUnitStates(alwaysFails)).resolves.toBeDefined();
  });

  it("handles a non-Error rejection", async () => {
    const run: RunCommand = async () => {
      throw "a bare string rejection";
    };
    const result = await collectUnitStates(run);
    expect(result.status).toBe("unavailable");
    expect(serialize(result)).toContain("a bare string rejection");
  });
});

describe("collectJournalTail", () => {
  const unit = SUPPORTED_UNITS[0];

  it("collects a redacted tail", async () => {
    const run = vi.fn<RunCommand>(alwaysReturns("2026-07-26T10:00:00 node started\n"));
    const result = await collectJournalTail(unit, run);

    expect(result.status).toBe("collected");
    expect(result.name).toBe(`journal-${unit}.txt`);
    expect(result.privacy).toBe("technical");
    expect(result.content).toContain("node started");
  });

  it("invokes journalctl with the line cap and no pager", async () => {
    const run = vi.fn<RunCommand>(alwaysReturns(""));
    await collectJournalTail(unit, run);
    const [file, args, timeout] = run.mock.calls[0] ?? [];
    expect(file).toBe("journalctl");
    expect(args).toEqual([
      "-u",
      unit,
      "-n",
      String(JOURNAL_LINE_LIMIT),
      "--no-pager",
      "--output=short-iso",
    ]);
    expect(timeout).toBe(COLLECTOR_TIMEOUT_MS);
  });

  it("caps content at MAX_ARTIFACT_BYTES", async () => {
    const result = await collectJournalTail(
      unit,
      alwaysReturns("x".repeat(MAX_ARTIFACT_BYTES * 2)),
    );
    const content = result.content as string;
    expect(content.length).toBeLessThan(MAX_ARTIFACT_BYTES + 100);
    expect(content).toContain("[truncated]");
  });

  it("does not truncate content already under the cap", async () => {
    const result = await collectJournalTail(unit, alwaysReturns("short line"));
    expect(result.content).not.toContain("[truncated]");
  });

  it("redacts secrets in journal content", async () => {
    // The journal is the highest-risk artifact: free text the node does not
    // control, and where secrets accidentally end up.
    const result = await collectJournalTail(
      unit,
      alwaysReturns(
        [
          `imap login failed with password ${IMAP}`,
          "Authorization: Bearer TEST_MATRIX_TOKEN_DO_NOT_LEAK",
          "delivery for boss@example.com",
        ].join("\n"),
      ),
    );
    const content = result.content as string;
    expect(content).not.toContain(IMAP);
    expect(content).not.toContain("TEST_MATRIX_TOKEN_DO_NOT_LEAK");
    expect(content).not.toContain("boss@example.com");
  });

  it("strips ANSI escapes from journal content", async () => {
    const esc = String.fromCharCode(0x1b);
    const result = await collectJournalTail(unit, alwaysReturns(`${esc}[31mERROR${esc}[0m boom`));
    expect(result.content as string).not.toContain(esc);
    expect(result.content as string).toContain("ERROR boom");
  });

  it("reports unavailable with a redacted reason on failure", async () => {
    const run: RunCommand = async () => {
      throw new Error(`journalctl denied for user with password ${IMAP}`);
    };
    const result = await collectJournalTail(unit, run);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBeDefined();
    expect(result.reason).not.toContain(IMAP);
    expect(result.content).toBeUndefined();
  });

  it("falls back to a default reason for a non-Error rejection", async () => {
    const run: RunCommand = async () => {
      throw "nope";
    };
    const result = await collectJournalTail(unit, run);
    expect(result.reason).toBe("journalctl unavailable or permission denied");
  });

  it("never throws for any supported unit when the runner always rejects", async () => {
    for (const supported of SUPPORTED_UNITS) {
      await expect(collectJournalTail(supported, alwaysFails)).resolves.toMatchObject({
        status: "unavailable",
      });
    }
  });
});

describe("collectSystemResources", () => {
  const dfOutput = [
    "Filesystem     1024-blocks     Used Available Capacity Mounted on",
    "/dev/sda1         61251280 20180416  37934080      35% /",
  ].join("\n");

  it("parses df output", async () => {
    const result = await collectSystemResources(alwaysReturns(dfOutput));
    expect(result.status).toBe("collected");
    expect(result.name).toBe("system-resources.json");
    expect(result.content).toMatchObject({
      rootFilesystem: {
        totalKb: 61251280,
        usedKb: 20180416,
        availableKb: 37934080,
        usePercent: "35%",
      },
    });
  });

  it("invokes df with constant argv", async () => {
    const run = vi.fn<RunCommand>(alwaysReturns(dfOutput));
    await collectSystemResources(run);
    expect(run).toHaveBeenCalledWith("df", ["-Pk", "/"], COLLECTOR_TIMEOUT_MS);
  });

  it("falls back when df fails, and still reports memory", async () => {
    const result = await collectSystemResources(alwaysFails);
    // Status stays `collected` because memory and load average are still real.
    expect(result.status).toBe("collected");
    expect(result.content).toMatchObject({ rootFilesystem: { error: "df unavailable" } });
    expect(
      (result.content as { memory: { totalBytes: number } }).memory.totalBytes,
    ).toBeGreaterThan(0);
  });

  it("handles df output with no data row", async () => {
    const result = await collectSystemResources(alwaysReturns("Filesystem 1024-blocks"));
    expect(result.content).toMatchObject({
      rootFilesystem: { totalKb: 0, usedKb: 0, availableKb: 0, usePercent: "unknown" },
    });
  });

  it("includes memory and load average", async () => {
    const content = (await collectSystemResources(alwaysReturns(dfOutput))).content as {
      memory: { totalBytes: number; freeBytes: number };
      loadAverage: number[];
    };
    expect(content.memory.totalBytes).toBeGreaterThan(0);
    expect(content.memory.freeBytes).toBeGreaterThanOrEqual(0);
    expect(content.loadAverage).toHaveLength(3);
  });

  it("emits no filesystem paths beyond the root filesystem figures", async () => {
    const serialized = serialize((await collectSystemResources(alwaysReturns(dfOutput))).content);
    expect(serialized).not.toContain("/dev/sda1");
    expect(serialized).not.toContain("Mounted on");
  });

  it("never throws when the runner always rejects", async () => {
    await expect(collectSystemResources(alwaysFails)).resolves.toMatchObject({
      status: "collected",
    });
  });
});

describe("collectClockState", () => {
  const timedatectlOutput = [
    "NTPSynchronized=yes",
    "Timezone=Europe/Berlin",
    "TimeUSec=Sun 2026-07-26 10:15:30 CEST",
  ].join("\n");

  it("parses key=value output", async () => {
    const result = await collectClockState(alwaysReturns(timedatectlOutput));
    expect(result.status).toBe("collected");
    expect(result.name).toBe("clock.json");
    expect(result.privacy).toBe("safe");
    expect(result.content).toMatchObject({
      NTPSynchronized: "yes",
      Timezone: "Europe/Berlin",
    });
  });

  it("stamps an observedAt timestamp", async () => {
    const content = (await collectClockState(alwaysReturns(timedatectlOutput))).content as {
      observedAt: string;
    };
    // The observation time is what makes drift measurable against TimeUSec.
    expect(() => new Date(content.observedAt).toISOString()).not.toThrow();
    expect(content.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("invokes timedatectl with constant argv", async () => {
    const run = vi.fn<RunCommand>(alwaysReturns(timedatectlOutput));
    await collectClockState(run);
    expect(run).toHaveBeenCalledWith(
      "timedatectl",
      ["show", "-p", "NTPSynchronized", "-p", "Timezone", "-p", "TimeUSec"],
      COLLECTOR_TIMEOUT_MS,
    );
  });

  it("detects an unsynchronised clock", async () => {
    const result = await collectClockState(alwaysReturns("NTPSynchronized=no\nTimezone=UTC"));
    expect(result.content).toMatchObject({ NTPSynchronized: "no" });
  });

  it("ignores malformed lines", async () => {
    const result = await collectClockState(alwaysReturns("garbage\nNTPSynchronized=yes\n"));
    expect(result.content).toMatchObject({ NTPSynchronized: "yes" });
  });

  it("reports unavailable with a redacted reason on failure", async () => {
    const run: RunCommand = async () => {
      throw new Error(`timedatectl failed, token ${IMAP}`);
    };
    const result = await collectClockState(run);
    expect(result.status).toBe("unavailable");
    expect(result.reason).not.toContain(IMAP);
    expect(result.content).toBeUndefined();
  });

  it("falls back to a default reason for a non-Error rejection", async () => {
    const run: RunCommand = async () => {
      throw 42;
    };
    expect((await collectClockState(run)).reason).toBe("timedatectl unavailable");
  });

  it("never throws when the runner always rejects", async () => {
    await expect(collectClockState(alwaysFails)).resolves.toMatchObject({
      status: "unavailable",
    });
  });
});

describe("collector failure tolerance — the shared contract", () => {
  it("no collector throws when every command fails", async () => {
    // The bundle must document the breakage rather than fail to generate, which
    // is exactly when a bundle is most needed.
    const results = await Promise.all([
      collectUnitStates(alwaysFails),
      collectSystemResources(alwaysFails),
      collectClockState(alwaysFails),
      collectJournalTail(SUPPORTED_UNITS[0], alwaysFails),
    ]);
    for (const result of results) {
      expect(typeof result.name).toBe("string");
      expect(result.name.length).toBeGreaterThan(0);
      expect(typeof result.purpose).toBe("string");
      expect(["collected", "unavailable", "skipped", "failed"]).toContain(result.status);
    }
  });

  it("no collector throws when a command hangs then rejects on timeout", async () => {
    const timesOut: RunCommand = async () => {
      throw Object.assign(new Error("ETIMEDOUT"), { killed: true, signal: "SIGKILL" });
    };
    await expect(collectUnitStates(timesOut)).resolves.toBeDefined();
    await expect(collectClockState(timesOut)).resolves.toBeDefined();
    await expect(collectSystemResources(timesOut)).resolves.toBeDefined();
    await expect(collectJournalTail(SUPPORTED_UNITS[0], timesOut)).resolves.toBeDefined();
  });

  it("no collector leaks a secret through any failure path", async () => {
    const leaky: RunCommand = async () => {
      throw new Error(`failed: OPENROUTER_API_KEY=${IMAP} and boss@example.com`);
    };
    const results = await Promise.all([
      collectUnitStates(leaky),
      collectSystemResources(leaky),
      collectClockState(leaky),
      collectJournalTail(SUPPORTED_UNITS[0], leaky),
    ]);
    for (const result of results) {
      const serialized = serialize(result);
      expect(serialized).not.toContain(IMAP);
      expect(serialized).not.toContain("boss@example.com");
    }
  });
});

describe("module constants", () => {
  it("bounds the journal line count", () => {
    expect(JOURNAL_LINE_LIMIT).toBe(200);
  });

  it("bounds a single artifact", () => {
    expect(MAX_ARTIFACT_BYTES).toBe(256 * 1024);
  });

  it("bounds every collector's wall clock", () => {
    expect(COLLECTOR_TIMEOUT_MS).toBe(10_000);
  });

  it("exposes units as a fixed compile-time list", () => {
    // A caller cannot ask for an arbitrary unit, which keeps this off the path
    // of user-controlled argv entirely.
    expect(SUPPORTED_UNITS.length).toBeGreaterThan(0);
    for (const unit of SUPPORTED_UNITS) {
      expect(unit).toMatch(/^[a-z0-9-]+$/u);
    }
  });
});

describe("collectGatewaySyncOrdering", () => {
  const runWith = (gatewayStart: string, synapseStart: string): RunCommand =>
    (async (file: string) =>
      file === "systemctl"
        ? { stdout: `ActiveState=active\nActiveEnterTimestamp=${gatewayStart}\n`, stderr: "" }
        : { stdout: `${synapseStart}\n`, stderr: "" }) as RunCommand;

  it("suspects an orphaned sync when Synapse started after the gateway", async () => {
    // The audit's #1 incident: homeserver restarted, gateway left stale.
    const result = await collectGatewaySyncOrdering(
      runWith("Mon 2026-07-27 09:00:00 UTC", "2026-07-27T10:00:00.000Z"),
    );
    const content = result.content as { suspected: boolean; note: string };
    expect(result.status).toBe("collected");
    expect(content.suspected).toBe(true);
    expect(content.note).toContain("SAN-MATRIX-003");
  });

  it("does not suspect when the gateway started after Synapse", async () => {
    const result = await collectGatewaySyncOrdering(
      runWith("Mon 2026-07-27 11:00:00 UTC", "2026-07-27T10:00:00.000Z"),
    );
    expect((result.content as { suspected: boolean }).suspected).toBe(false);
  });

  it("reports ordering as undetermined rather than guessing when a time is unparseable", async () => {
    const result = await collectGatewaySyncOrdering(runWith("n/a", "not-a-date"));
    const content = result.content as { suspected: boolean; note: string };
    expect(content.suspected).toBe(false);
    expect(content.note).toContain("could not be determined");
  });

  it("degrades to unavailable instead of throwing when the probes fail", async () => {
    const failing: RunCommand = async () => {
      throw new Error("docker: command not found");
    };
    const result = await collectGatewaySyncOrdering(failing);
    expect(result.status).toBe("unavailable");
    expect(result.content).toBeUndefined();
  });
});

describe("summarizeMailState — hostile state file (regression: adversarial review 2026-07-27)", () => {
  // The state file is the ONE collector input that is never schema-validated:
  // support-bundle.ts does a bare JSON.parse, and Mail Sentinel's own loader
  // only checks Array.isArray. An adversarial review used exactly this shape to
  // get a Matrix token, an OpenRouter key, an email address and private body
  // text into a shipped bundle while it still reported complete: true.
  const hostile = {
    alerts: [
      { zone: "red: PRIVATE_BODY_MARKER_DO_NOT_LEAK" },
      { zone: "victim.person@private-domain.example" },
      { zone: "leak syt_AAAAAAAAAAAAAAAA_tokenmarker" },
    ],
    lastImapSuccessAt: "syt_AAAAAAAAAAAAAAAA_tokenmarker",
    degradationState: "llm key sk-or-v1-AAAAAABBBBBBCCCCCC rejected",
    lastPollAt: { nested: "OPENROUTER_API_KEY=KEY_MARKER_DO_NOT_LEAK" },
    lastError: { code: "CODE_WITH_secret_sk-or-v1-DDDDDDEEEEEE", message: "x", retryable: false },
    messages: {},
    learning: { senderWeights: {}, domainWeights: {} },
  };

  const markers = [
    "PRIVATE_BODY_MARKER_DO_NOT_LEAK",
    "victim.person@private-domain.example",
    "syt_AAAAAAAAAAAAAAAA_tokenmarker",
    "sk-or-v1-AAAAAABBBBBBCCCCCC",
    "KEY_MARKER_DO_NOT_LEAK",
    "sk-or-v1-DDDDDDEEEEEE",
  ];

  it("emits no marker from any hostile field", () => {
    const serialized = JSON.stringify(summarizeMailState(hostile).content);
    for (const marker of markers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("buckets unrecognised zones instead of echoing them as keys", () => {
    const content = summarizeMailState(hostile).content as {
      zoneCounts: Record<string, number>;
    };
    expect(Object.keys(content.zoneCounts)).toEqual(["other"]);
    expect(content.zoneCounts.other).toBe(3);
  });

  it("reports non-conforming scalars as null rather than passing them through", () => {
    const content = summarizeMailState(hostile).content as Record<string, unknown>;
    // A field that should hold a timestamp but holds a token is not a timestamp.
    expect(content.lastImapSuccessAt).toBeNull();
    expect(content.lastPollAt).toBeNull();
    expect(content.degradationState).toBe("unknown");
  });

  it("redacts the error code, which is a string from an unvalidated file", () => {
    const content = summarizeMailState(hostile).content as { lastError: { code: string } };
    expect(content.lastError.code).not.toContain("sk-or-v1-DDDDDDEEEEEE");
    expect(content.lastError.code).toContain("[REDACTED]");
  });

  it("keeps a well-formed timestamp, so the guard does not destroy real evidence", () => {
    const content = summarizeMailState({
      ...hostile,
      lastImapSuccessAt: "2026-07-27T08:00:00.000Z",
    }).content as { lastImapSuccessAt: string | null };
    expect(content.lastImapSuccessAt).toBe("2026-07-27T08:00:00.000Z");
  });
});
