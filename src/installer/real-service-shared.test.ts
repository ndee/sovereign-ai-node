import { describe, expect, it } from "vitest";

import { isCoreAgentBindingBestEffortSkippable } from "./real-service-shared.js";

describe("isCoreAgentBindingBestEffortSkippable", () => {
  it("treats legacy command gaps as skippable for managed agents", () => {
    const error = {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: "OpenClaw node-operator-matrix-bind registration commands failed",
      retryable: true,
      details: {
        failures: [
          {
            stderr: 'unknown command "plugins enable"',
            stdout: "",
          },
        ],
      },
    };

    expect(isCoreAgentBindingBestEffortSkippable(error)).toBe(true);
  });

  it("keeps matrix plugin load failures fatal for managed agents", () => {
    const error = {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: "OpenClaw node-operator-matrix-bind registration commands failed",
      retryable: true,
      details: {
        failures: [
          {
            stderr:
              "[plugins] matrix failed to load from /usr/lib/node_modules/openclaw/extensions/matrix/index.ts: Error: Cannot find module '/usr/lib/node_modules/openclaw/dist/plugin-sdk/index.js/keyed-async-queue'\nUnknown channel \"matrix\".",
            stdout: "",
          },
        ],
      },
    };

    expect(isCoreAgentBindingBestEffortSkippable(error)).toBe(false);
  });

  it("keeps unrelated managed agent failures non-skippable", () => {
    const error = {
      code: "MANAGED_AGENT_REGISTER_FAILED",
      message: "OpenClaw node-operator-matrix-bind registration commands failed",
      retryable: true,
      details: {
        failures: [
          {
            stderr: "permission denied",
            stdout: "",
          },
        ],
      },
    };

    expect(isCoreAgentBindingBestEffortSkippable(error)).toBe(false);
  });
});
