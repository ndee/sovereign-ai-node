import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import { DockerComposeBundledMatrixProvisioner } from "./matrix.js";

const buildInstallRequest = (): InstallRequest => ({
  mode: "bundled_matrix",
  openclaw: {
    manageInstallation: true,
    installMethod: "install_sh",
    version: "pinned-by-sovereign",
    skipIfCompatibleInstalled: true,
    forceReinstall: false,
    runOnboard: false,
  },
  openrouter: {
    model: "openai/gpt-5-nano",
    apiKey: "sk-or-test",
  },
  imap: {
    host: "imap.example.org",
    port: 993,
    tls: true,
    username: "operator@example.org",
    secretRef: "file:/tmp/imap-secret",
    mailbox: "INBOX",
  },
  matrix: {
    homeserverDomain: "matrix.local.test",
    publicBaseUrl: "http://matrix.local.test:8008",
    federationEnabled: false,
    tlsMode: "local-dev",
    alertRoomName: "Sovereign Alerts",
  },
  operator: {
    username: "operator",
  },
  advanced: {
    nonInteractive: true,
  },
});

describe("DockerComposeBundledMatrixProvisioner", () => {
  it("writes a local-dev compose bundle and validates it with docker compose config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "services:\n  postgres: {}\n  synapse: {}\n",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "state"),
      logsDir: join(tempRoot, "logs"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
    );

    try {
      const result = await provisioner.provision(buildInstallRequest());

      expect(result.tlsMode).toBe("local-dev");
      expect(result.homeserverDomain).toBe("matrix.local.test");
      expect(result.adminBaseUrl).toBe("http://127.0.0.1:8008");

      const composeText = await readFile(result.composeFilePath, "utf8");
      expect(composeText).toContain("matrixdotorg/synapse:v1.125.0");
      expect(composeText).toContain("postgres:16-alpine");
      expect(composeText).toContain('POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"');
      expect(composeText).toContain('"0.0.0.0:8008:8008"');
      const envText = await readFile(join(result.projectDir, ".env"), "utf8");
      expect(envText).toContain("SYNAPSE_CONFIG_PATH=/data/homeserver.yaml");
      const synapseDirStat = await stat(join(result.projectDir, "synapse"));
      const postgresDirStat = await stat(join(result.projectDir, "postgres-data"));
      expect(synapseDirStat.mode & 0o777).toBe(0o777);
      expect(postgresDirStat.mode & 0o777).toBe(0o777);

      const homeserverText = await readFile(join(result.projectDir, "synapse", "homeserver.yaml"), "utf8");
      expect(homeserverText).toContain('server_name: "matrix.local.test"');
      expect(homeserverText).toContain('public_baseurl: "http://matrix.local.test:8008/"');
      expect(homeserverText).toContain("allow_unsafe_locale: true");
      expect(homeserverText).toContain("rc_login:");
      expect(homeserverText).toContain("per_second: 1000");
      const signingKey = await readFile(
        join(result.projectDir, "synapse", "matrix.local.test.signing.key"),
        "utf8",
      );
      expect(signingKey).toMatch(/^ed25519\s+a_1\s+[A-Za-z0-9+/]+/);

      expect(recordedExecCalls).toHaveLength(1);
      expect(recordedExecCalls[0]?.command).toBe("docker");
      expect(recordedExecCalls[0]?.args).toContain("compose");
      expect(recordedExecCalls[0]?.args).toContain("config");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps Synapse bound to loopback when the public base URL uses a loopback host", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "services:\n  postgres: {}\n  synapse: {}\n",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "state"),
      logsDir: join(tempRoot, "logs"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
    );

    try {
      const req = buildInstallRequest();
      req.matrix.publicBaseUrl = "http://127.0.0.1:8008";
      const result = await provisioner.provision(req);

      const composeText = await readFile(result.composeFilePath, "utf8");
      expect(composeText).toContain('"127.0.0.1:8008:8008"');
      expect(recordedExecCalls).toHaveLength(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes an auto-TLS reverse-proxy bundle for public installs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "services:\n  postgres: {}\n  synapse: {}\n  reverse-proxy: {}\n",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const paths: SovereignPaths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir: join(tempRoot, "state"),
      logsDir: join(tempRoot, "logs"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
    };

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
    );

    try {
      const req = buildInstallRequest();
      req.matrix.homeserverDomain = "matrix.example.org";
      req.matrix.publicBaseUrl = "https://matrix.example.org";
      req.matrix.tlsMode = "auto";
      const result = await provisioner.provision(req);

      expect(result.tlsMode).toBe("auto");
      expect(result.adminBaseUrl).toBe("http://127.0.0.1:8008");

      const composeText = await readFile(result.composeFilePath, "utf8");
      expect(composeText).toContain("reverse-proxy:");
      expect(composeText).toContain("caddy:2.10.2-alpine");
      expect(composeText).toContain('"127.0.0.1:8008:8008"');
      expect(composeText).toContain('"80:80"');
      expect(composeText).toContain('"443:443"');

      const homeserverText = await readFile(join(result.projectDir, "synapse", "homeserver.yaml"), "utf8");
      expect(homeserverText).toContain('public_baseurl: "https://matrix.example.org/"');
      expect(homeserverText).toContain("x_forwarded: true");

      const caddyText = await readFile(join(result.projectDir, "reverse-proxy", "Caddyfile"), "utf8");
      expect(caddyText).toContain("matrix.example.org {");
      expect(caddyText).toContain("@onboard path /onboard /onboard/ /onboard/index.html");
      expect(caddyText).toContain("reverse_proxy synapse:8008");

      const wellKnownClient = await readFile(
        join(result.projectDir, "well-known", ".well-known", "matrix", "client"),
        "utf8",
      );
      expect(wellKnownClient).toContain('"base_url": "https://matrix.example.org"');

      const wellKnownServer = await readFile(
        join(result.projectDir, "well-known", ".well-known", "matrix", "server"),
        "utf8",
      );
      expect(wellKnownServer).toContain('"m.server": "matrix.example.org"');
      const onboardPage = await readFile(
        join(result.projectDir, "well-known", "onboard", "index.html"),
        "utf8",
      );
      expect(onboardPage).toContain("Connect via Element Web");
      expect(onboardPage).toContain("https://app.element.io/#/login");
      expect(onboardPage).toContain("Copy Homeserver URL");
      expect(onboardPage).toContain("Copy Username");
      expect(onboardPage).toContain("cannot safely inject your password");
      expect(onboardPage).toContain("Bestätigung nicht möglich?");
      expect(onboardPage).toContain("<svg");
      expect(onboardPage).not.toContain("/downloads/caddy-root-ca.crt");
      expect(recordedExecCalls).toHaveLength(2);
      expect(recordedExecCalls.some((call) => call.command === "qrencode")).toBe(true);
      expect(recordedExecCalls.some((call) => call.command === "docker")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes an internal-TLS reverse-proxy bundle for LAN-only installs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "services:\n  postgres: {}\n  synapse: {}\n  reverse-proxy: {}\n",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const paths = buildPaths(tempRoot);
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
    );

    try {
      const req = buildInstallRequest();
      req.matrix.homeserverDomain = "matrix.local.test";
      req.matrix.publicBaseUrl = "https://192.168.0.54:8448";
      req.matrix.tlsMode = "internal";
      const result = await provisioner.provision(req);

      expect(result.tlsMode).toBe("internal");
      expect(result.adminBaseUrl).toBe("http://127.0.0.1:8008");

      const composeText = await readFile(result.composeFilePath, "utf8");
      expect(composeText).toContain("reverse-proxy:");
      expect(composeText).toContain('"127.0.0.1:8008:8008"');
      expect(composeText).toContain('"8448:443"');
      expect(composeText).not.toContain('"80:80"');

      const caddyText = await readFile(join(result.projectDir, "reverse-proxy", "Caddyfile"), "utf8");
      expect(caddyText).toContain("192.168.0.54 {");
      expect(caddyText).toContain("default_sni 192.168.0.54");
      expect(caddyText).toContain("tls internal");
      expect(caddyText).toContain("@ca path /downloads/caddy-root-ca.crt");

      const wellKnownServer = await readFile(
        join(result.projectDir, "well-known", ".well-known", "matrix", "server"),
        "utf8",
      );
      expect(wellKnownServer).toContain('"m.server": "matrix.local.test:8448"');
      const onboardPage = await readFile(
        join(result.projectDir, "well-known", "onboard", "index.html"),
        "utf8",
      );
      expect(onboardPage).toContain("/downloads/caddy-root-ca.crt");
      expect(onboardPage).toContain("Connect via Element Web");
      expect(onboardPage).toContain("Native Android Matrix apps may still reject local CAs");
      expect(onboardPage).toContain("Do not type only 192.168.0.54:8448.");
      expect(onboardPage).toContain("Brave Mobile is not a reliable target");
      expect(onboardPage).toContain("Bestätigung nicht möglich?");
      expect(onboardPage).toContain("<svg");
      expect(recordedExecCalls).toHaveLength(2);
      expect(recordedExecCalls.some((call) => call.command === "qrencode")).toBe(true);
      expect(recordedExecCalls.some((call) => call.command === "docker")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("bootstraps operator/bot accounts and creates alert room in local-dev mode", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];
    const recordedFetchUrls: string[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          const args = input.args ?? [];
          if (
            args.includes("config")
            || args.includes("up")
            || args.includes("register_new_matrix_user")
          ) {
            return {
              command: [input.command, ...args].join(" "),
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      recordedFetchUrls.push(url);

      if (url.endsWith("/_matrix/client/versions")) {
        return jsonResponse({
          versions: ["v1.1", "v1.2"],
        });
      }

      if (url.endsWith("/_matrix/client/v3/login")) {
        const payload = parseBody(init?.body);
        const localpart = readLoginLocalpart(payload) ?? "unknown";
        return jsonResponse({
          access_token: `token-${localpart}`,
          user_id: `@${localpart}:matrix.local.test`,
        });
      }

      if (url.endsWith("/_matrix/client/v3/createRoom")) {
        return jsonResponse({
          room_id: "!alerts:matrix.local.test",
        });
      }

      if (url.includes("/invite") || url.includes("/join")) {
        return jsonResponse({});
      }

      return new Response(JSON.stringify({ error: "not-found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    const paths = buildPaths(tempRoot);
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
      fakeFetch,
    );

    try {
      const req = buildInstallRequest();
      const provision = await provisioner.provision(req);
      const accounts = await provisioner.bootstrapAccounts(req, provision);
      const room = await provisioner.bootstrapRoom(req, provision, accounts);

      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      expect(accounts.bot.userId).toBe("@mail-sentinel:matrix.local.test");
      expect(accounts.operator.passwordSecretRef.startsWith("file:")).toBe(true);
      expect(accounts.bot.passwordSecretRef.startsWith("file:")).toBe(true);
      expect(room.roomId).toBe("!alerts:matrix.local.test");
      expect(room.roomName).toBe("Sovereign Alerts");

      const operatorSecretPath = accounts.operator.passwordSecretRef.slice("file:".length);
      const botSecretPath = accounts.bot.passwordSecretRef.slice("file:".length);
      expect((await readFile(operatorSecretPath, "utf8")).trim().length).toBeGreaterThan(0);
      expect((await readFile(botSecretPath, "utf8")).trim().length).toBeGreaterThan(0);

      const composeUpCalls = recordedExecCalls.filter(
        (call) => call.command === "docker" && (call.args ?? []).includes("up"),
      );
      expect(composeUpCalls).toHaveLength(1);

      const registerCalls = recordedExecCalls.filter(
        (call) =>
          call.command === "docker" && (call.args ?? []).includes("register_new_matrix_user"),
      );
      expect(registerCalls).toHaveLength(2);
      expect(registerCalls.some((call) => (call.args ?? []).includes("-a"))).toBe(true);
      expect(registerCalls.some((call) => (call.args ?? []).includes("--no-admin"))).toBe(true);

      expect(recordedFetchUrls.some((url) => url.endsWith("/_matrix/client/v3/login"))).toBe(true);
      expect(recordedFetchUrls.some((url) => url.endsWith("/_matrix/client/v3/createRoom"))).toBe(
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("recovers account bootstrap by resetting bundled postgres when login credentials drift", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];
    let operatorLoginAttempts = 0;

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          const args = input.args ?? [];
          if (
            args.includes("config")
            || args.includes("up")
            || args.includes("down")
            || args.includes("register_new_matrix_user")
          ) {
            return {
              command: [input.command, ...args].join(" "),
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/_matrix/client/versions")) {
        return jsonResponse({
          versions: ["v1.1", "v1.2"],
        });
      }

      if (url.endsWith("/_matrix/client/v3/login")) {
        const payload = parseBody(init?.body);
        const localpart = readLoginLocalpart(payload) ?? "unknown";
        if (localpart === "operator" && operatorLoginAttempts < 5) {
          operatorLoginAttempts += 1;
          return jsonResponse(
            {
              errcode: "M_FORBIDDEN",
              error: "Invalid username or password",
            },
            403,
          );
        }
        return jsonResponse({
          access_token: `token-${localpart}`,
          user_id: `@${localpart}:matrix.local.test`,
        });
      }

      return jsonResponse({});
    };

    const paths = buildPaths(tempRoot);
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
      fakeFetch,
    );

    try {
      const req = buildInstallRequest();
      const provision = await provisioner.provision(req);
      const accounts = await provisioner.bootstrapAccounts(req, provision);

      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      expect(accounts.bot.userId).toBe("@mail-sentinel:matrix.local.test");

      const downCalls = recordedExecCalls.filter(
        (call) => call.command === "docker" && (call.args ?? []).includes("down"),
      );
      const upCalls = recordedExecCalls.filter(
        (call) => call.command === "docker" && (call.args ?? []).includes("up"),
      );
      expect(downCalls).toHaveLength(1);
      expect(upCalls).toHaveLength(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("regenerates bootstrap passwords after credential recovery when stored secrets are stale", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          const args = input.args ?? [];
          if (
            args.includes("config")
            || args.includes("up")
            || args.includes("down")
            || args.includes("register_new_matrix_user")
          ) {
            return {
              command: [input.command, ...args].join(" "),
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/_matrix/client/versions")) {
        return jsonResponse({
          versions: ["v1.1", "v1.2"],
        });
      }

      if (url.endsWith("/_matrix/client/v3/login")) {
        const payload = parseBody(init?.body);
        const localpart = readLoginLocalpart(payload) ?? "unknown";
        const password = readLoginPassword(payload) ?? "";
        if (localpart === "operator" && password === "stale-operator-password") {
          return jsonResponse(
            {
              errcode: "M_FORBIDDEN",
              error: "Invalid username or password",
            },
            403,
          );
        }
        return jsonResponse({
          access_token: `token-${localpart}`,
          user_id: `@${localpart}:matrix.local.test`,
        });
      }

      return jsonResponse({});
    };

    const paths = buildPaths(tempRoot);
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
      fakeFetch,
    );

    try {
      const req = buildInstallRequest();
      const provision = await provisioner.provision(req);
      const secretsDir = join(provision.projectDir, "bootstrap-secrets");
      await mkdir(secretsDir, { recursive: true });
      await writeFile(join(secretsDir, "operator.password"), "stale-operator-password\n", "utf8");
      await writeFile(join(secretsDir, "mail-sentinel.password"), "stale-bot-password\n", "utf8");

      const accounts = await provisioner.bootstrapAccounts(req, provision);

      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      expect(accounts.bot.userId).toBe("@mail-sentinel:matrix.local.test");
      const operatorSecretPath = accounts.operator.passwordSecretRef.slice("file:".length);
      expect((await readFile(operatorSecretPath, "utf8")).trim()).not.toBe(
        "stale-operator-password",
      );

      const downCalls = recordedExecCalls.filter(
        (call) => call.command === "docker" && (call.args ?? []).includes("down"),
      );
      expect(downCalls).toHaveLength(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries Matrix login when Synapse returns M_LIMIT_EXCEEDED", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];
    let operatorLoginAttempts = 0;

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (input.command === "docker") {
          const args = input.args ?? [];
          if (
            args.includes("config")
            || args.includes("up")
            || args.includes("down")
            || args.includes("register_new_matrix_user")
          ) {
            return {
              command: [input.command, ...args].join(" "),
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          }
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/_matrix/client/versions")) {
        return jsonResponse({
          versions: ["v1.1", "v1.2"],
        });
      }

      if (url.endsWith("/_matrix/client/v3/login")) {
        const payload = parseBody(init?.body);
        const localpart = readLoginLocalpart(payload) ?? "unknown";
        if (localpart === "operator" && operatorLoginAttempts === 0) {
          operatorLoginAttempts += 1;
          return jsonResponse(
            {
              errcode: "M_LIMIT_EXCEEDED",
              error: "Too Many Requests",
              retry_after_ms: 1,
            },
            429,
          );
        }
        return jsonResponse({
          access_token: `token-${localpart}`,
          user_id: `@${localpart}:matrix.local.test`,
        });
      }

      return jsonResponse({});
    };

    const paths = buildPaths(tempRoot);
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
      fakeFetch,
    );

    try {
      const req = buildInstallRequest();
      const provision = await provisioner.provision(req);
      const accounts = await provisioner.bootstrapAccounts(req, provision);

      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      expect(accounts.bot.userId).toBe("@mail-sentinel:matrix.local.test");
      const downCalls = recordedExecCalls.filter(
        (call) => call.command === "docker" && (call.args ?? []).includes("down"),
      );
      expect(downCalls).toHaveLength(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns pass checks when matrix client and federation probes succeed", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const paths = buildPaths(tempRoot);

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => ({
        command: [input.command, ...(input.args ?? [])].join(" "),
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    };

    const fakeFetch = async (url: string): Promise<Response> => {
      if (url.endsWith("/_matrix/client/versions")) {
        return jsonResponse({
          versions: ["v1.1"],
        });
      }
      if (url.endsWith("/_matrix/federation/v1/version")) {
        return jsonResponse({
          server: {
            name: "synapse",
            version: "1.125.0",
          },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
      fakeFetch,
    );

    try {
      const result = await provisioner.test({
        publicBaseUrl: "http://matrix.local.test:8008",
        federationEnabled: true,
      });

      expect(result.ok).toBe(true);
      expect(result.homeserverUrl).toBe("http://matrix.local.test:8008");
      expect(result.serverDiscovery).toEqual({
        required: true,
        ok: true,
      });
      expect(result.checks.every((entry) => entry.status === "pass")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reuses existing postgres password from prior env on reprovision", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const paths = buildPaths(tempRoot);
    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        if (input.command === "docker") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
    );

    try {
      const req = buildInstallRequest();
      const first = await provisioner.provision(req);
      const firstEnv = await readFile(join(first.projectDir, ".env"), "utf8");
      const expected = firstEnv
        .split(/\r?\n/)
        .find((line) => line.startsWith("POSTGRES_PASSWORD="))
        ?.slice("POSTGRES_PASSWORD=".length);
      expect(expected).toBeTruthy();

      const second = await provisioner.provision(req);
      const secondEnv = await readFile(join(second.projectDir, ".env"), "utf8");
      expect(secondEnv).toContain(`POSTGRES_PASSWORD=${expected}`);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

const buildPaths = (tempRoot: string): SovereignPaths => ({
  configPath: join(tempRoot, "etc", "sovereign-node.json5"),
  secretsDir: join(tempRoot, "etc", "secrets"),
  stateDir: join(tempRoot, "state"),
  logsDir: join(tempRoot, "logs"),
  installJobsDir: join(tempRoot, "install-jobs"),
  openclawServiceHome: join(tempRoot, "openclaw-home"),
});

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

const parseBody = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") {
    return {};
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const readLoginLocalpart = (payload: Record<string, unknown>): string | null => {
  const identifier = payload.identifier;
  if (typeof identifier !== "object" || identifier === null) {
    return null;
  }
  const user = (identifier as { user?: unknown }).user;
  return typeof user === "string" && user.trim().length > 0 ? user : null;
};

const readLoginPassword = (payload: Record<string, unknown>): string | null => {
  const password = payload.password;
  return typeof password === "string" && password.trim().length > 0 ? password : null;
};
