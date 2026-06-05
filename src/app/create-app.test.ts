import { describe, expect, it } from "vitest";

import { DEFAULT_PATHS } from "../config/paths.js";
import { createApp } from "./create-app.js";

describe("createApp", () => {
  it("wires the production app container with the default paths", () => {
    const app = createApp();

    expect(app.logger).toBeDefined();
    expect(app.paths).toBe(DEFAULT_PATHS);
    expect(app.installerService).toBeDefined();
    expect(app.backupService).toBeDefined();
    // The installer service must expose its public install entry points.
    expect(typeof app.installerService.startInstall).toBe("function");
    expect(typeof app.installerService.getInstallJob).toBe("function");
  });
});
