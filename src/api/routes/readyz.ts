import type { FastifyInstance } from "fastify";

import type { AppContainer } from "../../app/create-app.js";
import type { DoctorReport } from "../../contracts/index.js";

/**
 * Hard ceiling on a single readiness evaluation.
 *
 * `getDoctorReport` shells out to `openclaw`, `systemctl` and `df`. Each of
 * those has its own timeout, but a wedged host (D-state process, hung NFS
 * mount) can still stall the aggregate indefinitely. A poller that blocks
 * forever is worse than one that gets a fast, honest 503, so the whole report
 * is raced against this deadline.
 */
export const READYZ_TIMEOUT_MS = 10_000;

/** Compact, poll-friendly readiness payload. */
export type ReadyzBody = {
  ok: boolean;
  /** Mirrors DoctorReport.overall, plus "unknown" when the report never landed. */
  status: "pass" | "warn" | "fail" | "unknown";
  /** Number of checks that returned "pass". A count only — never their names. */
  passing: number;
  /**
   * Only the checks that are NOT passing, as id + status. Deliberately omits
   * `name`, `message` and `details`: doctor puts mount points, resolved binary
   * paths, commit SHAs, detected versions and truncated command output in
   * those, and this endpoint is polled by things that log their responses.
   */
  failing: Array<{ id: string; status: "warn" | "fail" }>;
  /** Set only on the internal-error / timeout paths. */
  reason?: "readiness check timed out" | "readiness check failed";
};

const summarize = (report: DoctorReport): ReadyzBody => {
  const failing = report.checks
    .filter((entry) => entry.status !== "pass")
    .map((entry) => ({ id: entry.id, status: entry.status as "warn" | "fail" }));

  return {
    // "warn" is degraded-but-serving, so it stays ok:true / HTTP 200. Only a
    // hard "fail" takes the node out of rotation.
    ok: report.overall !== "fail",
    status: report.overall,
    passing: report.checks.length - failing.length,
    failing,
  };
};

/**
 * `GET /readyz` — real readiness, as opposed to `/healthz`'s liveness.
 *
 * `/healthz` is FROZEN: it answers an unconditional `{ ok: true }` and the
 * installer's `wait_for_healthz` depends on exactly that. `/readyz` is the
 * additive endpoint that actually inspects the node. Nothing is wired to it in
 * this change by design — moving the installer over is a separate step so a
 * readiness bug cannot brick an in-flight install.
 *
 * Readiness is derived entirely from the EXISTING doctor report. Doctor is
 * already the node's health framework; a second, parallel set of checks would
 * only drift from it. Doctor performs local probes only (`openclaw health`,
 * `systemctl show`, `df`, reads of the runtime config) — it makes no
 * provider-billed calls, so polling this endpoint never costs OpenRouter
 * credits. Keep it that way.
 *
 * Auth: registered so it stays reachable without a session, matching
 * `/healthz` (allowlisted in api/auth/middleware.ts). Monitoring and the
 * updater have no session to present, and this API binds 127.0.0.1:8787 by
 * default (see bin/sovereign-node-api.ts), so the audience is already
 * local-only. The body is still reduced to ids and statuses rather than
 * relying on that binding — the loopback default is a deployment choice, not
 * an invariant.
 */
export const registerReadyzRoutes = (server: FastifyInstance, app: AppContainer): void => {
  server.get("/readyz", async (_request, reply) => {
    // The Promise executor runs synchronously, so `timer` is always assigned
    // before the race is awaited — no undefined guard needed in `finally`.
    let timer!: NodeJS.Timeout;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, READYZ_TIMEOUT_MS);
      });

      const outcome = await Promise.race([app.installerService.getDoctorReport(), timeout]);

      if (outcome === "timeout") {
        return await reply.code(503).send({
          ok: false,
          status: "unknown",
          passing: 0,
          failing: [],
          reason: "readiness check timed out",
        } satisfies ReadyzBody);
      }

      const body = summarize(outcome);
      return await reply.code(body.ok ? 200 : 503).send(body);
    } catch {
      // Never throw, and never echo the error: doctor failures carry command
      // lines and filesystem paths. A fixed reason string is all a poller can
      // act on anyway; the detail belongs in `sovereign-node doctor`.
      return await reply.code(503).send({
        ok: false,
        status: "unknown",
        passing: 0,
        failing: [],
        reason: "readiness check failed",
      } satisfies ReadyzBody);
    } finally {
      clearTimeout(timer);
    }
  });
};
