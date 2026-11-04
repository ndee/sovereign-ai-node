import { describe, expect, it } from "vitest";

import {
  GUARDED_JSON_STATE_OPENCLAW_PLUGIN_ID,
  GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME,
} from "../openclaw/guarded-json-state-context.js";
import { renderGuardedJsonStateWorkspacePluginManifest } from "./real-service-guarded-json-state-plugin.js";

describe("guarded JSON state plugin manifest", () => {
  // Without contracts.tools OpenClaw 2026.8 never loads the plugin's tool.
  it("declares its one tool and loads on gateway startup", () => {
    expect(JSON.parse(renderGuardedJsonStateWorkspacePluginManifest())).toEqual({
      id: GUARDED_JSON_STATE_OPENCLAW_PLUGIN_ID,
      activation: { onStartup: true },
      contracts: { tools: [GUARDED_JSON_STATE_OPENCLAW_TOOL_NAME] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    });
  });
});
