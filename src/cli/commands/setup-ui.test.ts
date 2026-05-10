import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import type { AppContainer } from "../../app/create-app.js";
import { StubInstallerService } from "../../installer/stub-service.js";
import { createLogger } from "../../logging/logger.js";
import { registerSetupUiCommand } from "./setup-ui.js";

const buildProgram = (): {
  program: Command;
  service: StubInstallerService;
  logger: ReturnType<typeof createLogger>;
} => {
  const logger = createLogger();
  const service = new StubInstallerService(logger);
  const program = new Command();
  program.exitOverride();
  registerSetupUiCommand(program, {
    logger,
    installerService: service,
  } as unknown as AppContainer);
  return { program, service, logger };
};

const captureStdout = async (run: () => Promise<unknown> | unknown): Promise<string> => {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
  try {
    await run();
    return chunks.join("");
  } finally {
    spy.mockRestore();
    void original;
  }
};

describe("setup-ui CLI command", () => {
  it("issues a bootstrap token with default TTL and human output", async () => {
    const { program, service } = buildProgram();
    const spy = vi.spyOn(service, "issueSetupUiBootstrapToken");
    const out = await captureStdout(() =>
      program.parseAsync(["node", "test", "setup-ui", "issue-bootstrap-token"]),
    );
    expect(spy).toHaveBeenCalledWith({ ttlMinutes: 24 * 60 });
    expect(out).toContain("Setup UI bootstrap token issued.");
    expect(out).toContain("ABCD-EFGH-JKLM");
  });

  it("forwards a custom --ttl-minutes value", async () => {
    const { program, service } = buildProgram();
    const spy = vi.spyOn(service, "issueSetupUiBootstrapToken");
    await captureStdout(() =>
      program.parseAsync([
        "node",
        "test",
        "setup-ui",
        "issue-bootstrap-token",
        "--ttl-minutes",
        "30",
      ]),
    );
    expect(spy).toHaveBeenCalledWith({ ttlMinutes: 30 });
  });

  it("emits JSON output when --json is passed", async () => {
    const { program } = buildProgram();
    const out = await captureStdout(() =>
      program.parseAsync(["node", "test", "setup-ui", "issue-bootstrap-token", "--json"]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.token).toBe("ABCD-EFGH-JKLM");
  });

  it("rejects a non-numeric --ttl-minutes with a CLI error", async () => {
    const { program } = buildProgram();
    const stderrChunks: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    try {
      await captureStdout(() =>
        program.parseAsync([
          "node",
          "test",
          "setup-ui",
          "issue-bootstrap-token",
          "--ttl-minutes",
          "not-a-number",
        ]),
      );
    } finally {
      spy.mockRestore();
    }
    expect(process.exitCode).toBe(1);
    expect(stderrChunks.join("")).toMatch(/positive integer/);
    process.exitCode = 0;
  });
});
