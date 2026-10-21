// privileged-systemd-unit: install one of the node's managed systemd units on
// behalf of the unprivileged runtime API.
//
// Usage: install-systemd-unit <unit-name>   (unit content on stdin)
//
// Only the fixed unit names below are accepted, the target path is derived
// from the name (never from the caller), and the content is validated before
// it is written:
//   - units that run as the service user must name exactly that user and
//     group, and may only use directives from an allowlist. Everything that
//     would run a command with more privilege, read or write files as root on
//     the unit's behalf, or pull in arbitrary other units is refused;
//   - the relay tunnel unit runs as root, so it must match the installer's
//     template byte for byte, with only the frpc config path free to vary
//     between two fixed locations.
// The caller still reloads systemd and starts the unit through its exact
// sudo rules.

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import { isCanonicalAbsolutePath, refuse } from "./privileged-helper-config.mjs";

export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";
export const MAX_UNIT_BYTES = 64 * 1024;
export const RELAY_TUNNEL_UNIT = "sovereign-matrix-relay-tunnel.service";
export const RELAY_TUNNEL_IMAGE = "ghcr.io/fatedier/frpc:v0.61.1";
export const RELAY_TUNNEL_CONTAINER = "sovereign-matrix-relay-tunnel";

export const MANAGED_UNITS = {
  "sovereign-openclaw-gateway.service": { kind: "service" },
  "sovereign-mail-sentinel-scan.service": { kind: "service" },
  "sovereign-mail-sentinel-scan.timer": {
    kind: "timer",
    unit: "sovereign-mail-sentinel-scan.service",
  },
  [RELAY_TUNNEL_UNIT]: { kind: "relay-tunnel" },
};

const DEPENDENCY_UNITS = new Set([
  "network-online.target",
  "network.target",
  "docker.service",
  "time-sync.target",
  "sovereign-node-api.service",
  ...Object.keys(MANAGED_UNITS),
]);
const INSTALL_TARGETS = new Set(["multi-user.target", "timers.target", "default.target"]);

const anyValue = () => true;
const oneOf = (...values) => (value) => values.includes(value);
const matches = (pattern) => (value) => pattern.test(value);
const BOOLEAN = oneOf("yes", "no", "true", "false", "on", "off", "1", "0");
const TIME_SPAN = matches(/^[0-9][0-9a-z .]*$|^infinity$/);
const UNIT_LIST = matches(/^[A-Za-z0-9@._:-]+( [A-Za-z0-9@._:-]+)*$/);
const dependencyList = (value) =>
  UNIT_LIST(value) && value.split(" ").every((unit) => DEPENDENCY_UNITS.has(unit));

// systemd runs a command with full privileges when its line starts with one
// of the "+", "!" or "!!" prefixes, so only "-" (ignore failure) and "@"
// (custom argv[0]) are allowed in front of the executable.
const commandLine = (value) => {
  const prefix = /^[-@+!:|]*/.exec(value)[0];
  return !/[+!:|]/.test(prefix) && value.length > prefix.length;
};

// Directives that only narrow what the unit may do. A unit cannot gain
// anything through them, so they are accepted with any value.
const SANDBOX_DIRECTIVES = [
  "NoNewPrivileges",
  "ProtectSystem",
  "ProtectHome",
  "PrivateTmp",
  "PrivateDevices",
  "PrivateNetwork",
  "PrivateUsers",
  "PrivateIPC",
  "ProtectKernelTunables",
  "ProtectKernelModules",
  "ProtectKernelLogs",
  "ProtectControlGroups",
  "ProtectClock",
  "ProtectHostname",
  "ProtectProc",
  "ProcSubset",
  "RestrictSUIDSGID",
  "RestrictNamespaces",
  "RestrictRealtime",
  "RestrictAddressFamilies",
  "LockPersonality",
  "MemoryDenyWriteExecute",
  "RemoveIPC",
  "SystemCallFilter",
  "SystemCallArchitectures",
  "SystemCallErrorNumber",
  "CapabilityBoundingSet",
  "ReadWritePaths",
  "ReadOnlyPaths",
  "InaccessiblePaths",
  "NoExecPaths",
  "ExecPaths",
  "MemoryMax",
  "MemoryHigh",
  "CPUQuota",
  "TasksMax",
];

const sectionRules = (identity, timerUnit) => ({
  Unit: {
    Description: anyValue,
    Documentation: anyValue,
    After: UNIT_LIST,
    Before: UNIT_LIST,
    Wants: dependencyList,
    Requires: dependencyList,
    PartOf: dependencyList,
    StartLimitIntervalSec: TIME_SPAN,
    StartLimitBurst: matches(/^[0-9]+$/),
  },
  Service: {
    Type: oneOf("simple", "exec", "oneshot", "notify"),
    User: (value) => value === identity.serviceUser,
    Group: (value) => value === identity.serviceGroup,
    WorkingDirectory: (value) => isCanonicalAbsolutePath(value.replace(/^-/, "")),
    Environment: anyValue,
    // systemd reads environment files as root, so they must sit in the
    // node's own config or state tree.
    EnvironmentFile: (value) => {
      const path = value.replace(/^-/, "");
      return (
        isCanonicalAbsolutePath(path) &&
        [identity.configDir, identity.stateDir].some((root) => path.startsWith(`${root}/`))
      );
    },
    ExecStart: commandLine,
    ExecStartPre: commandLine,
    ExecStartPost: commandLine,
    ExecStop: commandLine,
    ExecStopPost: commandLine,
    ExecReload: commandLine,
    Restart: oneOf(
      "no",
      "always",
      "on-success",
      "on-failure",
      "on-abnormal",
      "on-abort",
      "on-watchdog",
    ),
    RestartSec: TIME_SPAN,
    TimeoutSec: TIME_SPAN,
    TimeoutStartSec: TIME_SPAN,
    TimeoutStopSec: TIME_SPAN,
    RemainAfterExit: BOOLEAN,
    KillMode: oneOf("control-group", "mixed", "process"),
    KillSignal: matches(/^SIG[A-Z0-9+]+$/),
    SuccessExitStatus: matches(/^[A-Z0-9 ]+$/),
    LimitNOFILE: matches(/^[0-9]+(:[0-9]+)?$|^infinity$/),
    Nice: matches(/^-?[0-9]{1,2}$/),
    UMask: matches(/^0?[0-7]{3}$/),
    SyslogIdentifier: matches(/^[A-Za-z0-9._-]+$/),
    StandardOutput: oneOf("journal", "null", "inherit"),
    StandardError: oneOf("journal", "null", "inherit"),
    ...Object.fromEntries(SANDBOX_DIRECTIVES.map((name) => [name, anyValue])),
  },
  Timer: {
    OnCalendar: matches(/^[A-Za-z0-9 :.*,/~-]+$/),
    OnActiveSec: TIME_SPAN,
    OnBootSec: TIME_SPAN,
    OnStartupSec: TIME_SPAN,
    OnUnitActiveSec: TIME_SPAN,
    OnUnitInactiveSec: TIME_SPAN,
    AccuracySec: TIME_SPAN,
    RandomizedDelaySec: TIME_SPAN,
    Persistent: BOOLEAN,
    Unit: (value) => value === timerUnit,
  },
  Install: {
    WantedBy: (value) => UNIT_LIST(value) && value.split(" ").every((t) => INSTALL_TARGETS.has(t)),
  },
});

const SECTIONS_BY_KIND = {
  service: ["Unit", "Service", "Install"],
  timer: ["Unit", "Timer", "Install"],
};

export const parseUnitFile = (content) => {
  const entries = [];
  let section;
  for (const [index, line] of content.split("\n").entries()) {
    const where = `line ${index + 1}`;
    if (line.trim().length === 0 || /^[#;]/.test(line)) {
      continue;
    }
    if (line.endsWith("\\") || line.includes("\r") || line.includes("\0")) {
      refuse(`${where}: continuation lines and control characters are not accepted`);
    }
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1];
      continue;
    }
    const directive = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (directive === null || section === undefined) {
      refuse(`${where}: not a directive inside a section`);
    }
    entries.push({ where, section, key: directive[1], value: directive[2] });
  }
  return entries;
};

export const renderRelayTunnelUnitTemplate = ({ configPath }) =>
  [
    "[Unit]",
    "Description=Sovereign Matrix Relay Tunnel",
    "After=network-online.target docker.service",
    "Wants=network-online.target",
    "Requires=docker.service",
    "",
    "[Service]",
    "Type=simple",
    `ExecStartPre=-/usr/bin/docker rm -f ${RELAY_TUNNEL_CONTAINER}`,
    `ExecStart=/usr/bin/docker run --rm --name ${RELAY_TUNNEL_CONTAINER} --network host -v ${configPath}:/etc/frp/frpc.toml:ro ${RELAY_TUNNEL_IMAGE} -c /etc/frp/frpc.toml`,
    `ExecStop=/usr/bin/docker stop ${RELAY_TUNNEL_CONTAINER}`,
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");

const validateRelayTunnelUnit = (content, identity) => {
  const accepted = [identity.stateDir, identity.configDir].map((root) =>
    renderRelayTunnelUnitTemplate({ configPath: `${root}/relay/frpc.toml` }),
  );
  if (!accepted.includes(content)) {
    refuse(`${RELAY_TUNNEL_UNIT} does not match the installer's relay tunnel template`);
  }
};

export const validateUnit = (unitName, content, identity) => {
  const managed = MANAGED_UNITS[unitName];
  if (managed === undefined) {
    refuse(`${unitName} is not a managed unit`);
  }
  if (managed.kind === "relay-tunnel") {
    validateRelayTunnelUnit(content, identity);
    return;
  }
  const rules = sectionRules(identity, managed.unit);
  const allowedSections = SECTIONS_BY_KIND[managed.kind];
  const seen = new Set();
  for (const { where, section, key, value } of parseUnitFile(content)) {
    if (!allowedSections.includes(section)) {
      refuse(`${where}: section [${section}] is not accepted in ${unitName}`);
    }
    const accepts = rules[section][key];
    if (accepts === undefined) {
      refuse(`${where}: ${key}= is not accepted in [${section}]`);
    }
    if (!accepts(value)) {
      refuse(`${where}: ${key}=${value} is not accepted`);
    }
    seen.add(`${section}.${key}`);
  }
  if (managed.kind === "service" && (!seen.has("Service.User") || !seen.has("Service.Group"))) {
    refuse(`${unitName} must set User= and Group= to the service identity`);
  }
};

// Writes through a fresh temp file and a rename so a reader never sees a
// partial unit and an existing symlink at the target is replaced, not followed.
export const writeUnitFile = (
  unitName,
  content,
  { unitDir = SYSTEMD_UNIT_DIR, fs = { openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } } = {},
) => {
  const target = join(unitDir, unitName);
  const temp = join(unitDir, `.${unitName}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o644);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(temp, target);
  return target;
};

export const installSystemdUnit = ({ argv, stdinText, identity, write = writeUnitFile }) => {
  if (argv.length !== 1) {
    refuse("usage: install-systemd-unit <unit-name> < unit-file");
  }
  const [unitName] = argv;
  if (Buffer.byteLength(stdinText) === 0 || Buffer.byteLength(stdinText) > MAX_UNIT_BYTES) {
    refuse(`unit content must be between 1 and ${MAX_UNIT_BYTES} bytes`);
  }
  validateUnit(unitName, stdinText, identity);
  return write(unitName, stdinText);
};
