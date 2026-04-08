import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import { writeCliError, writeCliSuccess } from "../output.js";

export const DEFAULT_INSTALL_SH_URL =
  "https://raw.githubusercontent.com/ndee/sovereign-ai-node/main/scripts/install.sh";

const INSTALL_SH_URL_TEMPLATE = (ref: string): string =>
  `https://raw.githubusercontent.com/ndee/sovereign-ai-node/${ref}/scripts/install.sh`;

const FETCH_TIMEOUT_MS = 30_000;

type UpdateOptions = {
  json?: boolean;
  requestFile?: string;
  ref?: string;
  installerUrl?: string;
};

const updateResultSchema = z.object({
  installerUrl: z.string().url(),
  exitCode: z.number().int(),
});

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SpawnResultLike = {
  status: number | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
};

export type SpawnerLike = (
  file: string,
  args: readonly string[],
  options: { stdio: "inherit" },
) => SpawnResultLike;

export const buildInstallerUrl = (opts: {
  installerUrl?: string | undefined;
  ref?: string | undefined;
  envUrl?: string | undefined;
  envRef?: string | undefined;
}): string => {
  if (opts.envUrl !== undefined && opts.envUrl.length > 0) {
    return opts.envUrl;
  }
  if (opts.installerUrl !== undefined && opts.installerUrl.length > 0) {
    return opts.installerUrl;
  }
  if (opts.envRef !== undefined && opts.envRef.length > 0) {
    return INSTALL_SH_URL_TEMPLATE(opts.envRef);
  }
  if (opts.ref !== undefined && opts.ref.length > 0) {
    return INSTALL_SH_URL_TEMPLATE(opts.ref);
  }
  return DEFAULT_INSTALL_SH_URL;
};

export const buildInstallerArgs = (opts: { requestFile?: string | undefined }): string[] => {
  const args = ["--update", "--non-interactive"];
  if (opts.requestFile !== undefined && opts.requestFile.length > 0) {
    args.push("--request-file", opts.requestFile);
  }
  return args;
};

const defaultGetuid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);

export const requireRoot = (getuid: () => number = defaultGetuid): void => {
  if (getuid() !== 0) {
    throw {
      code: "UPDATE_REQUIRES_ROOT",
      message: "sovereign-node update must run as root; re-run with sudo",
      retryable: false,
    };
  }
};

export const downloadInstallerScript = async (
  url: string,
  fetchFn: FetchLike = globalThis.fetch,
): Promise<string> => {
  if (!url.startsWith("https://")) {
    throw {
      code: "UPDATE_INSTALLER_URL_INSECURE",
      message: `Installer URL must use https://, got: ${url}`,
      retryable: false,
    };
  }
  const response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw {
      code: "UPDATE_INSTALLER_DOWNLOAD_FAILED",
      message: `Failed to download installer from ${url}: HTTP ${response.status}`,
      retryable: true,
      details: { status: response.status },
    };
  }
  const body = await response.text();
  if (!body.startsWith("#!")) {
    throw {
      code: "UPDATE_INSTALLER_BODY_INVALID",
      message: `Installer body does not start with a shebang (#!): ${url}`,
      retryable: false,
    };
  }
  return body;
};

export const writeInstallerTempScript = async (
  body: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "sovereign-node-update-"));
  const path = join(dir, "install.sh");
  await writeFile(path, body, "utf8");
  await chmod(path, 0o700);
  return { dir, path };
};

export const runInstallerScript = (
  scriptPath: string,
  args: readonly string[],
  spawnFn: SpawnerLike = spawnSync as unknown as SpawnerLike,
): number => {
  const result = spawnFn("bash", [scriptPath, ...args], { stdio: "inherit" });
  if (result.error !== undefined) {
    throw {
      code: "UPDATE_INSTALLER_SPAWN_FAILED",
      message: `Failed to execute install.sh: ${result.error.message}`,
      retryable: false,
    };
  }
  return result.status ?? 1;
};

export const executeUpdateViaInstaller = async (
  opts: {
    requestFile?: string | undefined;
    installerUrl?: string | undefined;
    ref?: string | undefined;
  },
  deps: {
    fetchFn?: FetchLike | undefined;
    spawnFn?: SpawnerLike | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  } = {},
): Promise<{ installerUrl: string; exitCode: number }> => {
  const env = deps.env ?? process.env;
  const installerUrl = buildInstallerUrl({
    installerUrl: opts.installerUrl,
    ref: opts.ref,
    envUrl: env.SOVEREIGN_NODE_INSTALL_SH_URL,
    envRef: env.SOVEREIGN_NODE_REF,
  });
  const body = await downloadInstallerScript(installerUrl, deps.fetchFn);
  const { dir, path } = await writeInstallerTempScript(body);
  try {
    const args = buildInstallerArgs({ requestFile: opts.requestFile });
    const exitCode = runInstallerScript(path, args, deps.spawnFn);
    return { installerUrl, exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export const registerUpdateCommand = (program: Command, app: AppContainer): void => {
  program
    .command("update")
    .description(
      "Download the latest install.sh and re-run it in --update mode. " +
        "Installer output streams live; --json emits a summary envelope after it exits.",
    )
    .option("--json", "Emit JSON output")
    .option("--request-file <path>", "Forwarded to install.sh as --request-file <path>")
    .option("--ref <ref>", "Git ref for install.sh (default: main)")
    .option("--installer-url <url>", "Override the install.sh URL (wins over --ref)")
    .action(async (opts: UpdateOptions) => {
      const command = "update";
      try {
        const pending = await app.installerService.getPendingMigrations();
        if (pending.pending.length > 0) {
          throw {
            code: "UPDATE_REQUIRES_MIGRATION",
            message: `Run 'sovereign-node migrate' before update (${pending.pending.map((entry) => entry.id).join(", ")})`,
            retryable: false,
            details: {
              requestFile: pending.requestFile,
              pending: pending.pending.map((entry) => entry.id),
            },
          };
        }
        requireRoot();
        const result = await executeUpdateViaInstaller({
          requestFile: opts.requestFile,
          ref: opts.ref,
          installerUrl: opts.installerUrl,
        });
        writeCliSuccess(command, result, updateResultSchema, Boolean(opts.json));
        process.exitCode = result.exitCode;
      } catch (error) {
        writeCliError(command, error, Boolean(opts.json));
        process.exitCode = 1;
      }
    });
};
