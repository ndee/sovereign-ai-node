import { describe, expect, it } from "vitest";

import {
  buildOpenClawClosedToolPolicy,
  isOpenClawCoreToolId,
  OPENCLAW_CORE_TOOL_GROUP_IDS,
  resolveOpenClawScanAgentId,
} from "./agent-tool-policy.js";

describe("buildOpenClawClosedToolPolicy", () => {
  it("allows the plugin tools plus a denied core anchor and denies every core group", () => {
    expect(buildOpenClawClosedToolPolicy(["mail_sentinel", "exec", "mail_sentinel"])).toEqual({
      allow: ["mail_sentinel", "session_status"],
      deny: [...OPENCLAW_CORE_TOOL_GROUP_IDS],
    });
  });

  it("denies the shell, process, browser and web tools through their groups", () => {
    const { deny } = buildOpenClawClosedToolPolicy(["llm-task"]);
    expect(deny).toEqual(
      expect.arrayContaining([
        "group:runtime",
        "group:fs",
        "group:web",
        "group:ui",
        "group:sessions",
      ]),
    );
  });
});

describe("isOpenClawCoreToolId", () => {
  it("recognizes core tools case-insensitively", () => {
    expect(isOpenClawCoreToolId(" Exec ")).toBe(true);
    expect(isOpenClawCoreToolId("llm-task")).toBe(false);
  });
});

describe("resolveOpenClawScanAgentId", () => {
  it("derives the scan agent id from the chat agent id", () => {
    expect(resolveOpenClawScanAgentId("mail-sentinel")).toBe("mail-sentinel-scan");
  });
});
