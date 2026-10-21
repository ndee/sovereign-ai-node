import { dirname, join, posix } from "node:path";

/**
 * Filesystem view of a sandboxed unit. Every path is rendered with systemd's
 * "-" prefix, so a path that does not exist on a given host is skipped rather
 * than failing the unit with 226/NAMESPACE.
 */
export type SystemdSandboxPaths = {
  /** Writable under ProtectSystem=strict. */
  readWritePaths: readonly string[];
  /**
   * Read-only even when nested inside a writable path. Used for the trees the
   * unit may execute from, so the unit cannot plant a program it may then run.
   * A deeper ReadWritePaths entry still wins over these.
   */
  readOnlyPaths: readonly string[];
  /** The only paths the unit may execute or map executable code from. */
  execPaths: readonly string[];
};

// The dynamic loader and the shared libraries that node and the native addons
// link against live here; mapping them needs exec permission as well.
export const SYSTEMD_SANDBOX_LIBRARY_EXEC_PATHS: readonly string[] = [
  "/usr/lib",
  "/usr/lib64",
  "/lib",
  "/lib64",
];

export const SYSTEMD_SANDBOX_INACCESSIBLE_PATHS: readonly string[] = [
  "/run/docker.sock",
  "/run/containerd/containerd.sock",
];

// AF_NETLINK is required: the gateway enumerates network interfaces when it
// loads (os.networkInterfaces()), which throws when netlink sockets are denied.
export const SYSTEMD_SANDBOX_ADDRESS_FAMILIES: readonly string[] = [
  "AF_UNIX",
  "AF_INET",
  "AF_INET6",
  "AF_NETLINK",
];

const HOME_PROTECTED_ROOTS: readonly string[] = ["/home", "/root", "/run/user"];

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const normalizeSandboxPath = (path: string): string => {
  const normalized = posix.normalize(path.trim());
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
};

const dedupeSandboxPaths = (paths: readonly string[]): string[] =>
  Array.from(
    new Set(
      paths
        .filter((path) => path.trim().length > 0)
        .map(normalizeSandboxPath)
        .filter((path) => path.startsWith("/")),
    ),
  );

// Path lists are space separated and expand "%" specifiers, so a path with
// whitespace, quotes or backslashes is quoted and "%" is always doubled.
const renderSystemdPath = (path: string): string => {
  const entry = `-${path.replaceAll("%", "%%")}`;
  if (!/[\s"'\\]/.test(entry)) {
    return entry;
  }
  return `"${entry.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};

const renderPathList = (paths: readonly string[]): string =>
  dedupeSandboxPaths(paths).map(renderSystemdPath).join(" ");

/**
 * Sandboxing directives shared by the OpenClaw gateway unit and the
 * bot-declared service units. MemoryDenyWriteExecute is deliberately absent:
 * the V8 JIT needs writable executable memory.
 */
export const renderSystemdSandboxDirectives = (paths: SystemdSandboxPaths): string[] => {
  const readOnlyPaths = dedupeSandboxPaths(paths.readOnlyPaths);
  // ProtectHome=yes hides these roots entirely and nothing can be re-exposed
  // beneath it, so a unit that needs a path there gets a read-only view with
  // its writable paths nested inside.
  const needsHomeAccess = [...paths.readWritePaths, ...readOnlyPaths, ...paths.execPaths]
    .map(normalizeSandboxPath)
    .some((path) => HOME_PROTECTED_ROOTS.some((root) => isWithin(path, root)));
  return [
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    `ProtectHome=${needsHomeAccess ? "read-only" : "yes"}`,
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "RestrictNamespaces=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "CapabilityBoundingSet=",
    `RestrictAddressFamilies=${SYSTEMD_SANDBOX_ADDRESS_FAMILIES.join(" ")}`,
    `ReadWritePaths=${renderPathList(paths.readWritePaths)}`,
    ...(readOnlyPaths.length === 0 ? [] : [`ReadOnlyPaths=${renderPathList(readOnlyPaths)}`]),
    `InaccessiblePaths=${renderPathList(SYSTEMD_SANDBOX_INACCESSIBLE_PATHS)}`,
    "NoExecPaths=/",
    `ExecPaths=${renderPathList([...SYSTEMD_SANDBOX_LIBRARY_EXEC_PATHS, ...paths.execPaths])}`,
  ];
};

/**
 * `<prefix>/bin/<cli>` -> `<prefix>`. The CLIs in the bin dir are symlinks into
 * `<prefix>/lib/node_modules`, which also holds their native addons.
 */
export const npmPrefixFromBinDir = (binDir: string): string =>
  dirname(normalizeSandboxPath(binDir));

// The Matrix extension downloads its native crypto module into this package
// directory when the gateway starts, so it stays writable (and executable,
// through the package root) inside an otherwise read-only package tree.
export const MATRIX_CRYPTO_RUNTIME_PACKAGE_DIR = join(
  "extensions",
  "matrix",
  "node_modules",
  "@matrix-org",
  "matrix-sdk-crypto-nodejs",
);

export type GatewaySandboxInput = {
  stateDir: string;
  openclawServiceHome: string;
  tempDir: string;
  agentWorkspaces: readonly string[];
  serviceNpmPrefix: string;
  /** Candidate OpenClaw package directories (native addons included). */
  openclawPackageRoots: readonly string[];
  /**
   * Every host program the gateway may start: the runtime, shebang
   * interpreters, the root-owned sovereign CLIs and the programs agents are
   * allowed to run. Anything that gives agents a new way to start a host
   * program must add that program here or it cannot start.
   */
  programs: readonly string[];
};

export const buildGatewaySandboxPaths = (input: GatewaySandboxInput): SystemdSandboxPaths => ({
  readWritePaths: [
    input.stateDir,
    input.openclawServiceHome,
    input.tempDir,
    ...input.agentWorkspaces,
    ...input.openclawPackageRoots.map((root) => join(root, MATRIX_CRYPTO_RUNTIME_PACKAGE_DIR)),
  ],
  readOnlyPaths: [input.serviceNpmPrefix, ...input.openclawPackageRoots],
  execPaths: [...input.programs, input.serviceNpmPrefix, ...input.openclawPackageRoots],
});

export type BotServiceSandboxInput = {
  stateDir: string;
  openclawServiceHome: string;
  workspaces: readonly string[];
  serviceNpmPrefix?: string;
  /** Every host program the unit may start, as for the gateway. */
  programs: readonly string[];
};

export const buildBotServiceSandboxPaths = (input: BotServiceSandboxInput): SystemdSandboxPaths => {
  const npmPrefix = input.serviceNpmPrefix === undefined ? [] : [input.serviceNpmPrefix];
  return {
    readWritePaths: [input.stateDir, input.openclawServiceHome, ...input.workspaces],
    readOnlyPaths: npmPrefix,
    execPaths: [...input.programs, ...npmPrefix],
  };
};
