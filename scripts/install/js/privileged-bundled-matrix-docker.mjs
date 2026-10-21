// privileged-bundled-matrix-docker: run the bundled Matrix stack's docker
// commands on behalf of the unprivileged runtime API, so the service user
// does not need to be in the container-runtime group.
//
// Usage: bundled-matrix-docker <project-dir> compose <args...>
//        bundled-matrix-docker <project-dir> inspect --format {{.State.Error}} <container>
//        bundled-matrix-docker <project-dir> ps --filter publish=<port> --format <format>
//
// Only the fixed command forms in COMPOSE_FORMS (and the two read-only docker
// queries) are accepted. For compose commands the project is first resolved
// with `docker compose config` running as the service user, so no file is read
// as root on the caller's behalf. The resolved model must pass the policy in
// validateComposeModel (allowlisted images and service keys, bind mounts only
// inside the project or the two read-only node paths). The command then runs
// as root against a root-owned copy of that resolved model, so the caller
// cannot change the project between the check and the run.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize } from "node:path";

import { HELPER_PATH_ENV, isCanonicalAbsolutePath, refuse } from "./privileged-helper-config.mjs";

const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MATRIX_LOCALPART = /^[a-z0-9._=/+-]{1,255}$/;
const BASE_URL = /^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9._~/-]*)?$/;
export const CONTAINER_ERROR_FORMAT = "{{.State.Error}}";
export const PORT_OWNER_FORMAT = '{{.Names}}\t{{.Label "com.docker.compose.project"}}';
const COMPOSE_TIMEOUT_MS = 10 * 60 * 1000;

export const ALLOWED_IMAGE_REPOSITORIES = new Set([
  "postgres",
  "matrixdotorg/synapse",
  "caddy",
  "ghcr.io/ndee/sovereign-caddy-desec",
  "node",
]);

const ALLOWED_SERVICE_KEYS = new Set([
  "image",
  "restart",
  "environment",
  "volumes",
  "depends_on",
  "ports",
  "expose",
  "healthcheck",
  "command",
  "entrypoint",
  "networks",
  "labels",
  "user",
  "working_dir",
  "tmpfs",
  "stop_grace_period",
  "stop_signal",
  "logging",
  "init",
  "hostname",
  "ulimits",
  "platform",
  "pull_policy",
  "extra_hosts",
  "dns",
  "mem_limit",
  "cpus",
  "tty",
  "stdin_open",
  "read_only",
  "shm_size",
  "deploy",
]);
const ALLOWED_TOP_LEVEL_KEYS = new Set(["name", "services", "networks", "volumes"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const services = (args) => args.every((arg) => SERVICE_NAME.test(arg));
const exact = (expected) => (args) =>
  args.length === expected.length && args.every((arg, index) => arg === expected[index]);
const prefixed = (prefix, rest) => (args) =>
  args.length >= prefix.length &&
  prefix.every((arg, index) => args[index] === arg) &&
  rest(args.slice(prefix.length));

// Every compose command the node runs against the bundled Matrix project.
// `services` lists the positions that name a compose service, so the run can
// be refused when the resolved project has no such service.
export const COMPOSE_FORMS = [
  { id: "config", accepts: exact(["config"]) },
  { id: "pull", accepts: prefixed(["pull"], services), services: (a) => a.slice(1) },
  { id: "up", accepts: prefixed(["up", "-d"], services), services: (a) => a.slice(2) },
  {
    id: "recreate",
    accepts: prefixed(["up", "-d", "--remove-orphans", "--force-recreate"], services),
    services: (a) => a.slice(4),
  },
  { id: "down", accepts: exact(["down"]) },
  { id: "down-orphans", accepts: exact(["down", "--remove-orphans"]) },
  { id: "ps", accepts: exact(["ps", "-a"]) },
  { id: "ps-json", accepts: exact(["ps", "-a", "--format", "json"]) },
  {
    id: "logs",
    accepts: (a) =>
      a.length === 5 &&
      exact(["logs", "--no-color", "--tail"])(a.slice(0, 3)) &&
      /^[0-9]{1,5}$/.test(a[3]) &&
      SERVICE_NAME.test(a[4]),
    services: (a) => [a[4]],
  },
  {
    id: "restart",
    accepts: (a) => a.length === 2 && a[0] === "restart" && SERVICE_NAME.test(a[1]),
    services: (a) => [a[1]],
  },
  {
    id: "register-user",
    accepts: (a) =>
      a.length === 12 &&
      exact(["exec", "-T", "synapse", "register_new_matrix_user", "-u"])(a.slice(0, 5)) &&
      MATRIX_LOCALPART.test(a[5]) &&
      a[6] === "-p" &&
      a[7].length > 0 &&
      a[7].length <= 1024 &&
      (a[8] === "-a" || a[8] === "--no-admin") &&
      a[9] === "-c" &&
      a[10] === "/data/homeserver.yaml" &&
      BASE_URL.test(a[11]),
    services: () => ["synapse"],
  },
  ...[
    ["pg_dump", "-U", "synapse", "synapse"],
    ["dropdb", "-U", "synapse", "--if-exists", "synapse"],
    ["createdb", "-U", "synapse", "synapse"],
    ["psql", "-U", "synapse", "-d", "synapse"],
    ["pg_isready", "-U", "synapse"],
  ].map((command) => ({
    id: command[0],
    accepts: exact(["exec", "-T", "postgres", ...command]),
    services: () => ["postgres"],
  })),
];

export const parseRequest = (argv) => {
  const [projectDir, verb, ...rest] = argv;
  if (projectDir === undefined || verb === undefined) {
    refuse("usage: bundled-matrix-docker <project-dir> compose|inspect|ps <args...>");
  }
  if (verb === "compose") {
    const form = COMPOSE_FORMS.find((candidate) => candidate.accepts(rest));
    if (form === undefined) {
      refuse(`compose command is not one of the fixed forms: ${rest.join(" ")}`);
    }
    return { projectDir, kind: "compose", form, args: rest };
  }
  if (verb === "inspect" && rest.length === 3 && rest[0] === "--format") {
    if (rest[1] === CONTAINER_ERROR_FORMAT && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(rest[2])) {
      return { projectDir, kind: "inspect", args: ["inspect", ...rest], container: rest[2] };
    }
  }
  if (verb === "ps" && rest.length === 4 && rest[0] === "--filter" && rest[2] === "--format") {
    const port = /^publish=([0-9]{1,5})$/.exec(rest[1]);
    if (port !== null && Number(port[1]) <= 65535 && rest[3] === PORT_OWNER_FORMAT) {
      return { projectDir, kind: "ps", args: ["ps", ...rest] };
    }
  }
  refuse(`docker command is not one of the fixed forms: ${[verb, ...rest].join(" ")}`);
};

const assertRealDirectory = (path, lstat) => {
  let stat;
  try {
    stat = lstat(path);
  } catch {
    refuse(`${path} does not exist`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    refuse(`${path} must be a directory, not a symlink`);
  }
};

export const resolveProject = (projectDir, identity, { lstat = lstatSync } = {}) => {
  const root = join(identity.stateDir, "bundled-matrix");
  const name = basename(projectDir);
  if (
    !isCanonicalAbsolutePath(projectDir) ||
    dirname(projectDir) !== root ||
    !PROJECT_NAME.test(name)
  ) {
    refuse(`${projectDir} is not a bundled Matrix project directory`);
  }
  assertRealDirectory(root, lstat);
  assertRealDirectory(projectDir, lstat);
  return { projectDir, projectName: name };
};

export const imageRepository = (image) => {
  let reference = image.split("@")[0];
  const tagColon = reference.indexOf(":", reference.lastIndexOf("/") + 1);
  if (tagColon >= 0) {
    reference = reference.slice(0, tagColon);
  }
  return reference.replace(/^docker\.io\//, "").replace(/^library\//, "");
};

// A bind source inside the project must not reach outside it through a
// symlink, so every existing path component below the project dir is checked.
const assertNoSymlinkBelow = (projectDir, source, lstat) => {
  let current = projectDir;
  for (const part of source.slice(projectDir.length + 1).split("/")) {
    current = join(current, part);
    let stat;
    try {
      stat = lstat(current);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      refuse(`bind mount source ${source} passes through a symlink`);
    }
  }
};

const validateVolume = (serviceName, volume, context, lstat) => {
  if (!isRecord(volume)) {
    refuse(`service ${serviceName} has a malformed volume entry`);
  }
  if (volume.type === "tmpfs") {
    return;
  }
  if (volume.type !== "bind" || typeof volume.source !== "string") {
    refuse(`service ${serviceName} may only use bind mounts and tmpfs`);
  }
  const propagation = volume.bind?.propagation;
  if (typeof propagation === "string" && propagation.includes("shared")) {
    refuse(`service ${serviceName} may not use shared mount propagation`);
  }
  const source = volume.source;
  if (normalize(source) !== source) {
    refuse(`bind mount source ${source} is not a normalized path`);
  }
  if (source === context.projectDir || source.startsWith(`${context.projectDir}/`)) {
    assertNoSymlinkBelow(context.projectDir, source, lstat);
    return;
  }
  if (context.readOnlySources.includes(source) && volume.read_only === true) {
    return;
  }
  refuse(`service ${serviceName} mounts ${source}, which is outside the project`);
};

export const validateComposeModel = (model, context, { lstat = lstatSync } = {}) => {
  if (!isRecord(model) || !isRecord(model.services)) {
    refuse("resolved compose project has no services");
  }
  for (const key of Object.keys(model)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      refuse(`top-level compose key ${key} is not accepted`);
    }
  }
  if (model.name !== context.projectName) {
    refuse(`compose project name must be ${context.projectName}`);
  }
  if (model.volumes !== undefined && (!isRecord(model.volumes) || Object.keys(model.volumes).length > 0)) {
    refuse("named volumes are not accepted");
  }
  for (const [name, network] of Object.entries(model.networks ?? {})) {
    if (
      !isRecord(network) ||
      network.external === true ||
      network.driver_opts !== undefined ||
      (network.driver !== undefined && network.driver !== "bridge")
    ) {
      refuse(`network ${name} must be a plain bridge network`);
    }
  }
  for (const [name, service] of Object.entries(model.services)) {
    if (!SERVICE_NAME.test(name) || !isRecord(service)) {
      refuse(`service ${name} is malformed`);
    }
    for (const key of Object.keys(service)) {
      if (!ALLOWED_SERVICE_KEYS.has(key)) {
        refuse(`service ${name} uses ${key}, which is not accepted`);
      }
    }
    if (typeof service.image !== "string" || !ALLOWED_IMAGE_REPOSITORIES.has(imageRepository(service.image))) {
      refuse(`service ${name} uses an image outside the allowlist`);
    }
    for (const volume of service.volumes ?? []) {
      validateVolume(name, volume, context, lstat);
    }
  }
};

const sanitizedEnv = (home) => ({ PATH: HELPER_PATH_ENV, HOME: home });

export const resolveComposeModel = (project, identity, { spawn = spawnSync } = {}) => {
  const result = spawn(
    "docker",
    [
      "compose",
      "-f",
      join(project.projectDir, "compose.yaml"),
      "--project-directory",
      project.projectDir,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: project.projectDir,
      uid: identity.serviceUid,
      gid: identity.serviceGid,
      env: sanitizedEnv(identity.stateDir),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: COMPOSE_TIMEOUT_MS,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    refuse(
      `docker compose config failed: ${result.error?.message ?? (result.stderr ?? "").trim().slice(0, 2000)}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    refuse("docker compose config did not return JSON");
  }
};

export const runBundledMatrixDocker = ({
  argv,
  identity,
  spawn = spawnSync,
  lstat = lstatSync,
  makeTempDir = () => mkdtempSync(join(tmpdir(), "sovereign-matrix-compose-")),
  writeFile = writeFileSync,
  removeDir = (path) => rmSync(path, { recursive: true, force: true }),
}) => {
  const request = parseRequest(argv);
  const project = resolveProject(request.projectDir, identity, { lstat });
  const runAsRoot = (args, cwd) => {
    const result = spawn("docker", args, { cwd, stdio: "inherit", env: sanitizedEnv("/root") });
    if (result.error !== undefined) {
      throw result.error;
    }
    return result.status ?? 1;
  };

  if (request.kind === "inspect") {
    if (!request.container.startsWith(`${project.projectName}-`)) {
      refuse(`container ${request.container} does not belong to ${project.projectName}`);
    }
    return runAsRoot(request.args, project.projectDir);
  }
  if (request.kind === "ps") {
    return runAsRoot(request.args, project.projectDir);
  }

  const model = resolveComposeModel(project, identity, { spawn });
  validateComposeModel(
    model,
    {
      ...project,
      readOnlySources: [join(identity.appDir, "dist"), join(identity.configDir, "secrets")],
    },
    { lstat },
  );
  for (const service of request.form.services?.(request.args) ?? []) {
    if (model.services[service] === undefined) {
      refuse(`compose project has no service ${service}`);
    }
  }
  if (request.form.id === "config") {
    return 0;
  }

  const workDir = makeTempDir();
  try {
    const resolvedFile = join(workDir, "compose.json");
    writeFile(resolvedFile, JSON.stringify(model), { mode: 0o600 });
    return runAsRoot(
      [
        "compose",
        "-f",
        resolvedFile,
        "--project-directory",
        workDir,
        "-p",
        project.projectName,
        ...request.args,
      ],
      workDir,
    );
  } finally {
    removeDir(workDir);
  }
};
