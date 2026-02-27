import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { TestMatrixRequest } from "../contracts/api.js";
import type { CheckResult } from "../contracts/common.js";
import type { InstallRequest, TestMatrixResult } from "../contracts/index.js";
import type { SovereignPaths } from "../config/paths.js";
import type { Logger } from "../logging/logger.js";
import type { ExecRunner, ExecResult } from "./exec.js";

const MATRIX_INTERNAL_BASE_URL = "http://127.0.0.1:8008";
const MATRIX_READY_TIMEOUT_MS = 180_000;
const MATRIX_READY_POLL_INTERVAL_MS = 1_500;
const MATRIX_HTTP_TIMEOUT_MS = 8_000;
const MATRIX_BOOTSTRAP_SECRET_DIR = "bootstrap-secrets";
const DEFAULT_SYNAPSE_IMAGE = "matrixdotorg/synapse:v1.125.0";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type BundledMatrixProvisionResult = {
  projectDir: string;
  composeFilePath: string;
  homeserverDomain: string;
  publicBaseUrl: string;
  adminBaseUrl: string;
  federationEnabled: boolean;
  tlsMode: "local-dev";
};

type MatrixBootstrapAccount = {
  localpart: string;
  userId: string;
  passwordSecretRef: string;
  accessToken: string;
};

export type BundledMatrixAccountsResult = {
  operator: MatrixBootstrapAccount;
  bot: MatrixBootstrapAccount;
};

export type BundledMatrixRoomBootstrapResult = {
  roomId: string;
  roomName: string;
};

export interface BundledMatrixProvisioner {
  provision(req: InstallRequest): Promise<BundledMatrixProvisionResult>;
  bootstrapAccounts(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
  ): Promise<BundledMatrixAccountsResult>;
  bootstrapRoom(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
    accounts: BundledMatrixAccountsResult,
  ): Promise<BundledMatrixRoomBootstrapResult>;
  test(req: TestMatrixRequest): Promise<TestMatrixResult>;
}

export class DockerComposeBundledMatrixProvisioner implements BundledMatrixProvisioner {
  private resolvedBaseDir: string | null = null;

  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
    private readonly paths: SovereignPaths,
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  async provision(req: InstallRequest): Promise<BundledMatrixProvisionResult> {
    const tlsMode = req.matrix.tlsMode ?? "auto";
    if (tlsMode !== "local-dev") {
      throw {
        code: "MATRIX_TLS_MODE_UNSUPPORTED",
        message:
          "Bundled Matrix provisioning is currently implemented only for tlsMode=local-dev",
        retryable: false,
        details: {
          requestedTlsMode: tlsMode,
          supportedTlsMode: "local-dev",
        },
      };
    }

    const homeserverDomain = req.matrix.homeserverDomain;
    const publicBaseUrl = req.matrix.publicBaseUrl;
    const federationEnabled = req.matrix.federationEnabled ?? false;
    const baseDir = await this.ensureBaseDir();
    const projectSlug = slugifyProjectName(homeserverDomain);
    const projectDir = join(baseDir, projectSlug);
    const synapseDir = join(projectDir, "synapse");
    const postgresDir = join(projectDir, "postgres-data");
    const composeFilePath = join(projectDir, "compose.yaml");
    const envFilePath = join(projectDir, ".env");

    await mkdir(synapseDir, { recursive: true });
    await mkdir(postgresDir, { recursive: true });
    await ensureDirectoryTreeWritable(synapseDir);
    await ensureDirectoryTreeWritable(postgresDir);

    const existingEnv = await this.readExistingEnv(projectDir);
    const existingPostgresPassword = existingEnv.POSTGRES_PASSWORD?.trim();
    const generated = {
      postgresPassword:
        existingPostgresPassword !== undefined && existingPostgresPassword.length > 0
          ? existingPostgresPassword
          : `pg_${randomUUID().replaceAll("-", "")}`,
      registrationSharedSecret: randomUUID().replaceAll("-", ""),
      macaroonSecret: randomUUID().replaceAll("-", ""),
      formSecret: randomUUID().replaceAll("-", ""),
      signingKeyFile: `${homeserverDomain}.signing.key`,
    };

    const composeYaml = renderComposeYaml(resolveSynapseImage());
    const envFile = renderEnvFile({
      homeserverDomain,
      publicBaseUrl,
      federationEnabled,
      postgresPassword: generated.postgresPassword,
      synapseConfigPath: "/data/homeserver.yaml",
    });
    const homeserverYaml = renderSynapseConfig({
      homeserverDomain,
      publicBaseUrl,
      federationEnabled,
      postgresPassword: generated.postgresPassword,
      registrationSharedSecret: generated.registrationSharedSecret,
      macaroonSecret: generated.macaroonSecret,
      formSecret: generated.formSecret,
      signingKeyFile: generated.signingKeyFile,
    });
    const signingKey = renderSigningKey();
    const logConfig = renderSynapseLogConfig();

    await Promise.all([
      writeFile(composeFilePath, `${composeYaml}\n`, "utf8"),
      writeFile(envFilePath, `${envFile}\n`, "utf8"),
      writeFile(join(synapseDir, "homeserver.yaml"), `${homeserverYaml}\n`, "utf8"),
      writeFile(join(synapseDir, generated.signingKeyFile), `${signingKey}\n`, "utf8"),
      writeFile(join(synapseDir, "log.config"), `${logConfig}\n`, "utf8"),
    ]);
    await ensureDirectoryTreeWritable(synapseDir);
    await ensureDirectoryTreeWritable(postgresDir);

    const composeConfigCheck = await this.runComposeCommand(projectDir, composeFilePath, [
      "config",
    ]);
    if (composeConfigCheck.exitCode !== 0) {
      throw {
        code: "MATRIX_COMPOSE_CONFIG_FAILED",
        message: "Bundled Matrix compose configuration validation failed",
        retryable: true,
        details: {
          command: composeConfigCheck.command,
          exitCode: composeConfigCheck.exitCode,
          stderr: truncateText(composeConfigCheck.stderr, 4000),
          stdout: truncateText(composeConfigCheck.stdout, 4000),
          projectDir,
          composeFilePath,
        },
      };
    }

    this.logger.info(
      {
        projectDir,
        homeserverDomain,
        publicBaseUrl,
        tlsMode,
      },
      "Bundled Matrix local-dev compose bundle generated and validated",
    );

    return {
      projectDir,
      composeFilePath,
      homeserverDomain,
      publicBaseUrl,
      adminBaseUrl: MATRIX_INTERNAL_BASE_URL,
      federationEnabled,
      tlsMode: "local-dev",
    };
  }

  async bootstrapAccounts(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
  ): Promise<BundledMatrixAccountsResult> {
    await this.ensureStackRunning(provision);
    await this.waitForSynapseReadyWithRecovery(provision);

    const operatorLocalpart = sanitizeMatrixLocalpart(req.operator.username, "operator");
    const botLocalpart = chooseBotLocalpart(operatorLocalpart);
    const operatorPassword = generatePassword();
    const botPassword = generatePassword();
    const secretsDir = await this.ensureBootstrapSecretsDir(provision.projectDir);

    const operatorPasswordSecretRef = await this.writeSecretFile(
      secretsDir,
      `${operatorLocalpart}.password`,
      operatorPassword,
    );
    const botPasswordSecretRef = await this.writeSecretFile(
      secretsDir,
      `${botLocalpart}.password`,
      botPassword,
    );

    await this.registerSynapseUser(provision, {
      localpart: operatorLocalpart,
      password: operatorPassword,
      admin: true,
    });
    await this.registerSynapseUser(provision, {
      localpart: botLocalpart,
      password: botPassword,
      admin: false,
    });

    const operatorSession = await this.loginUser(
      provision.adminBaseUrl,
      operatorLocalpart,
      operatorPassword,
    );
    const botSession = await this.loginUser(provision.adminBaseUrl, botLocalpart, botPassword);

    const accounts: BundledMatrixAccountsResult = {
      operator: {
        localpart: operatorLocalpart,
        userId: operatorSession.userId,
        passwordSecretRef: operatorPasswordSecretRef,
        accessToken: operatorSession.accessToken,
      },
      bot: {
        localpart: botLocalpart,
        userId: botSession.userId,
        passwordSecretRef: botPasswordSecretRef,
        accessToken: botSession.accessToken,
      },
    };

    this.logger.info(
      {
        projectDir: provision.projectDir,
        homeserverDomain: provision.homeserverDomain,
        operatorUserId: accounts.operator.userId,
        botUserId: accounts.bot.userId,
      },
      "Bundled Matrix accounts bootstrapped",
    );

    return accounts;
  }

  async bootstrapRoom(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
    accounts: BundledMatrixAccountsResult,
  ): Promise<BundledMatrixRoomBootstrapResult> {
    await this.waitForSynapseReady(provision.adminBaseUrl);

    const roomName = req.matrix.alertRoomName?.trim() || "Sovereign Alerts";
    const created = await this.matrixJsonRequest<{ room_id?: unknown }>({
      baseUrl: provision.adminBaseUrl,
      path: "/_matrix/client/v3/createRoom",
      method: "POST",
      accessToken: accounts.operator.accessToken,
      body: {
        name: roomName,
        preset: "private_chat",
        visibility: "private",
      },
      errorCode: "MATRIX_ROOM_CREATE_FAILED",
      errorMessage: "Failed to create the Matrix alert room",
      retryable: true,
    });

    const roomId = typeof created.room_id === "string" ? created.room_id.trim() : "";
    if (roomId.length === 0) {
      throw {
        code: "MATRIX_ROOM_CREATE_FAILED",
        message: "Matrix room creation returned an invalid room_id",
        retryable: true,
      };
    }

    await this.matrixJsonRequest({
      baseUrl: provision.adminBaseUrl,
      path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      method: "POST",
      accessToken: accounts.operator.accessToken,
      body: {
        user_id: accounts.bot.userId,
      },
      errorCode: "MATRIX_ROOM_INVITE_FAILED",
      errorMessage: "Failed to invite bot account into the Matrix alert room",
      retryable: true,
    });

    await this.matrixJsonRequest({
      baseUrl: provision.adminBaseUrl,
      path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      method: "POST",
      accessToken: accounts.bot.accessToken,
      body: {},
      errorCode: "MATRIX_ROOM_JOIN_FAILED",
      errorMessage: "Bot account could not join the Matrix alert room",
      retryable: true,
    });

    const result: BundledMatrixRoomBootstrapResult = {
      roomId,
      roomName,
    };
    this.logger.info(
      {
        projectDir: provision.projectDir,
        roomId: result.roomId,
        roomName: result.roomName,
      },
      "Bundled Matrix alert room bootstrapped",
    );
    return result;
  }

  async test(req: TestMatrixRequest): Promise<TestMatrixResult> {
    const homeserverUrl = normalizePublicBaseUrl(req.publicBaseUrl);
    const checks: CheckResult[] = [];

    const clientProbe = await this.runProbe({
      id: "matrix-client-api",
      name: "Matrix client API",
      passMessage: "Matrix client API is reachable",
      failMessage: "Matrix client API is not reachable",
      run: async () => {
        const payload = await this.matrixJsonRequest<{ versions?: unknown }>({
          baseUrl: homeserverUrl,
          path: "/_matrix/client/versions",
          method: "GET",
          errorCode: "MATRIX_CLIENT_API_UNREACHABLE",
          errorMessage: "Matrix client API probe failed",
          retryable: true,
        });
        if (!Array.isArray(payload.versions)) {
          throw new Error("Matrix client versions response did not include a versions array");
        }
      },
    });
    checks.push(clientProbe.check);

    const federationEnabled = req.federationEnabled ?? false;
    let serverDiscovery: { required: boolean; ok: boolean };
    if (federationEnabled) {
      const federationProbe = await this.runProbe({
        id: "matrix-federation-api",
        name: "Matrix federation API",
        passMessage: "Matrix federation API is reachable",
        failMessage: "Matrix federation API is not reachable",
        run: async () => {
          const payload = await this.matrixJsonRequest<{ server?: unknown }>({
            baseUrl: homeserverUrl,
            path: "/_matrix/federation/v1/version",
            method: "GET",
            errorCode: "MATRIX_FEDERATION_API_UNREACHABLE",
            errorMessage: "Matrix federation probe failed",
            retryable: true,
          });
          if (!isRecord(payload.server)) {
            throw new Error("Matrix federation response did not include server metadata");
          }
        },
      });
      checks.push(federationProbe.check);
      serverDiscovery = {
        required: true,
        ok: federationProbe.ok,
      };
    } else {
      checks.push(
        check(
          "matrix-federation-api",
          "Matrix federation API",
          "skip",
          "Matrix federation is disabled; federation probe skipped",
        ),
      );
      serverDiscovery = {
        required: false,
        ok: true,
      };
    }

    return {
      ok: checks.every((entry) => entry.status !== "fail"),
      homeserverUrl,
      clientDiscovery: {
        required: false,
        ok: true,
      },
      serverDiscovery,
      checks,
    };
  }

  private async ensureStackRunning(provision: BundledMatrixProvisionResult): Promise<void> {
    const upArgs = ["up", "-d", "--remove-orphans", "--force-recreate", "postgres", "synapse"];
    const composeUp = await this.runComposeCommand(
      provision.projectDir,
      provision.composeFilePath,
      upArgs,
    );
    if (composeUp.exitCode === 0) {
      return;
    }

    const composeDown = await this.runComposeCommand(
      provision.projectDir,
      provision.composeFilePath,
      ["down", "--remove-orphans"],
    );
    const retryUp = await this.runComposeCommand(
      provision.projectDir,
      provision.composeFilePath,
      upArgs,
    );
    if (retryUp.exitCode === 0) {
      this.logger.warn(
        {
          projectDir: provision.projectDir,
          firstAttemptExitCode: composeUp.exitCode,
        },
        "Bundled Matrix stack start failed once and recovered after compose down/up retry",
      );
      return;
    }

    throw {
      code: "MATRIX_STACK_START_FAILED",
      message: "Failed to start bundled Matrix services with Docker Compose",
      retryable: true,
      details: {
        firstAttempt: {
          exitCode: composeUp.exitCode,
          stderr: truncateText(composeUp.stderr, 4000),
          stdout: truncateText(composeUp.stdout, 4000),
        },
        downAttempt: {
          exitCode: composeDown.exitCode,
          stderr: truncateText(composeDown.stderr, 3000),
          stdout: truncateText(composeDown.stdout, 3000),
        },
        retryAttempt: {
          exitCode: retryUp.exitCode,
          stderr: truncateText(retryUp.stderr, 4000),
          stdout: truncateText(retryUp.stdout, 4000),
        },
        projectDir: provision.projectDir,
        composeFilePath: provision.composeFilePath,
      },
    };
  }

  private async registerSynapseUser(
    provision: BundledMatrixProvisionResult,
    input: {
      localpart: string;
      password: string;
      admin: boolean;
    },
  ): Promise<void> {
    const args = [
      "exec",
      "-T",
      "synapse",
      "register_new_matrix_user",
      "-u",
      input.localpart,
      "-p",
      input.password,
      ...(input.admin ? ["-a"] : []),
      "-c",
      "/data/homeserver.yaml",
      provision.adminBaseUrl,
    ];
    let registerResult: ExecResult;
    try {
      registerResult = await this.runComposeCommand(
        provision.projectDir,
        provision.composeFilePath,
        args,
      );
    } catch (error) {
      throw {
        code: "MATRIX_ACCOUNT_BOOTSTRAP_FAILED",
        message: `Failed to register Matrix account '${input.localpart}'`,
        retryable: true,
        details: {
          localpart: input.localpart,
          admin: input.admin,
          projectDir: provision.projectDir,
          error: describeError(error),
        },
      };
    }
    if (registerResult.exitCode !== 0) {
      throw {
        code: "MATRIX_ACCOUNT_BOOTSTRAP_FAILED",
        message: `Failed to register Matrix account '${input.localpart}'`,
        retryable: true,
        details: {
          localpart: input.localpart,
          admin: input.admin,
          exitCode: registerResult.exitCode,
          stderr: truncateText(registerResult.stderr, 4000),
          stdout: truncateText(registerResult.stdout, 4000),
          projectDir: provision.projectDir,
        },
      };
    }
  }

  private async loginUser(
    baseUrl: string,
    localpart: string,
    password: string,
  ): Promise<{ accessToken: string; userId: string }> {
    const payload = await this.matrixJsonRequest<{
      access_token?: unknown;
      user_id?: unknown;
    }>({
      baseUrl,
      path: "/_matrix/client/v3/login",
      method: "POST",
      body: {
        type: "m.login.password",
        identifier: {
          type: "m.id.user",
          user: localpart,
        },
        password,
      },
      errorCode: "MATRIX_LOGIN_FAILED",
      errorMessage: `Matrix login failed for '${localpart}'`,
      retryable: false,
    });

    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    const userId = typeof payload.user_id === "string" ? payload.user_id : "";
    if (accessToken.length === 0 || userId.length === 0) {
      throw {
        code: "MATRIX_LOGIN_FAILED",
        message: `Matrix login response for '${localpart}' did not include an access token`,
        retryable: false,
      };
    }

    return {
      accessToken,
      userId,
    };
  }

  private async waitForSynapseReady(baseUrl: string): Promise<void> {
    const deadline = Date.now() + MATRIX_READY_TIMEOUT_MS;
    let lastError = "unknown";

    while (Date.now() < deadline) {
      try {
        const payload = await this.matrixJsonRequest<{ versions?: unknown }>({
          baseUrl,
          path: "/_matrix/client/versions",
          method: "GET",
          errorCode: "MATRIX_READY_CHECK_FAILED",
          errorMessage: "Matrix readiness check failed",
          retryable: true,
        });
        if (Array.isArray(payload.versions)) {
          return;
        }
        lastError = "versions array missing from readiness response";
      } catch (error) {
        lastError = describeError(error);
      }

      await delay(MATRIX_READY_POLL_INTERVAL_MS);
    }

    throw {
      code: "MATRIX_WAIT_READY_TIMEOUT",
      message: "Timed out waiting for bundled Matrix homeserver readiness",
      retryable: true,
      details: {
        baseUrl,
        timeoutMs: MATRIX_READY_TIMEOUT_MS,
        lastError,
      },
    };
  }

  private async waitForSynapseReadyWithRecovery(
    provision: BundledMatrixProvisionResult,
  ): Promise<void> {
    try {
      await this.waitForSynapseReady(provision.adminBaseUrl);
      return;
    } catch (error) {
      if (!(isStructuredError(error) && error.code === "MATRIX_WAIT_READY_TIMEOUT")) {
        throw error;
      }

      const diagnostics = await this.collectComposeDiagnostics(provision);
      const synapseLogs =
        typeof diagnostics.synapseLogs === "string" ? diagnostics.synapseLogs : "";
      if (!isPostgresAuthFailure(synapseLogs)) {
        throw {
          ...error,
          details: {
            ...(error.details ?? {}),
            ...diagnostics,
          },
        };
      }

      this.logger.warn(
        {
          projectDir: provision.projectDir,
        },
        "Detected bundled Matrix postgres credential mismatch; resetting postgres data and retrying",
      );

      await this.resetBundledPostgresState(provision);
      await this.ensureStackRunning(provision);
      try {
        await this.waitForSynapseReady(provision.adminBaseUrl);
        return;
      } catch (retryError) {
        const retryDiagnostics = await this.collectComposeDiagnostics(provision);
        if (isStructuredError(retryError)) {
          throw {
            ...retryError,
            details: {
              ...(retryError.details ?? {}),
              firstAttempt: diagnostics,
              retryAttempt: retryDiagnostics,
            },
          };
        }
        throw retryError;
      }
    }
  }

  private async resetBundledPostgresState(
    provision: BundledMatrixProvisionResult,
  ): Promise<void> {
    await this.runComposeCommand(
      provision.projectDir,
      provision.composeFilePath,
      ["down", "--remove-orphans"],
    );
    const postgresDir = join(provision.projectDir, "postgres-data");
    await rm(postgresDir, { recursive: true, force: true });
    await mkdir(postgresDir, { recursive: true });
    await ensureDirectoryTreeWritable(postgresDir);
  }

  private async collectComposeDiagnostics(
    provision: BundledMatrixProvisionResult,
  ): Promise<Record<string, unknown>> {
    const ps = await this.safeComposeDiagnosticCommand(
      provision,
      ["ps", "-a"],
      "ps-unavailable",
    );
    const logs = await this.safeComposeDiagnosticCommand(
      provision,
      ["logs", "--no-color", "--tail", "200", "synapse"],
      "logs-unavailable",
    );
    return {
      composePs: ps,
      synapseLogs: logs,
    };
  }

  private async safeComposeDiagnosticCommand(
    provision: BundledMatrixProvisionResult,
    args: string[],
    fallback: string,
  ): Promise<string> {
    try {
      const result = await this.runComposeCommand(
        provision.projectDir,
        provision.composeFilePath,
        args,
      );
      return truncateText(`${result.stdout}\n${result.stderr}`, 6000);
    } catch (error) {
      return `${fallback}: ${describeError(error)}`;
    }
  }

  private async runProbe(input: {
    id: string;
    name: string;
    passMessage: string;
    failMessage: string;
    run: () => Promise<void>;
  }): Promise<{ ok: boolean; check: CheckResult }> {
    try {
      await input.run();
      return {
        ok: true,
        check: check(input.id, input.name, "pass", input.passMessage),
      };
    } catch (error) {
      return {
        ok: false,
        check: check(input.id, input.name, "fail", input.failMessage, {
          error: describeError(error),
        }),
      };
    }
  }

  private async matrixJsonRequest<T>(input: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST";
    accessToken?: string;
    body?: unknown;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
  }): Promise<T> {
    const url = new URL(input.path, ensureTrailingSlash(input.baseUrl)).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MATRIX_HTTP_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          Accept: "application/json",
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(input.accessToken === undefined
            ? {}
            : { Authorization: `Bearer ${input.accessToken}` }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: controller.signal,
      });

      const rawBody = await response.text();
      const parsedBody = parseJsonSafely(rawBody);
      if (!response.ok) {
        throw {
          code: input.errorCode,
          message: input.errorMessage,
          retryable: input.retryable,
          details: {
            url,
            status: response.status,
            body: summarizeUnknown(parsedBody),
          },
        };
      }

      return parsedBody as T;
    } catch (error) {
      if (isStructuredError(error)) {
        throw error;
      }
      throw {
        code: input.errorCode,
        message: input.errorMessage,
        retryable: input.retryable,
        details: {
          url,
          error: describeError(error),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async ensureBootstrapSecretsDir(projectDir: string): Promise<string> {
    const dir = join(projectDir, MATRIX_BOOTSTRAP_SECRET_DIR);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
    return dir;
  }

  private async writeSecretFile(
    secretsDir: string,
    fileName: string,
    value: string,
  ): Promise<string> {
    const secretPath = join(secretsDir, fileName);
    await writeFile(secretPath, `${value}\n`, "utf8");
    await chmod(secretPath, 0o600);
    return `file:${secretPath}`;
  }

  private async runComposeCommand(
    projectDir: string,
    composeFilePath: string,
    trailingArgs: string[],
  ): Promise<ExecResult> {
    const commonArgs = ["compose", "-f", composeFilePath, "--project-directory", projectDir];
    const dockerCompose = await this.safeExec("docker", [...commonArgs, ...trailingArgs], projectDir);
    if (dockerCompose.ok && dockerCompose.result.exitCode === 0) {
      return dockerCompose.result;
    }

    const legacyArgs = ["-f", composeFilePath, ...trailingArgs];
    const dockerComposeLegacy = await this.safeExec("docker-compose", legacyArgs, projectDir);
    if (dockerComposeLegacy.ok && dockerComposeLegacy.result.exitCode === 0) {
      return dockerComposeLegacy.result;
    }

    if (dockerCompose.ok) {
      return dockerCompose.result;
    }
    if (dockerComposeLegacy.ok) {
      return dockerComposeLegacy.result;
    }

    throw {
      code: "MATRIX_COMPOSE_UNAVAILABLE",
      message: "Neither docker compose nor docker-compose could be executed",
      retryable: false,
      details: {
        dockerComposeError: dockerCompose.error,
        dockerComposeLegacyError: dockerComposeLegacy.error,
      },
    };
  }

  private async safeExec(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ ok: true; result: ExecResult } | { ok: false; error: string }> {
    try {
      const result = await this.execRunner.run({
        command,
        args,
        options: {
          cwd,
        },
      });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureBaseDir(): Promise<string> {
    if (this.resolvedBaseDir !== null) {
      return this.resolvedBaseDir;
    }

    const preferred = join(this.paths.stateDir, "bundled-matrix");
    try {
      await mkdir(preferred, { recursive: true });
      await access(preferred, fsConstants.W_OK);
      this.resolvedBaseDir = preferred;
      return preferred;
    } catch (error) {
      const fallback = resolve(process.cwd(), ".sovereign-node-dev", "bundled-matrix");
      await mkdir(fallback, { recursive: true });
      this.logger.debug(
        {
          preferredMatrixStateDir: preferred,
          fallbackMatrixStateDir: fallback,
          error: error instanceof Error ? error.message : String(error),
        },
        "Bundled Matrix state dir is not writable; using local fallback for scaffold/dev execution",
      );
      this.resolvedBaseDir = fallback;
      return fallback;
    }
  }

  private async readExistingEnv(projectDir: string): Promise<Record<string, string>> {
    const envPath = join(projectDir, ".env");
    try {
      const raw = await readFile(envPath, "utf8");
      return parseSimpleEnv(raw);
    } catch {
      return {};
    }
  }
}

type EnvTemplateInput = {
  homeserverDomain: string;
  publicBaseUrl: string;
  federationEnabled: boolean;
  postgresPassword: string;
  synapseConfigPath: string;
};

const renderComposeYaml = (synapseImage: string): string => `
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: synapse
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: synapse
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"
    volumes:
      - ./postgres-data:/var/lib/postgresql/data

  synapse:
    image: ${synapseImage}
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      SYNAPSE_CONFIG_PATH: \${SYNAPSE_CONFIG_PATH}
    ports:
      - "127.0.0.1:8008:8008"
    volumes:
      - ./synapse:/data
`.trim();

const renderEnvFile = (input: EnvTemplateInput): string =>
  [
    `POSTGRES_PASSWORD=${input.postgresPassword}`,
    `SYNAPSE_CONFIG_PATH=${input.synapseConfigPath}`,
    `MATRIX_HOMESERVER_DOMAIN=${input.homeserverDomain}`,
    `MATRIX_PUBLIC_BASE_URL=${input.publicBaseUrl}`,
    `MATRIX_FEDERATION_ENABLED=${input.federationEnabled ? "true" : "false"}`,
  ].join("\n");

type SynapseConfigInput = {
  homeserverDomain: string;
  publicBaseUrl: string;
  federationEnabled: boolean;
  postgresPassword: string;
  registrationSharedSecret: string;
  macaroonSecret: string;
  formSecret: string;
  signingKeyFile: string;
};

const renderSynapseConfig = (input: SynapseConfigInput): string => {
  const federationWhitelistLine = input.federationEnabled
    ? ""
    : "federation_domain_whitelist: []\n";

  return [
    `server_name: "${input.homeserverDomain}"`,
    `public_baseurl: "${ensureTrailingSlash(input.publicBaseUrl)}"`,
    "pid_file: /data/homeserver.pid",
    "",
    "listeners:",
    "  - port: 8008",
    "    tls: false",
    "    type: http",
    "    x_forwarded: false",
    "    bind_addresses: ['0.0.0.0']",
    "    resources:",
    "      - names: [client, federation]",
    "        compress: false",
    "",
    "database:",
    "  name: psycopg2",
    "  allow_unsafe_locale: true",
    "  args:",
    "    user: synapse",
    `    password: "${input.postgresPassword}"`,
    "    database: synapse",
    "    host: postgres",
    "",
    "report_stats: false",
    "enable_registration: false",
    "enable_registration_without_verification: false",
    "allow_public_rooms_without_auth: false",
    "allow_public_rooms_over_federation: false",
    `registration_shared_secret: "${input.registrationSharedSecret}"`,
    `macaroon_secret_key: "${input.macaroonSecret}"`,
    `form_secret: "${input.formSecret}"`,
    `signing_key_path: "/data/${input.signingKeyFile}"`,
    'media_store_path: "/data/media_store"',
    'log_config: "/data/log.config"',
    federationWhitelistLine.trimEnd(),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

const renderSigningKey = (): string => {
  const keyType = "ed25519";
  const keyId = "a_1";
  const seed = randomBytes(32).toString("base64").replace(/=+$/g, "");
  return `${keyType} ${keyId} ${seed}`;
};

const resolveSynapseImage = (): string => {
  const configured = process.env.SOVEREIGN_MATRIX_SYNAPSE_IMAGE?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return DEFAULT_SYNAPSE_IMAGE;
};

const ensureDirectoryTreeWritable = async (root: string): Promise<void> => {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    await chmod(current, 0o777);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      queue.push(join(current, entry.name));
    }
  }
};

const isPostgresAuthFailure = (value: string): boolean =>
  /password authentication failed for user ["']synapse["']/i.test(value);

const parseSimpleEnv = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key.length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
};

const renderSynapseLogConfig = (): string => `
version: 1
formatters:
  precise:
    format: "%(asctime)s %(name)s %(lineno)d %(levelname)s %(request)s %(message)s"
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
loggers:
  synapse:
    level: INFO
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
`.trim();

const slugifyProjectName = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "matrix-local-dev";
};

const ensureTrailingSlash = (value: string): string => (value.endsWith("/") ? value : `${value}/`);

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...(truncated)`;
};

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

const delay = async (ms: number): Promise<void> =>
  new Promise<void>((resolveTimeout) => {
    setTimeout(resolveTimeout, ms);
  });

const chooseBotLocalpart = (operatorLocalpart: string): string =>
  operatorLocalpart === "mail-sentinel" ? "mail-sentinel-bot" : "mail-sentinel";

const sanitizeMatrixLocalpart = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._=+\-/]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length > 0) {
    return normalized;
  }
  return fallback;
};

const generatePassword = (): string => `sn_${randomBytes(24).toString("base64url")}`;

const normalizePublicBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw {
      code: "MATRIX_URL_INVALID",
      message: "Matrix publicBaseUrl must use http or https",
      retryable: false,
      details: {
        publicBaseUrl: value,
      },
    };
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
};

const parseJsonSafely = (raw: string): unknown => {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const summarizeUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return truncateText(value, 800);
  }
  try {
    return truncateText(JSON.stringify(value), 800);
  } catch {
    return truncateText(String(value), 800);
  }
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : summarizeUnknown(error);

const check = (
  id: string,
  name: string,
  status: CheckResult["status"],
  message: string,
  details?: Record<string, unknown>,
): CheckResult => ({
  id,
  name,
  status,
  message,
  ...(details === undefined ? {} : { details }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStructuredError = (
  value: unknown,
): value is {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.code === "string"
    && typeof value.message === "string"
    && typeof value.retryable === "boolean"
  );
};
