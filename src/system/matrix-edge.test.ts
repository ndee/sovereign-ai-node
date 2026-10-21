import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import type { SovereignPaths } from "../config/paths.js";
import type { InstallRequest } from "../contracts/index.js";
import { createLogger } from "../logging/logger.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import { DockerComposeBundledMatrixProvisioner } from "./matrix.js";

type EdgeVariant = "internal" | "auto" | "relay" | "relay-passthrough";

const EDGE_VARIANTS: EdgeVariant[] = ["internal", "auto", "relay", "relay-passthrough"];
const POLICY_BEGIN = "  # BEGIN matrix edge policy";
const POLICY_END = "  # END matrix edge policy";

const buildRequest = (variant: EdgeVariant, federationEnabled: boolean): InstallRequest => {
  const relayed = variant === "relay" || variant === "relay-passthrough";
  const domain = relayed ? "node-abc.relay.example.com" : "matrix.example.org";
  return {
    mode: "bundled_matrix",
    openclaw: {
      manageInstallation: true,
      installMethod: "install_sh",
      version: "pinned-by-sovereign",
      skipIfCompatibleInstalled: true,
      forceReinstall: false,
      runOnboard: false,
    },
    openrouter: { model: "qwen/qwen-2.5-7b-instruct", apiKey: "sk-or-test" },
    imap: {
      host: "imap.example.org",
      port: 993,
      tls: true,
      username: "operator@example.org",
      secretRef: "file:/tmp/imap-secret",
      mailbox: "INBOX",
    },
    matrix: {
      homeserverDomain: domain,
      publicBaseUrl: `https://${domain}`,
      federationEnabled,
      tlsMode: variant === "internal" ? "internal" : "auto",
      alertRoomName: "Sovereign Alerts",
    },
    operator: { username: "operator" },
    advanced: { nonInteractive: true },
    ...(relayed
      ? {
          connectivity: { mode: "relay" as const },
          relay: {
            controlUrl: "https://relay.example.com",
            enrollmentToken: "relay-token",
            ...(variant === "relay-passthrough"
              ? {
                  dns01: {
                    provider: "desec" as const,
                    apiBase: "https://desec.io/api/v1",
                    zone: "_acme-challenge.relay.example.com",
                    subname: "node-abc",
                    acmeEmail: "ops@example.com",
                    token: "desec-secret-token",
                  },
                }
              : {}),
          },
        }
      : {}),
  };
};

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

const recordingExecRunner = (
  calls: ExecInput[],
  exitCodeFor: (input: ExecInput) => number = () => 0,
): ExecRunner => ({
  run: async (input): Promise<ExecResult> => {
    calls.push(input);
    const command = [input.command, ...(input.args ?? [])].join(" ");
    if (input.command !== "docker") {
      return { command, exitCode: 127, stdout: "", stderr: "command not found" };
    }
    return { command, exitCode: exitCodeFor(input), stdout: "", stderr: "compose said no" };
  },
});

const extractPolicy = (caddyfile: string): string[] => {
  const lines = caddyfile.split("\n");
  const begin = lines.indexOf(POLICY_BEGIN);
  const end = lines.indexOf(POLICY_END);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return lines.slice(begin, end + 1);
};

type Route = { matcher: string | null; target: "synapse" | "refused" | "too-large" | "other" };

// Mirrors Caddy's ordered `handle` evaluation over the rendered path matchers
// (exact paths and trailing-`*` prefixes) so tests can ask where a path goes.
const routePath = (policy: string[], path: string): Route["target"] => {
  const matchers = new Map<string, string[]>();
  for (const line of policy) {
    const match = /^ {2}@(\w+) path (.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      matchers.set(match[1], match[2].split(" "));
    }
  }
  const routes: Route[] = [];
  for (let index = 0; index < policy.length; index += 1) {
    const handle = /^ {2}handle(?: @(\w+))? \{$/.exec(policy[index] ?? "");
    if (handle === null) {
      continue;
    }
    const body: string[] = [];
    for (let inner = index + 1; policy[inner] !== "  }"; inner += 1) {
      body.push(policy[inner] ?? "");
    }
    const target = body.some((line) => line.includes("reverse_proxy synapse:8008"))
      ? "synapse"
      : body.some((line) => / 404$/.test(line))
        ? "refused"
        : body.some((line) => / 413$/.test(line))
          ? "too-large"
          : "other";
    routes.push({ matcher: handle[1] ?? null, target });
  }
  for (const route of routes) {
    if (route.matcher === null) {
      return route.target;
    }
    const patterns = matchers.get(route.matcher);
    if (patterns === undefined) {
      continue;
    }
    const hit = patterns.some((pattern) =>
      pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
    );
    if (hit) {
      return route.target;
    }
  }
  return "other";
};

describe("bundled Matrix edge policy", () => {
  let tempRoot: string;
  let calls: ExecInput[];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-edge-"));
    calls = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const provision = async (
    variant: EdgeVariant,
    federationEnabled: boolean,
  ): Promise<{ caddyfile: string; homeserverYaml: string; projectDir: string }> => {
    const root = join(tempRoot, `${variant}-${federationEnabled}`);
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      recordingExecRunner(calls),
      createLogger(),
      buildPaths(root),
      undefined,
      () => ["10.20.30.40"],
    );
    const result = await provisioner.provision(buildRequest(variant, federationEnabled));
    return {
      caddyfile: await readFile(join(result.projectDir, "reverse-proxy", "Caddyfile"), "utf8"),
      homeserverYaml: await readFile(join(result.projectDir, "synapse", "homeserver.yaml"), "utf8"),
      projectDir: result.projectDir,
    };
  };

  it("renders the same route block in every access and TLS mode", async () => {
    for (const federationEnabled of [false, true]) {
      const policies = await Promise.all(
        EDGE_VARIANTS.map(async (variant) =>
          extractPolicy((await provision(variant, federationEnabled)).caddyfile).join("\n"),
        ),
      );
      for (const policy of policies) {
        expect(policy).toBe(policies[0]);
      }
    }
  });

  it("proxies only the client, media and client-page paths and refuses everything else", async () => {
    const policy = extractPolicy((await provision("relay-passthrough", false)).caddyfile);

    for (const path of [
      "/",
      "/_matrix/client/versions",
      "/_matrix/client/v3/login",
      "/_matrix/client/v3/logout",
      "/_matrix/client/v3/sync",
      "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
      "/_matrix/client/v3/keys/upload",
      "/_matrix/client/v3/room_keys/version",
      "/_matrix/client/v1/auth_metadata",
      "/_matrix/client/unstable/org.matrix.msc2965/auth_issuer",
      "/_matrix/client/v1/media/download/node-abc.relay.example.com/abc",
      "/_matrix/media/v3/upload",
      "/_matrix/media/v3/download/node-abc.relay.example.com/abc",
      "/_matrix/static/",
      "/_synapse/client/new_user_consent",
    ]) {
      expect(routePath(policy, path), path).toBe("synapse");
    }

    for (const path of [
      "/_synapse/admin/v1/server_version",
      "/_synapse/admin/v2/users/@operator:node-abc.relay.example.com",
      "/_synapse/metrics",
      "/_matrix/federation/v1/version",
      "/_matrix/key/v2/server",
      "/_matrix/identity/v2",
      "/health",
      "/robots.txt",
    ]) {
      expect(routePath(policy, path), path).toBe("refused");
    }

    expect(routePath(policy, "/.well-known/matrix/client")).toBe("other");
    expect(routePath(policy, "/onboard")).toBe("other");
    expect(routePath(policy, "/onboard/api/redeem")).toBe("other");
    expect(policy.filter((line) => line.includes("reverse_proxy synapse:8008"))).toHaveLength(1);
    expect(policy.join("\n")).not.toContain("_synapse/admin");
  });

  it("refuses dot segments before any path is matched", async () => {
    const policy = extractPolicy((await provision("auto", true)).caddyfile);
    const guard = policy.indexOf(
      "  @nonCanonicalPath vars_regexp {http.request.uri.path} (^|/)\\.\\.?(/|$)",
    );
    expect(guard).toBeGreaterThan(0);
    expect(policy[guard + 1]).toBe("  handle @nonCanonicalPath {");
    expect(policy.slice(guard + 1).join("\n")).toMatch(
      /^ {2}handle @nonCanonicalPath \{\n.*\n.* 404$/m,
    );
    const firstForwardingHandle = policy.findIndex((line) =>
      /^ {2}handle @(wellKnown|onboard|onboardApi|synapseClient|synapseFederation) \{$/.test(line),
    );
    expect(guard).toBeLessThan(firstForwardingHandle);
  });

  it("serves the federation and server-key paths only while federation is enabled", async () => {
    const off = extractPolicy((await provision("auto", false)).caddyfile);
    const on = extractPolicy((await provision("auto", true)).caddyfile);
    for (const path of ["/_matrix/federation/v1/version", "/_matrix/key/v2/server"]) {
      expect(routePath(off, path), path).toBe("refused");
      expect(routePath(on, path), path).toBe("synapse");
    }
    expect(routePath(on, "/_synapse/admin/v1/server_version")).toBe("refused");
  });

  it("caps request bodies at the edge, with the media cap equal to the upload size", async () => {
    const { caddyfile, homeserverYaml } = await provision("internal", false);
    const policy = extractPolicy(caddyfile).join("\n");
    const mediaRegexp = "^/_matrix/media/[^/]+/upload(/|$)";

    expect(policy).toContain(
      `  @mediaUpload path_regexp ${mediaRegexp}\n  @apiBody not path_regexp ${mediaRegexp}`,
    );
    expect(policy).toContain("  request_body @mediaUpload {\n    max_size 52428800\n  }");
    expect(policy).toContain("  request_body @apiBody {\n    max_size 1048576\n  }");
    expect(policy).toContain(
      '{http.request.header.Content-Length} != "" && int({http.request.header.Content-Length}) > 52428800',
    );
    expect(policy).toContain(
      '{http.request.header.Content-Length} != "" && int({http.request.header.Content-Length}) > 1048576',
    );
    expect(policy).toMatch(/handle @mediaBodyTooLarge \{\n.*\n.*M_TOO_LARGE.* 413\n/);
    expect(policy).toMatch(/handle @apiBodyTooLarge \{\n.*\n.*M_TOO_LARGE.* 413\n/);
    expect(new RegExp(mediaRegexp).test("/_matrix/media/v3/upload")).toBe(true);
    expect(new RegExp(mediaRegexp).test("/_matrix/media/v3/upload/server/media-id")).toBe(true);
    expect(new RegExp(mediaRegexp).test("/_matrix/media/v3/download/server/id")).toBe(false);

    const config = parseYaml(homeserverYaml) as Record<string, unknown>;
    expect(config.max_upload_size).toBe("50M");
    expect(50 * 1024 * 1024).toBe(52428800);
  });

  it("renders finite login limits that leave room for the installer's own logins", async () => {
    const { homeserverYaml } = await provision("auto", false);
    const config = parseYaml(homeserverYaml) as {
      rc_login: Record<"address" | "account" | "failed_attempts", Record<string, number>>;
    };
    for (const bucket of ["address", "account", "failed_attempts"] as const) {
      const limits = config.rc_login[bucket];
      expect(Number.isFinite(limits?.per_second), bucket).toBe(true);
      expect(Number.isFinite(limits?.burst_count), bucket).toBe(true);
      expect(limits?.per_second ?? 0, bucket).toBeLessThan(1);
      expect(limits?.burst_count ?? 0, bucket).toBeLessThanOrEqual(10);
    }
    expect(config.rc_login.failed_attempts).toEqual({ per_second: 0.17, burst_count: 3 });
    // Fresh installs log in at most twice within one second and three times
    // within ten seconds from the same address.
    expect(config.rc_login.address?.burst_count ?? 0).toBeGreaterThanOrEqual(6);
    expect(config.rc_login.account?.burst_count ?? 0).toBeGreaterThanOrEqual(6);
  });

  describe("federation toggle", () => {
    const toggle = async (
      projectDir: string,
      federationEnabled: boolean,
      runner: ExecRunner = recordingExecRunner(calls),
    ): Promise<void> => {
      const provisioner = new DockerComposeBundledMatrixProvisioner(
        runner,
        createLogger(),
        buildPaths(tempRoot),
      );
      await provisioner.updateFederationConfig({
        federationEnabled,
        projectDir,
        composeFilePath: join(projectDir, "compose.yaml"),
        accessMode: "direct",
        homeserverDomain: "matrix.example.org",
        publicBaseUrl: "https://matrix.example.org",
      });
    };

    const composeArgs = (): string[] =>
      calls
        .filter((call) => call.command === "docker")
        .map((call) => (call.args ?? []).slice(5).join(" "));

    it("re-renders the edge policy and recreates the reverse proxy in both directions", async () => {
      const expectedEnabledPolicy = extractPolicy((await provision("internal", true)).caddyfile);
      const { caddyfile, projectDir } = await provision("internal", false);
      const caddyfilePath = join(projectDir, "reverse-proxy", "Caddyfile");
      const header = caddyfile.split(POLICY_BEGIN)[0];
      calls = [];

      await toggle(projectDir, true);
      const enabled = await readFile(caddyfilePath, "utf8");
      expect(enabled.split(POLICY_BEGIN)[0]).toBe(header);
      expect(enabled).toContain("tls internal");
      expect(enabled).toContain("@ca path /downloads/caddy-root-ca.crt");
      expect(routePath(extractPolicy(enabled), "/_matrix/federation/v1/version")).toBe("synapse");
      expect(extractPolicy(enabled)).toEqual(expectedEnabledPolicy);
      expect(composeArgs()).toEqual([
        "restart synapse",
        "up -d --no-deps --force-recreate reverse-proxy",
      ]);

      calls = [];
      await toggle(projectDir, false);
      const disabled = await readFile(caddyfilePath, "utf8");
      expect(disabled).toBe(caddyfile);
      expect(routePath(extractPolicy(disabled), "/_matrix/key/v2/server")).toBe("refused");
      expect(composeArgs()).toEqual([
        "restart synapse",
        "up -d --no-deps --force-recreate reverse-proxy",
      ]);
    });

    it("leaves the reverse proxy alone when the edge policy already matches", async () => {
      const { caddyfile, projectDir } = await provision("auto", true);
      calls = [];
      await toggle(projectDir, true);
      expect(await readFile(join(projectDir, "reverse-proxy", "Caddyfile"), "utf8")).toBe(
        caddyfile,
      );
      expect(composeArgs()).toEqual(["restart synapse"]);
    });

    it("keeps a Caddyfile without an edge policy region unchanged", async () => {
      const { projectDir } = await provision("auto", false);
      const caddyfilePath = join(projectDir, "reverse-proxy", "Caddyfile");
      const legacy = ":80 {\n  handle {\n    reverse_proxy synapse:8008\n  }\n}\n";
      await writeFile(caddyfilePath, legacy, "utf8");
      calls = [];
      await toggle(projectDir, true);
      expect(await readFile(caddyfilePath, "utf8")).toBe(legacy);
      expect(composeArgs()).toEqual(["restart synapse"]);
    });

    it("fails when the reverse proxy cannot be recreated", async () => {
      const { projectDir } = await provision("auto", false);
      const runner = recordingExecRunner(calls, (input) =>
        (input.args ?? []).includes("reverse-proxy") ? 1 : 0,
      );
      await expect(toggle(projectDir, true, runner)).rejects.toMatchObject({
        code: "MATRIX_EDGE_RELOAD_FAILED",
        retryable: true,
        details: { exitCode: 1, stderr: "compose said no" },
      });
    });
  });
});

describe("bundled Matrix bootstrap login rate limits", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-matrix-login-"));
    await mkdir(tempRoot, { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempRoot, { recursive: true, force: true });
  });

  type LoginUser = (
    baseUrl: string,
    localpart: string,
    password: string,
  ) => Promise<{ accessToken: string; userId: string }>;

  const buildLoginUser = (responses: Response[], fetched: string[]): LoginUser => {
    const provisioner = new DockerComposeBundledMatrixProvisioner(
      recordingExecRunner([]),
      createLogger(),
      buildPaths(tempRoot),
      async (url: string) => {
        fetched.push(url);
        const next = responses.shift();
        if (next === undefined) {
          throw new Error("unexpected login request");
        }
        return next;
      },
    );
    const loginUser = (provisioner as unknown as { loginUser: LoginUser }).loginUser;
    return loginUser.bind(provisioner);
  };

  const rateLimited = (retryAfterMs: number): Response =>
    new Response(
      JSON.stringify({
        errcode: "M_LIMIT_EXCEEDED",
        error: "Too Many Requests",
        retry_after_ms: retryAfterMs,
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );

  it("waits out a retry-after longer than ten seconds", async () => {
    vi.useFakeTimers();
    const fetched: string[] = [];
    const loginUser = buildLoginUser(
      [
        rateLimited(25_000),
        new Response(JSON.stringify({ access_token: "tok", user_id: "@operator:m.test" }), {
          status: 200,
        }),
      ],
      fetched,
    );
    const pending = loginUser("http://127.0.0.1:8008", "operator", "pw");
    await vi.advanceTimersByTimeAsync(24_000);
    expect(fetched).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ accessToken: "tok", userId: "@operator:m.test" });
    expect(fetched).toHaveLength(2);
  });

  it("gives up at once when the retry-after exceeds the remaining wait budget", async () => {
    const fetched: string[] = [];
    const loginUser = buildLoginUser([rateLimited(3_600_000)], fetched);
    await expect(loginUser("http://127.0.0.1:8008", "operator", "pw")).rejects.toMatchObject({
      code: "MATRIX_LOGIN_FAILED",
      details: { status: 429 },
    });
    expect(fetched).toHaveLength(1);
  });
});
