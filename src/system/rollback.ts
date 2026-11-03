export type RollbackFailure = { step: string; error: string };

export type RollbackOutcome = { complete: boolean; failures: RollbackFailure[] };

export type RollbackStep = { step: string; run: () => Promise<void> };

const describeFailure = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
};

// Every step runs even after an earlier one failed: a partial restore leaves
// less to repair by hand than one that stopped at the first error.
export const runRollback = async (steps: readonly RollbackStep[]): Promise<RollbackOutcome> => {
  const failures: RollbackFailure[] = [];
  for (const { step, run } of steps) {
    try {
      await run();
    } catch (error) {
      failures.push({ step, error: describeFailure(error) });
    }
  }
  return { complete: failures.length === 0, failures };
};

const isStructuredError = (
  error: unknown,
): error is { code: string; message: string; retryable?: unknown; details?: unknown } =>
  typeof error === "object" &&
  error !== null &&
  !(error instanceof Error) &&
  typeof (error as { code?: unknown }).code === "string" &&
  typeof (error as { message?: unknown }).message === "string";

const isRollbackOutcome = (value: unknown): value is RollbackOutcome =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { complete?: unknown }).complete === "boolean" &&
  Array.isArray((value as { failures?: unknown }).failures);

/**
 * Attaches the rollback outcome to the error that triggered it. A retry is only
 * offered when the original error allowed one and the rollback put everything
 * back: after an incomplete rollback the state is mixed and must be repaired
 * before the same change can be attempted again.
 */
export const withRollbackOutcome = (
  error: unknown,
  outcome: RollbackOutcome,
  fallback: { code: string; message: string },
): { code: string; message: string; retryable: boolean; details: Record<string, unknown> } => {
  if (isStructuredError(error)) {
    const details =
      typeof error.details === "object" && error.details !== null
        ? (error.details as Record<string, unknown>)
        : {};
    // An error rolled back once already (by a lower layer) keeps that outcome
    // and adds the steps the caller undid on top.
    const previous = isRollbackOutcome(details.rollback) ? details.rollback : null;
    const merged =
      previous === null
        ? outcome
        : {
            complete: previous.complete && outcome.complete,
            failures: [...previous.failures, ...outcome.failures],
          };
    return {
      ...error,
      retryable: error.retryable === true && merged.complete,
      details: { ...details, rollback: merged },
    };
  }
  return {
    code: fallback.code,
    message: fallback.message,
    retryable: false,
    details: { error: describeFailure(error), rollback: outcome },
  };
};
