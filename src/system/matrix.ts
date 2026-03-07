import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { TestMatrixRequest } from "../contracts/api.js";
import type { CheckResult } from "../contracts/common.js";
import type { InstallRequest, TestMatrixResult } from "../contracts/index.js";
import type { SovereignPaths } from "../config/paths.js";
import type { Logger } from "../logging/logger.js";
import { buildMatrixOnboardingUrl } from "../onboarding/bootstrap-code.js";
import type { ExecRunner, ExecResult } from "./exec.js";

const MATRIX_INTERNAL_BASE_URL = "http://127.0.0.1:8008";
const MATRIX_READY_TIMEOUT_MS = resolveDurationFromEnv(
  "SOVEREIGN_MATRIX_READY_TIMEOUT_MS",
  600_000,
);
const MATRIX_READY_POLL_INTERVAL_MS = 1_500;
const MATRIX_HTTP_TIMEOUT_MS = 8_000;
const MATRIX_LOGIN_RETRY_ATTEMPTS = 5;
const MATRIX_LOGIN_RETRY_DELAY_MS = 500;
const MATRIX_LOGIN_RATE_LIMIT_FALLBACK_DELAY_MS = 1_000;
const MATRIX_LOGIN_RATE_LIMIT_MAX_DELAY_MS = MATRIX_READY_TIMEOUT_MS;
const MATRIX_LOGIN_RATE_LIMIT_FAST_RETRY_THRESHOLD_MS = 10_000;
const MATRIX_COMPOSE_COMMAND_TIMEOUT_MS = resolveDurationFromEnv(
  "SOVEREIGN_MATRIX_COMPOSE_TIMEOUT_MS",
  600_000,
);
const DEFAULT_SYNAPSE_IMAGE = "matrixdotorg/synapse:v1.125.0";
const DEFAULT_CADDY_IMAGE = "caddy:2.10.2-alpine";
const DEFAULT_ONBOARDING_API_IMAGE = "node:22-alpine";
const RELAY_LOCAL_EDGE_PORT = 18080;
const MATRIX_ONBOARDING_DIR = "onboarding";
const MATRIX_ONBOARDING_STATE_FILE = "state.json";
const MATRIX_ONBOARDING_API_PORT = 8090;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type BundledMatrixTlsMode = "auto" | "internal" | "local-dev";
type BundledMatrixAccessMode = "direct" | "relay";
type BundledMatrixOnboardingMode = Exclude<BundledMatrixTlsMode, "local-dev"> | "relay";
type RequestedBundledMatrixTlsMode = BundledMatrixTlsMode | "manual";

export type BundledMatrixProvisionResult = {
  projectDir: string;
  composeFilePath: string;
  accessMode: BundledMatrixAccessMode;
  homeserverDomain: string;
  publicBaseUrl: string;
  adminBaseUrl: string;
  federationEnabled: boolean;
  tlsMode: BundledMatrixTlsMode;
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
  resetState?(provision: BundledMatrixProvisionResult): Promise<void>;
  bootstrapAccounts(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
    options?: {
      botLocalpart?: string;
    },
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
    const accessMode: BundledMatrixAccessMode =
      req.connectivity?.mode === "relay" || req.relay !== undefined ? "relay" : "direct";
    const requestedTlsMode: RequestedBundledMatrixTlsMode = req.matrix.tlsMode ?? "auto";
    const tlsMode = normalizeBundledTlsMode(accessMode, requestedTlsMode);
    const usesReverseProxy = shouldUseReverseProxy(accessMode, tlsMode);

    const homeserverDomain = req.matrix.homeserverDomain;
    const publicBaseUrl = normalizePublicBaseUrl(req.matrix.publicBaseUrl);
    if (accessMode === "direct") {
      validateBundledTlsMode({
        tlsMode,
        homeserverDomain,
        publicBaseUrl,
      });
    }
    const federationEnabled = accessMode === "relay" ? false : (req.matrix.federationEnabled ?? false);
    if (accessMode === "relay" && req.matrix.federationEnabled === true) {
      throw {
        code: "MATRIX_RELAY_FEDERATION_UNSUPPORTED",
        message: "Managed relay mode does not support Matrix federation in v1",
        retryable: false,
      };
    }
    const baseDir = await this.ensureBaseDir();
    const projectSlug = slugifyProjectName(homeserverDomain);
    const projectDir = join(baseDir, projectSlug);
    const synapseDir = join(projectDir, "synapse");
    const postgresDir = join(projectDir, "postgres-data");
    const wellKnownDir = join(projectDir, "well-known");
    const proxyDir = join(projectDir, "reverse-proxy");
    const proxyDataDir = join(projectDir, "reverse-proxy-data");
    const proxyConfigDir = join(projectDir, "reverse-proxy-config");
    const onboardingDir = join(projectDir, MATRIX_ONBOARDING_DIR);
    const composeFilePath = join(projectDir, "compose.yaml");
    const envFilePath = join(projectDir, ".env");

    await mkdir(synapseDir, { recursive: true });
    await mkdir(postgresDir, { recursive: true });
    if (usesReverseProxy) {
      await mkdir(wellKnownDir, { recursive: true });
      await mkdir(join(wellKnownDir, ".well-known", "matrix"), { recursive: true });
      await mkdir(join(wellKnownDir, "onboard"), { recursive: true });
      await mkdir(proxyDir, { recursive: true });
      await mkdir(proxyDataDir, { recursive: true });
      await mkdir(proxyConfigDir, { recursive: true });
      await mkdir(onboardingDir, { recursive: true });
    }
    await ensureDirectoryTreesWritable([synapseDir, postgresDir]);
    if (usesReverseProxy) {
      await ensureDirectoryTreesWritable([
        wellKnownDir,
        proxyDir,
        proxyDataDir,
        proxyConfigDir,
        onboardingDir,
      ]);
    }

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

    const composeYaml = renderComposeYaml({
      synapseImage: resolveSynapseImage(),
      caddyImage: DEFAULT_CADDY_IMAGE,
      onboardingApiImage: DEFAULT_ONBOARDING_API_IMAGE,
      appDistDir: resolveOnboardingApiDistDir(),
      secretsDir: this.paths.secretsDir,
      accessMode,
      tlsMode,
      localSynapsePortBinding:
        usesReverseProxy
          ? "127.0.0.1:8008:8008"
          : resolveLocalDevSynapsePortBinding(publicBaseUrl),
      ...(accessMode === "direct" && tlsMode !== "local-dev"
        ? { httpsProxyPortBinding: resolveAutoHttpsProxyPortBinding(publicBaseUrl) }
        : {}),
      ...(accessMode === "relay"
        ? { relayEdgePortBinding: `127.0.0.1:${RELAY_LOCAL_EDGE_PORT}:80` }
        : {}),
    });
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
      behindReverseProxy: usesReverseProxy,
      postgresPassword: generated.postgresPassword,
      registrationSharedSecret: generated.registrationSharedSecret,
      macaroonSecret: generated.macaroonSecret,
      formSecret: generated.formSecret,
      signingKeyFile: generated.signingKeyFile,
    });
    const signingKey = renderSigningKey();
    const logConfig = renderSynapseLogConfig();
    const operatorLocalpart = sanitizeMatrixLocalpart(req.operator.username, "operator");

    const writes = [
      writeFile(composeFilePath, `${composeYaml}\n`, "utf8"),
      writeFile(envFilePath, `${envFile}\n`, "utf8"),
      writeFile(join(synapseDir, "homeserver.yaml"), `${homeserverYaml}\n`, "utf8"),
      writeFile(join(synapseDir, generated.signingKeyFile), `${signingKey}\n`, "utf8"),
      writeFile(join(synapseDir, "log.config"), `${logConfig}\n`, "utf8"),
    ];
    if (usesReverseProxy) {
      const wellKnown = renderWellKnownFiles({
        homeserverDomain,
        publicBaseUrl,
      });
      const onboardingMode = resolveOnboardingMode(accessMode, tlsMode);
      writes.push(
        writeFile(
          join(proxyDir, "Caddyfile"),
          `${renderCaddyfile(new URL(publicBaseUrl).hostname, onboardingMode)}\n`,
          "utf8",
        ),
        writeFile(
          join(wellKnownDir, ".well-known", "matrix", "client"),
          `${wellKnown.client}\n`,
          "utf8",
        ),
        writeFile(
          join(wellKnownDir, ".well-known", "matrix", "server"),
          `${wellKnown.server}\n`,
          "utf8",
        ),
      );
    }

    await Promise.all(writes);
    if (usesReverseProxy) {
      await this.writeOnboardingPage({
        projectDir,
        publicBaseUrl,
        homeserverDomain,
        operatorLocalpart,
        tlsMode: resolveOnboardingMode(accessMode, tlsMode),
      });
    }
    await ensureDirectoryTreesWritable([synapseDir, postgresDir]);
    if (usesReverseProxy) {
      await ensureDirectoryTreesWritable([
        wellKnownDir,
        proxyDir,
        proxyDataDir,
        proxyConfigDir,
        onboardingDir,
      ]);
    }

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
      "Bundled Matrix compose bundle generated and validated",
    );

    return {
      projectDir,
      composeFilePath,
      accessMode,
      homeserverDomain,
      publicBaseUrl,
      adminBaseUrl: MATRIX_INTERNAL_BASE_URL,
      federationEnabled,
      tlsMode,
    };
  }

  async bootstrapAccounts(
    req: InstallRequest,
    provision: BundledMatrixProvisionResult,
    options?: {
      botLocalpart?: string;
    },
  ): Promise<BundledMatrixAccountsResult> {
    await this.ensureStackRunning(provision);
    await this.waitForSynapseReadyWithRecovery(provision);

    const operatorLocalpart = sanitizeMatrixLocalpart(req.operator.username, "operator");
    const botLocalpart = chooseServiceBotLocalpart(
      operatorLocalpart,
      options?.botLocalpart,
    );
    const secretsDir = await this.ensureManagedSecretsDir();
    const operatorSecretName = `matrix-${operatorLocalpart}.password`;
    const botSecretName = `matrix-${botLocalpart}.password`;
    const operatorPassword =
      (await this.readSecretFile(secretsDir, operatorSecretName)) ?? generatePassword();
    const botPassword = (await this.readSecretFile(secretsDir, botSecretName)) ?? generatePassword();

    const operatorPasswordSecretRef = await this.writeSecretFile(
      secretsDir,
      operatorSecretName,
      operatorPassword,
    );
    const botPasswordSecretRef = await this.writeSecretFile(
      secretsDir,
      botSecretName,
      botPassword,
    );

    try {
      return await this.bootstrapAccountsWithKnownPasswords({
        provision,
        operatorLocalpart,
        operatorPassword,
        operatorPasswordSecretRef,
        botLocalpart,
        botPassword,
        botPasswordSecretRef,
      });
    } catch (error) {
      if (!isRecoverableAccountCredentialFailure(error)) {
        throw error;
      }

      this.logger.warn(
        {
          projectDir: provision.projectDir,
          homeserverDomain: provision.homeserverDomain,
          operatorLocalpart,
          botLocalpart,
        },
        "Detected stale Matrix bootstrap credentials; resetting bundled Matrix Postgres state and retrying account bootstrap",
      );

      await this.resetBundledPostgresState(provision);
      await this.ensureStackRunning(provision);
      await this.waitForSynapseReadyWithRecovery(provision);

      const recoveredOperatorPassword = generatePassword();
      const recoveredBotPassword = generatePassword();
      const recoveredOperatorPasswordSecretRef = await this.writeSecretFile(
        secretsDir,
        operatorSecretName,
        recoveredOperatorPassword,
      );
      const recoveredBotPasswordSecretRef = await this.writeSecretFile(
        secretsDir,
        botSecretName,
        recoveredBotPassword,
      );

      return this.bootstrapAccountsWithKnownPasswords({
        provision,
        operatorLocalpart,
        operatorPassword: recoveredOperatorPassword,
        operatorPasswordSecretRef: recoveredOperatorPasswordSecretRef,
        botLocalpart,
        botPassword: recoveredBotPassword,
        botPasswordSecretRef: recoveredBotPasswordSecretRef,
      });
    }
  }

  private async bootstrapAccountsWithKnownPasswords(input: {
    provision: BundledMatrixProvisionResult;
    operatorLocalpart: string;
    operatorPassword: string;
    operatorPasswordSecretRef: string;
    botLocalpart: string;
    botPassword: string;
    botPasswordSecretRef: string;
  }): Promise<BundledMatrixAccountsResult> {
    await this.registerSynapseUser(input.provision, {
      localpart: input.operatorLocalpart,
      password: input.operatorPassword,
      admin: true,
    });
    await this.registerSynapseUser(input.provision, {
      localpart: input.botLocalpart,
      password: input.botPassword,
      admin: false,
    });

    const operatorSession = await this.loginUser(
      input.provision.adminBaseUrl,
      input.operatorLocalpart,
      input.operatorPassword,
    );
    const botSession = await this.loginUser(
      input.provision.adminBaseUrl,
      input.botLocalpart,
      input.botPassword,
    );

    const accounts: BundledMatrixAccountsResult = {
      operator: {
        localpart: input.operatorLocalpart,
        userId: operatorSession.userId,
        passwordSecretRef: input.operatorPasswordSecretRef,
        accessToken: operatorSession.accessToken,
      },
      bot: {
        localpart: input.botLocalpart,
        userId: botSession.userId,
        passwordSecretRef: input.botPasswordSecretRef,
        accessToken: botSession.accessToken,
      },
    };

    this.logger.info(
      {
        projectDir: input.provision.projectDir,
        homeserverDomain: input.provision.homeserverDomain,
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
    if (shouldUseReverseProxy(provision.accessMode, provision.tlsMode)) {
      await this.writeOnboardingPage({
        projectDir: provision.projectDir,
        publicBaseUrl: provision.publicBaseUrl,
        homeserverDomain: provision.homeserverDomain,
        operatorLocalpart: accounts.operator.localpart,
        tlsMode: resolveOnboardingMode(provision.accessMode, provision.tlsMode),
        alertRoomId: roomId,
      });
    }
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

  async resetState(provision: BundledMatrixProvisionResult): Promise<void> {
    await this.resetBundledPostgresState(provision);
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
    const services = ["postgres", "synapse"];
    if (provision.accessMode === "relay" || provision.tlsMode !== "local-dev") {
      services.push("reverse-proxy");
    }
    const upArgs = ["up", "-d", "--remove-orphans", "--force-recreate", ...services];
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
      ...(input.admin ? ["-a"] : ["--no-admin"]),
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
    let lastError: unknown;
    let credentialRetryAttempts = 0;
    const rateLimitDeadline = Date.now() + MATRIX_READY_TIMEOUT_MS;
    let rateLimitAttempts = 0;
    while (true) {
      try {
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
      } catch (error) {
        lastError = error;
        if (isRateLimitedMatrixLoginFailure(error)) {
          const remainingBudgetMs = rateLimitDeadline - Date.now();
          if (remainingBudgetMs <= 0) {
            break;
          }
          rateLimitAttempts += 1;
          const retryDelayMs = Math.min(readMatrixLoginRetryDelayMs(error), remainingBudgetMs);
          if (retryDelayMs > MATRIX_LOGIN_RATE_LIMIT_FAST_RETRY_THRESHOLD_MS) {
            this.logger.warn(
              {
                localpart,
                rateLimitAttempts,
                retryDelayMs,
              },
              "Matrix login rate limited with a long cooldown; aborting login retries",
            );
            break;
          }
          this.logger.info(
            {
              localpart,
              rateLimitAttempts,
              retryDelayMs,
            },
            "Matrix login rate limited; waiting before retry",
          );
          await delay(retryDelayMs);
          continue;
        }
        credentialRetryAttempts += 1;
        if (
          !isRecoverableAccountCredentialFailure(error)
          || credentialRetryAttempts >= MATRIX_LOGIN_RETRY_ATTEMPTS
        ) {
          break;
        }
        await delay(MATRIX_LOGIN_RETRY_DELAY_MS);
      }
    }

    throw lastError;
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
    const diagnosticsTrail: Array<Record<string, unknown>> = [];
    const maxRecoveries = 2;

    for (let attempt = 0; attempt <= maxRecoveries; attempt += 1) {
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
        const recoverable = isRecoverablePostgresBootstrapFailure(synapseLogs);
        diagnosticsTrail.push({
          attempt: attempt + 1,
          recoverable,
          diagnostics,
        });

        if (!recoverable || attempt === maxRecoveries) {
          throw {
            ...error,
            details: {
              ...(error.details ?? {}),
              recoveryAttempts: diagnosticsTrail,
            },
          };
        }

        this.logger.warn(
          {
            projectDir: provision.projectDir,
            recoveryAttempt: attempt + 1,
            maxRecoveries,
          },
          "Detected recoverable bundled Matrix Postgres bootstrap mismatch; resetting postgres data and retrying",
        );

        await this.resetBundledPostgresState(provision);
        await this.ensureStackRunning(provision);
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
        const retryAfterMs =
          isRecord(parsedBody)
          && typeof parsedBody.retry_after_ms === "number"
          && Number.isFinite(parsedBody.retry_after_ms)
          && parsedBody.retry_after_ms > 0
            ? Math.trunc(parsedBody.retry_after_ms)
            : undefined;
        throw {
          code: input.errorCode,
          message: input.errorMessage,
          retryable: input.retryable,
          details: {
            url,
            status: response.status,
            body: summarizeUnknown(parsedBody),
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
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

  private async ensureManagedSecretsDir(): Promise<string> {
    const dir = this.paths.secretsDir;
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

  private async readSecretFile(secretsDir: string, fileName: string): Promise<string | null> {
    const secretPath = join(secretsDir, fileName);
    try {
      const raw = await readFile(secretPath, "utf8");
      const value = stripSingleTrailingNewline(raw);
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
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
          timeout: MATRIX_COMPOSE_COMMAND_TIMEOUT_MS,
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

  private async renderOnboardingQrSvg(value: string): Promise<string> {
    const qr = await this.execRunner.run({
      command: "qrencode",
      args: ["-t", "SVG", "-o", "-", value],
    });
    if (qr.exitCode === 0 && qr.stdout.includes("<svg")) {
      return normalizeEmbeddedSvg(qr.stdout);
    }

    this.logger.warn(
      {
        command: qr.command,
        exitCode: qr.exitCode,
      },
      "qrencode unavailable; using onboarding QR fallback",
    );
    return renderFallbackQrSvg(value);
  }

  private async writeOnboardingPage(input: {
    projectDir: string;
    publicBaseUrl: string;
    homeserverDomain: string;
    operatorLocalpart: string;
    tlsMode: BundledMatrixOnboardingMode;
    alertRoomId?: string;
  }): Promise<void> {
    const onboardingPageUrl = buildOnboardingPageUrl(input.publicBaseUrl);
    const onboardingQrSvg = await this.renderOnboardingQrSvg(onboardingPageUrl);
    const onboardingPage = renderOnboardingPage({
      publicBaseUrl: input.publicBaseUrl,
      homeserverDomain: input.homeserverDomain,
      operatorLocalpart: input.operatorLocalpart,
      tlsMode: input.tlsMode,
      onboardingPageUrl,
      onboardingQrSvg,
      ...(input.alertRoomId === undefined ? {} : { alertRoomId: input.alertRoomId }),
    });
    await writeFile(
      join(input.projectDir, "well-known", "onboard", "index.html"),
      `${onboardingPage}\n`,
      "utf8",
    );
  }

}

type EnvTemplateInput = {
  homeserverDomain: string;
  publicBaseUrl: string;
  federationEnabled: boolean;
  postgresPassword: string;
  synapseConfigPath: string;
};

type ComposeTemplateInput = {
  synapseImage: string;
  caddyImage: string;
  onboardingApiImage: string;
  appDistDir: string;
  secretsDir: string;
  accessMode: BundledMatrixAccessMode;
  tlsMode: BundledMatrixTlsMode;
  localSynapsePortBinding: string;
  httpsProxyPortBinding?: string;
  relayEdgePortBinding?: string;
};

const renderComposeYaml = (input: ComposeTemplateInput): string => `
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
    image: ${input.synapseImage}
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      SYNAPSE_CONFIG_PATH: \${SYNAPSE_CONFIG_PATH}
    ports:
      - "${input.localSynapsePortBinding}"
    volumes:
      - ./synapse:/data
${input.accessMode === "relay" || input.tlsMode !== "local-dev"
  ? `

  onboarding-api:
    image: ${input.onboardingApiImage}
    restart: unless-stopped
    depends_on:
      - synapse
    environment:
      SOVEREIGN_ONBOARDING_BIND_HOST: 0.0.0.0
      SOVEREIGN_ONBOARDING_BIND_PORT: "${MATRIX_ONBOARDING_API_PORT}"
      SOVEREIGN_ONBOARDING_STATE_PATH: "/onboarding/${MATRIX_ONBOARDING_STATE_FILE}"
      SOVEREIGN_ONBOARDING_ALLOWED_SECRETS_DIR: "${input.secretsDir}"
    command:
      - node
      - /srv/sovereign-node-onboarding-api.js
    volumes:
      - "${input.appDistDir}:/srv:ro"
      - ./${MATRIX_ONBOARDING_DIR}:/onboarding
      - "${input.secretsDir}:${input.secretsDir}:ro"

  reverse-proxy:
    image: ${input.caddyImage}
    restart: unless-stopped
    depends_on:
      - synapse
      - onboarding-api
    ports:
${input.accessMode === "relay"
  ? `      - "${input.relayEdgePortBinding}"`
  : `${input.tlsMode === "auto" ? '      - "80:80"\n' : ""}      - "${input.httpsProxyPortBinding}"`}
    volumes:
      - ./reverse-proxy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./well-known:/srv:ro
      - ./reverse-proxy-data:/data
      - ./reverse-proxy-config:/config`
  : ""}
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
  behindReverseProxy: boolean;
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
    `    x_forwarded: ${input.behindReverseProxy ? "true" : "false"}`,
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
    "rc_login:",
    "  address:",
    "    per_second: 1000",
    "    burst_count: 1000",
    "  account:",
    "    per_second: 1000",
    "    burst_count: 1000",
    "  failed_attempts:",
    "    per_second: 1000",
    "    burst_count: 1000",
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

const resolveOnboardingApiDistDir = (): string => {
  const configured = process.env.SOVEREIGN_NODE_APP_DIR?.trim();
  if (configured !== undefined && configured.length > 0) {
    return join(configured, "dist");
  }
  return "/opt/sovereign-ai-node/app/dist";
};

const normalizeBundledTlsMode = (
  accessMode: BundledMatrixAccessMode,
  requestedTlsMode: RequestedBundledMatrixTlsMode,
): BundledMatrixTlsMode => {
  if (requestedTlsMode === "manual") {
    throw {
      code: "MATRIX_TLS_MODE_UNSUPPORTED",
      message:
        "Bundled Matrix provisioning does not yet support tlsMode=manual",
      retryable: false,
      details: {
        requestedTlsMode,
        supportedTlsModes: ["auto", "internal", "local-dev"],
      },
    };
  }
  if (
    accessMode === "direct"
    && requestedTlsMode !== "local-dev"
    && requestedTlsMode !== "auto"
    && requestedTlsMode !== "internal"
  ) {
    throw {
      code: "MATRIX_TLS_MODE_UNSUPPORTED",
      message: "Bundled Matrix provisioning received an unknown tlsMode",
      retryable: false,
      details: {
        requestedTlsMode,
      },
    };
  }
  return requestedTlsMode;
};

const shouldUseReverseProxy = (
  accessMode: BundledMatrixAccessMode,
  tlsMode: BundledMatrixTlsMode,
): boolean => accessMode === "relay" || tlsMode !== "local-dev";

const resolveOnboardingMode = (
  accessMode: BundledMatrixAccessMode,
  tlsMode: BundledMatrixTlsMode,
): BundledMatrixOnboardingMode => {
  if (accessMode === "relay") {
    return "relay";
  }
  if (tlsMode === "local-dev") {
    throw new Error("Onboarding mode is unavailable when tlsMode=local-dev");
  }
  return tlsMode;
};

const resolveLocalDevSynapsePortBinding = (publicBaseUrl: string): string => {
  const parsed = new URL(publicBaseUrl);
  const host = parsed.hostname.trim().toLowerCase();
  const hostBind = isLoopbackHostname(host) ? "127.0.0.1" : "0.0.0.0";
  const publicPort =
    parsed.port.length > 0 ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
  return `${hostBind}:${publicPort}:8008`;
};

const resolveAutoHttpsProxyPortBinding = (publicBaseUrl: string): string => {
  const parsed = new URL(publicBaseUrl);
  const httpsPort = parsed.port.length > 0 ? parsed.port : "443";
  return `${httpsPort}:443`;
};

const isLoopbackHostname = (value: string): boolean =>
  value === "localhost"
  || value === "127.0.0.1"
  || value === "::1"
  || value === "[::1]";

const isIpAddressHostname = (value: string): boolean =>
  /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(value) || value.includes(":");

const isLikelyLanOnlyHostname = (value: string): boolean =>
  isLoopbackHostname(value)
  || isIpAddressHostname(value)
  || !value.includes(".")
  || value.endsWith(".local")
  || value.endsWith(".localhost")
  || value.endsWith(".home.arpa")
  || value.endsWith(".internal")
  || value.endsWith(".lan");

const validateBundledTlsMode = (input: {
  tlsMode: BundledMatrixTlsMode;
  homeserverDomain: string;
  publicBaseUrl: string;
}): void => {
  if (input.tlsMode === "local-dev") {
    return;
  }

  const parsed = new URL(input.publicBaseUrl);
  const publicHost = parsed.hostname.trim().toLowerCase();
  const publicPort = parsed.port.length > 0 ? parsed.port : "443";
  const homeserverDomain = input.homeserverDomain.trim().toLowerCase();

  if (parsed.protocol !== "https:") {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message: `Bundled Matrix tlsMode=${input.tlsMode} requires an https publicBaseUrl`,
      retryable: false,
      details: {
        tlsMode: input.tlsMode,
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
  if (input.tlsMode === "auto" && isLikelyLanOnlyHostname(publicHost)) {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message:
        "Bundled Matrix tlsMode=auto requires a public DNS hostname, not a LAN-only hostname, loopback address, or IP literal",
      retryable: false,
      details: {
        tlsMode: input.tlsMode,
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
  if (input.tlsMode !== "internal" && publicHost !== homeserverDomain) {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message: `Bundled Matrix tlsMode=${input.tlsMode} currently requires homeserverDomain to match the publicBaseUrl hostname`,
      retryable: false,
      details: {
        homeserverDomain: input.homeserverDomain,
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
  if (publicPort === "80") {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message: `Bundled Matrix tlsMode=${input.tlsMode} cannot use HTTPS on port 80`,
      retryable: false,
      details: {
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
  if (publicPort === "8008") {
    throw {
      code: "MATRIX_TLS_MODE_INVALID",
      message:
        `Bundled Matrix tlsMode=${input.tlsMode} cannot publish HTTPS on port 8008 because that port is reserved for the local Synapse admin endpoint`,
      retryable: false,
      details: {
        publicBaseUrl: input.publicBaseUrl,
      },
    };
  }
};

const renderCaddyfile = (
  siteHostname: string,
  tlsMode: BundledMatrixOnboardingMode,
): string =>
  [
    "{",
    "  admin off",
    ...(tlsMode === "internal" ? [`  default_sni ${siteHostname}`] : []),
    "}",
    "",
    `${tlsMode === "relay" ? ":80" : siteHostname} {`,
    ...(tlsMode === "internal" ? ["  tls internal"] : []),
    "  @wellKnown path /.well-known/matrix/client /.well-known/matrix/server",
    "  handle @wellKnown {",
    "    root * /srv",
    "    header Access-Control-Allow-Origin *",
    "    header Content-Type application/json",
    "    header Cache-Control \"public, max-age=300\"",
    "    file_server",
    "  }",
    "",
    "  @onboard path /onboard /onboard/ /onboard/index.html",
    "  handle @onboard {",
    "    root * /srv",
    "    rewrite * /onboard/index.html",
    "    header Cache-Control \"no-store\"",
    "    file_server",
    "  }",
    "",
    "  @onboardApi path /onboard/api /onboard/api/*",
    "  handle @onboardApi {",
    "    header Cache-Control \"no-store\"",
    "    uri strip_prefix /onboard/api",
    `    reverse_proxy onboarding-api:${MATRIX_ONBOARDING_API_PORT}`,
    "  }",
    "",
    ...(tlsMode === "internal"
      ? [
          "  @ca path /downloads/caddy-root-ca.crt",
          "  handle @ca {",
          "    root * /data/caddy/pki/authorities/local",
          "    rewrite * /root.crt",
          "    header Content-Type application/x-x509-ca-cert",
          "    header Content-Disposition \"attachment; filename=sovereign-node-caddy-root-ca.crt\"",
          "    header Cache-Control \"no-store\"",
          "    file_server",
          "  }",
          "",
        ]
      : []),
    "  handle {",
    "    reverse_proxy synapse:8008",
    "  }",
    "}",
  ].join("\n");

const renderOnboardingPage = (input: {
  publicBaseUrl: string;
  homeserverDomain: string;
  operatorLocalpart: string;
  tlsMode: BundledMatrixOnboardingMode;
  onboardingPageUrl: string;
  onboardingQrSvg: string;
  alertRoomId?: string;
}): string => {
  const username = `@${input.operatorLocalpart}:${input.homeserverDomain}`;
  const elementWebLink = buildElementWebLoginLink(input.publicBaseUrl, username);
  const elementAndroidLink = buildElementAndroidIntentLink(input.publicBaseUrl, username);
  const roomLink = input.alertRoomId ? buildElementWebRoomLink(input.alertRoomId) : "";
  const caSection = input.tlsMode === "internal"
    ? [
        "<section class=\"card caution\">",
        "  <h2>1. Install the Local CA</h2>",
        "  <p>This LAN-only setup uses Caddy&apos;s internal certificate authority. Install the CA on your phone before opening Element.</p>",
        "  <a class=\"button button-secondary\" href=\"/downloads/caddy-root-ca.crt\">Download CA Certificate</a>",
        "  <p class=\"meta\">After download, trust this certificate in your device&apos;s settings. Native Android Matrix apps may still reject local CAs; Element Web in the browser is the reliable path.</p>",
        "</section>",
      ].join("\n")
    : "";
  const nativeAppHint = input.tlsMode === "internal"
    ? "If the native app still cannot reach the server, it is rejecting the local CA or local-network setup. In that case use the browser path above. Vanadium and Brave may behave differently, so the copy buttons below remain the fallback path."
    : "The Android app button prefills the homeserver using Element Classic&apos;s documented deep link. If the app still drops you into a generic login flow, use the copy buttons below and paste the exact values manually.";
  const roomSection = input.alertRoomId
    ? [
        "<section class=\"card\">",
        "  <h2>After login: open the alert room</h2>",
        "  <p>After login, use this button to jump directly into the existing Sovereign Alerts room.</p>",
        "  <a class=\"button button-secondary\" href=\"" + escapeHtml(roomLink) + "\" target=\"_blank\" rel=\"noreferrer\">Open Alert Room in Element Web</a>",
        "  <p class=\"meta\">If Element asks again, keep the same homeserver URL and session.</p>",
        "</section>",
      ].join("\n")
    : "";
  const copyStep = input.tlsMode === "internal" ? 2 : 1;
  const webStep = input.tlsMode === "internal" ? 3 : 2;
  const qrStep = input.tlsMode === "internal" ? 4 : 3;
  const signInStep = input.tlsMode === "internal" ? 5 : 4;
  const verifyStep = input.tlsMode === "internal" ? 6 : 5;

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <title>Sovereign Node Phone Setup</title>",
    "  <style>",
    "    :root { color-scheme: light; --bg: #0f172a; --panel: rgba(15, 23, 42, 0.84); --panel-2: rgba(30, 41, 59, 0.78); --text: #e2e8f0; --muted: #bfdbfe; --accent: #22c55e; --accent-2: #38bdf8; --warn: #f59e0b; }",
    "    * { box-sizing: border-box; }",
    "    body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; background: radial-gradient(circle at top, #1d4ed8 0%, #0f172a 42%, #020617 100%); color: var(--text); }",
    "    main { width: min(100%, 760px); margin: 0 auto; padding: 24px 16px 40px; }",
    "    .hero { padding: 24px; border-radius: 24px; background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(14, 116, 144, 0.15)), var(--panel); box-shadow: 0 24px 80px rgba(2, 6, 23, 0.45); }",
    "    .eyebrow { margin: 0 0 8px; font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }",
    "    h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.2rem); line-height: 1.05; }",
    "    p { line-height: 1.55; }",
    "    .stack { display: grid; gap: 16px; margin-top: 20px; }",
    "    .card { padding: 20px; border-radius: 20px; background: var(--panel-2); border: 1px solid rgba(148, 163, 184, 0.18); }",
    "    .caution { border-color: rgba(245, 158, 11, 0.35); background: linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(30, 41, 59, 0.85)); }",
    "    h2 { margin: 0 0 10px; font-size: 1.05rem; }",
    "    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 52px; width: 100%; padding: 14px 18px; border: 0; border-radius: 16px; text-decoration: none; font: inherit; font-weight: 700; cursor: pointer; color: #020617; background: linear-gradient(135deg, var(--accent), #86efac); }",
    "    .button-secondary { margin-top: 8px; color: var(--text); background: linear-gradient(135deg, rgba(56, 189, 248, 0.22), rgba(59, 130, 246, 0.28)); }",
    "    .qr-shell { display: grid; place-items: center; margin-top: 14px; padding: 18px; border-radius: 18px; background: rgba(255, 255, 255, 0.92); }",
    "    .qr-shell svg { width: min(100%, 280px); height: auto; }",
    "    code { display: block; margin-top: 10px; padding: 12px 14px; border-radius: 14px; background: rgba(2, 6, 23, 0.55); overflow-wrap: anywhere; color: #dbeafe; }",
    "    ol { margin: 10px 0 0; padding-left: 20px; }",
    "    li + li { margin-top: 8px; }",
    "    .meta { margin: 10px 0 0; font-size: 0.92rem; color: var(--muted); }",
    "    .field { display: grid; gap: 8px; margin-top: 12px; }",
    "    .field span { font-size: 0.92rem; color: var(--muted); }",
    "    .field input { width: 100%; min-height: 52px; border-radius: 14px; border: 1px solid rgba(148, 163, 184, 0.28); background: rgba(2, 6, 23, 0.55); color: var(--text); padding: 0 16px; font: inherit; letter-spacing: 0.12em; text-transform: uppercase; }",
    "    .button-row { display: grid; gap: 8px; margin-top: 12px; }",
    "    .hidden { display: none !important; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    "    <section class=\"hero\">",
    "      <p class=\"eyebrow\">Sovereign Node</p>",
    "      <h1>Connect your phone to Matrix</h1>",
    "      <p>Use this page on your phone to finish Matrix setup with the least manual typing.</p>",
    "      <code>Homeserver URL: " + escapeHtml(input.publicBaseUrl) + "</code>",
    "      <code>Sign in as: " + escapeHtml(username) + "</code>",
    "    </section>",
    "    <div class=\"stack\">",
    caSection,
    "      <section class=\"card\">",
    "        <h2>" + String(copyStep) + ". Quick copy and unlock</h2>",
    "        <p>Copy the homeserver and username here. Unlock the password with a one-time code printed by the installer or generated later with <code>sudo sovereign-node onboarding issue</code>.</p>",
    "        <div class=\"button-row\">",
    "          <button class=\"button button-secondary\" type=\"button\" onclick=\"copyHomeserverUrl(this)\">Copy Server URL</button>",
    "          <button class=\"button button-secondary\" type=\"button\" onclick=\"copyUsername(this)\">Copy Username</button>",
    "        </div>",
    "        <label class=\"field\" for=\"bootstrapCode\">",
    "          <span>One-time onboarding code</span>",
    "          <input id=\"bootstrapCode\" name=\"bootstrapCode\" autocomplete=\"one-time-code\" autocapitalize=\"characters\" spellcheck=\"false\" placeholder=\"ABCD-EFGH-IJKL\">",
    "        </label>",
    "        <div class=\"button-row\">",
    "          <button class=\"button\" id=\"redeemButton\" type=\"button\" onclick=\"redeemCode(this)\">Unlock Password</button>",
    "          <button class=\"button button-secondary hidden\" id=\"copyPasswordButton\" type=\"button\" onclick=\"copyPassword(this)\">Copy Password</button>",
    "        </div>",
    "        <p class=\"meta\" id=\"passwordStatus\">The password is not embedded in this page. The code works once, expires after 10 minutes, and must be reissued for later device onboarding.</p>",
    "      </section>",
    "      <section class=\"card\">",
    "        <h2>" + String(webStep) + ". Continue with Element Web</h2>",
    "        <p>The button opens Element Web with your homeserver prefilled. Browser restrictions still prevent safe password injection into app.element.io, so you may still need to paste the password manually.</p>",
    "        <a class=\"button\" href=\"" + escapeHtml(elementWebLink) + "\" rel=\"noreferrer\">Connect via Element Web</a>",
    "        <a class=\"button button-secondary\" href=\"" + escapeHtml(elementAndroidLink) + "\" rel=\"noreferrer\">Open in Element Android App</a>",
    "        <p class=\"meta\">If Element still shows the generic login screen, tap <strong>Edit</strong> in the homeserver field and paste the full URL exactly as shown above. Do not type only " + escapeHtml(new URL(input.publicBaseUrl).host) + ".</p>",
    "        <p class=\"meta\">The Android button uses Element Classic&apos;s documented <code>hs_url</code> deep link and explicitly targets the F-Droid package <code>im.vector.app</code>. It can prefill the homeserver, but not securely inject the password.</p>",
    "        <p class=\"meta\">" + nativeAppHint + "</p>",
    "      </section>",
    "      <section class=\"card\">",
    "        <h2>" + String(qrStep) + ". Open this setup page on another device</h2>",
    "        <p>Open this page on a laptop, then scan the QR code from your phone if you want to hand off setup between devices.</p>",
    "        <div class=\"qr-shell\">",
    input.onboardingQrSvg,
    "        </div>",
    "        <p class=\"meta\">This QR points to " + escapeHtml(input.onboardingPageUrl) + "</p>",
    "      </section>",
    "      <section class=\"card\">",
    "        <h2>" + String(signInStep) + ". Sign in</h2>",
    "        <ol>",
    "          <li>Use the username shown above.</li>",
    "          <li>Unlock the password from this page with your one-time code, then copy it into Element.</li>",
    "          <li>If Element asks for a homeserver again, paste the exact <code>https://</code> URL shown at the top of this page.</li>",
    "        </ol>",
    "      </section>",
    "      <section class=\"card\">",
    "        <h2>" + String(verifyStep) + ". If Element asks to verify another device</h2>",
    "        <ol>",
    "          <li>Tap <strong>Bestätigung nicht möglich?</strong>.</li>",
    "          <li>Continue without verification or without secure backup.</li>",
    "          <li>This is acceptable for the default Sovereign Alerts room because it is not configured as an encrypted room.</li>",
    "        </ol>",
    "      </section>",
    roomSection,
    "    </div>",
    "  </main>",
    "  <script>",
    "    const homeserverUrl = " + JSON.stringify(input.publicBaseUrl) + ";",
    "    const username = " + JSON.stringify(username) + ";",
    "    let revealedPassword = '';",
    "    async function copyHomeserverUrl(button) {",
    "      await copyValue(button, homeserverUrl);",
    "    }",
    "    async function copyUsername(button) {",
    "      await copyValue(button, username);",
    "    }",
    "    async function redeemCode(button) {",
    "      const codeInput = document.getElementById('bootstrapCode');",
    "      const status = document.getElementById('passwordStatus');",
    "      const copyButton = document.getElementById('copyPasswordButton');",
    "      const code = typeof codeInput?.value === 'string' ? codeInput.value.trim() : '';",
    "      if (!code) {",
    "        status.textContent = 'Enter the one-time onboarding code from the installer output.';",
    "        return;",
    "      }",
    "      const previousText = button.textContent;",
    "      button.textContent = 'Unlocking...';",
    "      button.disabled = true;",
    "      try {",
    "        const response = await fetch('/onboard/api/redeem', {",
    "          method: 'POST',",
    "          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },",
    "          cache: 'no-store',",
    "          body: JSON.stringify({ code }),",
    "        });",
    "        const payload = await response.json().catch(() => ({}));",
    "        if (!response.ok) {",
    "          revealedPassword = '';",
    "          copyButton.classList.add('hidden');",
    "          status.textContent = typeof payload.message === 'string' && payload.message.length > 0",
    "            ? payload.message + ' Run sudo sovereign-node onboarding issue to get a fresh code.'",
    "            : 'The one-time code could not be redeemed. Run sudo sovereign-node onboarding issue to get a fresh code.';",
    "          return;",
    "        }",
    "        revealedPassword = typeof payload.password === 'string' ? payload.password : '';",
    "        if (!revealedPassword) {",
    "          throw new Error('Password was missing from the onboarding response');",
    "        }",
    "        copyButton.classList.remove('hidden');",
    "        status.textContent = 'Password unlocked for this page session. Copy it now. After one successful copy it is cleared from this page.';",
    "      } catch (error) {",
    "        revealedPassword = '';",
    "        copyButton.classList.add('hidden');",
    "        status.textContent = error instanceof Error ? error.message : 'Unlock failed';",
    "      } finally {",
    "        button.disabled = false;",
    "        button.textContent = previousText;",
    "      }",
    "    }",
    "    async function copyPassword(button) {",
    "      const status = document.getElementById('passwordStatus');",
    "      const copyButton = document.getElementById('copyPasswordButton');",
    "      if (!revealedPassword) {",
    "        const oldText = button.textContent;",
    "        button.textContent = 'Not available';",
    "        setTimeout(() => { button.textContent = oldText; }, 1800);",
    "        return;",
    "      }",
    "      await copyValue(button, revealedPassword);",
    "      revealedPassword = '';",
    "      copyButton.classList.add('hidden');",
    "      status.textContent = 'Password copied. It has been cleared from this page. Run sudo sovereign-node onboarding issue if you need a fresh one-time code.';",
    "    }",
    "    async function copyValue(button, value) {",
    "      try {",
    "        if (navigator.clipboard && navigator.clipboard.writeText) {",
    "          await navigator.clipboard.writeText(value);",
    "        } else {",
    "          const el = document.createElement('textarea');",
    "          el.value = value;",
    "          document.body.appendChild(el);",
    "          el.select();",
    "          document.execCommand('copy');",
    "          el.remove();",
    "        }",
    "        const oldText = button.textContent;",
    "        button.textContent = 'Copied';",
    "        setTimeout(() => { button.textContent = oldText; }, 1800);",
    "      } catch {",
    "        const oldText = button.textContent;",
    "        button.textContent = 'Copy failed';",
    "        setTimeout(() => { button.textContent = oldText; }, 1800);",
    "      }",
    "    }",
    "    window.addEventListener('pagehide', () => {",
    "      revealedPassword = '';",
    "    });",
    "  </script>",
    "</body>",
    "</html>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

const buildOnboardingPageUrl = (publicBaseUrl: string): string =>
  buildMatrixOnboardingUrl(publicBaseUrl);

const buildElementWebLoginLink = (publicBaseUrl: string, username: string): string =>
  `https://app.element.io/#/login?hs_url=${encodeURIComponent(publicBaseUrl)}&login_hint=${encodeURIComponent(username)}`;

const buildElementAndroidDeepLink = (publicBaseUrl: string, username: string): string =>
  `https://mobile.element.io/?hs_url=${encodeURIComponent(publicBaseUrl)}&login_hint=${encodeURIComponent(username)}`;

const buildElementAndroidIntentLink = (publicBaseUrl: string, username: string): string => {
  const fallbackUrl = buildElementAndroidDeepLink(publicBaseUrl, username);
  return "intent://mobile.element.io/"
    + `?hs_url=${encodeURIComponent(publicBaseUrl)}`
    + `&login_hint=${encodeURIComponent(username)}`
    + "#Intent;scheme=https;package=im.vector.app"
    + `;S.browser_fallback_url=${encodeURIComponent(fallbackUrl)}`
    + ";end";
};

const buildElementWebRoomLink = (roomId: string): string =>
  `https://app.element.io/#/room/${encodeURIComponent(roomId)}`;

const renderWellKnownFiles = (input: {
  homeserverDomain: string;
  publicBaseUrl: string;
}): { client: string; server: string } => {
  const parsed = new URL(input.publicBaseUrl);
  const httpsPort = parsed.port.length > 0 ? parsed.port : "443";
  return {
    client: JSON.stringify(
      {
        "m.homeserver": {
          base_url: input.publicBaseUrl,
        },
      },
      null,
      2,
    ),
    server: JSON.stringify(
      {
        "m.server": httpsPort === "443" ? input.homeserverDomain : `${input.homeserverDomain}:${httpsPort}`,
      },
      null,
      2,
    ),
  };
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

const ensureDirectoryTreesWritable = async (dirs: string[]): Promise<void> => {
  for (const dir of dirs) {
    await ensureDirectoryTreeWritable(dir);
  }
};

const isRecoverablePostgresBootstrapFailure = (value: string): boolean =>
  /password authentication failed for user ["']synapse["']/i.test(value)
  || /incorrect collation/i.test(value)
  || /incorrectdatabasesetup/i.test(value);

const isRecoverableAccountCredentialFailure = (error: unknown): boolean => {
  if (!isStructuredError(error) || error.code !== "MATRIX_LOGIN_FAILED") {
    return false;
  }
  if (!isRecord(error.details)) {
    return false;
  }

  const status = error.details.status;
  if (status === 403) {
    return true;
  }

  const body = error.details.body;
  return (
    typeof body === "string"
    && /invalid username or password|m_forbidden/i.test(body)
  );
};

const isRateLimitedMatrixLoginFailure = (error: unknown): boolean => {
  if (!isStructuredError(error) || error.code !== "MATRIX_LOGIN_FAILED") {
    return false;
  }
  if (!isRecord(error.details)) {
    return false;
  }

  const status = error.details.status;
  if (status === 429) {
    return true;
  }

  const body = error.details.body;
  return (
    typeof body === "string"
    && /m_limit_exceeded|too many requests/i.test(body)
  );
};

const readMatrixLoginRetryDelayMs = (error: unknown): number =>
  clampPositiveDelayMs(
    isStructuredError(error)
    && isRecord(error.details)
    && typeof error.details.retryAfterMs === "number"
    && Number.isFinite(error.details.retryAfterMs)
      ? Math.trunc(error.details.retryAfterMs)
      : MATRIX_LOGIN_RATE_LIMIT_FALLBACK_DELAY_MS,
    MATRIX_LOGIN_RATE_LIMIT_FALLBACK_DELAY_MS,
    MATRIX_LOGIN_RATE_LIMIT_MAX_DELAY_MS,
  );

const clampPositiveDelayMs = (value: number, fallback: number, max: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), max);
};

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

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");

const normalizeEmbeddedSvg = (value: string): string =>
  value
    .replace(/<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>\s*/i, "")
    .trim();

const renderFallbackQrSvg = (value: string): string => {
  const safeValue = escapeHtml(value);
  return [
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 320\" role=\"img\" aria-label=\"Open this setup page on another device\">",
    "  <rect width=\"320\" height=\"320\" rx=\"24\" fill=\"#ffffff\" />",
    "  <rect x=\"24\" y=\"24\" width=\"272\" height=\"272\" rx=\"16\" fill=\"#0f172a\" opacity=\"0.08\" />",
    "  <rect x=\"42\" y=\"42\" width=\"72\" height=\"72\" rx=\"10\" fill=\"#0f172a\" />",
    "  <rect x=\"206\" y=\"42\" width=\"72\" height=\"72\" rx=\"10\" fill=\"#0f172a\" />",
    "  <rect x=\"42\" y=\"206\" width=\"72\" height=\"72\" rx=\"10\" fill=\"#0f172a\" />",
    "  <rect x=\"144\" y=\"144\" width=\"32\" height=\"32\" rx=\"6\" fill=\"#0f172a\" />",
    "  <rect x=\"190\" y=\"144\" width=\"20\" height=\"20\" rx=\"4\" fill=\"#0f172a\" />",
    "  <rect x=\"220\" y=\"184\" width=\"26\" height=\"26\" rx=\"5\" fill=\"#0f172a\" />",
    "  <text x=\"160\" y=\"250\" text-anchor=\"middle\" font-family=\"Arial, sans-serif\" font-size=\"15\" fill=\"#0f172a\">Open setup page</text>",
    `  <text x="160" y="273" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#334155">${safeValue}</text>`,
    "</svg>",
  ].join("\n");
};

function resolveDurationFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallbackMs;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.trunc(parsed);
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

const delay = async (ms: number): Promise<void> =>
  new Promise<void>((resolveTimeout) => {
    setTimeout(resolveTimeout, ms);
  });

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

const chooseServiceBotLocalpart = (
  operatorLocalpart: string,
  preferredLocalpart?: string,
): string => {
  const desiredLocalpart = sanitizeMatrixLocalpart(preferredLocalpart ?? "service-bot", "service-bot");
  return operatorLocalpart === desiredLocalpart ? `${desiredLocalpart}-bot` : desiredLocalpart;
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

const stripSingleTrailingNewline = (value: string): string =>
  value.endsWith("\n") ? value.slice(0, -1) : value;

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
