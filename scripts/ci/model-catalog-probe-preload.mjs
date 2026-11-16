// Loaded into a probe gateway with --import. Records every outbound host
// lookup and HTTP request, and shortens the six-hour model catalog refresh
// timer so a short run sees the scheduled refreshes. Writes JSON lines to
// $SOVEREIGN_CI_PROBE_LOG.
import diagnosticsChannel from "node:diagnostics_channel";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const logPath = process.env.SOVEREIGN_CI_PROBE_LOG;
const shortenedMs = Number(process.env.SOVEREIGN_CI_PROBE_TIMER_MS ?? "1000");
const record = (entry) => {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...entry })}\n`);
  }
};

const hostOf = (origin) => {
  try {
    return new URL(String(origin)).hostname;
  } catch {
    return String(origin);
  }
};

diagnosticsChannel.subscribe("undici:request:create", ({ request }) => {
  record({ kind: "request", host: hostOf(request.origin), path: request.path });
});
diagnosticsChannel.subscribe("http.client.request.start", ({ request }) => {
  record({ kind: "request", host: request.host, path: request.path });
});

// Host lookups are recorded too, so a request that fails before it is created
// (no DNS on the runner) still counts.
const { lookup } = dns;
dns.lookup = function (hostname, ...rest) {
  record({ kind: "lookup", host: hostname });
  return lookup.call(this, hostname, ...rest);
};
const promisesLookup = dns.promises.lookup;
dns.promises.lookup = function (hostname, ...rest) {
  record({ kind: "lookup", host: hostname });
  return promisesLookup.call(this, hostname, ...rest);
};
syncBuiltinESMExports();

// OpenClaw reschedules the catalog refresh with its six-hour TTL, or the rest
// of it when the stored catalog is still fresh. No other gateway timer falls
// in this window.
const CATALOG_TIMER_MIN_MS = 5 * 60 * 60 * 1000;
const CATALOG_TIMER_MAX_MS = 6 * 60 * 60 * 1000;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (callback, ms, ...args) {
  if (
    typeof callback === "function" &&
    typeof ms === "number" &&
    ms > CATALOG_TIMER_MIN_MS &&
    ms <= CATALOG_TIMER_MAX_MS &&
    /update-startup-/.test(new Error().stack ?? "")
  ) {
    record({ kind: "catalog-timer", ms });
    return realSetTimeout.call(
      this,
      (...callbackArgs) => {
        record({ kind: "catalog-tick" });
        return callback(...callbackArgs);
      },
      shortenedMs,
      ...args,
    );
  }
  return realSetTimeout.call(this, callback, ms, ...args);
};
