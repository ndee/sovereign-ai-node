import { describe, expect, it } from "vitest";

import { normalizeErrorDetail } from "./common.js";

describe("normalizeErrorDetail", () => {
  it("preserves structured installer errors", () => {
    expect(
      normalizeErrorDetail(
        {
          code: "BOT_REPO_NOT_FOUND",
          message: "The Sovereign bot repository was not found.",
          retryable: true,
          details: {
            workspaceRoot: "/opt",
          },
        },
        "CLI_ERROR",
      ),
    ).toEqual({
      code: "BOT_REPO_NOT_FOUND",
      message: "The Sovereign bot repository was not found.",
      retryable: true,
      details: {
        workspaceRoot: "/opt",
      },
    });
  });

  it("falls back to the provided error code for plain exceptions", () => {
    expect(normalizeErrorDetail(new Error("boom"), "CLI_ERROR")).toEqual({
      code: "CLI_ERROR",
      message: "boom",
      retryable: false,
    });
  });
});
