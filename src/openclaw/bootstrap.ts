import { type Dirent, existsSync, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "../logging/logger.js";
import {
  type ExecFailureReason,
  type ExecRunner,
  resolveTraversableSpawnCwd,
} from "../system/exec.js";

const OPENCLAW_DETECT_TIMEOUT_MS = 20_000;
const OPENCLAW_INSTALL_TIMEOUT_MS = 15 * 60_000;
const OPENCLAW_EXTENSION_REPAIR_TIMEOUT_MS = 5 * 60_000;
const BUNDLED_OPENCLAW_EXTENSION_REPAIR_TARGETS = [
  {
    label: "matrix",
    relativeDir: join("extensions", "matrix"),
  },
] as const;

// Sovereign pins one OpenClaw release and installs it only from the locked
// runtime project in deploy/openclaw-runtime, whose package.json and
// package-lock.json must name this exact version (a unit test enforces it).
export const SOVEREIGN_PINNED_OPENCLAW_VERSION = "2026.8.35";
export const SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS = "pinned-by-sovereign";

export type OpenClawInstallOptions = {
  version: string;
  noPrompt?: boolean;
  noOnboard?: boolean;
  forceReinstall?: boolean;
  skipIfCompatibleInstalled?: boolean;
};

export type DetectedOpenClaw = {
  binaryPath: string;
  version: string;
};

export type OpenClawInstallInfo = {
  binaryPath: string;
  version: string;
  // Only "locked_project" is produced now; the older values stay assignable so
  // test doubles and callers written against earlier releases still compile.
  installMethod: "locked_project" | "install_sh" | "npm_fallback";
  /** True when this call (re)installed the CLI rather than keeping the one found. */
  reinstalled?: boolean;
};

export interface OpenClawBootstrapper {
  detectInstalled(): Promise<DetectedOpenClaw | null>;
  ensureInstalled(opts: OpenClawInstallOptions): Promise<OpenClawInstallInfo>;
}

/**
 * Why a detection attempt produced no version.
 *
 * `spawn_failed` — the exec threw (CLI not on the PATH used / ENOENT).
 * `non_zero_exit` — the CLI ran and exited non-zero.
 * `unparsable_version` — it exited 0 but printed nothing version-shaped.
 */
export type OpenClawDetectionOutcome =
  | "detected"
  | "spawn_failed"
  | "non_zero_exit"
  | "unparsable_version";

type OpenClawDetectionProbe = {
  detected: DetectedOpenClaw | null;
  outcome: OpenClawDetectionOutcome;
  lookupPath: string | undefined;
  npmPrefix: string | undefined;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  failureReason?: ExecFailureReason;
};

/**
 * What the resolved `openclaw` command actually is on disk.
 *
 * `unparsable_version` says the CLI ran and printed nothing usable, but says
 * nothing about what was run. Without this, an empty install log leaves no way
 * to tell a truncated download from a wrapper script from a dangling symlink.
 */
type OpenClawBinaryEvidence = {
  path: string;
  size?: number;
  firstLine?: string;
  symlinkTarget?: string;
  error?: string;
};

type ExecResultLike = {
  stdout: string;
  stderr: string;
};

/**
 * The npm prefix subdirectory OpenClaw (like lobster, see
 * real-service-lobster.ts) is installed into when the install runs
 * unprivileged. `<serviceHome>/.npm-global/bin` is already on the API
 * unit's PATH (deploy/systemd/sovereign-node-api.service) and on bot unit
 * PATHs (#232), so the CLI stays resolvable by bare name afterwards.
 */
const NPM_GLOBAL_SUBDIR = ".npm-global";

const isRunningAsRoot = (): boolean => process.getuid?.() === 0;

/**
 * Resolve the npm global prefix the OpenClaw install must target.
 *
 * A root install keeps the system prefix (npm's default, /usr/lib/node_modules)
 * so nothing changes for the curl installer. An unprivileged install — the web
 * installer, where sovereign-node-api.service runs as the non-root service user
 * — cannot write there and must target a prefix inside a home it owns.
 *
 * Returning `undefined` means "leave npm's default prefix alone".
 */
/**
 * Resolve a working directory every spawned helper can legally start in.
 *
 * A child process inherits the parent's cwd, and the kernel resolves that cwd
 * for the CHILD's credentials. When the parent was started in a directory the
 * child's user cannot traverse — `/root` is mode 0700, and a CLI invoked as
 * `runuser -u <service-user> -- sovereign-node ...` from a root shell inherits
 * exactly that — the spawn is refused with EACCES before the binary is ever
 * consulted. The failure names the command (`spawn npm EACCES`), which reads
 * like npm is unexecutable; it is not, and the same npm runs fine for the same
 * user from a traversable cwd.
 *
 * This only bites when the process is NOT root: root traverses 0700 regardless,
 * which is why the identical step succeeds during a root install and fails when
 * it is re-entered unprivileged.
 *
 * `/` is the fallback because it is world-traversable on every supported
 * system; the service home is preferred so npm's own relative lookups land
 * somewhere the service user owns.
 */
/**
 * Decide whether a failed exec is worth retrying.
 *
 * `spawn_failed` is deterministic — the command could not be started at all
 * (EACCES/ENOENT), and nothing about a second attempt changes that. A timeout
 * or a signal can genuinely be transient (a slow registry, a killed child), so
 * those stay retryable, as does a plain non-zero exit, which is the network-blip
 * case the retry was originally written for.
 */
export const isRetryableExecFailure = (failureReason?: ExecFailureReason): boolean =>
  failureReason !== "spawn_failed";

export const resolveOpenClawSpawnCwd = (serviceHome?: string): string | undefined => {
  if (isRunningAsRoot()) {
    return undefined;
  }
  const home = serviceHome?.trim();
  if (home !== undefined && home.length > 0) {
    return home;
  }
  // No explicit service home: fall back to the generic traversable cwd the
  // exec runner would have defaulted to anyway, so there is one definition of
  // "somewhere this user may legally start" rather than two that can drift.
  return resolveTraversableSpawnCwd();
};

export const resolveOpenClawNpmPrefix = (serviceHome?: string): string | undefined => {
  if (isRunningAsRoot()) {
    return undefined;
  }
  const home = serviceHome?.trim();
  const base = home !== undefined && home.length > 0 ? home : process.env.HOME;
  if (base === undefined || base.length === 0) {
    return undefined;
  }
  return join(base, NPM_GLOBAL_SUBDIR);
};

/**
 * The HOME an OpenClaw npm spawn must run with.
 *
 * npm derives its cache, its userconfig (`$HOME/.npmrc`) and its default
 * prefix from HOME. Handing an unprivileged spawn `HOME=/root` points all
 * three at a directory that user cannot read, so npm fails on a path that only
 * exists for root — the same root-shaped-environment assumption that produced
 * the cwd and PATH bugs. `resolveOpenClawNpmPrefix` already encodes the rule:
 * when it returns a prefix we are unprivileged, and the service home is the
 * only HOME that spawn may legally use.
 *
 * Returns undefined when the ambient HOME is correct (running as root, or no
 * service home configured), so call sites can spread it away and inherit.
 */
export const resolveOpenClawSpawnHome = (serviceHome?: string): string | undefined => {
  if (isRunningAsRoot()) {
    return undefined;
  }
  const home = serviceHome?.trim();
  if (home !== undefined && home.length > 0) {
    return home;
  }
  return undefined;
};

/**
 * Build the PATH that OpenClaw must be looked up on.
 *
 * The install runs `bash -lc` with `<prefix>/bin` prepended to PATH, but that
 * export dies with the subshell. `openclaw` is published as a bin link inside
 * `<prefix>/bin` (verified against the upstream install.sh npm path), so a
 * detection that inherits only the parent PATH cannot see it and the exec
 * fails with ENOENT — the installer reports success and detection still
 * returns null. Prepend the same prefix bin dir the install targeted so both
 * halves agree on where the CLI lives.
 */
export const resolveOpenClawLookupPath = (
  npmPrefix: string | undefined,
  basePath: string | undefined = process.env.PATH,
): string | undefined => {
  if (npmPrefix === undefined) {
    return basePath;
  }
  const binDir = join(npmPrefix, "bin");
  if (basePath === undefined || basePath.length === 0) {
    return binDir;
  }
  const segments = basePath.split(":");
  if (segments.includes(binDir)) {
    return basePath;
  }
  return `${binDir}:${basePath}`;
};

/**
 * The PATH an OpenClaw CLI spawn must be looked up on, or undefined when the
 * ambient PATH already suffices.
 *
 * This is the consumer-facing form of `resolveOpenClawLookupPath`. That helper
 * returns the base PATH unchanged when there is no npm prefix to prepend,
 * which is the right shape for a lookup but the wrong one for a spawn `env`:
 * setting `PATH` to a copy of the inherited value is pure noise, and on a
 * privilege drop it adds a redundant `PATH=` to the `env` argument list.
 *
 * Returning undefined in that case lets every call site use the same
 * `...(lookupPath === undefined ? {} : { PATH: lookupPath })` spread and get
 * "inherit" for free.
 */
export const resolveOpenClawSpawnLookupPath = (serviceHome?: string): string | undefined => {
  const npmPrefix = resolveOpenClawNpmPrefix(serviceHome);
  if (npmPrefix === undefined) {
    return undefined;
  }
  const lookupPath = resolveOpenClawLookupPath(npmPrefix);
  return lookupPath === process.env.PATH ? undefined : lookupPath;
};

export class ShellOpenClawBootstrapper implements OpenClawBootstrapper {
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
    private readonly serviceHome?: string,
    private readonly runtimeTemplateDir: string | null = resolveOpenClawRuntimeTemplateDir(
      dirname(fileURLToPath(import.meta.url)),
    ),
  ) {}

  async detectInstalled(): Promise<DetectedOpenClaw | null> {
    return (await this.probeInstalled()).detected;
  }

  /**
   * Run the detection probe and keep the evidence.
   *
   * `detectInstalled()` collapses every failure to `null`, which is the right
   * shape for callers but destroys the reason. The probe records which of the
   * three null-conditions fired plus the raw exec result, so a failing install
   * can report why instead of only that.
   */
  private async probeInstalled(): Promise<OpenClawDetectionProbe> {
    const npmPrefix = resolveOpenClawNpmPrefix(this.serviceHome);
    const lookupPath = resolveOpenClawLookupPath(npmPrefix);
    const spawnCwd = resolveOpenClawSpawnCwd(this.serviceHome);
    let result: Awaited<ReturnType<ExecRunner["run"]>>;
    try {
      result = await this.execRunner.run({
        command: "openclaw",
        args: ["--version"],
        options: {
          timeout: OPENCLAW_DETECT_TIMEOUT_MS,
          ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
          env: {
            CI: "1",
            ...(lookupPath === undefined ? {} : { PATH: lookupPath }),
          },
        },
      });
    } catch (error) {
      return {
        detected: null,
        outcome: "spawn_failed",
        lookupPath,
        npmPrefix,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      return {
        detected: null,
        // A process that never started is a spawn failure, not a CLI that ran
        // and failed. Before the exec runner reported this, an ENOENT arrived
        // here as "exit 0, no output" and was misfiled as unparsable_version.
        outcome: result.failureReason === "spawn_failed" ? "spawn_failed" : "non_zero_exit",
        lookupPath,
        npmPrefix,
        exitCode: result.exitCode,
        stdout: truncateText(result.stdout, 2000),
        stderr: truncateText(result.stderr, 2000),
        ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
      };
    }
    const parsedVersion = parseVersionToken(versionOutput);
    if (parsedVersion === null) {
      return {
        detected: null,
        outcome: "unparsable_version",
        lookupPath,
        npmPrefix,
        exitCode: result.exitCode,
        stdout: truncateText(result.stdout, 2000),
        stderr: truncateText(result.stderr, 2000),
      };
    }
    return {
      detected: {
        binaryPath: "openclaw",
        version: parsedVersion,
      },
      outcome: "detected",
      lookupPath,
      npmPrefix,
      exitCode: result.exitCode,
    };
  }

  /**
   * Resolve the CLI's on-disk location for diagnostics only.
   *
   * Never used to decide success — it exists so a failure report can say
   * whether the binary is absent or merely unreachable on the PATH used.
   */
  private async resolveOpenClawCommandLocation(
    lookupPath: string | undefined,
  ): Promise<string | null> {
    const spawnCwd = resolveOpenClawSpawnCwd(this.serviceHome);
    try {
      const result = await this.execRunner.run({
        command: "sh",
        args: ["-c", "command -v openclaw"],
        options: {
          timeout: OPENCLAW_DETECT_TIMEOUT_MS,
          ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
          env: {
            CI: "1",
            ...(lookupPath === undefined ? {} : { PATH: lookupPath }),
          },
        },
      });
      if (result.exitCode !== 0) {
        return null;
      }
      const resolved = result.stdout.trim();
      return resolved.length === 0 ? null : resolved;
    } catch {
      return null;
    }
  }

  /**
   * Assemble the evidence bundle attached to OPENCLAW_INSTALL_FAILED.
   */
  private async buildDetectionFailureDetails(
    probe: OpenClawDetectionProbe,
    installResult: Pick<ExecResultLike, "stdout" | "stderr">,
  ): Promise<Record<string, unknown>> {
    const commandLocation = await this.resolveOpenClawCommandLocation(probe.lookupPath);
    const binaryEvidence =
      commandLocation === null ? null : await describeOpenClawBinary(commandLocation);
    return {
      detectionOutcome: probe.outcome,
      npmPrefix: probe.npmPrefix ?? null,
      lookupPath: probe.lookupPath ?? null,
      commandLocation,
      // What the resolved command actually is. An empty install log plus an
      // unparsable version leaves the installer otherwise unexplained.
      resolvedBinary: binaryEvidence,
      ...(probe.exitCode === undefined ? {} : { detectExitCode: probe.exitCode }),
      ...(probe.failureReason === undefined ? {} : { detectFailureReason: probe.failureReason }),
      ...(probe.stdout === undefined ? {} : { detectStdout: probe.stdout }),
      ...(probe.stderr === undefined ? {} : { detectStderr: probe.stderr }),
      ...(probe.error === undefined ? {} : { detectError: probe.error }),
      installStdout: truncateText(installResult.stdout, 2000),
      installStderr: truncateText(installResult.stderr, 4000),
    };
  }

  async ensureInstalled(opts: OpenClawInstallOptions): Promise<OpenClawInstallInfo> {
    const requestedVersion = resolveRequestedOpenClawVersion(opts.version);
    const template = await this.readRuntimeTemplate();
    if (!versionsMatch(requestedVersion, template.version)) {
      // The locked project is the only install source, so another version
      // cannot be honoured; installing the lock keeps old request files that
      // still name an earlier pin working instead of failing the run.
      this.logger.warn(
        { requestedVersion, lockedVersion: template.version },
        "Requested OpenClaw version differs from the locked runtime; installing the locked version",
      );
    }
    const detected = await this.detectInstalled();
    const npmPrefix = await this.resolveInstallPrefix();
    const runtimeDir = resolveOpenClawRuntimeDir(npmPrefix);
    if (
      detected !== null &&
      !opts.forceReinstall &&
      (opts.skipIfCompatibleInstalled ?? true) &&
      versionsMatch(detected.version, template.version) &&
      (await isLockedRuntimeCurrent(runtimeDir, npmPrefix, template))
    ) {
      await this.repairBundledExtensionRuntimeDependencies(runtimeDir);
      this.logger.info(
        {
          openclawVersion: detected.version,
          binaryPath: detected.binaryPath,
          runtimeDir,
        },
        "OpenClaw already installed from the locked runtime; skipping reinstall",
      );
      return {
        binaryPath: detected.binaryPath,
        version: detected.version,
        installMethod: "locked_project",
        reinstalled: false,
      };
    }

    this.logger.info(
      {
        openclawVersion: template.version,
        runtimeDir,
        npmPrefix,
        forceReinstall: opts.forceReinstall ?? false,
        skipIfCompatibleInstalled: opts.skipIfCompatibleInstalled ?? true,
      },
      "Installing OpenClaw from the locked runtime project",
    );
    const installResult = await this.installLockedRuntime(npmPrefix, runtimeDir, template);

    const probe = await this.probeInstalled();
    const installed = probe.detected;
    if (installed === null) {
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw locked runtime install completed but the openclaw CLI was not detected",
        retryable: true,
        details: {
          runtimeDir,
          ...(await this.buildDetectionFailureDetails(probe, installResult)),
        },
      };
    }

    if (!versionsMatch(installed.version, template.version)) {
      this.logger.warn(
        {
          expectedVersion: template.version,
          detectedVersion: installed.version,
          lookupPath: probe.lookupPath,
        },
        "OpenClaw install completed but the openclaw on the lookup PATH reports another version",
      );
    }

    await this.repairBundledExtensionRuntimeDependencies(runtimeDir);

    return {
      binaryPath: installed.binaryPath,
      version: installed.version,
      installMethod: "locked_project",
      reinstalled: true,
    };
  }

  private async readRuntimeTemplate(): Promise<OpenClawRuntimeTemplate> {
    const templateDir = this.runtimeTemplateDir;
    try {
      if (templateDir === null) {
        throw new Error("no deploy/openclaw-runtime directory next to this build");
      }
      return await readOpenClawRuntimeTemplate(templateDir);
    } catch (error) {
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "The locked OpenClaw runtime project is missing or unreadable in this build",
        retryable: false,
        details: {
          templateDir,
          error: (error as Error).message,
        },
      };
    }
  }

  /**
   * The npm prefix whose `bin` receives the `openclaw` link and whose `lib`
   * holds the locked runtime: the service user's own prefix when the install
   * runs unprivileged, otherwise the running npm's global prefix, so the CLI
   * lands where a root install always put it.
   */
  private async resolveInstallPrefix(): Promise<string> {
    const servicePrefix = resolveOpenClawNpmPrefix(this.serviceHome);
    if (servicePrefix !== undefined) {
      return servicePrefix;
    }
    const spawnCwd = resolveOpenClawSpawnCwd(this.serviceHome);
    const result = await this.execRunner.run({
      command: "npm",
      args: ["prefix", "-g"],
      options: {
        timeout: OPENCLAW_DETECT_TIMEOUT_MS,
        ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
        env: { CI: "1" },
      },
    });
    const prefix = result.exitCode === 0 ? firstNonEmptyLine(result.stdout) : undefined;
    if (prefix === undefined) {
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "Could not resolve the npm global prefix for the OpenClaw install",
        retryable: isRetryableExecFailure(result.failureReason),
        details: {
          command: result.command,
          exitCode: result.exitCode,
          stderr: truncateText(result.stderr, 2000),
          stdout: truncateText(result.stdout, 2000),
        },
      };
    }
    return prefix;
  }

  /**
   * Install the locked project into a staging directory and swap it in.
   *
   * `npm ci` honours the committed lockfile and the project's `overrides`,
   * neither of which a global install can carry. Staging keeps a failed or
   * interrupted install from touching the runtime that is in place, so a
   * rerun always starts from a working tree.
   */
  private async installLockedRuntime(
    npmPrefix: string,
    runtimeDir: string,
    template: OpenClawRuntimeTemplate,
  ): Promise<ExecResultLike> {
    const stagingDir = `${runtimeDir}${RUNTIME_STAGING_SUFFIX}`;
    const previousDir = `${runtimeDir}${RUNTIME_PREVIOUS_SUFFIX}`;
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true, mode: 0o755 });
    await writeFile(join(stagingDir, OPENCLAW_RUNTIME_MANIFEST), template.manifestText, "utf8");
    await writeFile(join(stagingDir, OPENCLAW_RUNTIME_LOCKFILE), template.lockfileText, "utf8");

    // Resolve HOME before the cache: an unprivileged install must keep npm's
    // cache under the service home too, or npm writes beside root's and fails
    // on the first unreadable entry.
    const spawnHome = resolveOpenClawSpawnHome(this.serviceHome);
    const effectiveHome = spawnHome ?? process.env.HOME ?? "/root";
    const cacheDir = process.env.NPM_CONFIG_CACHE ?? join(effectiveHome, ".npm");
    const lookupPath = resolveOpenClawSpawnLookupPath(this.serviceHome);
    const installResult = await this.execRunner.run({
      command: "npm",
      args: ["ci", "--omit=dev", "--no-audit", "--no-fund"],
      options: {
        cwd: stagingDir,
        timeout: OPENCLAW_INSTALL_TIMEOUT_MS,
        env: {
          CI: "1",
          HOME: effectiveHome,
          NPM_CONFIG_CACHE: cacheDir,
          ...(lookupPath === undefined ? {} : { PATH: lookupPath }),
        },
      },
    });
    if (installResult.exitCode !== 0) {
      await rm(stagingDir, { recursive: true, force: true });
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw locked runtime install (npm ci) exited with a non-zero status",
        // A process that never started will never start on a retry: the cwd is
        // untraversable or npm is unexecutable for this user, and neither heals
        // with time. Only failures that CAN change are marked retryable.
        retryable: isRetryableExecFailure(installResult.failureReason),
        details: {
          command: installResult.command,
          exitCode: installResult.exitCode,
          ...(installResult.failureReason === undefined
            ? {}
            : { failureReason: installResult.failureReason }),
          ...(installResult.errorCode === undefined ? {} : { errorCode: installResult.errorCode }),
          runtimeDir,
          stderr: truncateText(installResult.stderr, 4000),
          stdout: truncateText(installResult.stdout, 2000),
        },
      };
    }

    // A restrictive umask on the installing shell would leave the tree
    // unreadable for the service user the gateway runs as.
    await ensureOpenClawPackageReadable(stagingDir, this.logger);
    await rm(previousDir, { recursive: true, force: true });
    if (existsSync(runtimeDir)) {
      await rename(runtimeDir, previousDir);
    }
    await rename(stagingDir, runtimeDir);
    await rm(previousDir, { recursive: true, force: true });
    await linkOpenClawBin(runtimeDir, npmPrefix);
    this.logger.info(
      { runtimeDir, binPath: join(npmPrefix, "bin", "openclaw") },
      "OpenClaw locked runtime installed",
    );
    return installResult;
  }

  private async repairBundledExtensionRuntimeDependencies(runtimeDir: string): Promise<void> {
    const packageRoot = resolveOpenClawRuntimePackageRoot(runtimeDir);
    await ensureOpenClawPackageReadable(packageRoot, this.logger);
    await hardenBundledExtensionDirectories(packageRoot);

    const repairHome = resolveOpenClawSpawnHome(this.serviceHome);
    const repairCache = repairHome === undefined ? undefined : join(repairHome, ".npm");
    const repairLookupPath = resolveOpenClawSpawnLookupPath(this.serviceHome);

    for (const target of BUNDLED_OPENCLAW_EXTENSION_REPAIR_TARGETS) {
      const extensionDir = join(packageRoot, target.relativeDir);
      const repairPlan = await planBundledExtensionDependencyRepair(extensionDir);
      if (repairPlan === null || repairPlan.missingDependencies.length === 0) {
        continue;
      }

      this.logger.warn(
        {
          extension: repairPlan.packageName,
          extensionDir,
          missingDependencies: repairPlan.missingDependencies.map((dependency) => dependency.name),
        },
        "Repairing missing bundled OpenClaw extension runtime dependencies",
      );

      const installResult = await this.execRunner.run({
        command: "npm",
        args: [
          "install",
          "--omit=dev",
          "--no-package-lock",
          "--no-save",
          ...repairPlan.missingDependencies.map(
            (dependency) => `${dependency.name}@${dependency.spec}`,
          ),
        ],
        options: {
          // cwd stays the extension dir — that is the package being repaired —
          // but the rest of the environment must still be the service user's,
          // or an unprivileged repair inherits root's HOME/cache and PATH.
          cwd: extensionDir,
          timeout: OPENCLAW_EXTENSION_REPAIR_TIMEOUT_MS,
          env: {
            CI: "1",
            ...(repairHome === undefined ? {} : { HOME: repairHome }),
            ...(repairCache === undefined ? {} : { NPM_CONFIG_CACHE: repairCache }),
            ...(repairLookupPath === undefined ? {} : { PATH: repairLookupPath }),
          },
        },
      });

      if (installResult.exitCode !== 0) {
        throw {
          code: "OPENCLAW_INSTALL_FAILED",
          message: `Bundled OpenClaw ${target.label} extension dependency repair failed`,
          retryable: true,
          details: {
            command: installResult.command,
            exitCode: installResult.exitCode,
            stderr: truncateText(installResult.stderr, 4000),
            stdout: truncateText(installResult.stdout, 2000),
          },
        };
      }

      const remainingMissing = await findMissingExtensionDependencies(
        extensionDir,
        repairPlan.missingDependencies,
      );
      if (remainingMissing.length > 0) {
        throw {
          code: "OPENCLAW_INSTALL_FAILED",
          message: `Bundled OpenClaw ${target.label} extension dependencies are still missing after repair`,
          retryable: true,
          details: {
            extension: repairPlan.packageName,
            extensionDir,
            missingDependencies: remainingMissing.map((dependency) => dependency.name),
          },
        };
      }

      this.logger.info(
        {
          extension: repairPlan.packageName,
          extensionDir,
          repairedDependencies: repairPlan.missingDependencies.map((dependency) => dependency.name),
        },
        "Bundled OpenClaw extension runtime dependencies repaired successfully",
      );
    }
  }
}

type PackageJsonWithDependencies = {
  name?: string;
  dependencies?: Record<string, string>;
};

type ExtensionDependencySpec = {
  name: string;
  spec: string;
};

type BundledExtensionRepairPlan = {
  packageName: string;
  missingDependencies: ExtensionDependencySpec[];
};

/** Where the locked runtime project ships inside a sovereign-node build. */
const OPENCLAW_RUNTIME_TEMPLATE_RELATIVE_DIR = join("deploy", "openclaw-runtime");
const OPENCLAW_RUNTIME_MANIFEST = "package.json";
const OPENCLAW_RUNTIME_LOCKFILE = "package-lock.json";
const OPENCLAW_RUNTIME_PACKAGE = "openclaw";
const OPENCLAW_RUNTIME_DIRNAME = "sovereign-openclaw-runtime";
const RUNTIME_STAGING_SUFFIX = ".staging";
const RUNTIME_PREVIOUS_SUFFIX = ".previous";
/** dist/<entry>.js, dist/lib/<entry>.js and src/openclaw/<module>.ts all sit within two levels. */
const RUNTIME_TEMPLATE_SEARCH_DEPTH = 3;

type OpenClawRuntimeTemplate = {
  version: string;
  manifestText: string;
  lockfileText: string;
};

/**
 * Find the locked runtime project shipped next to this build.
 *
 * The module is bundled into dist/ for releases and run from src/ in tests and
 * development, so walk up a few levels instead of assuming one layout.
 */
export const resolveOpenClawRuntimeTemplateDir = (
  moduleDir: string,
  fileExists: (path: string) => boolean = existsSync,
): string | null => {
  let current = moduleDir;
  for (let depth = 0; depth < RUNTIME_TEMPLATE_SEARCH_DEPTH; depth += 1) {
    const candidate = join(current, OPENCLAW_RUNTIME_TEMPLATE_RELATIVE_DIR);
    if (fileExists(join(candidate, OPENCLAW_RUNTIME_LOCKFILE))) {
      return candidate;
    }
    current = dirname(current);
  }
  return null;
};

/**
 * The locked runtime lives in its own project directory inside the prefix's
 * lib dir, never at the prefix itself: `npm ci` prunes everything its lockfile
 * does not name, which at /usr/lib would delete npm and corepack.
 */
export const resolveOpenClawRuntimeDir = (npmPrefix: string): string =>
  join(npmPrefix, "lib", OPENCLAW_RUNTIME_DIRNAME);

export const resolveOpenClawRuntimePackageRoot = (runtimeDir: string): string =>
  join(runtimeDir, "node_modules", OPENCLAW_RUNTIME_PACKAGE);

export const readOpenClawRuntimeTemplate = async (
  templateDir: string,
): Promise<OpenClawRuntimeTemplate> => {
  const manifestText = await readFile(join(templateDir, OPENCLAW_RUNTIME_MANIFEST), "utf8");
  const lockfileText = await readFile(join(templateDir, OPENCLAW_RUNTIME_LOCKFILE), "utf8");
  const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, string> };
  const version = manifest.dependencies?.[OPENCLAW_RUNTIME_PACKAGE]?.trim();
  if (version === undefined || version.length === 0) {
    throw new Error(`${OPENCLAW_RUNTIME_MANIFEST} does not depend on ${OPENCLAW_RUNTIME_PACKAGE}`);
  }
  return { version, manifestText, lockfileText };
};

const readOpenClawBinRelativePath = async (packageRoot: string): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[OPENCLAW_RUNTIME_PACKAGE];
  if (bin === undefined || bin.trim().length === 0) {
    throw {
      code: "OPENCLAW_INSTALL_FAILED",
      message: "The installed OpenClaw package declares no openclaw bin entry",
      retryable: false,
      details: { packageRoot },
    };
  }
  return bin.trim();
};

/**
 * Point `<prefix>/bin/openclaw` at the locked runtime's CLI.
 *
 * The link replaces whatever was there (an earlier global install's link
 * included) through a rename, so a reader never sees the name missing.
 */
const linkOpenClawBin = async (runtimeDir: string, npmPrefix: string): Promise<void> => {
  const packageRoot = resolveOpenClawRuntimePackageRoot(runtimeDir);
  const target = join(packageRoot, await readOpenClawBinRelativePath(packageRoot));
  const targetMode = (await stat(target)).mode & 0o777;
  if ((targetMode & 0o111) !== 0o111) {
    await chmod(target, targetMode | 0o555);
  }
  const binDir = join(npmPrefix, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  const linkPath = join(binDir, OPENCLAW_RUNTIME_PACKAGE);
  const temporaryLink = join(binDir, `.${OPENCLAW_RUNTIME_PACKAGE}.${process.pid}.tmp`);
  await rm(temporaryLink, { force: true });
  await symlink(target, temporaryLink);
  await rename(temporaryLink, linkPath);
};

/**
 * True when the runtime in place was installed from exactly this lock and the
 * prefix's `openclaw` resolves into it. A matching `--version` alone is not
 * enough: a CLI installed any other way carries none of the overrides.
 */
const isLockedRuntimeCurrent = async (
  runtimeDir: string,
  npmPrefix: string,
  template: OpenClawRuntimeTemplate,
): Promise<boolean> => {
  try {
    const packageRoot = resolveOpenClawRuntimePackageRoot(runtimeDir);
    const [manifestText, lockfileText, installedManifest] = await Promise.all([
      readFile(join(runtimeDir, OPENCLAW_RUNTIME_MANIFEST), "utf8"),
      readFile(join(runtimeDir, OPENCLAW_RUNTIME_LOCKFILE), "utf8"),
      readFile(join(packageRoot, "package.json"), "utf8"),
    ]);
    const installedVersion = (JSON.parse(installedManifest) as { version?: string }).version;
    if (
      manifestText !== template.manifestText ||
      lockfileText !== template.lockfileText ||
      installedVersion === undefined ||
      !versionsMatch(installedVersion, template.version)
    ) {
      return false;
    }
    const linked = await realpath(join(npmPrefix, "bin", OPENCLAW_RUNTIME_PACKAGE));
    const expected = await realpath(
      join(packageRoot, await readOpenClawBinRelativePath(packageRoot)),
    );
    return linked === expected;
  } catch {
    return false;
  }
};

const firstNonEmptyLine = (value: string): string | undefined =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

/** How much of the resolved binary to read for the `firstLine` evidence. */
const OPENCLAW_BINARY_HEAD_BYTES = 200;

/**
 * Describe the resolved `openclaw` command for a failure report.
 *
 * Diagnostics only — never used to decide success. Reports the real file's
 * size and first line (the shebang, for the published `openclaw.mjs` bin
 * link), plus the symlink target when the command is a link, so a zero-byte
 * file, a wrapper script, or a dangling link is visible in the error itself.
 */
const describeOpenClawBinary = async (path: string): Promise<OpenClawBinaryEvidence> => {
  const evidence: OpenClawBinaryEvidence = { path };
  try {
    const linkInfo = await lstat(path);
    if (linkInfo.isSymbolicLink()) {
      evidence.symlinkTarget = await readlink(path);
    }
    // stat() follows the link, so this is the size of what actually runs.
    evidence.size = (await stat(path)).size;
    evidence.firstLine = await readFirstLine(path);
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return evidence;
};

/**
 * Read the first line of a file without loading the whole thing.
 *
 * The target may be a multi-megabyte bundle, so read a small head window and
 * keep only up to the first newline.
 */
const readFirstLine = async (path: string): Promise<string> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(OPENCLAW_BINARY_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, OPENCLAW_BINARY_HEAD_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = head.indexOf("\n");
    return (newlineIndex === -1 ? head : head.slice(0, newlineIndex)).trim();
  } finally {
    await handle.close();
  }
};

const parseVersionToken = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const semverMatch = trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return semverMatch?.[0] ?? trimmed.split(/\s+/)[0] ?? null;
};

/**
 * Ensure the OpenClaw package tree is readable (and traversable) by the
 * unprivileged service user that loads it via `node /usr/bin/openclaw`.
 *
 * The third-party openclaw install.sh occasionally writes the tree under a
 * restrictive umask (observed: 0o077 on Raspberry Pi OS Bookworm), leaving
 * directories at 0o700 root:root and files at 0o600 root:root. The
 * sovereign-node service user then hits MODULE_NOT_FOUND when Node tries
 * to import any sibling file inside the package.
 *
 * Walk the tree and OR in u=rwX,go=rX (read for all; execute for all on
 * dirs and on files that already had any execute bit). Existing tighter
 * modes are not loosened beyond r-x.
 */
const ensureOpenClawPackageReadable = async (
  packageRoot: string,
  logger: { warn: (...args: unknown[]) => void },
): Promise<void> => {
  const queue = [packageRoot];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (currentPath === undefined) {
      continue;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(currentPath);
    } catch (error) {
      logger.warn(
        { path: currentPath, error: error instanceof Error ? error.message : String(error) },
        "Could not stat OpenClaw package entry while ensuring readability",
      );
      continue;
    }

    const currentMode = info.mode & 0o777;
    const ownerHasExec = (currentMode & 0o100) !== 0;
    let target = currentMode | 0o444;
    if (info.isDirectory() || ownerHasExec) {
      target |= 0o111;
    }
    if (target !== currentMode) {
      try {
        await chmod(currentPath, target);
      } catch (error) {
        logger.warn(
          {
            path: currentPath,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to chmod OpenClaw package entry to readable mode",
        );
      }
    }

    if (!info.isDirectory()) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      logger.warn(
        {
          path: currentPath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Could not list OpenClaw package directory while ensuring readability",
      );
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      queue.push(join(currentPath, entry.name));
    }
  }
};

const hardenBundledExtensionDirectories = async (packageRoot: string): Promise<void> => {
  const extensionsRoot = join(packageRoot, "extensions");
  const queue = [extensionsRoot];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (currentPath === undefined) {
      continue;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(currentPath);
    } catch {
      continue;
    }

    const currentMode = info.mode & 0o777;
    const hardenedMode = currentMode & ~0o022;
    if (hardenedMode !== currentMode) {
      await chmod(currentPath, hardenedMode);
    }

    if (!info.isDirectory()) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      queue.push(join(currentPath, entry.name));
    }
  }
};

const planBundledExtensionDependencyRepair = async (
  extensionDir: string,
): Promise<BundledExtensionRepairPlan | null> => {
  const packageJsonPath = join(extensionDir, "package.json");
  try {
    await access(packageJsonPath, fsConstants.R_OK);
  } catch {
    return null;
  }

  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as PackageJsonWithDependencies;
  const declaredDependencies = Object.entries(packageJson.dependencies ?? {})
    .filter(([, spec]) => isInstallableDependencySpec(spec))
    .map(([name, spec]) => ({ name, spec }));

  if (declaredDependencies.length === 0) {
    return null;
  }

  const missingDependencies = await findMissingExtensionDependencies(
    extensionDir,
    declaredDependencies,
  );
  if (missingDependencies.length === 0) {
    return null;
  }

  return {
    packageName: packageJson.name?.trim() || extensionDir,
    missingDependencies,
  };
};

const findMissingExtensionDependencies = async (
  extensionDir: string,
  dependencies: ExtensionDependencySpec[],
): Promise<ExtensionDependencySpec[]> => {
  const resolveFromExtension = createRequire(join(extensionDir, "package.json"));
  return dependencies.filter((dependency) => {
    try {
      resolveFromExtension.resolve(dependency.name);
      return false;
    } catch {
      return true;
    }
  });
};

const isInstallableDependencySpec = (spec: string): boolean => {
  const trimmed = spec.trim();
  return (
    !trimmed.startsWith("file:") &&
    !trimmed.startsWith("link:") &&
    !trimmed.startsWith("workspace:")
  );
};

const versionsMatch = (detectedVersion: string, requestedVersion: string): boolean => {
  const normalizedDetected = normalizeVersion(detectedVersion);
  const normalizedRequested = normalizeVersion(resolveRequestedOpenClawVersion(requestedVersion));
  return normalizedDetected === normalizedRequested;
};

const isAbstractSovereignPin = (value: string): boolean =>
  value.trim().toLowerCase() === SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS;

export const resolveRequestedOpenClawVersion = (requestedVersion?: string | null): string => {
  const trimmed = requestedVersion?.trim() ?? "";
  if (trimmed.length === 0 || isAbstractSovereignPin(trimmed)) {
    return SOVEREIGN_PINNED_OPENCLAW_VERSION;
  }
  return trimmed;
};

const normalizeVersion = (value: string): string => parseVersionToken(value) ?? value.trim();

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};
