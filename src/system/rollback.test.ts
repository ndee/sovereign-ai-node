import { describe, expect, it } from "vitest";

import { runRollback, withRollbackOutcome } from "./rollback.js";

const FALLBACK = { code: "FALLBACK", message: "fallback message" };

describe("runRollback", () => {
  it("runs every step in order and reports a complete rollback", async () => {
    const ran: string[] = [];
    const outcome = await runRollback([
      { step: "a", run: async () => void ran.push("a") },
      { step: "b", run: async () => void ran.push("b") },
    ]);
    expect(ran).toEqual(["a", "b"]);
    expect(outcome).toEqual({ complete: true, failures: [] });
  });

  it("keeps going after a failed step and describes each failure", async () => {
    const ran: string[] = [];
    const outcome = await runRollback([
      {
        step: "error",
        run: async () => {
          throw new Error("disk full");
        },
      },
      {
        step: "structured",
        run: async () => {
          throw { code: "X", message: "helper refused" };
        },
      },
      {
        step: "string",
        run: async () => {
          throw "plain text";
        },
      },
      { step: "last", run: async () => void ran.push("last") },
    ]);
    expect(ran).toEqual(["last"]);
    expect(outcome).toEqual({
      complete: false,
      failures: [
        { step: "error", error: "disk full" },
        { step: "structured", error: "helper refused" },
        { step: "string", error: "plain text" },
      ],
    });
  });
});

describe("withRollbackOutcome", () => {
  const complete = { complete: true, failures: [] };
  const incomplete = { complete: false, failures: [{ step: "a", error: "boom" }] };

  it("keeps a structured error retryable only after a complete rollback", () => {
    const error = { code: "E", message: "m", retryable: true, details: { exitCode: 1 } };
    expect(withRollbackOutcome(error, complete, FALLBACK)).toEqual({
      code: "E",
      message: "m",
      retryable: true,
      details: { exitCode: 1, rollback: complete },
    });
    expect(withRollbackOutcome(error, incomplete, FALLBACK)).toMatchObject({
      retryable: false,
      details: { exitCode: 1, rollback: incomplete },
    });
  });

  it("never makes a non-retryable error retryable and tolerates missing details", () => {
    expect(withRollbackOutcome({ code: "E", message: "m" }, complete, FALLBACK)).toEqual({
      code: "E",
      message: "m",
      retryable: false,
      details: { rollback: complete },
    });
  });

  it("adds the caller's rollback to one a lower layer already ran", () => {
    const lower = {
      code: "E",
      message: "m",
      retryable: true,
      details: { rollback: complete },
    };
    expect(withRollbackOutcome(lower, complete, FALLBACK)).toMatchObject({
      retryable: true,
      details: { rollback: complete },
    });
    expect(withRollbackOutcome(lower, incomplete, FALLBACK)).toMatchObject({
      retryable: false,
      details: { rollback: incomplete },
    });
    const lowerIncomplete = { ...lower, details: { rollback: incomplete } };
    expect(
      withRollbackOutcome(
        lowerIncomplete,
        { complete: false, failures: [{ step: "b", error: "bang" }] },
        FALLBACK,
      ),
    ).toMatchObject({
      retryable: false,
      details: {
        rollback: {
          complete: false,
          failures: [
            { step: "a", error: "boom" },
            { step: "b", error: "bang" },
          ],
        },
      },
    });
  });

  it("wraps anything else in the fallback error", () => {
    expect(withRollbackOutcome(new Error("EIO"), complete, FALLBACK)).toEqual({
      code: "FALLBACK",
      message: "fallback message",
      retryable: false,
      details: { error: "EIO", rollback: complete },
    });
    expect(withRollbackOutcome(42, incomplete, FALLBACK)).toMatchObject({
      code: "FALLBACK",
      details: { error: "42", rollback: incomplete },
    });
  });
});
