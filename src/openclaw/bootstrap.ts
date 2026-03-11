import { constants as fsConstants } from "node:fs";
import { access, chmod, readFile, readdir, stat } from "node:fs/promises";
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

// OpenClaw 2026.3.2 regressed Matrix plugin loading, so Sovereign stays on the
// prior known-good release until the upstream fix is adopted.
export const SOVEREIGN_PINNED_OPENCLAW_VERSION = "2026.3.1";
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
  installMethod: "install_sh";
};

export interface OpenClawBootstrapper {
  detectInstalled(): Promise<DetectedOpenClaw | null>;
  ensureInstalled(opts: OpenClawInstallOptions): Promise<OpenClawInstallInfo>;
}

export class ShellOpenClawBootstrapper implements OpenClawBootstrapper {
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
  ) {}

  async detectInstalled(): Promise<DetectedOpenClaw | null> {
    let result;
    try {
      result = await this.execRunner.run({
        command: "openclaw",
        args: ["--version"],
        options: {
          timeout: OPENCLAW_DETECT_TIMEOUT_MS,
          env: {
            CI: "1",
          },
        },
      });
    } catch {
      return null;
    }
    if (result.exitCode !== 0) {
      return null;
    }
    const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
    const parsedVersion = parseVersionToken(versionOutput);
    if (parsedVersion === null) {
      return null;
    }
    return {
      binaryPath: "openclaw",
      version: parsedVersion,
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
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw install.sh exited with a non-zero status",
        retryable: true,
        details: {
          command: installResult.command,
          exitCode: installResult.exitCode,
          stderr: truncateText(installResult.stderr, 4000),
          stdout: truncateText(installResult.stdout, 2000),
        },
      };
    }

    const installed = await this.detectInstalled();
    if (installed === null) {
      throw {
        code: "OPENCLAW_INSTALL_FAILED",
        message: "OpenClaw installer completed but the openclaw CLI was not detected",
        retryable: true,
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
    const packageRoot = await resolveInstalledOpenClawPackageRoot(this.execRunner);
    if (packageRoot === null) {
      this.logger.warn(
        "OpenClaw package root could not be resolved after install; skipping bundled extension dependency repair",
      );
      return;
    }

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
}

type InstallShellArgs = {
  version?: string;
  noPrompt: boolean;
  noOnboard: boolean;
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

  return [
    "set -euo pipefail",
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
): Promise<string | null> => {
  const candidates: string[] = [];
  const npmRootResult = await execRunner.run({
    command: "npm",
    args: ["root", "-g"],
    options: {
      timeout: OPENCLAW_DETECT_TIMEOUT_MS,
      env: {
        CI: "1",
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
  candidates.push("/usr/lib/node_modules/openclaw", "/usr/local/lib/node_modules/openclaw");

  for (const candidate of candidates) {
    try {
      await access(join(candidate, "package.json"), fsConstants.R_OK);
      return candidate;
    } catch {}
  }

  return null;
};

const hardenBundledExtensionDirectories = async (packageRoot: string): Promise<void> => {
  const extensionsRoot = join(packageRoot, "extensions");
  let entries;
  try {
    entries = await readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const candidateDirs = [
    extensionsRoot,
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(extensionsRoot, entry.name)),
  ];

  for (const candidateDir of candidateDirs) {
    const info = await stat(candidateDir);
    const currentMode = info.mode & 0o777;
    const hardenedMode = currentMode & ~0o022;
    if (hardenedMode === currentMode) {
      continue;
    }
    await chmod(candidateDir, hardenedMode);
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
