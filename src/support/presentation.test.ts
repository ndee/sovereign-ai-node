import { describe, expect, it } from "vitest";

import type { DoctorReport, SovereignStatus } from "../contracts/index.js";
import { buildDiagnosticsPresentation, diagnosticsPresentationSchema } from "./presentation.js";

const NOW = new Date("2026-07-29T12:00:00.000Z");

const baseStatus = (overrides: Partial<SovereignStatus> = {}): SovereignStatus =>
  ({
    mode: "bundled_matrix",
    services: [],
    matrix: {
      homeserverUrl: "https://matrix.example.org",
      health: "healthy",
      roomReachable: true,
      federationEnabled: false,
      alertRoomId: "!room:matrix.example.org",
    },
    openclaw: {
      managedBySovereign: true,
      cliInstalled: true,
      health: "healthy",
      serviceInstalled: true,
      serviceState: "running",
      agentPresent: true,
      cronPresent: true,
    },
    bots: {
      "mail-sentinel": { fields: {}, health: "healthy" },
      "node-operator": { fields: {}, health: "healthy" },
    },
    hostResources: [],
    imap: {
      authStatus: "ok",
      host: "imap.example.org",
      mailbox: "INBOX",
      lastCredentialTestAt: "2026-07-29T11:00:00.000Z",
    },
    version: { contractVersion: "1.0.0" },
    ...overrides,
  }) as SovereignStatus;

const baseDoctor = (overrides: Partial<DoctorReport> = {}): DoctorReport => ({
  overall: "pass",
  checks: [
    { id: "gateway-service-health", name: "Gateway", status: "pass", message: "ok" },
    { id: "managed-bot-registration", name: "Bots", status: "pass", message: "ok" },
    { id: "disk-space-root", name: "Disk", status: "pass", message: "ok" },
  ],
  suggestedCommands: [],
  ...overrides,
});

const healthyMailState = { degradationState: "healthy", lastScanAt: "2026-07-29T11:30:00.000Z" };

describe("buildDiagnosticsPresentation", () => {
  it("reports healthy overall when everything passes", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor(),
      mailSentinelState: healthyMailState,
    });
    expect(presentation.overall).toBe("healthy");
    expect(presentation.checkedAt).toBe(NOW.toISOString());
    expect(presentation.headline).toBe("All components are working normally.");
    expect(presentation.components.map((c) => c.id)).toEqual([
      "sovereign-ai-node",
      "matrix",
      "node-operator",
      "mail-sentinel",
      "mailbox",
      "classification-provider",
    ]);
    expect(presentation.components.every((c) => c.status === "healthy")).toBe(true);
    expect(diagnosticsPresentationSchema.parse(presentation)).toBeTruthy();
  });

  it("is unavailable with no components when neither status nor doctor is available", () => {
    const presentation = buildDiagnosticsPresentation({ now: NOW });
    expect(presentation.overall).toBe("unavailable");
    expect(presentation.components).toEqual([]);
  });

  it("maps classification degradation to the provider component, not the mailbox", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor(),
      mailSentinelState: { degradationState: "classification-degraded" },
    });
    expect(presentation.overall).toBe("degraded");
    const provider = presentation.components.find((c) => c.id === "classification-provider");
    expect(provider?.status).toBe("degraded");
    expect(provider?.code).toBe("SAN-LLM-001");
    const mailbox = presentation.components.find((c) => c.id === "mailbox");
    expect(mailbox?.status).toBe("healthy");
    expect(mailbox?.code).toBeUndefined();
    expect(presentation.headline).toContain("Mail is still being retrieved");
  });

  it("maps failing scans to mailbox and module failure with SAN-MAIL-001", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor(),
      mailSentinelState: { degradationState: "scans-failing" },
    });
    expect(presentation.overall).toBe("action_required");
    expect(presentation.components.find((c) => c.id === "mail-sentinel")?.code).toBe(
      "SAN-MAIL-001",
    );
    expect(presentation.components.find((c) => c.id === "mailbox")?.code).toBe("SAN-MAIL-001");
  });

  it("prefers SAN-IMAP-001 for a rejected mailbox sign-in", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus({
        imap: { authStatus: "failed", host: "imap.example.org", mailbox: "INBOX" },
      } as Partial<SovereignStatus>),
      doctorReport: baseDoctor(),
      mailSentinelState: healthyMailState,
    });
    const mailbox = presentation.components.find((c) => c.id === "mailbox");
    expect(mailbox?.status).toBe("failed");
    expect(mailbox?.code).toBe("SAN-IMAP-001");
    expect(presentation.overall).toBe("action_required");
  });

  it("maps a failed gateway to matrix and node-operator failure with SAN-MATRIX-003", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor({
        overall: "fail",
        checks: [
          { id: "gateway-service-health", name: "Gateway", status: "fail", message: "down" },
        ],
      }),
      mailSentinelState: healthyMailState,
    });
    expect(presentation.components.find((c) => c.id === "matrix")?.code).toBe("SAN-MATRIX-003");
    const operator = presentation.components.find((c) => c.id === "node-operator");
    expect(operator?.status).toBe("failed");
    expect(operator?.code).toBe("SAN-MATRIX-003");
  });

  it("degrades node-operator on a registration warning and fails it on registration failure", () => {
    const warned = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor({
        overall: "warn",
        checks: [
          { id: "managed-bot-registration", name: "Bots", status: "warn", message: "unverifiable" },
        ],
      }),
      mailSentinelState: healthyMailState,
    });
    expect(warned.components.find((c) => c.id === "node-operator")?.status).toBe("degraded");

    const failed = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor({
        overall: "fail",
        checks: [
          {
            id: "managed-bot-registration",
            name: "Bots",
            status: "fail",
            message: "agent missing",
          },
        ],
      }),
      mailSentinelState: healthyMailState,
    });
    expect(failed.components.find((c) => c.id === "node-operator")?.status).toBe("failed");
  });

  it("omits node-operator and mail-sentinel components when those bots are not installed", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus({ bots: {} } as Partial<SovereignStatus>),
      doctorReport: baseDoctor(),
    });
    const ids = presentation.components.map((c) => c.id);
    expect(ids).not.toContain("node-operator");
    expect(ids).not.toContain("mail-sentinel");
    expect(ids).not.toContain("classification-provider");
  });

  it("marks disk pressure on the node component with SAN-SYSTEM-001", () => {
    const warn = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor({
        overall: "warn",
        checks: [{ id: "disk-space-root", name: "Disk", status: "warn", message: "low" }],
      }),
      mailSentinelState: healthyMailState,
    });
    const node = warn.components.find((c) => c.id === "sovereign-ai-node");
    expect(node?.status).toBe("degraded");
    expect(node?.code).toBe("SAN-SYSTEM-001");

    const fail = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor({
        overall: "fail",
        checks: [{ id: "disk-space-root", name: "Disk", status: "fail", message: "full" }],
      }),
      mailSentinelState: healthyMailState,
    });
    expect(fail.components.find((c) => c.id === "sovereign-ai-node")?.status).toBe("failed");
  });

  it("includes relay only when enabled and reflects its connection state", () => {
    const withoutRelay = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor(),
    });
    expect(withoutRelay.components.map((c) => c.id)).not.toContain("relay");

    const relayStatus = baseStatus();
    (relayStatus as { relay?: unknown }).relay = {
      enabled: true,
      connected: false,
      serviceInstalled: true,
      serviceState: "running",
    };
    const degraded = buildDiagnosticsPresentation({
      now: NOW,
      status: relayStatus,
      doctorReport: baseDoctor(),
    });
    expect(degraded.components.find((c) => c.id === "relay")?.status).toBe("degraded");

    (relayStatus as { relay?: { serviceState?: string; connected?: boolean } }).relay = {
      enabled: true,
      connected: false,
      serviceInstalled: true,
      serviceState: "failed",
    } as never;
    const failed = buildDiagnosticsPresentation({
      now: NOW,
      status: relayStatus,
      doctorReport: baseDoctor(),
    });
    expect(failed.components.find((c) => c.id === "relay")?.status).toBe("failed");
  });

  it("includes the update service only when the caller provides updater state", () => {
    const without = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor(),
    });
    expect(without.components.map((c) => c.id)).not.toContain("update-service");

    const failed = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor(),
      mailSentinelState: healthyMailState,
      update: { status: "failed" },
    });
    const update = failed.components.find((c) => c.id === "update-service");
    expect(update?.status).toBe("degraded");
    expect(update?.code).toBe("SAN-UPDATE-001");
    expect(failed.overall).toBe("degraded");

    const unknown = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor(),
      mailSentinelState: healthyMailState,
      update: { status: "unknown" },
    });
    expect(unknown.components.find((c) => c.id === "update-service")?.status).toBe("unknown");
  });

  it("treats a missing doctor report as unknown node health, not a crash", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
    });
    expect(presentation.components.find((c) => c.id === "sovereign-ai-node")?.status).toBe(
      "unknown",
    );
  });

  it("degrades matrix when the alert room is unreachable", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus({
        matrix: {
          health: "healthy",
          roomReachable: false,
          federationEnabled: false,
        },
      } as Partial<SovereignStatus>),
      doctorReport: baseDoctor(),
    });
    expect(presentation.components.find((c) => c.id === "matrix")?.status).toBe("degraded");
  });

  it("never leaks values from inputs: only fixed sentences, codes and timestamps appear", () => {
    const SENTINELS = [
      "sk-or-v1-LEAKED-OPENROUTER",
      "syt_LEAKEDMATRIXTOKEN",
      "ghp_LEAKEDGITHUBTOKEN",
      "hunter2-mailbox-password",
      "leaked.address@example.org",
      "Re: extremely private subject",
      "/etc/sovereign-node/secrets/leak-path",
      "leaked-hostname.internal",
    ] as const;
    const poisonedStatus = baseStatus({
      imap: {
        authStatus: "failed",
        host: SENTINELS[4],
        mailbox: SENTINELS[5],
      },
    } as Partial<SovereignStatus>);
    (poisonedStatus as { installationId?: string }).installationId = SENTINELS[2];
    const poisonedDoctor = baseDoctor({
      overall: "fail",
      checks: [
        {
          id: "gateway-service-health",
          name: "leaked-hostname.internal",
          status: "fail",
          message: `token ${SENTINELS[1]} at ${SENTINELS[6]}`,
        },
      ],
      suggestedCommands: [`journalctl -u secret ${SENTINELS[0]}`],
    });
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: poisonedStatus,
      doctorReport: poisonedDoctor,
      mailSentinelState: {
        degradationState: "scans-failing",
        lastScanAt: SENTINELS[3],
        lastError: { message: SENTINELS[5] },
      },
    });
    const rendered = JSON.stringify(presentation);
    for (const sentinel of SENTINELS) {
      expect(rendered).not.toContain(sentinel);
    }
    // The poisoned lastScanAt is not a valid timestamp and must be dropped.
    expect(
      presentation.components.find((c) => c.id === "mail-sentinel")?.lastSuccessAt,
    ).toBeUndefined();
  });

  it("re-serialises valid timestamps and drops overlong or invalid ones", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus(),
      doctorReport: baseDoctor(),
      mailSentinelState: { degradationState: "healthy", lastScanAt: "2026-07-29T10:15:00+02:00" },
    });
    expect(presentation.components.find((c) => c.id === "mail-sentinel")?.lastSuccessAt).toBe(
      "2026-07-29T08:15:00.000Z",
    );
    expect(presentation.components.find((c) => c.id === "mailbox")?.lastSuccessAt).toBe(
      "2026-07-29T11:00:00.000Z",
    );
  });

  it("tolerates malformed mail state without changing shape", () => {
    for (const state of [null, 42, "junk", { degradationState: "bogus" }, []]) {
      const presentation = buildDiagnosticsPresentation({
        now: NOW,
        status: baseStatus(),
        doctorReport: baseDoctor(),
        mailSentinelState: state,
      });
      expect(diagnosticsPresentationSchema.parse(presentation)).toBeTruthy();
      // Unknown degradation info leaves the provider state unknown, not broken.
      expect(presentation.components.find((c) => c.id === "classification-provider")?.status).toBe(
        "unknown",
      );
    }
  });

  it("attaches a safe action to every non-healthy component", () => {
    const presentation = buildDiagnosticsPresentation({
      now: NOW,
      status: baseStatus({
        imap: { authStatus: "failed", host: "imap.example.org", mailbox: "INBOX" },
      } as Partial<SovereignStatus>),
      doctorReport: baseDoctor({
        overall: "fail",
        checks: [
          { id: "gateway-service-health", name: "Gateway", status: "fail", message: "down" },
        ],
      }),
      mailSentinelState: { degradationState: "classification-degraded" },
    });
    for (const component of presentation.components) {
      if (component.status !== "healthy") {
        expect(component.action).toBeTruthy();
      } else {
        expect(component.action).toBeUndefined();
      }
    }
  });
});
