import { Command } from "commander";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import type { DiagnosticsPresentation } from "../../support/presentation.js";
import { registerDiagnosticsCommand, renderDiagnosticsText } from "./diagnostics.js";

const healthyStatus = {
  mode: "bundled_matrix",
  services: [],
  matrix: { health: "healthy", roomReachable: true, federationEnabled: false },
  openclaw: {
    managedBySovereign: true,
    cliInstalled: true,
    health: "healthy",
    serviceInstalled: true,
    agentPresent: true,
    cronPresent: true,
  },
  bots: {
    "mail-sentinel": { fields: {}, health: "healthy" },
    "node-operator": { fields: {}, health: "healthy" },
  },
  hostResources: [],
  imap: { authStatus: "ok", host: "imap.example.org", mailbox: "INBOX" },
  version: { contractVersion: "1.0.0" },
};

const healthyDoctor = {
  overall: "pass",
  checks: [
    { id: "gateway-service-health", name: "Gateway", status: "pass", message: "ok" },
    { id: "disk-space-root", name: "Disk", status: "pass", message: "ok" },
  ],
  suggestedCommands: [],
};

const createMockApp = (overrides: Record<string, unknown> = {}): AppContainer =>
  ({
    installerService: {
      getDoctorReport: vi.fn(async () => healthyDoctor),
      getStatus: vi.fn(async () => healthyStatus),
      ...overrides,
    },
  }) as unknown as AppContainer;

const runCli = async (app: AppContainer, args: string[]): Promise<void> => {
  const program = new Command();
  program.exitOverride();
  registerDiagnosticsCommand(program, app);
  await program.parseAsync(["node", "sovereign-node", ...args]);
};

let written: string[];
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  originalExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

const output = (): string => written.join("");

describe("sovereign-node diagnostics", () => {
  it("emits the presentation model in the JSON envelope", async () => {
    await runCli(createMockApp(), ["diagnostics", "--json"]);
    const parsed = JSON.parse(output()) as {
      ok: boolean;
      command: string;
      result: DiagnosticsPresentation;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("diagnostics");
    expect(parsed.result.overall).toBe("healthy");
    expect(parsed.result.components.map((c) => c.id)).toContain("node-operator");
  });

  it("renders readable human output without raw JSON, paths or check messages", async () => {
    await runCli(createMockApp(), ["diagnostics"]);
    const text = output();
    expect(text).toContain("Node status: Healthy");
    expect(text).toContain("Node Operator: Healthy");
    expect(text).not.toContain("{");
    expect(text).not.toContain("imap.example.org");
  });

  it("degrades to an unavailable presentation when both sources fail", async () => {
    await runCli(
      createMockApp({
        getDoctorReport: vi.fn(async () => {
          throw new Error("boom /etc/secret-path");
        }),
        getStatus: vi.fn(async () => {
          throw new Error("boom token=syt_LEAKED");
        }),
      }),
      ["diagnostics"],
    );
    const text = output();
    expect(text).toContain("Node status: Unavailable");
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain("syt_LEAKED");
    expect(process.exitCode).not.toBe(1);
  });
});

describe("renderDiagnosticsText", () => {
  it("matches the partner-facing layout with codes on a dedicated line", () => {
    const presentation: DiagnosticsPresentation = {
      contractVersion: "1.0.0",
      overall: "degraded",
      checkedAt: "2026-07-29T12:00:00.000Z",
      headline:
        "Mail is still being retrieved, but semantic classification is currently unavailable, so alert quality may be reduced.",
      components: [
        {
          id: "mailbox",
          label: "Mailbox",
          status: "healthy",
          summary: "Mail is being retrieved from the mailbox.",
        },
        {
          id: "classification-provider",
          label: "Semantic classification",
          status: "degraded",
          code: "SAN-LLM-001",
          summary: "Semantic classification is unavailable; alerts continue at reduced confidence.",
          action: "Check the classification provider key on the Node Status page, then retry.",
        },
      ],
    };
    const text = renderDiagnosticsText(presentation);
    expect(text).toBe(
      [
        "Node status: Degraded",
        "",
        "Mailbox: Healthy",
        "Semantic classification: Degraded",
        "",
        "Mail is still being retrieved, but semantic classification is currently unavailable, so alert quality may be reduced.",
        "",
        "Code: SAN-LLM-001",
        "",
      ].join("\n"),
    );
  });

  it("deduplicates repeated codes and omits the code line when none exist", () => {
    const base: DiagnosticsPresentation = {
      contractVersion: "1.0.0",
      overall: "healthy",
      checkedAt: "2026-07-29T12:00:00.000Z",
      headline: "All components are working normally.",
      components: [],
    };
    expect(renderDiagnosticsText(base)).toBe(
      ["Node status: Healthy", "", "All components are working normally.", ""].join("\n"),
    );

    const doubled: DiagnosticsPresentation = {
      ...base,
      overall: "action_required",
      headline: "One or more components need attention.",
      components: [
        {
          id: "mail-sentinel",
          label: "Mail Sentinel",
          status: "failed",
          code: "SAN-MAIL-001",
          summary: "Mail Sentinel scans are failing.",
          action: "Check the mailbox connection on the Node Status page.",
        },
        {
          id: "mailbox",
          label: "Mailbox",
          status: "failed",
          code: "SAN-MAIL-001",
          summary: "New mail is not being retrieved from the mailbox.",
          action: "Check the mailbox connection on the Node Status page.",
        },
      ],
    };
    const text = renderDiagnosticsText(doubled);
    expect(text).toContain("Node status: Action required");
    expect(text.match(/SAN-MAIL-001/g)).toHaveLength(1);
  });
});
