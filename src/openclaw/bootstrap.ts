import { type Dirent, constants as fsConstants } from "node:fs";
import { access, chmod, readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Logger } from "../logging/logger.js";
import type { ExecRunner } from "../system/exec.js";

const OPENCLAW_DETECT_TIMEOUT_MS = 20_000;
const OPENCLAW_INSTALL_TIMEOUT_MS = 15 * 60_000;
const OPENCLAW_EXTENSION_REPAIR_TIMEOUT_MS = 5 * 60_000;
const BUNDLED_OPENCLAW_EXTENSION_REPAIR_TARGETS = [
  {
    label: "matrix",
    relativeDir: join("extensions", "matrix"),
  },
] as const;

// Sovereign pins a specific OpenClaw release to ensure stability.
// 2026.3.13 includes health-monitor fixes for long-polling channels (Matrix),
// cron isolated-session deadlock prevention, and numerous security patches.
export const SOVEREIGN_PINNED_OPENCLAW_VERSION = "2026.3.13";
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
  installMethod: "install_sh" | "npm_fallback";
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

export class ShellOpenClawBootstrapper implements OpenClawBootstrapper {
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
    private readonly serviceHome?: string,
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
    let result: Awaited<ReturnType<ExecRunner["run"]>>;
    try {
      result = await this.execRunner.run({
        command: "openclaw",
        args: ["--version"],
        options: {
          timeout: OPENCLAW_DETECT_TIMEOUT_MS,
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
        outcome: "non_zero_exit",
        lookupPath,
        npmPrefix,
        exitCode: result.exitCode,
        stdout: truncateText(result.stdout, 2000),
        stderr: truncateText(result.stderr, 2000),
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
    try {
      const result = await this.execRunner.run({
        command: "sh",
        args: ["-c", "command -v openclaw"],
        options: {
          timeout: OPENCLAW_DETECT_TIMEOUT_MS,
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
    return {
      detectionOutcome: probe.outcome,
      npmPrefix: probe.npmPrefix ?? null,
      lookupPath: probe.lookupPath ?? null,
      commandLocation: await this.resolveOpenClawCommandLocation(probe.lookupPath),
      ...(probe.exitCode === undefined ? {} : { detectExitCode: probe.exitCode }),
      ...(probe.stdout === undefined ? {} : { detectStdout: probe.stdout }),
      ...(probe.stderr === undefined ? {} : { detectStderr: probe.stderr }),
      ...(probe.error === undefined ? {} : { detectError: probe.error }),
      installStdout: truncateText(installResult.stdout, 2000),
      installStderr: truncateText(installResult.stderr, 4000),
    };
  }

  async ensureInstalled(opts: OpenClawInstallOptions): Promise<OpenClawInstallInfo> {
    const desiredVersion = resolveRequestedOpenClawVersion(opts.version);
    const installVersion = resolveInstallVersion(desiredVersion);
    const detected = await this.detectInstalled();
    if (
      detected !== null &&
      !opts.forceReinstall &&
      (opts.skipIfCompatibleInstalled ?? true) &&
      versionsMatch(detected.version, desiredVersion)
    ) {
      await this.repairBundledExtensionRuntimeDependencies();
      this.logger.info(
        {
          openclawVersion: detected.version,
          binaryPath: detected.binaryPath,
        },
        "OpenClaw already installed with compatible version; skipping reinstall",
      );
      return {
        binaryPath: detected.binaryPath,
        version: detected.version,
        installMethod: "install_sh",
      };
    }

    const shellScript = buildInstallShellScript({
      noPrompt: opts.noPrompt ?? true,
      noOnboard: opts.noOnboard ?? true,
      npmPrefix: resolveOpenClawNpmPrefix(this.serviceHome),
      ...(installVersion === undefined ? {} : { version: installVersion }),
    });
    this.logger.info(
      {
        openclawVersion: installVersion,
        noPrompt: opts.noPrompt ?? true,
        noOnboard: opts.noOnboard ?? true,
        forceReinstall: opts.forceReinstall ?? false,
        skipIfCompatibleInstalled: opts.skipIfCompatibleInstalled ?? true,
      },
      "Installing OpenClaw via official install.sh",
    );

    const installResult = await this.execRunner.run({
      command: "bash",
      args: ["-lc", shellScript],
      options: {
        timeout: OPENCLAW_INSTALL_TIMEOUT_MS,
        env: {
          CI: "1",
        },
      },
    });
    if (installResult.exitCode !== 0) {
      this.logger.warn(
        {
          command: installResult.command,
          exitCode: installResult.exitCode,
          stderr: truncateText(installResult.stderr, 4000),
          stdout: truncateText(installResult.stdout, 2000),
        },
        "OpenClaw install.sh failed; attempting direct npm fallback install",
      );
      await this.installViaDirectNpmFallback(desiredVersion);
      const fallbackProbe = await this.probeInstalled();
      const installed = fallbackProbe.detected;
      if (installed === null) {
        throw {
          code: "OPENCLAW_INSTALL_FAILED",
          message: "OpenClaw install fallback completed but the openclaw CLI was not detected",
          retryable: true,
          details: await this.buildDetectionFailureDetails(fallbackProbe, installResult),
        };
      }
      await this.repairBundledExtensionRuntimeDependencies();
      return {
        binaryPath: installed.binaryPath,
        version: installed.version,
        installMethod: "npm_fallback",
      };
    }

    const probe = await this.probeInstalled();
    const installed = probe.detected;
    if (installed === null) {
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw installer completed but the openclaw CLI was not detected",
        retryable: true,
        details: await this.buildDetectionFailureDetails(probe, installResult),
      };
    }

    if (!versionsMatch(installed.version, desiredVersion)) {
      this.logger.warn(
        {
          expectedVersion: desiredVersion,
          detectedVersion: installed.version,
        },
        "OpenClaw install completed but detected version does not match requested version",
      );
    }

    await this.repairBundledExtensionRuntimeDependencies();

    return {
      binaryPath: installed.binaryPath,
      version: installed.version,
      installMethod: "install_sh",
    };
  }

  private async repairBundledExtensionRuntimeDependencies(): Promise<void> {
    const packageRoot = await resolveInstalledOpenClawPackageRoot(
      this.execRunner,
      resolveOpenClawNpmPrefix(this.serviceHome),
    );
    if (packageRoot === null) {
      this.logger.warn(
        "OpenClaw package root could not be resolved after install; skipping bundled extension dependency repair",
      );
      return;
    }

    await ensureOpenClawPackageReadable(packageRoot, this.logger);
    await hardenBundledExtensionDirectories(packageRoot);

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
          cwd: extensionDir,
          timeout: OPENCLAW_EXTENSION_REPAIR_TIMEOUT_MS,
          env: {
            CI: "1",
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

  private async installViaDirectNpmFallback(desiredVersion: string): Promise<void> {
    const installTarget =
      desiredVersion === SOVEREIGN_PINNED_OPENCLAW_VERSION_ALIAS
        ? SOVEREIGN_PINNED_OPENCLAW_VERSION
        : desiredVersion;
    const cacheDir = process.env.NPM_CONFIG_CACHE ?? join(process.env.HOME ?? "/root", ".npm");
    const prefix = resolveOpenClawNpmPrefix(this.serviceHome);
    if (prefix !== undefined) {
      this.logger.info(
        { npmPrefix: prefix },
        "Installing OpenClaw into the service user's npm prefix (install is running unprivileged)",
      );
    }
    const installResult = await this.execRunner.run({
      command: "npm",
      args: ["install", "-g", `openclaw@${installTarget}`],
      options: {
        timeout: OPENCLAW_INSTALL_TIMEOUT_MS,
        env: {
          CI: "1",
          HOME: process.env.HOME ?? "/root",
          NPM_CONFIG_CACHE: cacheDir,
          ...(prefix === undefined ? {} : { npm_config_prefix: prefix }),
        },
      },
    });
    if (installResult.exitCode !== 0) {
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw direct npm fallback install exited with a non-zero status",
        retryable: true,
        details: {
          command: installResult.command,
          exitCode: installResult.exitCode,
          stderr: truncateText(installResult.stderr, 4000),
          stdout: truncateText(installResult.stdout, 2000),
        },
      };
    }
  }
}

type InstallShellArgs = {
  version?: string;
  noPrompt: boolean;
  noOnboard: boolean;
  npmPrefix?: string | undefined;
};

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

const buildInstallShellScript = (args: InstallShellArgs): string => {
  const installArgs = ["-s", "--"];
  if (args.version !== undefined) {
    installArgs.push("--version", args.version);
  }
  if (args.noOnboard) {
    installArgs.push("--no-onboard");
  }
  if (args.noPrompt) {
    installArgs.push("--no-prompt");
  }
  const dollar = "$";

  const prefixLines =
    args.npmPrefix === undefined
      ? []
      : [
          // Unprivileged install: the upstream install.sh shells out to
          // `npm install -g`, which would target the root-owned system prefix
          // and EACCES. Anchor it to a prefix the invoking user owns.
          `export npm_config_prefix=${shellQuote(args.npmPrefix)}`,
          'mkdir -p "$npm_config_prefix"',
          `export PATH="${dollar}{npm_config_prefix}/bin:${dollar}PATH"`,
        ];

  return [
    "set -euo pipefail",
    `if [ "$(id -u)" = "0" ] && [ -z "${dollar}{HOME:-}" ]; then export HOME=/root; fi`,
    `export NPM_CONFIG_CACHE="${dollar}{NPM_CONFIG_CACHE:-${dollar}{HOME:-/root}/.npm}"`,
    'mkdir -p "$NPM_CONFIG_CACHE"',
    ...prefixLines,
    "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh \\",
    `  | bash ${installArgs.map(shellQuote).join(" ")}`,
  ].join("\n");
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const parseVersionToken = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const semverMatch = trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return semverMatch?.[0] ?? trimmed.split(/\s+/)[0] ?? null;
};

const resolveInstalledOpenClawPackageRoot = async (
  execRunner: ExecRunner,
  npmPrefix?: string | undefined,
): Promise<string | null> => {
  const candidates: string[] = [];
  const npmRootResult = await execRunner.run({
    command: "npm",
    args: ["root", "-g"],
    options: {
      timeout: OPENCLAW_DETECT_TIMEOUT_MS,
      env: {
        CI: "1",
        // Resolve against the same prefix the install targeted; otherwise
        // `npm root -g` reports the system prefix and the post-install
        // extension repair silently skips an unprivileged install.
        ...(npmPrefix === undefined ? {} : { npm_config_prefix: npmPrefix }),
      },
    },
  });
  if (npmRootResult.exitCode === 0) {
    const npmRoot = npmRootResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (npmRoot !== undefined) {
      candidates.push(join(npmRoot, "openclaw"));
    }
  }
  if (npmPrefix !== undefined) {
    candidates.push(join(npmPrefix, "lib", "node_modules", "openclaw"));
  }
  candidates.push("/usr/lib/node_modules/openclaw", "/usr/local/lib/node_modules/openclaw");

  for (const candidate of candidates) {
    try {
      await access(join(candidate, "package.json"), fsConstants.R_OK);
      return candidate;
    } catch {}
  }

  return null;
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

const resolveInstallVersion = (requestedVersion: string): string | undefined => {
  const trimmed = resolveRequestedOpenClawVersion(requestedVersion).trim();
  return trimmed.length === 0 ? undefined : trimmed;
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
