import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { createLogger } from "../logging/logger.js";
import type { OpenClawBootstrapper } from "../openclaw/bootstrap.js";
import type { ImapTester } from "../system/imap.js";
import type { BundledMatrixProvisioner } from "../system/matrix.js";
import type { HostPreflightChecker } from "../system/preflight.js";
import { RealInstallerService } from "./real-service.js";
import type { FetchLike } from "./real-service-shared.js";

const noopDeps = {
  openclawBootstrapper: {} as unknown as OpenClawBootstrapper,
  openclawGatewayServiceManager: {
    install: async () => {},
    start: async () => {},
    restart: async () => {},
  },
  preflightChecker: {} as unknown as HostPreflightChecker,
  imapTester: {} as unknown as ImapTester,
  matrixProvisioner: {} as unknown as BundledMatrixProvisioner,
};

type LoginInput = {
  adminBaseUrl: string;
  localpart: string;
  password: string;
  expectedUserId: string;
};
type LoginMatrixUser = (input: LoginInput) => Promise<{ userId: string; accessToken: string }>;

const loginInput: LoginInput = {
  adminBaseUrl: "http://127.0.0.1:8008",
  localpart: "service-bot",
  password: "pw",
  expectedUserId: "@service-bot:matrix.example.org",
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const rateLimited = (retryAfterMs?: number): Response =>
  json(429, {
    errcode: "M_LIMIT_EXCEEDED",
    error: "Too Many Requests",
    ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
  });

describe("Matrix password logins under homeserver rate limits", () => {
  let tempRoot: string;
  let paths: SovereignPaths;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "matrix-login-"));
    paths = {
      configPath: join(tempRoot, "sovereign-node.json"),
      secretsDir: join(tempRoot, "secrets"),
      stateDir: join(tempRoot, "state"),
      logsDir: join(tempRoot, "logs"),
      installJobsDir: join(tempRoot, "jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const buildService = (responses: Response[], fetched: string[] = []): RealInstallerService =>
    new RealInstallerService(createLogger(), paths, {
      ...noopDeps,
      fetchImpl: (async (url: string) => {
        fetched.push(url);
        const next = responses.shift();
        if (next === undefined) {
          throw new Error("unexpected request");
        }
        return next;
      }) as FetchLike,
    });

  const loginMatrixUser = (service: RealInstallerService): LoginMatrixUser => {
    const login = (service as unknown as { loginMatrixUser: LoginMatrixUser }).loginMatrixUser;
    return login.bind(service);
  };

  describe("loginMatrixUser", () => {
    it("waits out a retry-after longer than the old five-second cap", async () => {
      vi.useFakeTimers();
      const fetched: string[] = [];
      const service = buildService(
        [rateLimited(20_000), json(200, { user_id: "@service-bot:m", access_token: "tok" })],
        fetched,
      );
      const pending = loginMatrixUser(service)(loginInput);
      await vi.advanceTimersByTimeAsync(19_000);
      expect(fetched).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ userId: "@service-bot:m", accessToken: "tok" });
      expect(fetched).toEqual([
        "http://127.0.0.1:8008/_matrix/client/v3/login",
        "http://127.0.0.1:8008/_matrix/client/v3/login",
      ]);
    });

    it("keeps retrying short cooldowns with a minimum delay", async () => {
      vi.useFakeTimers();
      const fetched: string[] = [];
      const service = buildService(
        [rateLimited(0), rateLimited(0), json(200, { access_token: "tok" })],
        fetched,
      );
      const pending = loginMatrixUser(service)(loginInput);
      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toEqual({
        userId: "@service-bot:matrix.example.org",
        accessToken: "tok",
      });
      expect(fetched).toHaveLength(3);
    });

    it("fails at once when a retry-after exceeds the remaining wait budget", async () => {
      const fetched: string[] = [];
      const service = buildService([rateLimited(121_000)], fetched);
      await expect(loginMatrixUser(service)(loginInput)).rejects.toMatchObject({
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        details: { status: 429 },
      });
      expect(fetched).toHaveLength(1);
    });

    it("stops once the total wait budget is spent", async () => {
      vi.useFakeTimers();
      const fetched: string[] = [];
      const service = buildService(
        [rateLimited(60_000), rateLimited(50_000), rateLimited(15_000)],
        fetched,
      );
      const pending = loginMatrixUser(service)(loginInput);
      const assertion = expect(pending).rejects.toMatchObject({ details: { status: 429 } });
      await vi.advanceTimersByTimeAsync(110_000);
      await assertion;
      expect(fetched).toHaveLength(3);
    });

    it("does not retry a rejected password even when it carries a retry-after", async () => {
      const fetched: string[] = [];
      const service = buildService(
        [json(403, { errcode: "M_FORBIDDEN", retry_after_ms: 1 })],
        fetched,
      );
      await expect(loginMatrixUser(service)(loginInput)).rejects.toMatchObject({
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        details: { status: 403 },
      });
      expect(fetched).toHaveLength(1);
    });

    it("fails on a rate limit that carries no retry-after", async () => {
      const service = buildService([rateLimited()]);
      await expect(loginMatrixUser(service)(loginInput)).rejects.toMatchObject({
        code: "MATRIX_AGENT_IDENTITY_FAILED",
        details: { status: 429 },
      });
    });
  });

  describe("verifyOperatorPassword", () => {
    const writeConfig = async (): Promise<void> => {
      await writeFile(
        paths.configPath,
        `${JSON.stringify({
          matrix: {
            accessMode: "direct",
            publicBaseUrl: "https://matrix.example.org",
            adminBaseUrl: "http://127.0.0.1:8008",
            homeserverDomain: "matrix.example.org",
            operator: {
              localpart: "operator",
              userId: "@operator:matrix.example.org",
              passwordSecretRef: "file:/tmp/operator.password",
            },
            bot: { userId: "@bot:matrix.example.org", accessTokenSecretRef: "file:/tmp/bot.token" },
            alertRoom: { roomId: "!room:matrix.example.org", roomName: "Alerts" },
          },
        })}\n`,
        "utf8",
      );
    };

    it("reports rate-limited with the homeserver's retry-after in whole seconds", async () => {
      await writeConfig();
      const service = buildService([rateLimited(42_100)]);
      await expect(service.verifyOperatorPassword("pw")).resolves.toEqual({
        ok: false,
        reason: "rate-limited",
        retryAfterSeconds: 43,
      });
    });

    it("rounds a sub-second retry-after up to one second", async () => {
      await writeConfig();
      const service = buildService([rateLimited(0)]);
      await expect(service.verifyOperatorPassword("pw")).resolves.toEqual({
        ok: false,
        reason: "rate-limited",
        retryAfterSeconds: 1,
      });
    });

    it("reports rate-limited without a retry-after when the homeserver omits it", async () => {
      await writeConfig();
      const service = buildService([new Response("Too Many Requests", { status: 429 })]);
      await expect(service.verifyOperatorPassword("pw")).resolves.toEqual({
        ok: false,
        reason: "rate-limited",
      });
    });

    it("still reports other failures as homeserver-unreachable", async () => {
      await writeConfig();
      const service = buildService([json(502, {})]);
      await expect(service.verifyOperatorPassword("pw")).resolves.toEqual({
        ok: false,
        reason: "homeserver-unreachable",
      });
    });
  });
});
