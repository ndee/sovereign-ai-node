import { access, readFile } from "node:fs/promises";

import type { Command } from "commander";

import type { AppContainer } from "../../app/create-app.js";
import { DEFAULT_BOT_REPO_URL } from "../../bots/catalog.js";
import {
  type InstallRequest,
  installRequestSchema,
  startInstallResultSchema,
} from "../../contracts/index.js";
import { DEFAULT_INSTALL_REQUEST_FILE } from "../../installer/real-service-shared.js";
import { SOVEREIGN_PINNED_OPENCLAW_VERSION } from "../../openclaw/bootstrap.js";
import {
  applyBotCatalogSourceOptions,
  type BotCatalogSourceOptions,
} from "../bot-catalog-source.js";
import { writeCliError, writeCliSuccess } from "../output.js";

type InstallOptions = {
  json?: boolean;
  nonInteractive?: boolean;
  openclawVersion?: string;
  skipOpenclawInstall?: boolean;
  forceOpenclawReinstall?: boolean;
  bot?: string[];
  connectivityMode?: "direct" | "relay";
  relayControlUrl?: string;
  relayEnrollmentToken?: string;
  matrixTlsMode?: "auto" | "internal" | "manual" | "local-dev";
  requestFile?: string;
} & BotCatalogSourceOptions;

const DEFAULT_MANAGED_RELAY_CONTROL_URL = "https://relay.sovereign-ai-node.com";

const buildScaffoldInstallRequest = (opts: InstallOptions): InstallRequest => {
  const connectivityMode = opts.connectivityMode ?? "relay";
  const selectedBots = opts.bot?.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return {
    mode: "bundled_matrix",
    connectivity: {
      mode: connectivityMode,
    },
    ...(connectivityMode === "relay"
      ? {
          relay: {
            controlUrl: opts.relayControlUrl ?? DEFAULT_MANAGED_RELAY_CONTROL_URL,
            ...(opts.relayEnrollmentToken === undefined
              ? {}
              : { enrollmentToken: opts.relayEnrollmentToken }),
          },
        }
      : {}),
    openclaw: {
      manageInstallation: !opts.skipOpenclawInstall,
      installMethod: "install_sh",
      version: opts.openclawVersion ?? SOVEREIGN_PINNED_OPENCLAW_VERSION,
      skipIfCompatibleInstalled: true,
      forceReinstall: opts.forceOpenclawReinstall ?? false,
      runOnboard: false,
    },
    openrouter: {
      model: "qwen/qwen3.5-9b",
      secretRef: "env:OPENROUTER_API_KEY",
    },
    matrix: {
      homeserverDomain:
        connectivityMode === "relay" ? "relay-pending.invalid" : "matrix.example.org",
      publicBaseUrl:
        connectivityMode === "relay"
          ? "https://relay-pending.invalid"
          : "https://matrix.example.org",
      federationEnabled: false,
      tlsMode: connectivityMode === "relay" ? "auto" : (opts.matrixTlsMode ?? "auto"),
      alertRoomName: "Sovereign Alerts",
    },
    operator: {
      username: "operator",
    },
    ...(selectedBots === undefined || selectedBots.length === 0
      ? {}
      : {
          bots: {
            selected: selectedBots,
          },
        }),
    advanced: {
      nonInteractive: opts.nonInteractive ?? false,
    },
  };
};

export const registerInstallCommand = (program: Command, app: AppContainer): void => {
  program
    .command("install")
    .description("Run the Sovereign Node installer flow (scaffold)")
    .option("--json", "Emit JSON output")
    .option("--non-interactive", "Run without interactive prompts")
    .option(
      "--openclaw-version <ver>",
      `Override pinned OpenClaw version (advanced; default ${SOVEREIGN_PINNED_OPENCLAW_VERSION})`,
    )
    .option("--skip-openclaw-install", "Reuse existing OpenClaw install only (advanced)")
    .option("--force-openclaw-reinstall", "Force OpenClaw reinstall (repair path)")
    .option(
      "--bot <id>",
      "Bot package id to install (repeatable; omit to use repo defaults)",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option("--connectivity-mode <mode>", "Connection mode (direct|relay) (scaffold/dev)")
    .option(
      "--relay-control-url <url>",
      "Relay control plane URL (default: https://relay.sovereign-ai-node.com)",
    )
    .option(
      "--relay-enrollment-token <token>",
      "Custom relay enrollment token (required for non-Sovereign relays)",
    )
    .option(
      "--matrix-tls-mode <mode>",
      "Matrix TLS mode (auto|internal|manual|local-dev) (scaffold/dev)",
    )
    .option(
      "--request-file <path>",
      "Path to an InstallRequest JSON file (overrides scaffold defaults)",
    )
    .option("--bots-source-dir <path>", "Use a local sovereign-ai-bots checkout")
    .option(
      "--bots-repo-url <url>",
      `Clone bot packages from a Git repository URL (default: ${DEFAULT_BOT_REPO_URL})`,
    )
    .option("--bots-repo-ref <ref>", "Git branch, tag, or commit for --bots-repo-url")
    .action(async (opts: InstallOptions) => {
      const command = "install";
      try {
        if (process.env.SOVEREIGN_INTERNAL_INSTALL === "1") {
          applyBotCatalogSourceOptions(opts);
          const req = await resolveInstallRequest(opts);
          const result = await app.installerService.startInstall(req);
          writeCliSuccess(command, result, startInstallResultSchema, Boolean(opts.json));
          return;
        }
        throw new Error(
          "Use scripts/install.sh or the curl installer for Sovereign Node v2 installs.",
        );
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};

export const resolveInstallRequest = async (
  opts: InstallOptions,
  defaultRequestFile: string = DEFAULT_INSTALL_REQUEST_FILE,
): Promise<InstallRequest> => {
  if (opts.requestFile !== undefined) {
    return await readInstallRequestFromFile(opts.requestFile);
  }

  try {
    await access(defaultRequestFile);
    return await readInstallRequestFromFile(defaultRequestFile);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return buildScaffoldInstallRequest(opts);
    }
    throw error;
  }
};

const readInstallRequestFromFile = async (path: string): Promise<InstallRequest> => {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return installRequestSchema.parse(parsed);
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;
