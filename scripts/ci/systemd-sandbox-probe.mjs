// Runs inside a sandboxed unit's mount namespace and checks what the sandbox
// allows. Takes one JSON argument:
//   writable:      paths that must accept a new file
//   readOnly:      paths that must refuse a new file with EROFS
//   refused:       [command, ...args] that must fail to start with EACCES
//   allowed:       [command, ...args] that must start and exit 0
//   unreachable:   unix sockets that must not answer an HTTP request
//   reachable:     unix sockets that must answer (positive control)
//   noNewPrivs:    whether /proc/self/status must show NoNewPrivs 1 and no capabilities
// Prints one PASS/FAIL line per check and exits 1 on any failure.
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

const spec = JSON.parse(process.argv[2] ?? "{}");
let failed = false;
const report = (ok, label, detail = "") => {
  failed ||= !ok;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : `: ${detail}`}`);
};

const tryWrite = (dir) => {
  const probe = join(dir, `.sandbox-probe-${process.pid}`);
  try {
    writeFileSync(probe, "probe\n");
    unlinkSync(probe);
    return "ok";
  } catch (error) {
    return error.code ?? String(error);
  }
};

for (const dir of spec.writable ?? []) {
  const outcome = tryWrite(dir);
  report(outcome === "ok", `writable ${dir}`, outcome === "ok" ? "" : outcome);
}
for (const dir of spec.readOnly ?? []) {
  const outcome = tryWrite(dir);
  report(outcome === "EROFS", `read-only ${dir}`, outcome);
}
for (const [command, ...args] of spec.refused ?? []) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  const code = result.error?.code ?? `exit ${result.status}`;
  report(code === "EACCES", `refused ${command}`, code);
}
for (const [command, ...args] of spec.allowed ?? []) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const ok = result.error === undefined && result.status === 0;
  report(
    ok,
    `allowed ${[command, ...args].join(" ")}`,
    ok ? "" : (result.error?.code ?? `exit ${result.status}: ${result.stderr.trim().slice(0, 300)}`),
  );
}

const answers = (socketPath) =>
  new Promise((resolve) => {
    const req = request({ socketPath, path: "/_ping", timeout: 5000 }, (res) => {
      res.resume();
      resolve(`HTTP ${res.statusCode}`);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve(error.code ?? error.message));
    req.end();
  });
for (const socketPath of spec.unreachable ?? []) {
  const outcome = await answers(socketPath);
  report(!outcome.startsWith("HTTP"), `unreachable ${socketPath}`, outcome);
}
for (const socketPath of spec.reachable ?? []) {
  const outcome = await answers(socketPath);
  report(outcome.startsWith("HTTP"), `reachable ${socketPath}`, outcome);
}

if (spec.noNewPrivs === true) {
  const status = readFileSync("/proc/self/status", "utf8");
  const field = (name) => status.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1];
  report(field("NoNewPrivs") === "1", "NoNewPrivs", field("NoNewPrivs"));
  report(/^0+$/.test(field("CapEff") ?? ""), "no effective capabilities", field("CapEff"));
  report(/^0+$/.test(field("CapBnd") ?? ""), "empty capability bounding set", field("CapBnd"));
}

process.exit(failed ? 1 : 0);
