/**
 * Waiting for the OpenClaw gateway to listen after a restart.
 *
 * A cold gateway start loads and transpiles every bundled plugin before it
 * opens its port, which takes minutes on a small ARM board. Readiness is
 * therefore a deadline, not an attempt count, and the per-attempt signal is a
 * cheap loopback HTTP request: spawning the `openclaw` CLI to ask would pay the
 * same plugin-loading cost on every attempt.
 */

export const OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789/";
export const GATEWAY_READY_POLL_MS = 2_000;
export const GATEWAY_READY_PROBE_TIMEOUT_MS = 2_000;
export const GATEWAY_READY_DEADLINE_MS = 300_000;
export const GATEWAY_READY_DEADLINE_MIN_MS = 30_000;
export const GATEWAY_READY_DEADLINE_MAX_MS = 900_000;
export const GATEWAY_READY_TIMEOUT_ENV = "SOVEREIGN_NODE_GATEWAY_READY_TIMEOUT_MS";

export type GatewayPortProbe = { ok: boolean; reason: string };

export type GatewayUnitSnapshot = {
  /** systemd ActiveState, e.g. "active", "activating", "failed". */
  activeState?: string;
  /** systemd NRestarts; undefined when the unit manager does not report it. */
  restarts?: number;
};

export type GatewayReadinessOutcome = {
  unitStarted: boolean;
  ready: boolean;
  waitedMs: number;
  deadlineMs: number;
  lastProbe?: string;
  /** ISO time the gateway was first seen listening. */
  readyAt?: string;
  /** The systemd unit that was waited on. */
  unit?: string;
};

export type GatewayReadinessWaitDeps = {
  probe: () => Promise<GatewayPortProbe>;
  inspectUnit: () => Promise<GatewayUnitSnapshot>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
};

export const resolveGatewayReadyDeadlineMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env[GATEWAY_READY_TIMEOUT_ENV]?.trim();
  if (raw === undefined || raw.length === 0) {
    return GATEWAY_READY_DEADLINE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return GATEWAY_READY_DEADLINE_MS;
  }
  return Math.min(
    GATEWAY_READY_DEADLINE_MAX_MS,
    Math.max(GATEWAY_READY_DEADLINE_MIN_MS, Math.round(parsed)),
  );
};

/**
 * Polls until the gateway answers, the deadline passes, or systemd shows the
 * unit cannot come up (failed, or restarted by systemd during the wait: a
 * crash loop never starts listening, so waiting out the deadline is pointless).
 */
export const waitForGatewayReady = async (
  deadlineMs: number,
  deps: GatewayReadinessWaitDeps,
): Promise<GatewayReadinessOutcome> => {
  const pollMs = deps.pollMs ?? GATEWAY_READY_POLL_MS;
  const startedAt = deps.now();
  const baseline = await deps.inspectUnit();
  let lastProbe: string | undefined;

  for (;;) {
    const probe = await deps.probe();
    const waitedMs = deps.now() - startedAt;
    if (probe.ok) {
      return {
        unitStarted: true,
        ready: true,
        waitedMs,
        deadlineMs,
        readyAt: new Date(deps.now()).toISOString(),
      };
    }
    lastProbe = probe.reason;

    const unit = await deps.inspectUnit();
    if (unit.activeState === "failed") {
      return notReady(false, waitedMs, deadlineMs, `unit failed; last probe: ${lastProbe}`);
    }
    if (
      baseline.restarts !== undefined &&
      unit.restarts !== undefined &&
      unit.restarts > baseline.restarts
    ) {
      return notReady(
        false,
        waitedMs,
        deadlineMs,
        `unit restarted ${unit.restarts - baseline.restarts} time(s) while starting; last probe: ${lastProbe}`,
      );
    }

    const remainingMs = deadlineMs - waitedMs;
    if (remainingMs <= 0) {
      return notReady(true, waitedMs, deadlineMs, lastProbe);
    }
    await deps.sleep(Math.min(pollMs, remainingMs));
  }
};

const notReady = (
  unitStarted: boolean,
  waitedMs: number,
  deadlineMs: number,
  lastProbe: string,
): GatewayReadinessOutcome => ({ unitStarted, ready: false, waitedMs, deadlineMs, lastProbe });

/** The operator-facing sentence for a gateway that did not come up in time. */
export const describeGatewayNotReady = (outcome: GatewayReadinessOutcome): string => {
  const waited = Math.round(outcome.waitedMs / 1000);
  const deadline = Math.round(outcome.deadlineMs / 1000);
  const probe = outcome.lastProbe === undefined ? "" : `; last probe: ${outcome.lastProbe}`;
  return outcome.unitStarted
    ? `OpenClaw gateway unit is running but not listening after ${waited} s (deadline ${deadline} s)${probe}`
    : `OpenClaw gateway unit failed to start${probe}`;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Any HTTP response means the gateway is listening; only transport errors do not. */
export const probeGatewayHttp = async (
  fetchImpl: FetchLike,
  url: string = OPENCLAW_GATEWAY_URL,
  timeoutMs: number = GATEWAY_READY_PROBE_TIMEOUT_MS,
): Promise<GatewayPortProbe> => {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    return { ok: true, reason: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: describeProbeError(error) };
  }
};

const describeProbeError = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (typeof cause?.code === "string") {
      return cause.code;
    }
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
    return error.message;
  }
  return String(error);
};

// `systemctl show --timestamp=unix` prints `@<seconds>`; a plain value is
// accepted too, for systemd builds that ignore the flag.
const parseSystemdTimestamp = (value: string | undefined): Date | null => {
  if (value === undefined || value.length === 0) {
    return null;
  }
  const unixSeconds = /^@(\d+)$/.exec(value)?.[1];
  return unixSeconds === undefined ? new Date(value) : new Date(Number(unixSeconds) * 1000);
};

/**
 * Parses `systemctl show --timestamp=unix -p ActiveState -p NRestarts
 * -p ActiveEnterTimestamp` output.
 */
export const parseSystemctlShow = (
  stdout: string,
): GatewayUnitSnapshot & { activeEnterTimestamp?: string } => {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  const activeState = fields.get("ActiveState");
  const restarts = Number.parseInt(fields.get("NRestarts") ?? "", 10);
  const activeEnterDate = parseSystemdTimestamp(fields.get("ActiveEnterTimestamp"));
  return {
    ...(activeState === undefined || activeState.length === 0 ? {} : { activeState }),
    ...(Number.isInteger(restarts) ? { restarts } : {}),
    ...(activeEnterDate === null || Number.isNaN(activeEnterDate.getTime())
      ? {}
      : { activeEnterTimestamp: activeEnterDate.toISOString() }),
  };
};
