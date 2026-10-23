import { describe, expect, it } from "vitest";

import {
  ALLOWED_IMAGE_REPOSITORIES,
  COMPOSE_FORMS,
  CONTAINER_ERROR_FORMAT,
  imageRepository,
  parseRequest,
  PORT_OWNER_FORMAT,
  resolveComposeModel,
  resolveProject,
  runBundledMatrixDocker,
  validateComposeModel,
} from "./privileged-bundled-matrix-docker.mjs";

const identity = {
  serviceUser: "sovereign-node",
  serviceGroup: "sovereign-node",
  serviceUid: 998,
  serviceGid: 997,
  stateDir: "/var/lib/sovereign-node",
  configDir: "/etc/sovereign-node",
  appDir: "/opt/sovereign-ai-node/app",
};
const PROJECT = "/var/lib/sovereign-node/bundled-matrix/matrix-example-org";

const dirStat = { isDirectory: () => true, isSymbolicLink: () => false };
const linkStat = { isDirectory: () => false, isSymbolicLink: () => true };
const fileStat = { isDirectory: () => false, isSymbolicLink: () => false };
const missing = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const lstatFrom =
  (overrides = {}) =>
  (path) => {
    const value = overrides[path];
    if (value === "missing") {
      return missing();
    }
    return value ?? dirStat;
  };

// Shaped like `docker compose config --format json` output for the bundled
// stack in relay mode (every service the renderer can emit).
const model = () => ({
  name: "matrix-example-org",
  services: {
    postgres: {
      image: "postgres:16-alpine",
      restart: "unless-stopped",
      environment: { POSTGRES_USER: "synapse" },
      networks: { default: null },
      volumes: [
        {
          type: "bind",
          source: `${PROJECT}/postgres-data`,
          target: "/var/lib/postgresql/data",
          bind: { create_host_path: true },
        },
      ],
    },
    synapse: {
      image: "matrixdotorg/synapse:v1.125.0",
      depends_on: { postgres: { condition: "service_started", required: true } },
      ports: [{ mode: "ingress", host_ip: "127.0.0.1", target: 8008, published: "8008" }],
      healthcheck: { test: ["CMD-SHELL", "true"], interval: "30s" },
      volumes: [{ type: "bind", source: `${PROJECT}/synapse`, target: "/data" }],
    },
    "onboarding-api": {
      image: "node:22-alpine",
      command: ["node", "/srv/sovereign-node-onboarding-api.js"],
      volumes: [
        { type: "bind", source: "/opt/sovereign-ai-node/app/dist", target: "/srv", read_only: true },
        { type: "bind", source: `${PROJECT}/onboarding`, target: "/onboarding" },
        {
          type: "bind",
          source: "/etc/sovereign-node/secrets",
          target: "/etc/sovereign-node/secrets",
          read_only: true,
        },
      ],
    },
    "reverse-proxy": {
      image:
        "ghcr.io/ndee/sovereign-caddy-desec:2.10.2@sha256:370cd93ff12d1c3c691a5eaf64c06458b2c33100c481e0c6e56c0e91fd622bf6",
      volumes: [
        { type: "bind", source: `${PROJECT}/reverse-proxy/Caddyfile`, target: "/etc/caddy/Caddyfile", read_only: true },
        { type: "tmpfs", target: "/tmp" },
      ],
    },
  },
  networks: { default: { name: "matrix-example-org_default" } },
});

const context = {
  projectDir: PROJECT,
  projectName: "matrix-example-org",
  readOnlySources: ["/opt/sovereign-ai-node/app/dist", "/etc/sovereign-node/secrets"],
};

const validate = (value, overrides) =>
  validateComposeModel(value, context, { lstat: lstatFrom(overrides) });

describe("parseRequest", () => {
  it.each([
    [["config"], "config"],
    [["pull", "synapse", "postgres"], "pull"],
    [["pull"], "pull"],
    [["up", "-d"], "up"],
    [["up", "-d", "postgres"], "up"],
    [["up", "-d", "--remove-orphans", "--force-recreate", "synapse"], "recreate"],
    [["down"], "down"],
    [["down", "--remove-orphans"], "down-orphans"],
    [["ps", "-a"], "ps"],
    [["ps", "-a", "--format", "json"], "ps-json"],
    [["logs", "--no-color", "--tail", "200", "synapse"], "logs"],
    [["restart", "synapse"], "restart"],
    [
      [
        "exec",
        "-T",
        "synapse",
        "register_new_matrix_user",
        "-u",
        "operator",
        "--password-file",
        "/dev/stdin",
        "-a",
        "-c",
        "/data/homeserver.yaml",
        "http://127.0.0.1:8008",
      ],
      "register-user",
    ],
    [
      [
        "exec",
        "-T",
        "synapse",
        "register_new_matrix_user",
        "-u",
        "mail-sentinel",
        "--password-file",
        "/dev/stdin",
        "--no-admin",
        "-c",
        "/data/homeserver.yaml",
        "https://matrix.example.org/",
      ],
      "register-user",
    ],
    [["exec", "-T", "postgres", "pg_dump", "-U", "synapse", "synapse"], "pg_dump"],
    [["exec", "-T", "postgres", "dropdb", "-U", "synapse", "--if-exists", "synapse"], "dropdb"],
    [["exec", "-T", "postgres", "createdb", "-U", "synapse", "synapse"], "createdb"],
    [["exec", "-T", "postgres", "psql", "-U", "synapse", "-d", "synapse"], "psql"],
    [["exec", "-T", "postgres", "pg_isready", "-U", "synapse"], "pg_isready"],
  ])("accepts compose %j", (args, id) => {
    const request = parseRequest([PROJECT, "compose", ...args]);
    expect(request).toMatchObject({ projectDir: PROJECT, kind: "compose", args });
    expect(request.form.id).toBe(id);
  });

  it.each([
    [["exec", "-T", "synapse", "sh"]],
    [["exec", "-T", "postgres", "psql", "-U", "postgres"]],
    [["run", "--rm", "synapse"]],
    [["up", "-d", "--build"]],
    [["up", "-d", "../evil"]],
    [["logs", "--no-color", "--tail", "all", "synapse"]],
    [["logs", "--no-color", "--tail", "200", "Bad"]],
    [["restart", "synapse", "postgres"]],
    [["-f", "/tmp/evil.yaml", "up", "-d"]],
    [["cp", "synapse:/data", "/tmp"]],
    [
      [
        "exec",
        "-T",
        "synapse",
        "register_new_matrix_user",
        "-u",
        "Operator!",
        "--password-file",
        "/dev/stdin",
        "-a",
        "-c",
        "/data/homeserver.yaml",
        "http://127.0.0.1:8008",
      ],
    ],
    [
      [
        "exec",
        "-T",
        "synapse",
        "register_new_matrix_user",
        "-u",
        "op",
        "--password-file",
        "/etc/shadow",
        "--admin",
        "-c",
        "/etc/shadow",
        "file:///x",
      ],
    ],
  ])("refuses compose %j", (args) => {
    expect(() => parseRequest([PROJECT, "compose", ...args])).toThrow(/not one of the fixed forms/);
  });

  const registerWith = (secretArgs) => [
    "exec",
    "-T",
    "synapse",
    "register_new_matrix_user",
    "-u",
    "operator",
    ...secretArgs,
    "-a",
    "-c",
    "/data/homeserver.yaml",
    "http://127.0.0.1:8008",
  ];

  it.each([
    [["-p", "planted-secret-value"]],
    [["--password", "planted-secret-value"]],
    [["--password=planted-secret-value"]],
    [["--password-file", "/dev/stdin", "-k", "planted-secret-value"]],
    [["--password-file", "/dev/stdin", "--shared-secret=planted-secret-value"]],
  ])("refuses a secret carried in the arguments %j without echoing it", (secretArgs) => {
    const argv = [PROJECT, "compose", ...registerWith(secretArgs)];
    expect(() => parseRequest(argv)).toThrow(/must be passed on stdin/);
    expect(() => parseRequest(argv)).not.toThrow(/planted-secret-value/);
  });

  it("does not echo arguments that follow an unknown register form", () => {
    expect(() =>
      parseRequest([PROJECT, "compose", "exec", "-T", "synapse", "register_new_matrix_user", "planted-secret-value"]),
    ).toThrow(/^(?![\s\S]*planted-secret-value)[\s\S]*not one of the fixed forms/);
  });

  it("accepts the two read-only docker queries", () => {
    expect(
      parseRequest([PROJECT, "inspect", "--format", CONTAINER_ERROR_FORMAT, "matrix-example-org-synapse-1"]),
    ).toMatchObject({ kind: "inspect", container: "matrix-example-org-synapse-1" });
    expect(
      parseRequest([PROJECT, "ps", "--filter", "publish=8448", "--format", PORT_OWNER_FORMAT]),
    ).toMatchObject({ kind: "ps", args: ["ps", "--filter", "publish=8448", "--format", PORT_OWNER_FORMAT] });
  });

  it.each([
    [[]],
    [[PROJECT]],
    [[PROJECT, "inspect", "--format", "{{json .}}", "matrix-example-org-synapse-1"]],
    [[PROJECT, "inspect", "--format", CONTAINER_ERROR_FORMAT, "../x"]],
    [[PROJECT, "inspect", "x"]],
    [[PROJECT, "ps", "--filter", "publish=99999", "--format", PORT_OWNER_FORMAT]],
    [[PROJECT, "ps", "--filter", "name=x", "--format", PORT_OWNER_FORMAT]],
    [[PROJECT, "ps", "--filter", "publish=80", "--format", "{{json .}}"]],
    [[PROJECT, "ps", "-a"]],
    [[PROJECT, "run", "-v", "/:/host", "alpine"]],
  ])("refuses %j", (argv) => {
    expect(() => parseRequest(argv)).toThrow();
  });

  it("lists every form with a unique id", () => {
    const ids = COMPOSE_FORMS.map((form) => form.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveProject", () => {
  it("accepts a real project directory below the bundled-matrix root", () => {
    expect(resolveProject(PROJECT, identity, { lstat: lstatFrom() })).toEqual({
      projectDir: PROJECT,
      projectName: "matrix-example-org",
    });
  });

  it.each([
    ["/var/lib/sovereign-node/bundled-matrix/../../../etc"],
    ["/var/lib/sovereign-node/other/matrix-example-org"],
    ["/var/lib/sovereign-node/bundled-matrix/a/b"],
    ["/var/lib/sovereign-node/bundled-matrix/Upper"],
    ["relative/bundled-matrix/x"],
  ])("refuses %s", (projectDir) => {
    expect(() => resolveProject(projectDir, identity, { lstat: lstatFrom() })).toThrow(
      /not a bundled Matrix project directory/,
    );
  });

  it.each([
    ["a symlinked project", { [PROJECT]: linkStat }, /must be a directory/],
    ["a symlinked root", { "/var/lib/sovereign-node/bundled-matrix": linkStat }, /must be a directory/],
    ["a regular file", { [PROJECT]: fileStat }, /must be a directory/],
    ["a missing project", { [PROJECT]: "missing" }, /does not exist/],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => resolveProject(PROJECT, identity, { lstat: lstatFrom(overrides) })).toThrow(message);
  });
});

describe("imageRepository", () => {
  it.each([
    ["postgres:16-alpine", "postgres"],
    ["docker.io/library/postgres:16", "postgres"],
    ["matrixdotorg/synapse:v1.125.0", "matrixdotorg/synapse"],
    ["ghcr.io/ndee/sovereign-caddy-desec:2.10.2@sha256:abc", "ghcr.io/ndee/sovereign-caddy-desec"],
    ["localhost:5000/evil", "localhost:5000/evil"],
    ["caddy", "caddy"],
  ])("%s -> %s", (image, expected) => {
    expect(imageRepository(image)).toBe(expected);
  });

  it("allows the repositories of the images the node renders", () => {
    for (const image of [
      "postgres:16-alpine",
      "matrixdotorg/synapse:v1.125.0",
      "caddy:2.10.2-alpine",
      "ghcr.io/ndee/sovereign-caddy-desec:2.10.2@sha256:370cd93ff12d1c3c691a5eaf64c06458b2c33100c481e0c6e56c0e91fd622bf6",
      "node:22-alpine",
    ]) {
      expect(ALLOWED_IMAGE_REPOSITORIES.has(imageRepository(image))).toBe(true);
    }
  });
});

describe("validateComposeModel", () => {
  it("accepts the node's bundled stack", () => {
    expect(() => validate(model())).not.toThrow();
  });

  it("accepts a model without networks or volumes and an empty volume map", () => {
    const value = model();
    delete value.networks;
    value.volumes = {};
    delete value.services.postgres.volumes;
    expect(() => validate(value)).not.toThrow();
  });

  const mutate = (fn) => {
    const value = model();
    fn(value);
    return value;
  };

  it.each([
    ["no services", () => ({ name: "matrix-example-org" }), /no services/],
    ["a non-object model", () => null, /no services/],
    ["an extra top-level key", () => mutate((m) => (m.secrets = {})), /top-level compose key secrets/],
    ["a foreign project name", () => mutate((m) => (m.name = "other")), /project name/],
    ["named volumes", () => mutate((m) => (m.volumes = { data: {} })), /named volumes/],
    ["a non-object volume map", () => mutate((m) => (m.volumes = [])), /named volumes/],
    ["a host network driver", () => mutate((m) => (m.networks.default.driver = "host")), /plain bridge/],
    ["network driver options", () => mutate((m) => (m.networks.default.driver_opts = {})), /plain bridge/],
    ["an external network", () => mutate((m) => (m.networks.default.external = true)), /plain bridge/],
    ["a malformed network", () => mutate((m) => (m.networks.default = null)), /plain bridge/],
    ["a malformed service", () => mutate((m) => (m.services.synapse = "x")), /malformed/],
    ["a bad service name", () => mutate((m) => (m.services["Bad Name"] = {})), /malformed/],
    ["privileged mode", () => mutate((m) => (m.services.synapse.privileged = true)), /privileged/],
    ["host networking", () => mutate((m) => (m.services.synapse.network_mode = "host")), /network_mode/],
    ["added capabilities", () => mutate((m) => (m.services.synapse.cap_add = ["ALL"])), /cap_add/],
    ["devices", () => mutate((m) => (m.services.synapse.devices = ["/dev/sda"])), /devices/],
    ["a host pid namespace", () => mutate((m) => (m.services.synapse.pid = "host")), /pid/],
    ["an image outside the allowlist", () => mutate((m) => (m.services.synapse.image = "alpine")), /allowlist/],
    ["a missing image", () => mutate((m) => delete m.services.synapse.image), /allowlist/],
    [
      "a bind mount of the host root",
      () => mutate((m) => m.services.synapse.volumes.push({ type: "bind", source: "/", target: "/host" })),
      /outside the project/,
    ],
    [
      "a writable mount of the app dir",
      () =>
        mutate((m) => {
          m.services["onboarding-api"].volumes[0].read_only = false;
        }),
      /outside the project/,
    ],
    [
      "a path that escapes the project",
      () => mutate((m) => m.services.synapse.volumes.push({ type: "bind", source: `${PROJECT}/../x`, target: "/x" })),
      /not a normalized path/,
    ],
    [
      "a named volume mount",
      () => mutate((m) => m.services.synapse.volumes.push({ type: "volume", source: "data", target: "/x" })),
      /only use bind mounts/,
    ],
    [
      "a bind without a source",
      () => mutate((m) => m.services.synapse.volumes.push({ type: "bind", target: "/x" })),
      /only use bind mounts/,
    ],
    [
      "shared propagation",
      () =>
        mutate((m) =>
          m.services.synapse.volumes.push({
            type: "bind",
            source: `${PROJECT}/synapse`,
            target: "/x",
            bind: { propagation: "rshared" },
          }),
        ),
      /shared mount propagation/,
    ],
    ["a malformed volume", () => mutate((m) => m.services.synapse.volumes.push("x:/y")), /malformed volume/],
  ])("refuses %s", (_label, build, message) => {
    expect(() => validate(build())).toThrow(message);
  });

  it("refuses a project bind mount that passes through a symlink", () => {
    expect(() => validate(model(), { [`${PROJECT}/synapse`]: linkStat })).toThrow(/through a symlink/);
  });

  it("accepts a project bind mount whose source does not exist yet", () => {
    expect(() => validate(model(), { [`${PROJECT}/postgres-data`]: "missing" })).not.toThrow();
  });
});

describe("resolveComposeModel", () => {
  const project = { projectDir: PROJECT, projectName: "matrix-example-org" };

  it("resolves the project as the service user with a clean environment", () => {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify(model()) };
    };
    expect(resolveComposeModel(project, identity, { spawn }).name).toBe("matrix-example-org");
    expect(calls[0].args).toEqual([
      "compose",
      "-f",
      `${PROJECT}/compose.yaml`,
      "--project-directory",
      PROJECT,
      "config",
      "--format",
      "json",
    ]);
    expect(calls[0].options).toMatchObject({
      cwd: PROJECT,
      uid: 998,
      gid: 997,
      env: { PATH: expect.any(String), HOME: "/var/lib/sovereign-node" },
    });
  });

  it.each([
    ["a spawn error", { error: new Error("ENOENT docker") }, /ENOENT docker/],
    ["a failing config", { status: 1, stderr: "invalid compose\n" }, /invalid compose/],
    ["a failing config without stderr", { status: 1 }, /compose config failed/],
    ["non-JSON output", { status: 0, stdout: "services:" }, /did not return JSON/],
  ])("refuses %s", (_label, result, message) => {
    expect(() => resolveComposeModel(project, identity, { spawn: () => result })).toThrow(message);
  });
});

describe("runBundledMatrixDocker", () => {
  const setup = ({ configStatus = 0, runStatus = 0, runError, resolved = model() } = {}) => {
    const calls = [];
    const written = [];
    const removed = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes("config")) {
        return { status: configStatus, stdout: JSON.stringify(resolved), stderr: "" };
      }
      return runError === undefined ? { status: runStatus } : { error: runError };
    };
    const run = (argv) =>
      runBundledMatrixDocker({
        argv,
        identity,
        spawn,
        lstat: lstatFrom(),
        makeTempDir: () => "/tmp/sovereign-matrix-compose-x",
        writeFile: (path, content, options) => written.push({ path, content, options }),
        removeDir: (path) => removed.push(path),
      });
    return { calls, written, removed, run };
  };

  it("runs a compose command as root against the resolved project", () => {
    const { calls, written, removed, run } = setup({ runStatus: 3 });
    expect(run([PROJECT, "compose", "up", "-d", "--remove-orphans", "--force-recreate", "synapse"])).toBe(3);
    expect(written).toEqual([
      {
        path: "/tmp/sovereign-matrix-compose-x/compose.json",
        content: JSON.stringify(model()),
        options: { mode: 0o600 },
      },
    ]);
    expect(calls[1]).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "-f",
        "/tmp/sovereign-matrix-compose-x/compose.json",
        "--project-directory",
        "/tmp/sovereign-matrix-compose-x",
        "-p",
        "matrix-example-org",
        "up",
        "-d",
        "--remove-orphans",
        "--force-recreate",
        "synapse",
      ],
      options: { stdio: "inherit", env: { HOME: "/root" } },
    });
    expect(calls[1].options.uid).toBeUndefined();
    expect(removed).toEqual(["/tmp/sovereign-matrix-compose-x"]);
  });

  it("only validates for the config form", () => {
    const { calls, written, run } = setup();
    expect(run([PROJECT, "compose", "config"])).toBe(0);
    expect(calls).toHaveLength(1);
    expect(written).toEqual([]);
  });

  it("refuses a service that the project does not define", () => {
    const { run } = setup();
    expect(() => run([PROJECT, "compose", "restart", "caddy"])).toThrow(/no service caddy/);
  });

  it("refuses to run a project that fails the policy", () => {
    const resolved = model();
    resolved.services.synapse.privileged = true;
    const { calls, run } = setup({ resolved });
    expect(() => run([PROJECT, "compose", "up", "-d"])).toThrow(/privileged/);
    expect(calls).toHaveLength(1);
  });

  it("cleans up and rethrows when docker cannot be started", () => {
    const { removed, run } = setup({ runError: new Error("spawn docker ENOENT") });
    expect(() => run([PROJECT, "compose", "ps", "-a"])).toThrow(/ENOENT/);
    expect(removed).toEqual(["/tmp/sovereign-matrix-compose-x"]);
  });

  it("maps a signal-terminated docker run onto exit code 1", () => {
    const { run } = setup({ runStatus: null });
    expect(run([PROJECT, "compose", "ps", "-a"])).toBe(1);
  });

  it("answers the container-error query for the project's own containers only", () => {
    const { calls, run } = setup();
    expect(
      run([PROJECT, "inspect", "--format", CONTAINER_ERROR_FORMAT, "matrix-example-org-synapse-1"]),
    ).toBe(0);
    expect(calls[0].args).toEqual([
      "inspect",
      "--format",
      CONTAINER_ERROR_FORMAT,
      "matrix-example-org-synapse-1",
    ]);
    expect(() =>
      run([PROJECT, "inspect", "--format", CONTAINER_ERROR_FORMAT, "other-db-1"]),
    ).toThrow(/does not belong/);
  });

  it("answers the port-owner query", () => {
    const { calls, run } = setup();
    expect(run([PROJECT, "ps", "--filter", "publish=443", "--format", PORT_OWNER_FORMAT])).toBe(0);
    expect(calls[0].args).toEqual(["ps", "--filter", "publish=443", "--format", PORT_OWNER_FORMAT]);
  });

  it("uses the real temp dir, writer and cleanup by default", () => {
    const spawn = (_command, args) =>
      args.includes("config") ? { status: 0, stdout: JSON.stringify(model()) } : { status: 0 };
    expect(
      runBundledMatrixDocker({
        argv: [PROJECT, "compose", "ps", "-a"],
        identity,
        spawn,
        lstat: lstatFrom(),
      }),
    ).toBe(0);
  });
});
