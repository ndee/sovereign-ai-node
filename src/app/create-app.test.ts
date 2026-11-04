import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./create-app.js";

type BootstrapperInternals = { resolveInstallPrefix(): Promise<string> };

describe("createApp", () => {
  const priorHome = process.env.HOME;

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = priorHome;
  });

  it("keeps OpenClaw's npm prefix in the HOME the process started with", async () => {
    vi.spyOn(process as typeof process & { getuid: () => number }, "getuid").mockReturnValue(999);
    process.env.HOME = "/var/lib/sovereign-node";
    const app = createApp();
    process.env.HOME = "/var/lib/sovereign-node/openclaw-home";

    const bootstrapper = (
      app.installerService as unknown as { openclawBootstrapper: BootstrapperInternals }
    ).openclawBootstrapper;

    await expect(bootstrapper.resolveInstallPrefix()).resolves.toBe(
      join("/var/lib/sovereign-node", ".npm-global"),
    );
  });
});
