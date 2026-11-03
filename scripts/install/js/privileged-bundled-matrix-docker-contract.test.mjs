// The bundled-matrix-docker helper accepts only the fixed command forms in
// COMPOSE_FORMS, and the node builds its compose argument lists in matrix.ts
// and backup.ts. A list the helper does not know fails only for an
// unprivileged caller, so neither side may change without the other. This
// drives every compose call site through the helper access path and checks
// each list it produces against the helper itself.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { createLogger } from "../../../src/logging/logger.ts";
import { RealBackupService } from "../../../src/system/backup.ts";
import { DockerComposeBundledMatrixProvisioner } from "../../../src/system/matrix.ts";
import { BUNDLED_MATRIX_DOCKER_HELPER_PATH } from "../../../src/system/privileged-helpers.ts";
import { COMPOSE_FORMS, parseRequest, resolveProject } from "./privileged-bundled-matrix-docker.mjs";

const SOURCES = ["src/system/matrix.ts", "src/system/backup.ts"].map((path) =>
  resolve(import.meta.dirname, "../../..", path),
);
const DOMAIN = "matrix.example.org";

// The caller of runComposeCommand, read from the stack of the exec call it
// makes, identifies the call site that produced an argument list.
const composeCallSite = (stack) => {
  const frames = stack.split("\n");
  const index = frames.findIndex((frame) => /\.runComposeCommand \(/.test(frame));
  const caller = index < 0 ? undefined : /\(([^()]+\.ts):(\d+):\d+\)$/.exec(frames[index + 1] ?? "");
  return caller === null || caller === undefined ? undefined : `${caller[1]}:${caller[2]}`;
};

const sourceCallSites = async () => {
  const sites = [];
  for (const path of SOURCES) {
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (line.includes("this.runComposeCommand(")) {
        sites.push(`${path}:${index + 1}`);
      }
    });
  }
  return sites.sort();
};

const installRequest = () => ({
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
  matrix: {
    homeserverDomain: DOMAIN,
    publicBaseUrl: `https://${DOMAIN}`,
    federationEnabled: false,
    tlsMode: "auto",
    alertRoomName: "Sovereign Alerts",
  },
  operator: { username: "operator" },
  advanced: { nonInteractive: true },
});

const jsonResponse = (payload) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const fakeHomeserver = async (url, init) => {
  if (url.endsWith("/_matrix/key/v2/server")) {
    return jsonResponse({ server_name: DOMAIN, valid_until_ts: 0, verify_keys: {} });
  }
  if (url.endsWith("/_matrix/client/v3/login")) {
    const localpart = JSON.parse(String(init?.body)).identifier.user;
    return jsonResponse({ access_token: `token-${localpart}`, user_id: `@${localpart}:${DOMAIN}` });
  }
  return jsonResponse({ versions: ["v1.1"] });
};

const composePs = (state) =>
  ["postgres", "synapse", "reverse-proxy"]
    .map((service) => JSON.stringify({ Service: service, State: state, Status: state }))
    .join("\n");

describe("compose commands the node sends to the bundled-matrix-docker helper", () => {
  let tempRoot;
  const requests = [];
  let projectDir;
  let stateDir;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bundled-matrix-docker-contract-"));
    stateDir = join(tempRoot, "state");
    const paths = {
      configPath: join(tempRoot, "etc", "sovereign-node.json5"),
      secretsDir: join(tempRoot, "etc", "secrets"),
      stateDir,
      logsDir: join(tempRoot, "logs"),
      installJobsDir: join(tempRoot, "install-jobs"),
      openclawServiceHome: join(tempRoot, "openclaw-home"),
      provenancePath: join(tempRoot, "install-provenance.json"),
      backupsDir: join(tempRoot, "backups"),
    };
    let nextPsState = "running";
    const execRunner = {
      run: async ({ command, args = [] }) => {
        if (command === "sudo" && args[1] === BUNDLED_MATRIX_DOCKER_HELPER_PATH) {
          requests.push({ argv: args.slice(2), site: composeCallSite(new Error().stack ?? "") });
        }
        let stdout = "";
        if (args.includes("--format") && args.includes("json")) {
          stdout = composePs(nextPsState);
          nextPsState = "running";
        }
        return { command: [command, ...args].join(" "), exitCode: 0, stdout, stderr: "" };
      },
    };
    const matrix = new DockerComposeBundledMatrixProvisioner(
      execRunner,
      createLogger(),
      paths,
      fakeHomeserver,
      undefined,
      () => "helper",
    );

    const request = installRequest();
    const provision = await matrix.provision(request);
    projectDir = provision.projectDir;
    await matrix.bootstrapAccounts(request, provision);

    // A first start that leaves the containers in `created` takes the
    // tear-down-and-retry path.
    nextPsState = "created";
    await matrix.ensureStackRunning(provision);
    await matrix.collectComposeDiagnostics(provision);
    await matrix.collectContainerErrors(projectDir, [
      { service: "synapse", state: "created", name: `${basename(projectDir)}-synapse-1` },
    ]);
    await matrix.findHostPortOwner(projectDir, 8008);
    await matrix.resetState(provision);
    for (const federationEnabled of [true, false]) {
      await matrix.updateFederationConfig({
        federationEnabled,
        projectDir,
        composeFilePath: provision.composeFilePath,
        accessMode: "direct",
        homeserverDomain: DOMAIN,
        publicBaseUrl: `https://${DOMAIN}`,
      });
    }

    const backup = new RealBackupService(execRunner, createLogger(), paths, () => "helper");
    const stagingDir = join(tempRoot, "staging");
    const extractDir = join(tempRoot, "extract");
    await mkdir(stagingDir, { recursive: true });
    await mkdir(extractDir, { recursive: true });
    await writeFile(join(extractDir, "pg_dump.sql"), "SELECT 1;\n");
    await backup.collectPgDump(stagingDir, projectDir, []);
    await backup.stopServices(projectDir, []);
    await backup.restorePostgres(
      extractDir,
      projectDir,
      { items: [{ key: "postgres_dump", relativePath: "pg_dump.sql", optional: false }] },
      [],
    );
    await backup.startMatrixStack(projectDir, []);
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("exercises every compose call site in matrix.ts and backup.ts", async () => {
    const reached = [...new Set(requests.map((request) => request.site).filter(Boolean))].sort();
    expect(reached).toEqual(await sourceCallSites());
  });

  it("sends only argument lists the helper accepts", () => {
    expect(requests.length).toBeGreaterThan(0);
    const refused = [];
    for (const { argv } of requests) {
      try {
        parseRequest(argv);
      } catch (error) {
        refused.push(`${argv.slice(1).join(" ")}: ${error.message}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it("names only services the rendered compose project defines", async () => {
    const compose = parseYaml(await readFile(join(projectDir, "compose.yaml"), "utf8"));
    const defined = Object.keys(compose.services);
    for (const { argv } of requests) {
      const request = parseRequest(argv);
      for (const service of request.form?.services?.(request.args) ?? []) {
        expect(defined).toContain(service);
      }
    }
  });

  it("targets a project directory the helper resolves", () => {
    for (const { argv } of requests) {
      expect(resolveProject(argv[0], { stateDir })).toMatchObject({ projectDir: argv[0] });
    }
  });

  it("uses every helper form, so the helper accepts nothing the node never sends", () => {
    const used = new Set(
      requests.map(({ argv }) => {
        const request = parseRequest(argv);
        return request.kind === "compose" ? request.form.id : request.kind;
      }),
    );
    expect([...used].sort()).toEqual(
      [...COMPOSE_FORMS.map((form) => form.id), "inspect", "ps"].sort(),
    );
  });
});
