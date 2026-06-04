import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    model: "qwen/qwen3.5-9b",
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
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
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

      // Parent directories must be traversable by the Synapse and Postgres
      // container UIDs (non-root) so they can reach their bind-mounts.
      const baseDirStat = await stat(join(tempRoot, "state", "bundled-matrix"));
      const projectDirStat = await stat(result.projectDir);
      expect(baseDirStat.mode & 0o755).toBe(0o755);
      expect(projectDirStat.mode & 0o755).toBe(0o755);

      // Synapse config files must be readable by the Synapse container's
      // non-root user (UID 991 in the upstream image).
      const homeserverStat = await stat(join(result.projectDir, "synapse", "homeserver.yaml"));
      const signingKeyStat = await stat(
        join(result.projectDir, "synapse", "matrix.local.test.signing.key"),
      );
      const logConfigStat = await stat(join(result.projectDir, "synapse", "log.config"));
      expect(homeserverStat.mode & 0o644).toBe(0o644);
      expect(signingKeyStat.mode & 0o644).toBe(0o644);
      expect(logConfigStat.mode & 0o644).toBe(0o644);

      const homeserverText = await readFile(
        join(result.projectDir, "synapse", "homeserver.yaml"),
        "utf8",
      );
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
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
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
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
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
      expect(composeText).toContain("onboarding-api:");
      expect(composeText).toContain("node:22-alpine");
      expect(composeText).toContain("/srv/sovereign-node-onboarding-api.js");
      expect(composeText).toContain('"127.0.0.1:8008:8008"');
      expect(composeText).toContain('"80:80"');
      expect(composeText).toContain('"443:443"');

      const homeserverText = await readFile(
        join(result.projectDir, "synapse", "homeserver.yaml"),
        "utf8",
      );
      expect(homeserverText).toContain('public_baseurl: "https://matrix.example.org/"');
      expect(homeserverText).toContain("x_forwarded: true");

      const caddyText = await readFile(
        join(result.projectDir, "reverse-proxy", "Caddyfile"),
        "utf8",
      );
      expect(caddyText).toContain("matrix.example.org {");
      expect(caddyText).toContain("@onboard path /onboard /onboard/ /onboard/index.html");
      expect(caddyText).toContain("@onboardApi path /onboard/api /onboard/api/*");
      expect(caddyText).toContain("reverse_proxy onboarding-api:8090");
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
      expect(onboardPage).toContain("Open in Element Android App");
      expect(onboardPage).toContain("https://app.element.io/#/login?hs_url=");
      expect(onboardPage).toContain("intent://mobile.element.io/");
      expect(onboardPage).toContain("package=im.vector.app");
      expect(onboardPage).toContain("Copy Server URL");
      expect(onboardPage).toContain("Copy Username");
      expect(onboardPage).toContain("Unlock Password");
      expect(onboardPage).toContain("/onboard/api/redeem");
      expect(onboardPage).toContain("The username and password are not embedded in this page.");
      expect(onboardPage).toContain("sudo sovereign-node onboarding issue");
      expect(onboardPage).toContain("Bestätigung nicht möglich?");
      expect(onboardPage).toContain("After login: message the right bot");
      expect(onboardPage).toContain("Node Operator");
      expect(onboardPage).toContain("Mail Sentinel");
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
      undefined,
      // No additional LAN IPs in this fixture — keep the cert site list
      // identical to the publicBaseUrl host (192.168.0.54).
      () => [],
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
      expect(composeText).toContain("onboarding-api:");
      expect(composeText).toContain('"127.0.0.1:8008:8008"');
      expect(composeText).toContain('"8448:443"');
      expect(composeText).not.toContain('"80:80"');

      const caddyText = await readFile(
        join(result.projectDir, "reverse-proxy", "Caddyfile"),
        "utf8",
      );
      expect(caddyText).toContain("192.168.0.54 {");
      expect(caddyText).toContain("default_sni 192.168.0.54");
      expect(caddyText).toContain("tls internal");
      expect(caddyText).toContain("@ca path /downloads/caddy-root-ca.crt");
      expect(caddyText).toContain("@onboardApi path /onboard/api /onboard/api/*");

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
      expect(onboardPage).toContain("Open in Element Android App");
      expect(onboardPage).toContain("package=im.vector.app");
      expect(onboardPage).toContain("Copy Server URL");
      expect(onboardPage).toContain("Unlock Password");
      expect(onboardPage).toContain("The username and password are not embedded in this page.");
      expect(onboardPage).toContain("Native Android Matrix apps may still reject local CAs");
      expect(onboardPage).toContain("Do not type only 192.168.0.54:8448.");
      expect(onboardPage).toContain("Vanadium and Brave may behave differently");
      expect(onboardPage).toContain("Bestätigung nicht möglich?");
      expect(onboardPage).toContain("After login: message the right bot");
      expect(onboardPage).toContain("Node Operator");
      expect(onboardPage).toContain("Mail Sentinel");
      expect(onboardPage).toContain("<svg");
      expect(recordedExecCalls).toHaveLength(2);
      expect(recordedExecCalls.some((call) => call.command === "qrencode")).toBe(true);
      expect(recordedExecCalls.some((call) => call.command === "docker")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("includes detected LAN IPv4 addresses as additional Caddy site names for Local LAN installs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-matrix-test-"));
    const fakeExecRunner: ExecRunner = {
      async run(input) {
        if (input.command === "qrencode") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            stderr: "",
          };
        }
        if (input.command === "docker") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "",
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
      undefined,
      // Stub two LAN IPs; the cert should cover both alongside the
      // hostname so https://192.168.0.181/ and https://10.0.0.5/ are
      // accepted by browsers that trust the Caddy CA.
      () => ["192.168.0.181", "10.0.0.5"],
    );

    try {
      const req = buildInstallRequest();
      req.matrix.homeserverDomain = "matrix.lan.local";
      req.matrix.publicBaseUrl = "https://matrix.lan.local";
      req.matrix.tlsMode = "internal";
      const result = await provisioner.provision(req);

      const caddyText = await readFile(
        join(result.projectDir, "reverse-proxy", "Caddyfile"),
        "utf8",
      );
      // Site directive lists hostname + each LAN IP, comma-separated.
      expect(caddyText).toContain("matrix.lan.local, 192.168.0.181, 10.0.0.5 {");
      // default_sni stays at the hostname (Caddy uses it when SNI is absent).
      expect(caddyText).toContain("default_sni matrix.lan.local");
      expect(caddyText).toContain("tls internal");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not duplicate the publicBaseUrl host if it is also in the LAN IP list", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-matrix-test-"));
    const fakeExecRunner: ExecRunner = {
      async run(input) {
        if (input.command === "qrencode") {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            stderr: "",
          };
        }
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };

    const paths = buildPaths(tempRoot);
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
      undefined,
      () => ["192.168.0.54", "10.0.0.5"],
    );

    try {
      const req = buildInstallRequest();
      req.matrix.homeserverDomain = "matrix.local.test";
      req.matrix.publicBaseUrl = "https://192.168.0.54:8448";
      req.matrix.tlsMode = "internal";
      const result = await provisioner.provision(req);

      const caddyText = await readFile(
        join(result.projectDir, "reverse-proxy", "Caddyfile"),
        "utf8",
      );
      // 192.168.0.54 is the publicBaseUrl host and was also in the LAN list;
      // it must appear exactly once in the site directive.
      expect(caddyText).toContain("192.168.0.54, 10.0.0.5 {");
      expect(caddyText).not.toContain("192.168.0.54, 192.168.0.54");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes a relay-mode local-edge bundle for managed relay installs", async () => {
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
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      paths,
    );

    try {
      const req = buildInstallRequest();
      req.connectivity = {
        mode: "relay",
      };
      req.relay = {
        controlUrl: "https://relay.example.com",
        enrollmentToken: "relay-token",
      };
      req.matrix.homeserverDomain = "node-abc.relay.example.com";
      req.matrix.publicBaseUrl = "https://node-abc.relay.example.com";
      req.matrix.federationEnabled = true;
      req.matrix.tlsMode = "auto";

      const result = await provisioner.provision(req);

      expect(result.accessMode).toBe("relay");
      const composeText = await readFile(result.composeFilePath, "utf8");
      expect(composeText).toContain("onboarding-api:");
      expect(composeText).toContain('"127.0.0.1:18080:80"');
      expect(composeText).not.toContain('"80:80"');
      expect(composeText).not.toContain(':443"');

      const caddyText = await readFile(
        join(result.projectDir, "reverse-proxy", "Caddyfile"),
        "utf8",
      );
      const envText = await readFile(join(result.projectDir, ".env"), "utf8");
      const homeserverYaml = await readFile(
        join(result.projectDir, "synapse", "homeserver.yaml"),
        "utf8",
      );
      const wellKnownServer = await readFile(
        join(result.projectDir, "well-known", ".well-known", "matrix", "server"),
        "utf8",
      );
      expect(caddyText).toContain(":80 {");
      expect(caddyText).not.toContain("tls internal");
      expect(caddyText).not.toContain("/downloads/caddy-root-ca.crt");
      expect(caddyText).toContain("@onboardApi path /onboard/api /onboard/api/*");
      expect(envText).toContain("MATRIX_FEDERATION_ENABLED=true");
      expect(homeserverYaml).not.toContain("federation_domain_whitelist: []");
      expect(wellKnownServer).toContain('"m.server": "node-abc.relay.example.com:443"');

      const onboardPage = await readFile(
        join(result.projectDir, "well-known", "onboard", "index.html"),
        "utf8",
      );
      expect(onboardPage).toContain("Connect via Element Web");
      expect(onboardPage).toContain("Open in Element Android App");
      expect(onboardPage).toContain("Unlock Password");
      expect(onboardPage).toContain("The username and password are not embedded in this page.");
      expect(onboardPage).not.toContain("/downloads/caddy-root-ca.crt");
      expect(recordedExecCalls).toHaveLength(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("bootstraps operator/bot accounts, creates the alert room, and rewrites onboarding for HTTPS mode", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedExecCalls: ExecInput[] = [];
    const recordedFetchUrls: string[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        recordedExecCalls.push(input);
        if (isComposePsCall(input)) {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: composePsRunningJson(),
            stderr: "",
          };
        }
        if (input.command === "docker") {
          const args = input.args ?? [];
          if (
            args.includes("config") ||
            args.includes("up") ||
            args.includes("register_new_matrix_user")
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

      const readiness = matrixReadinessResponse(url);
      if (readiness !== undefined) {
        return readiness;
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
      req.matrix.publicBaseUrl = "https://192.168.0.54:8448";
      req.matrix.tlsMode = "internal";
      req.matrix.alertRoomName = "Alerts";
      const provision = await provisioner.provision(req);
      const accounts = await provisioner.bootstrapAccounts(req, provision);
      const room = await provisioner.bootstrapRoom(req, provision, accounts);

      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      expect(accounts.bot.userId).toBe("@service-bot:matrix.local.test");
      expect(accounts.operator.passwordSecretRef.startsWith("file:")).toBe(true);
      expect(accounts.bot.passwordSecretRef.startsWith("file:")).toBe(true);
      expect(room.roomId).toBe("!alerts:matrix.local.test");
      expect(room.roomName).toBe("Alerts");

      const operatorSecretPath = accounts.operator.passwordSecretRef.slice("file:".length);
      const botSecretPath = accounts.bot.passwordSecretRef.slice("file:".length);
      const operatorPassword = (await readFile(operatorSecretPath, "utf8")).trim();
      expect(operatorPassword.length).toBeGreaterThan(0);
      expect((await readFile(botSecretPath, "utf8")).trim().length).toBeGreaterThan(0);

      const onboardPage = await readFile(
        join(provision.projectDir, "well-known", "onboard", "index.html"),
        "utf8",
      );
      expect(onboardPage).toContain("Copy Password");
      expect(onboardPage).toContain("Unlock Password");
      expect(onboardPage).toContain("The username and password are not embedded in this page.");
      expect(onboardPage).not.toContain(operatorPassword);
      expect(onboardPage).toContain("Open Alert Room in Element Web");
      expect(onboardPage).toContain("existing Alerts room");
      expect(onboardPage).toContain("Use <code>Alerts</code> for notifications");
      expect(onboardPage).not.toContain("existing Sovereign Alerts room");

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
        if (isComposePsCall(input)) {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: composePsRunningJson(),
            stderr: "",
          };
        }
        if (input.command === "docker") {
          const args = input.args ?? [];
          if (
            args.includes("config") ||
            args.includes("up") ||
            args.includes("down") ||
            args.includes("register_new_matrix_user")
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
      const readiness = matrixReadinessResponse(url);
      if (readiness !== undefined) {
        return readiness;
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
      expect(accounts.bot.userId).toBe("@service-bot:matrix.local.test");

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
        if (isComposePsCall(input)) {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: composePsRunningJson(),
            stderr: "",
          };
        }
        if (input.command === "docker") {
          const args = input.args ?? [];
          if (
            args.includes("config") ||
            args.includes("up") ||
            args.includes("down") ||
            args.includes("register_new_matrix_user")
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
      const readiness = matrixReadinessResponse(url);
      if (readiness !== undefined) {
        return readiness;
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
      await mkdir(paths.secretsDir, { recursive: true });
      await writeFile(
        join(paths.secretsDir, "matrix-operator.password"),
        "stale-operator-password\n",
        "utf8",
      );
      await writeFile(
        join(paths.secretsDir, "matrix-service-bot.password"),
        "stale-bot-password\n",
        "utf8",
      );

      const accounts = await provisioner.bootstrapAccounts(req, provision);

      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      expect(accounts.bot.userId).toBe("@service-bot:matrix.local.test");
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
        if (isComposePsCall(input)) {
          return {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: composePsRunningJson(),
            stderr: "",
          };
        }
        if (input.command === "docker") {
          const args = input.args ?? [];
          if (
            args.includes("config") ||
            args.includes("up") ||
            args.includes("down") ||
            args.includes("register_new_matrix_user")
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
      const readiness = matrixReadinessResponse(url);
      if (readiness !== undefined) {
        return readiness;
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
      expect(accounts.bot.userId).toBe("@service-bot:matrix.local.test");
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

  it("removes federation_domain_whitelist from homeserver.yaml when enabling federation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const paths = buildPaths(tempRoot);
    const synapseDir = join(tempRoot, "project", "synapse");
    const projectDir = join(tempRoot, "project");
    const wellKnownDir = join(projectDir, "well-known", ".well-known", "matrix");
    const composeFilePath = join(projectDir, "compose.yaml");

    await mkdir(synapseDir, { recursive: true });
    await mkdir(wellKnownDir, { recursive: true });
    await writeFile(
      join(synapseDir, "homeserver.yaml"),
      [
        'server_name: "matrix.example.org"',
        "report_stats: false",
        "federation_domain_whitelist: []",
        'log_config: "/data/log.config"',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectDir, ".env"),
      [
        "POSTGRES_PASSWORD=secret",
        "MATRIX_FEDERATION_ENABLED=false",
        "MATRIX_HOMESERVER_DOMAIN=matrix.example.org",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(wellKnownDir, "server"),
      '{\n  "m.server": "node-abc.relay.example.com"\n}\n',
      "utf8",
    );
    await writeFile(composeFilePath, "version: '3'\nservices:\n  synapse: {}", "utf8");

    const execRunner: ExecRunner = {
      run: async () => ({
        command: "docker compose restart synapse",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    };
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      execRunner,
      createLogger(),
      paths,
    );

    try {
      await provisioner.updateFederationConfig({
        federationEnabled: true,
        projectDir,
        composeFilePath,
        accessMode: "relay",
        homeserverDomain: "node-abc.relay.example.com",
        publicBaseUrl: "https://node-abc.relay.example.com",
      });

      const yaml = await readFile(join(synapseDir, "homeserver.yaml"), "utf8");
      expect(yaml).not.toContain("federation_domain_whitelist");

      const env = await readFile(join(projectDir, ".env"), "utf8");
      expect(env).toContain("MATRIX_FEDERATION_ENABLED=true");

      const wellKnownServer = await readFile(join(wellKnownDir, "server"), "utf8");
      expect(wellKnownServer).toContain('"m.server": "node-abc.relay.example.com:443"');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("adds federation_domain_whitelist to homeserver.yaml when disabling federation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const paths = buildPaths(tempRoot);
    const synapseDir = join(tempRoot, "project", "synapse");
    const projectDir = join(tempRoot, "project");
    const composeFilePath = join(projectDir, "compose.yaml");

    await mkdir(synapseDir, { recursive: true });
    await writeFile(
      join(synapseDir, "homeserver.yaml"),
      [
        'server_name: "matrix.example.org"',
        "report_stats: false",
        'log_config: "/data/log.config"',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectDir, ".env"),
      [
        "POSTGRES_PASSWORD=secret",
        "MATRIX_FEDERATION_ENABLED=true",
        "MATRIX_HOMESERVER_DOMAIN=matrix.example.org",
      ].join("\n"),
      "utf8",
    );
    await writeFile(composeFilePath, "version: '3'\nservices:\n  synapse: {}", "utf8");

    const execRunner: ExecRunner = {
      run: async () => ({
        command: "docker compose restart synapse",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    };
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      execRunner,
      createLogger(),
      paths,
    );

    try {
      await provisioner.updateFederationConfig({
        federationEnabled: false,
        projectDir,
        composeFilePath,
        accessMode: "direct",
        homeserverDomain: "matrix.example.org",
        publicBaseUrl: "https://matrix.example.org",
      });

      const yaml = await readFile(join(synapseDir, "homeserver.yaml"), "utf8");
      expect(yaml).toContain("federation_domain_whitelist: []");

      const env = await readFile(join(projectDir, ".env"), "utf8");
      expect(env).toContain("MATRIX_FEDERATION_ENABLED=false");
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
  provenancePath: join(tempRoot, "install-provenance.json"),
  backupsDir: join(tempRoot, "backups"),
});

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

// Default homeserver domain produced by buildInstallRequest().
const DEFAULT_TEST_HOMESERVER_DOMAIN = "matrix.local.test";

// `docker compose ps --format json` payload reporting every service running.
// Mirrors the NDJSON shape modern compose emits (one object per line).
const composePsRunningJson = (
  services: string[] = ["postgres", "synapse", "reverse-proxy"],
): string =>
  services
    .map((service) =>
      JSON.stringify({ Service: service, State: "running", Status: "Up (healthy)" }),
    )
    .join("\n");

// `/_matrix/key/v2/server` identity payload for a given homeserver domain.
// An empty string omits `server_name` entirely, simulating a response with no
// usable identity field.
const serverKeyResponse = (serverName = DEFAULT_TEST_HOMESERVER_DOMAIN): Response =>
  jsonResponse(
    serverName.length === 0
      ? { valid_until_ts: 0, verify_keys: {} }
      : { server_name: serverName, valid_until_ts: 0, verify_keys: {} },
  );

// True when a fake exec call is a `docker compose ps` invocation.
const isComposePsCall = (input: ExecInput): boolean =>
  input.command === "docker" &&
  (input.args ?? []).includes("ps") &&
  (input.args ?? []).includes("--format");

// Answer the readiness + identity probes a successful provision now performs.
// Returns undefined for unrelated URLs so callers can chain their own handling.
const matrixReadinessResponse = (
  url: string,
  serverName = DEFAULT_TEST_HOMESERVER_DOMAIN,
): Response | undefined => {
  if (url.endsWith("/_matrix/client/versions")) {
    return jsonResponse({ versions: ["v1.1", "v1.2"] });
  }
  if (url.endsWith("/_matrix/key/v2/server")) {
    return serverKeyResponse(serverName);
  }
  return undefined;
};

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

type FetchCall = { url: string; init: RequestInit | undefined };

const createAvatarProvisioner = async (
  responder: (call: FetchCall) => Response | Promise<Response>,
): Promise<{
  provisioner: DockerComposeBundledMatrixProvisioner;
  calls: FetchCall[];
  cleanup: () => Promise<void>;
}> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-avatar-test-"));
  const paths: SovereignPaths = {
    configPath: join(tempRoot, "etc", "sovereign-node.json5"),
    secretsDir: join(tempRoot, "etc", "secrets"),
    stateDir: join(tempRoot, "state"),
    logsDir: join(tempRoot, "logs"),
    installJobsDir: join(tempRoot, "install-jobs"),
    openclawServiceHome: join(tempRoot, "openclaw-home"),
    provenancePath: join(tempRoot, "install-provenance.json"),
    backupsDir: join(tempRoot, "backups"),
  };
  const execRunner: ExecRunner = {
    run: async (input): Promise<ExecResult> => ({
      command: [input.command, ...(input.args ?? [])].join(" "),
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
  };
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return await Promise.resolve(responder({ url, init }));
  };
  const provisioner = new DockerComposeBundledMatrixProvisioner(
    execRunner,
    createLogger(),
    paths,
    fetchImpl,
  );
  return {
    provisioner,
    calls,
    cleanup: async () => await rm(tempRoot, { recursive: true, force: true }),
  };
};

describe("DockerComposeBundledMatrixProvisioner.uploadMedia", () => {
  it("uploads the payload and returns the mxc content uri", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({ content_uri: "mxc://example/abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      const data = new Uint8Array([1, 2, 3, 4]);
      const result = await provisioner.uploadMedia({
        baseUrl: "http://matrix.local.test:8008",
        accessToken: "token-123",
        fileName: "avatar.png",
        contentType: "image/png",
        data,
      });
      expect(result.contentUri).toBe("mxc://example/abc");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "http://matrix.local.test:8008/_matrix/media/v3/upload?filename=avatar.png",
      );
      const init = calls[0]?.init;
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-123");
      expect(headers["Content-Type"]).toBe("image/png");
      expect(init?.body).toBe(data);
    } finally {
      await cleanup();
    }
  });

  it("throws MATRIX_MEDIA_UPLOAD_FAILED on a non-2xx response", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({ errcode: "M_LIMIT_EXCEEDED" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await expect(
        provisioner.uploadMedia({
          baseUrl: "http://matrix.local.test:8008",
          accessToken: "token",
          fileName: "a.png",
          contentType: "image/png",
          data: new Uint8Array([0]),
        }),
      ).rejects.toMatchObject({
        code: "MATRIX_MEDIA_UPLOAD_FAILED",
        retryable: true,
        details: expect.objectContaining({ status: 429 }),
      });
    } finally {
      await cleanup();
    }
  });

  it("throws MATRIX_MEDIA_UPLOAD_FAILED when the server returns no content_uri", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await expect(
        provisioner.uploadMedia({
          baseUrl: "http://matrix.local.test:8008",
          accessToken: "token",
          fileName: "a.png",
          contentType: "image/png",
          data: new Uint8Array([0]),
        }),
      ).rejects.toMatchObject({ code: "MATRIX_MEDIA_UPLOAD_FAILED" });
    } finally {
      await cleanup();
    }
  });

  it("throws MATRIX_MEDIA_UPLOAD_FAILED when content_uri is not an mxc uri", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({ content_uri: "https://example/x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await expect(
        provisioner.uploadMedia({
          baseUrl: "http://matrix.local.test:8008",
          accessToken: "token",
          fileName: "a.png",
          contentType: "image/png",
          data: new Uint8Array([0]),
        }),
      ).rejects.toMatchObject({ code: "MATRIX_MEDIA_UPLOAD_FAILED" });
    } finally {
      await cleanup();
    }
  });

  it("throws MATRIX_MEDIA_UPLOAD_FAILED when fetch rejects", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      throw new Error("network down");
    });
    try {
      await expect(
        provisioner.uploadMedia({
          baseUrl: "http://matrix.local.test:8008",
          accessToken: "token",
          fileName: "a.png",
          contentType: "image/png",
          data: new Uint8Array([0]),
        }),
      ).rejects.toMatchObject({ code: "MATRIX_MEDIA_UPLOAD_FAILED" });
    } finally {
      await cleanup();
    }
  });
});

describe("DockerComposeBundledMatrixProvisioner.setUserAvatar", () => {
  it("PUTs the avatar_url to the profile endpoint", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(() => {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
      await provisioner.setUserAvatar({
        baseUrl: "http://matrix.local.test:8008",
        userId: "@bot:matrix.local.test",
        accessToken: "bot-token",
        contentUri: "mxc://example/bot",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "http://matrix.local.test:8008/_matrix/client/v3/profile/%40bot%3Amatrix.local.test/avatar_url",
      );
      expect(calls[0]?.init?.method).toBe("PUT");
      expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
        avatar_url: "mxc://example/bot",
      });
    } finally {
      await cleanup();
    }
  });

  it("throws MATRIX_USER_AVATAR_FAILED on a non-2xx response", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({ errcode: "M_FORBIDDEN" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await expect(
        provisioner.setUserAvatar({
          baseUrl: "http://matrix.local.test:8008",
          userId: "@bot:matrix.local.test",
          accessToken: "t",
          contentUri: "mxc://e/b",
        }),
      ).rejects.toMatchObject({
        code: "MATRIX_USER_AVATAR_FAILED",
        details: expect.objectContaining({ status: 403 }),
      });
    } finally {
      await cleanup();
    }
  });

  it("throws MATRIX_USER_AVATAR_FAILED when fetch rejects", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      throw new Error("boom");
    });
    try {
      await expect(
        provisioner.setUserAvatar({
          baseUrl: "http://matrix.local.test:8008",
          userId: "@bot:matrix.local.test",
          accessToken: "t",
          contentUri: "mxc://e/b",
        }),
      ).rejects.toMatchObject({ code: "MATRIX_USER_AVATAR_FAILED" });
    } finally {
      await cleanup();
    }
  });
});

describe("DockerComposeBundledMatrixProvisioner.tryApplyAlertRoomAvatar", () => {
  type AvatarAsset = {
    path: string;
    data: Uint8Array;
    sha256: string;
    contentType: string;
    fileName: string;
  };
  type TryApplyInput = {
    provision: { adminBaseUrl: string; projectDir: string };
    roomId: string;
    operatorAccessToken: string;
    avatarResolver: { resolveAlertRoomAvatar: () => Promise<AvatarAsset | null> } | undefined;
    previousAvatarSha256: string | undefined;
  };
  type WithPrivate = {
    tryApplyAlertRoomAvatar: (input: TryApplyInput) => Promise<string | undefined>;
  };

  const callPrivate = (
    provisioner: DockerComposeBundledMatrixProvisioner,
    input: TryApplyInput,
  ): Promise<string | undefined> => {
    return (provisioner as unknown as WithPrivate).tryApplyAlertRoomAvatar(input);
  };

  const provision = {
    adminBaseUrl: "http://matrix.local.test:8008",
    projectDir: "/tmp/proj",
  };

  it("returns the previous sha when no resolver is provided", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(
      () => new Response("{}", { status: 200 }),
    );
    try {
      const result = await callPrivate(provisioner, {
        provision,
        roomId: "!abc:matrix.local.test",
        operatorAccessToken: "op",
        avatarResolver: undefined,
        previousAvatarSha256: "cafe".repeat(16),
      });
      expect(result).toBe("cafe".repeat(16));
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("returns the previous sha when no avatar file exists on disk", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(
      () => new Response("{}", { status: 200 }),
    );
    try {
      const result = await callPrivate(provisioner, {
        provision,
        roomId: "!abc:matrix.local.test",
        operatorAccessToken: "op",
        avatarResolver: { resolveAlertRoomAvatar: async () => null },
        previousAvatarSha256: "dead".repeat(16),
      });
      expect(result).toBe("dead".repeat(16));
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("short-circuits when the avatar sha matches the persisted sha", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(
      () => new Response("{}", { status: 200 }),
    );
    try {
      const asset: AvatarAsset = {
        path: "/repo/alert-room.png",
        data: new Uint8Array([1]),
        sha256: "beef".repeat(16),
        contentType: "image/png",
        fileName: "alert-room.png",
      };
      const result = await callPrivate(provisioner, {
        provision,
        roomId: "!abc:matrix.local.test",
        operatorAccessToken: "op",
        avatarResolver: { resolveAlertRoomAvatar: async () => asset },
        previousAvatarSha256: "beef".repeat(16),
      });
      expect(result).toBe("beef".repeat(16));
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("uploads the avatar and sets it on the room when the sha differs", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner((call) => {
      if (call.url.includes("/_matrix/media/v3/upload")) {
        return new Response(JSON.stringify({ content_uri: "mxc://example/room-avatar" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url.includes("/state/m.room.avatar")) {
        return new Response(JSON.stringify({ event_id: "$1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    try {
      const asset: AvatarAsset = {
        path: "/repo/alert-room.png",
        data: new Uint8Array([1, 2, 3]),
        sha256: "cafebabe".repeat(8),
        contentType: "image/png",
        fileName: "alert-room.png",
      };
      const result = await callPrivate(provisioner, {
        provision,
        roomId: "!abc:matrix.local.test",
        operatorAccessToken: "op",
        avatarResolver: { resolveAlertRoomAvatar: async () => asset },
        previousAvatarSha256: "feedface".repeat(8),
      });
      expect(result).toBe("cafebabe".repeat(8));
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toContain("/_matrix/media/v3/upload");
      expect(calls[1]?.url).toContain("/state/m.room.avatar");
      expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
        url: "mxc://example/room-avatar",
      });
    } finally {
      await cleanup();
    }
  });

  it("uploads the avatar when no previous sha is persisted", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner((call) => {
      if (call.url.includes("/_matrix/media/v3/upload")) {
        return new Response(JSON.stringify({ content_uri: "mxc://example/x" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    try {
      const asset: AvatarAsset = {
        path: "/repo/alert-room.png",
        data: new Uint8Array([9]),
        sha256: "0".repeat(64),
        contentType: "image/png",
        fileName: "alert-room.png",
      };
      const result = await callPrivate(provisioner, {
        provision,
        roomId: "!abc:matrix.local.test",
        operatorAccessToken: "op",
        avatarResolver: { resolveAlertRoomAvatar: async () => asset },
        previousAvatarSha256: undefined,
      });
      expect(result).toBe("0".repeat(64));
      expect(calls).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("falls back to the previous sha when the resolver throws", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(
      () => new Response("{}", { status: 200 }),
    );
    try {
      const result = await callPrivate(provisioner, {
        provision,
        roomId: "!abc:matrix.local.test",
        operatorAccessToken: "op",
        avatarResolver: {
          resolveAlertRoomAvatar: async () => {
            throw new Error("filesystem offline");
          },
        },
        previousAvatarSha256: "previous-sha",
      });
      expect(result).toBe("previous-sha");
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("falls back to the previous sha when the upload fails", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({ errcode: "M_LIMIT_EXCEEDED" }), { status: 429 });
    });
    try {
      const asset: AvatarAsset = {
        path: "/repo/alert-room.png",
        data: new Uint8Array([5]),
        sha256: "new-sha".padEnd(64, "x"),
        contentType: "image/png",
        fileName: "alert-room.png",
      };
      const result = await callPrivate(provisioner, {
        provision,
        roomId: "!abc:matrix.local.test",
        operatorAccessToken: "op",
        avatarResolver: { resolveAlertRoomAvatar: async () => asset },
        previousAvatarSha256: "old-sha",
      });
      expect(result).toBe("old-sha");
    } finally {
      await cleanup();
    }
  });
});

describe("DockerComposeBundledMatrixProvisioner.tryApplyServiceBotAvatar", () => {
  type AvatarAsset = {
    path: string;
    data: Uint8Array;
    sha256: string;
    contentType: string;
    fileName: string;
  };
  type TryApplyInput = {
    provision: { adminBaseUrl: string; projectDir: string };
    botUserId: string;
    botAccessToken: string;
    avatarResolver: { resolveServiceBotAvatar: () => Promise<AvatarAsset | null> } | undefined;
    previousAvatarSha256: string | undefined;
  };
  type WithPrivate = {
    tryApplyServiceBotAvatar: (input: TryApplyInput) => Promise<string | undefined>;
  };

  const callPrivate = (
    provisioner: DockerComposeBundledMatrixProvisioner,
    input: TryApplyInput,
  ): Promise<string | undefined> => {
    return (provisioner as unknown as WithPrivate).tryApplyServiceBotAvatar(input);
  };

  const provision = {
    adminBaseUrl: "http://matrix.local.test:8008",
    projectDir: "/tmp/proj",
  };

  it("returns the previous sha when no resolver is provided", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(
      () => new Response("{}", { status: 200 }),
    );
    try {
      const result = await callPrivate(provisioner, {
        provision,
        botUserId: "@bot:matrix.local.test",
        botAccessToken: "bot-token",
        avatarResolver: undefined,
        previousAvatarSha256: "cafe".repeat(16),
      });
      expect(result).toBe("cafe".repeat(16));
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("returns the previous sha when no service-bot avatar is on disk", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(
      () => new Response("{}", { status: 200 }),
    );
    try {
      const result = await callPrivate(provisioner, {
        provision,
        botUserId: "@bot:matrix.local.test",
        botAccessToken: "bot-token",
        avatarResolver: { resolveServiceBotAvatar: async () => null },
        previousAvatarSha256: "dead".repeat(16),
      });
      expect(result).toBe("dead".repeat(16));
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("short-circuits when the avatar sha matches the persisted sha", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(
      () => new Response("{}", { status: 200 }),
    );
    try {
      const asset: AvatarAsset = {
        path: "/repo/service-bot.png",
        data: new Uint8Array([1]),
        sha256: "beef".repeat(16),
        contentType: "image/png",
        fileName: "service-bot.png",
      };
      const result = await callPrivate(provisioner, {
        provision,
        botUserId: "@bot:matrix.local.test",
        botAccessToken: "bot-token",
        avatarResolver: { resolveServiceBotAvatar: async () => asset },
        previousAvatarSha256: "beef".repeat(16),
      });
      expect(result).toBe("beef".repeat(16));
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("uploads the avatar and sets it on the user when the sha differs", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner((call) => {
      if (call.url.includes("/_matrix/media/v3/upload")) {
        return new Response(JSON.stringify({ content_uri: "mxc://example/bot-avatar" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url.includes("/profile/") && call.url.includes("/avatar_url")) {
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    try {
      const asset: AvatarAsset = {
        path: "/repo/service-bot.png",
        data: new Uint8Array([1, 2, 3]),
        sha256: "cafebabe".repeat(8),
        contentType: "image/png",
        fileName: "service-bot.png",
      };
      const result = await callPrivate(provisioner, {
        provision,
        botUserId: "@bot:matrix.local.test",
        botAccessToken: "bot-token",
        avatarResolver: { resolveServiceBotAvatar: async () => asset },
        previousAvatarSha256: "feedface".repeat(8),
      });
      expect(result).toBe("cafebabe".repeat(8));
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toContain("/_matrix/media/v3/upload");
      expect(calls[1]?.url).toContain("/profile/%40bot%3Amatrix.local.test/avatar_url");
      expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
        avatar_url: "mxc://example/bot-avatar",
      });
      const uploadHeaders = calls[0]?.init?.headers as Record<string, string>;
      expect(uploadHeaders.Authorization).toBe("Bearer bot-token");
    } finally {
      await cleanup();
    }
  });

  it("uploads when no previous sha is persisted", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner((call) => {
      if (call.url.includes("/_matrix/media/v3/upload")) {
        return new Response(JSON.stringify({ content_uri: "mxc://example/x" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    try {
      const asset: AvatarAsset = {
        path: "/repo/service-bot.png",
        data: new Uint8Array([9]),
        sha256: "0".repeat(64),
        contentType: "image/png",
        fileName: "service-bot.png",
      };
      const result = await callPrivate(provisioner, {
        provision,
        botUserId: "@bot:matrix.local.test",
        botAccessToken: "bot-token",
        avatarResolver: { resolveServiceBotAvatar: async () => asset },
        previousAvatarSha256: undefined,
      });
      expect(result).toBe("0".repeat(64));
      expect(calls).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("falls back to the previous sha when the resolver throws", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(
      () => new Response("{}", { status: 200 }),
    );
    try {
      const result = await callPrivate(provisioner, {
        provision,
        botUserId: "@bot:matrix.local.test",
        botAccessToken: "bot-token",
        avatarResolver: {
          resolveServiceBotAvatar: async () => {
            throw new Error("fs offline");
          },
        },
        previousAvatarSha256: "previous-sha",
      });
      expect(result).toBe("previous-sha");
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("falls back to the previous sha when the upload fails", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({ errcode: "M_LIMIT_EXCEEDED" }), { status: 429 });
    });
    try {
      const asset: AvatarAsset = {
        path: "/repo/service-bot.png",
        data: new Uint8Array([5]),
        sha256: "new-sha".padEnd(64, "x"),
        contentType: "image/png",
        fileName: "service-bot.png",
      };
      const result = await callPrivate(provisioner, {
        provision,
        botUserId: "@bot:matrix.local.test",
        botAccessToken: "bot-token",
        avatarResolver: { resolveServiceBotAvatar: async () => asset },
        previousAvatarSha256: "old-sha",
      });
      expect(result).toBe("old-sha");
    } finally {
      await cleanup();
    }
  });
});

describe("DockerComposeBundledMatrixProvisioner.setRoomAvatar", () => {
  it("PUTs the state event for m.room.avatar", async () => {
    const { provisioner, calls, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({ event_id: "$1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await provisioner.setRoomAvatar({
        baseUrl: "http://matrix.local.test:8008",
        roomId: "!abc:matrix.local.test",
        accessToken: "op-token",
        contentUri: "mxc://example/room",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "http://matrix.local.test:8008/_matrix/client/v3/rooms/!abc%3Amatrix.local.test/state/m.room.avatar/",
      );
      expect(calls[0]?.init?.method).toBe("PUT");
      expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
        url: "mxc://example/room",
      });
    } finally {
      await cleanup();
    }
  });

  it("throws MATRIX_ROOM_AVATAR_FAILED on a non-2xx response", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      return new Response(JSON.stringify({ errcode: "M_FORBIDDEN" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await expect(
        provisioner.setRoomAvatar({
          baseUrl: "http://matrix.local.test:8008",
          roomId: "!abc:matrix.local.test",
          accessToken: "op",
          contentUri: "mxc://e/r",
        }),
      ).rejects.toMatchObject({
        code: "MATRIX_ROOM_AVATAR_FAILED",
        details: expect.objectContaining({ status: 403 }),
      });
    } finally {
      await cleanup();
    }
  });

  it("throws MATRIX_ROOM_AVATAR_FAILED when fetch rejects", async () => {
    const { provisioner, cleanup } = await createAvatarProvisioner(() => {
      throw new Error("net");
    });
    try {
      await expect(
        provisioner.setRoomAvatar({
          baseUrl: "http://matrix.local.test:8008",
          roomId: "!abc:matrix.local.test",
          accessToken: "op",
          contentUri: "mxc://e/r",
        }),
      ).rejects.toMatchObject({ code: "MATRIX_ROOM_AVATAR_FAILED" });
    } finally {
      await cleanup();
    }
  });
});

describe("DockerComposeBundledMatrixProvisioner onProgress reporting", () => {
  it("emits compose progress notes during bootstrapAccounts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-test-"));
    const recordedNotes: string[] = [];

    const fakeExecRunner: ExecRunner = {
      run: async (input): Promise<ExecResult> => {
        const args = input.args ?? [];
        if (isComposePsCall(input)) {
          return {
            command: [input.command, ...args].join(" "),
            exitCode: 0,
            stdout: composePsRunningJson(),
            stderr: "",
          };
        }
        if (
          input.command === "docker" &&
          (args.includes("config") ||
            args.includes("up") ||
            args.includes("register_new_matrix_user"))
        ) {
          return {
            command: [input.command, ...args].join(" "),
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          };
        }
        return {
          command: [input.command, ...args].join(" "),
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        };
      },
    };

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const readiness = matrixReadinessResponse(url);
      if (readiness !== undefined) {
        return readiness;
      }
      if (url.endsWith("/_matrix/client/v3/login")) {
        const payload = parseBody(init?.body);
        const localpart = readLoginLocalpart(payload) ?? "unknown";
        return jsonResponse({
          access_token: `token-${localpart}`,
          user_id: `@${localpart}:matrix.local.test`,
        });
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
      await provisioner.bootstrapAccounts(req, provision, {
        onProgress: (note) => {
          recordedNotes.push(note);
        },
      });

      expect(recordedNotes).toContain("Starting bundled Matrix containers (docker compose up)");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("DockerComposeBundledMatrixProvisioner cross-project conflict handling", () => {
  // Records the docker compose subcommands the provisioner issues so tests can
  // assert it never takes down a foreign project.
  type ConflictHarness = {
    provisioner: DockerComposeBundledMatrixProvisioner;
    composeSubcommands: string[];
    cleanup: () => Promise<void>;
  };

  const buildHarness = async (input: {
    // A single ps payload, or one payload per successive `compose ps` call.
    psStdout: string | string[];
    psThrows?: boolean;
    upStderr?: string;
    upExitCode?: number;
    portOwnerStdout?: string;
    portOwnerExitCode?: number;
    // `docker inspect --format '{{.State.Error}}' <name>` output (the port-bind
    // failure that compose-up-exit-0 hides in the container's .State.Error).
    containerError?: string;
    serverName?: string;
  }): Promise<ConflictHarness> => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-conflict-test-"));
    const composeSubcommands: string[] = [];
    const psStdouts = Array.isArray(input.psStdout) ? input.psStdout : [input.psStdout];
    let psCallIndex = 0;

    const fakeExecRunner: ExecRunner = {
      run: async (execInput): Promise<ExecResult> => {
        const args = execInput.args ?? [];
        const command = [execInput.command, ...args].join(" ");
        // When ps is unavailable, both the `docker compose ps` and the legacy
        // `docker-compose ps` fallback must throw so runComposeCommand surfaces
        // MATRIX_COMPOSE_UNAVAILABLE and inspectComposeServiceStates hits its catch.
        if (input.psThrows && args.includes("ps") && args.includes("--format")) {
          throw new Error("docker compose ps unavailable");
        }
        if (execInput.command !== "docker") {
          return { command, exitCode: 127, stdout: "", stderr: "command not found" };
        }
        // `docker inspect --format '{{.State.Error}}' <name>` container-error probe.
        if (args.includes("inspect") && args.includes("{{.State.Error}}")) {
          return { command, exitCode: 0, stdout: input.containerError ?? "", stderr: "" };
        }
        // Raw `docker ps --filter publish=...` port-owner lookup (no "compose").
        if (!args.includes("compose") && args.includes("ps") && args.includes("--filter")) {
          return {
            command,
            exitCode: input.portOwnerExitCode ?? 0,
            stdout: input.portOwnerStdout ?? "",
            stderr: "",
          };
        }
        if (isComposePsCall(execInput)) {
          const stdout = psStdouts[Math.min(psCallIndex, psStdouts.length - 1)] ?? "";
          psCallIndex += 1;
          return { command, exitCode: 0, stdout, stderr: "" };
        }
        if (args.includes("config")) {
          return { command, exitCode: 0, stdout: "services:\n  synapse: {}\n", stderr: "" };
        }
        if (args.includes("up")) {
          composeSubcommands.push("up");
          return {
            command,
            exitCode: input.upExitCode ?? 0,
            stdout: "",
            stderr: input.upStderr ?? "",
          };
        }
        if (args.includes("down")) {
          composeSubcommands.push("down");
          return { command, exitCode: 0, stdout: "", stderr: "" };
        }
        return { command, exitCode: 0, stdout: "ok", stderr: "" };
      },
    };

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const readiness = matrixReadinessResponse(url, input.serverName);
      if (readiness !== undefined) {
        return readiness;
      }
      if (url.endsWith("/_matrix/client/v3/login")) {
        const localpart = readLoginLocalpart(parseBody(init?.body)) ?? "unknown";
        return jsonResponse({
          access_token: `token-${localpart}`,
          user_id: `@${localpart}:matrix.local.test`,
        });
      }
      if (url.endsWith("/_matrix/client/v3/createRoom")) {
        return jsonResponse({ room_id: "!alerts:matrix.local.test" });
      }
      return jsonResponse({});
    };

    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      buildPaths(tempRoot),
      fakeFetch,
    );

    return {
      provisioner,
      composeSubcommands,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  };

  it("does not treat a created-but-not-running Synapse as a successful start", async () => {
    // compose up exits 0, but ps shows synapse stuck in `created` (no port conflict),
    // so the local down/up retry runs; it stays created → MATRIX_STACK_START_FAILED.
    const harness = await buildHarness({
      psStdout: [
        JSON.stringify({ Service: "postgres", State: "running", Status: "Up" }),
        JSON.stringify({ Service: "synapse", State: "created", Status: "Created" }),
      ].join("\n"),
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "MATRIX_STACK_START_FAILED",
      });
      // The created service must NOT have been accepted as running.
      expect(harness.composeSubcommands).toContain("down");
    } finally {
      await harness.cleanup();
    }
  });

  it("bails with BUNDLED_MATRIX_PORT_CONFLICT naming the foreign project and fix command", async () => {
    const harness = await buildHarness({
      upExitCode: 1,
      upStderr:
        "Error response from daemon: failed to set up container networking: " +
        "Bind for 127.0.0.1:8008 failed: port is already allocated",
      psStdout: JSON.stringify({
        Service: "synapse",
        State: "created",
        Status: "Created",
      }),
      portOwnerStdout: "pipi2-sovereign-ai-node-com-synapse-1\tpipi2-sovereign-ai-node-com\n",
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "BUNDLED_MATRIX_PORT_CONFLICT",
        retryable: false,
        details: {
          conflictingContainer: "pipi2-sovereign-ai-node-com-synapse-1",
          conflictingProject: "pipi2-sovereign-ai-node-com",
          suggestedFix: "docker compose -p pipi2-sovereign-ai-node-com down",
        },
      });
      // Critically: we must never take the foreign project down ourselves.
      expect(harness.composeSubcommands).not.toContain("down");
    } finally {
      await harness.cleanup();
    }
  });

  it("detects the conflict from container .State.Error when compose up exits 0 (issue #179 shape)", async () => {
    // The exact field bug: `docker compose up -d` exits 0, but synapse is stuck in
    // `created` and the "port is already allocated" message lives ONLY in the
    // container's .State.Error — not in compose stdout/stderr or the ps status.
    // Without inspecting .State.Error this fell through to MATRIX_STACK_START_FAILED.
    const createdSynapse = [
      JSON.stringify({
        Service: "postgres",
        State: "running",
        Status: "Up",
        Name: "ci-postgres-1",
      }),
      JSON.stringify({
        Service: "synapse",
        State: "created",
        Status: "Created",
        Name: "ci-synapse-1",
      }),
    ].join("\n");
    const harness = await buildHarness({
      upExitCode: 0, // compose up "succeeded" — the trap
      upStderr: "",
      psStdout: createdSynapse,
      containerError:
        "driver failed programming external connectivity on endpoint ci-synapse-1: " +
        "Bind for 127.0.0.1:8008 failed: port is already allocated",
      portOwnerStdout: "pipi2-sovereign-ai-node-com-synapse-1\tpipi2-sovereign-ai-node-com\n",
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "BUNDLED_MATRIX_PORT_CONFLICT",
        retryable: false,
        details: {
          conflictingContainer: "pipi2-sovereign-ai-node-com-synapse-1",
          conflictingProject: "pipi2-sovereign-ai-node-com",
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to docker rm fix when the conflicting container has no compose project", async () => {
    const harness = await buildHarness({
      upExitCode: 1,
      upStderr: "Bind for 127.0.0.1:8008 failed: port is already allocated",
      psStdout: JSON.stringify({ Service: "synapse", State: "created", Status: "Created" }),
      // Container with an empty compose-project label.
      portOwnerStdout: "rogue-synapse\t\n",
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "BUNDLED_MATRIX_PORT_CONFLICT",
        details: {
          conflictingContainer: "rogue-synapse",
          suggestedFix: "docker rm -f rogue-synapse",
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("still reports a port conflict when the owning container cannot be identified", async () => {
    const harness = await buildHarness({
      upExitCode: 1,
      upStderr: "Bind for 127.0.0.1:8008 failed: port is already allocated",
      psStdout: JSON.stringify({ Service: "synapse", State: "created", Status: "Created" }),
      portOwnerStdout: "", // docker ps returns nothing
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "BUNDLED_MATRIX_PORT_CONFLICT",
        message: expect.stringContaining("another container"),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects with MATRIX_FOREIGN_SYNAPSE_ON_PORT when the responding server_name differs", async () => {
    // Stack starts cleanly, readiness passes, but the Synapse on the port belongs
    // to a different homeserver domain than the one we provisioned.
    const harness = await buildHarness({
      psStdout: composePsRunningJson(["postgres", "synapse", "reverse-proxy"]),
      serverName: "pipi2.sovereign-ai-node.com",
    });
    try {
      const req = buildInstallRequest();
      req.matrix.tlsMode = "internal";
      req.matrix.publicBaseUrl = "https://matrix.local.test:8448";
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "MATRIX_FOREIGN_SYNAPSE_ON_PORT",
        retryable: false,
        details: {
          expectedServerName: "matrix.local.test",
          actualServerName: "pipi2.sovereign-ai-node.com",
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects when the responding server omits its server_name entirely", async () => {
    // `/_matrix/key/v2/server` answers but without a usable server_name string.
    const harness = await buildHarness({
      psStdout: composePsRunningJson(["postgres", "synapse", "reverse-proxy"]),
      serverName: "", // → server_name: "" → treated as unidentifiable
    });
    try {
      const req = buildInstallRequest();
      req.matrix.tlsMode = "internal";
      req.matrix.publicBaseUrl = "https://matrix.local.test:8448";
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "MATRIX_FOREIGN_SYNAPSE_ON_PORT",
        message: expect.stringContaining("got 'unknown'"),
        details: { actualServerName: "" },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("proceeds when the responding server_name matches the provisioned domain", async () => {
    const harness = await buildHarness({
      psStdout: composePsRunningJson(["postgres", "synapse"]),
      serverName: "matrix.local.test",
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      const accounts = await harness.provisioner.bootstrapAccounts(req, provision);
      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
    } finally {
      await harness.cleanup();
    }
  });

  it("recovers when the first start is partial but the down/up retry brings services up", async () => {
    // 1st ps: synapse created (partial). 2nd ps (after down/up): all running.
    const harness = await buildHarness({
      psStdout: [
        [
          JSON.stringify({ Service: "postgres", State: "running", Status: "Up" }),
          JSON.stringify({ Service: "synapse", State: "created", Status: "Created" }),
        ].join("\n"),
        composePsRunningJson(["postgres", "synapse"]),
      ],
      serverName: "matrix.local.test",
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      const accounts = await harness.provisioner.bootstrapAccounts(req, provision);
      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
      // The recovery down/up retry must have run.
      expect(harness.composeSubcommands).toContain("down");
      expect(harness.composeSubcommands.filter((c) => c === "up")).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("treats containers as not-running when `compose ps` itself fails", async () => {
    // ps throws on every call → inspection yields no running services → the start
    // is never accepted and the flow ultimately fails (no port conflict here).
    const harness = await buildHarness({
      psStdout: "",
      psThrows: true,
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "MATRIX_STACK_START_FAILED",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("reports a port conflict even when the docker ps owner lookup fails", async () => {
    const harness = await buildHarness({
      upExitCode: 1,
      upStderr: "Bind for 127.0.0.1:8008 failed: port is already allocated",
      psStdout: JSON.stringify({ Service: "synapse", State: "created", Status: "Created" }),
      portOwnerExitCode: 1, // docker ps lookup errors out
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "BUNDLED_MATRIX_PORT_CONFLICT",
        message: expect.stringContaining("another container"),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("recognizes a generic 'address already in use' as a port conflict", async () => {
    const harness = await buildHarness({
      upExitCode: 1,
      // Generalized port-conflict phrasing (not the docker-proxy specific message).
      upStderr: "listen tcp 127.0.0.1:8008: bind: address already in use",
      psStdout: JSON.stringify({ Service: "synapse", State: "created", Status: "Created" }),
      portOwnerStdout: "rogue-synapse\n",
    });
    try {
      const req = buildInstallRequest();
      const provision = await harness.provisioner.provision(req);
      await expect(harness.provisioner.bootstrapAccounts(req, provision)).rejects.toMatchObject({
        code: "BUNDLED_MATRIX_PORT_CONFLICT",
        details: {
          conflictingContainer: "rogue-synapse",
          conflictingProject: "",
          suggestedFix: "docker rm -f rogue-synapse",
        },
      });
    } finally {
      await harness.cleanup();
    }
  });
});

describe("compose ps JSON parsing", () => {
  // Drive ensureStackRunning with a scripted sequence of `compose ps` payloads so
  // each `parseComposePsJson` shape (array, NDJSON-with-blanks, empty) is exercised.
  const runWithPsSequence = async (psStdoutByCall: string[]): Promise<void> => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-psjson-test-"));
    let psCallIndex = 0;
    const fakeExecRunner: ExecRunner = {
      run: async (execInput): Promise<ExecResult> => {
        const args = execInput.args ?? [];
        const command = [execInput.command, ...args].join(" ");
        if (execInput.command !== "docker") {
          return { command, exitCode: 127, stdout: "", stderr: "" };
        }
        if (isComposePsCall(execInput)) {
          const stdout = psStdoutByCall[Math.min(psCallIndex, psStdoutByCall.length - 1)] ?? "";
          psCallIndex += 1;
          return { command, exitCode: 0, stdout, stderr: "" };
        }
        if (args.includes("config")) {
          return { command, exitCode: 0, stdout: "services:\n  synapse: {}\n", stderr: "" };
        }
        return { command, exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const readiness = matrixReadinessResponse(url);
      if (readiness !== undefined) {
        return readiness;
      }
      if (url.endsWith("/_matrix/client/v3/login")) {
        const localpart = readLoginLocalpart(parseBody(init?.body)) ?? "unknown";
        return jsonResponse({
          access_token: `token-${localpart}`,
          user_id: `@${localpart}:matrix.local.test`,
        });
      }
      return jsonResponse({});
    };
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      fakeExecRunner,
      createLogger(),
      buildPaths(tempRoot),
      fakeFetch,
    );
    try {
      const req = buildInstallRequest();
      const provision = await provisioner.provision(req);
      const accounts = await provisioner.bootstrapAccounts(req, provision);
      expect(accounts.operator.userId).toBe("@operator:matrix.local.test");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  };

  it("accepts the JSON-array form and tolerates junk / Name-only / exit-code entries", async () => {
    await runWithPsSequence([
      JSON.stringify([
        // Junk array element (not an object) — skipped.
        null,
        // Entry identified by `Name` instead of `Service`, carrying an exit code.
        { Name: "matrix-extra", State: "exited", Status: "Exited (0)", ExitCode: 0 },
        // Entry with neither Service nor Name — skipped.
        { State: "running" },
        // Extra service with no State/Status fields → normalized to "unknown"/"".
        { Service: "extra-sidecar" },
        { Service: "postgres", State: "running", Status: "Up" },
        { Service: "synapse", State: "running", Status: "Up" },
      ]),
    ]);
  });

  it("handles empty output then NDJSON with a blank line on retry", async () => {
    await runWithPsSequence([
      // 1st call: empty output → parsed as no services → not running → retry.
      "",
      // 2nd call (after down/up): NDJSON with a blank line that must be skipped.
      [
        JSON.stringify({ Service: "postgres", State: "running", Status: "Up" }),
        "",
        JSON.stringify({ Service: "synapse", State: "running", Status: "Up" }),
      ].join("\n"),
    ]);
  });
});
