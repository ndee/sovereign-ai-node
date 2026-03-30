import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SovereignPaths } from "../config/paths.js";
import { backupManifestSchema } from "../contracts/backup.js";
import { createLogger } from "../logging/logger.js";
import { RealBackupService } from "./backup.js";
import type { ExecInput, ExecResult, ExecRunner } from "./exec.js";
import { ExecaExecRunner } from "./exec.js";

const realExecRunner = new ExecaExecRunner();
const PASSTHROUGH_COMMANDS = new Set(["tar", "cp"]);

const buildPaths = (root: string): SovereignPaths => ({
  configPath: join(root, "etc", "sovereign-node.json5"),
  secretsDir: join(root, "etc", "secrets"),
  stateDir: join(root, "state"),
  logsDir: join(root, "logs"),
  installJobsDir: join(root, "install-jobs"),
  openclawServiceHome: join(root, "openclaw-home"),
  provenancePath: join(root, "install-provenance.json"),
  backupsDir: join(root, "backups"),
});

const writeConfig = async (configPath: string, projectDir: string): Promise<void> => {
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      matrix: {
        projectDir,
        homeserverDomain: "matrix.local.test",
        publicBaseUrl: "http://matrix.local.test:8008",
        bot: { accessTokenSecretRef: "file:/tmp/token" },
        alertRoom: { roomId: "!room:matrix.local.test" },
      },
    }),
    "utf8",
  );
};

const setupMatrixProjectDir = async (projectDir: string): Promise<void> => {
  await mkdir(join(projectDir, "synapse", "media_store"), { recursive: true });
  await mkdir(join(projectDir, "reverse-proxy-data"), { recursive: true });
  await mkdir(join(projectDir, "reverse-proxy"), { recursive: true });

  await writeFile(
    join(projectDir, "compose.yaml"),
    "version: '3'\nservices:\n  postgres:\n    image: postgres:16\n",
    "utf8",
  );
  await writeFile(
    join(projectDir, ".env"),
    "MATRIX_HOMESERVER_DOMAIN=matrix.local.test\nPOSTGRES_PASSWORD=test\n",
    "utf8",
  );
  await writeFile(
    join(projectDir, "synapse", "homeserver.yaml"),
    "server_name: matrix.local.test\n",
    "utf8",
  );
  await writeFile(
    join(projectDir, "synapse", "matrix.local.test.signing.key"),
    "ed25519 a_1 AAAA\n",
    "utf8",
  );
  await writeFile(
    join(projectDir, "reverse-proxy", "Caddyfile"),
    "matrix.local.test {\n  reverse_proxy synapse:8008\n}\n",
    "utf8",
  );
};

const setupSecrets = async (secretsDir: string): Promise<void> => {
  await mkdir(secretsDir, { recursive: true });
  await writeFile(join(secretsDir, "matrix-operator.password"), "secret-pw", "utf8");
  await writeFile(join(secretsDir, "openrouter-api-key"), "sk-or-test", "utf8");
};

type RecordedExecCall = ExecInput;

const createFakeExecRunner = (
  handlers?: Record<string, (input: ExecInput) => Partial<ExecResult>>,
): { runner: ExecRunner; calls: RecordedExecCall[] } => {
  const calls: RecordedExecCall[] = [];
  const runner: ExecRunner = {
    run: async (input) => {
      calls.push(input);

      if (PASSTHROUGH_COMMANDS.has(input.command)) {
        return realExecRunner.run(input);
      }

      const key = [input.command, ...(input.args ?? [])].join(" ");

      if (handlers !== undefined) {
        for (const [pattern, handler] of Object.entries(handlers)) {
          if (key.includes(pattern)) {
            const partial = handler(input);
            return {
              command: key,
              exitCode: partial.exitCode ?? 0,
              stdout: partial.stdout ?? "",
              stderr: partial.stderr ?? "",
            };
          }
        }
      }

      return {
        command: key,
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
  };
  return { runner, calls };
};

describe("RealBackupService", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-backup-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe("create()", () => {
    it("creates a valid backup archive with manifest", async () => {
      const paths = buildPaths(tempRoot);
      const projectDir = join(paths.stateDir, "bundled-matrix", "matrix-local-test");
      await setupMatrixProjectDir(projectDir);
      await writeConfig(paths.configPath, projectDir);
      await setupSecrets(paths.secretsDir);
      await writeFile(paths.provenancePath, '{"installed": true}', "utf8");

      const pgDumpOutput = "-- PostgreSQL dump\nCREATE TABLE test;\n";
      const { runner, calls } = createFakeExecRunner({
        pg_dump: () => ({ stdout: pgDumpOutput }),
      });

      const service = new RealBackupService(runner, createLogger(), paths);
      const result = await service.create({});

      expect(result.archivePath).toContain("sovereign-node-backup-");
      expect(result.archivePath.endsWith(".tar.gz")).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.manifest.version).toBe("1");
      expect(result.manifest.homeserverDomain).toBe("matrix.local.test");

      const itemKeys = result.manifest.items.map((i) => i.key);
      expect(itemKeys).toContain("postgres_dump");
      expect(itemKeys).toContain("synapse_signing_key");
      expect(itemKeys).toContain("sovereign_config");
      expect(itemKeys).toContain("secrets");

      const pgDumpCall = calls.find((c) => c.args?.includes("pg_dump"));
      expect(pgDumpCall).toBeDefined();
      expect(pgDumpCall?.args).toContain("-T");
      expect(pgDumpCall?.args).toContain("synapse");
    });

    it("uses custom output path when specified", async () => {
      const paths = buildPaths(tempRoot);
      await mkdir(join(paths.stateDir, "bundled-matrix"), { recursive: true });
      await mkdir(join(tempRoot, "etc"), { recursive: true });
      await writeFile(paths.configPath, "{}", "utf8");

      const { runner } = createFakeExecRunner();
      const service = new RealBackupService(runner, createLogger(), paths);

      const customPath = join(tempRoot, "custom-output", "my-backup.tar.gz");
      const result = await service.create({ outputPath: customPath });

      expect(result.archivePath).toBe(customPath);
    });

    it("handles missing Matrix project directory gracefully", async () => {
      const paths = buildPaths(tempRoot);
      await mkdir(join(tempRoot, "etc"), { recursive: true });
      await writeFile(paths.configPath, "{}", "utf8");

      const { runner } = createFakeExecRunner();
      const service = new RealBackupService(runner, createLogger(), paths);

      const result = await service.create({});

      expect(
        result.manifest.items.every((i) => !i.key.startsWith("matrix_") || i.optional === true),
      ).toBe(true);
      expect(result.manifest.homeserverDomain).toBeUndefined();
    });

    it("marks pg_dump as optional when Docker is not running", async () => {
      const paths = buildPaths(tempRoot);
      const projectDir = join(paths.stateDir, "bundled-matrix", "matrix-local-test");
      await setupMatrixProjectDir(projectDir);
      await writeConfig(paths.configPath, projectDir);

      const { runner } = createFakeExecRunner({
        pg_dump: () => ({ exitCode: 1, stderr: "connection refused" }),
        "docker-compose": () => ({ exitCode: 127, stderr: "not found" }),
      });

      const service = new RealBackupService(runner, createLogger(), paths);
      const result = await service.create({});

      const pgItem = result.manifest.items.find((i) => i.key === "postgres_dump");
      expect(pgItem).toBeDefined();
      expect(pgItem?.optional).toBe(true);
    });

    it("discovers project dir by scanning bundled-matrix directory", async () => {
      const paths = buildPaths(tempRoot);
      const projectDir = join(paths.stateDir, "bundled-matrix", "my-node-domain");
      await setupMatrixProjectDir(projectDir);
      await mkdir(join(tempRoot, "etc"), { recursive: true });
      await writeFile(paths.configPath, "{}", "utf8");

      const { runner } = createFakeExecRunner({
        pg_dump: () => ({ stdout: "-- dump" }),
      });

      const service = new RealBackupService(runner, createLogger(), paths);
      const result = await service.create({});

      expect(result.manifest.items.some((i) => i.key === "synapse_signing_key")).toBe(true);
    });

    it("handles missing optional files without failing", async () => {
      const paths = buildPaths(tempRoot);
      const projectDir = join(paths.stateDir, "bundled-matrix", "matrix-local-test");
      await mkdir(join(projectDir, "synapse"), { recursive: true });
      await writeFile(join(projectDir, "compose.yaml"), "version: '3'\n", "utf8");
      await writeConfig(paths.configPath, projectDir);

      const { runner } = createFakeExecRunner({
        pg_dump: () => ({ exitCode: 1, stderr: "no postgres" }),
        "docker-compose": () => ({ exitCode: 127, stderr: "not found" }),
      });

      const service = new RealBackupService(runner, createLogger(), paths);
      const result = await service.create({});

      const optionalItems = result.manifest.items.filter((i) => i.optional === true);
      expect(optionalItems.length).toBeGreaterThan(0);
    });
  });

  describe("restore()", () => {
    it("extracts archive and restores files to correct locations", async () => {
      const paths = buildPaths(tempRoot);
      const projectDir = join(paths.stateDir, "bundled-matrix", "matrix-local-test");
      await setupMatrixProjectDir(projectDir);
      await writeConfig(paths.configPath, projectDir);
      await setupSecrets(paths.secretsDir);

      const pgDumpSql = "-- PostgreSQL dump\nCREATE TABLE test;\n";
      let pgRestoreInput = "";

      const { runner } = createFakeExecRunner({
        pg_dump: () => ({ stdout: pgDumpSql }),
        pg_isready: () => ({ exitCode: 0 }),
        dropdb: () => ({ exitCode: 0 }),
        createdb: () => ({ exitCode: 0 }),
        psql: (input) => {
          pgRestoreInput = String(input.options?.input ?? "");
          return { exitCode: 0 };
        },
        compose: () => ({ exitCode: 0 }),
        systemctl: () => ({ exitCode: 0 }),
      });

      const service = new RealBackupService(runner, createLogger(), paths);

      const backup = await service.create({});

      await rm(paths.secretsDir, { recursive: true, force: true });
      await mkdir(paths.secretsDir, { recursive: true });

      const result = await service.restore(backup.archivePath);

      expect(result.archivePath).toBe(backup.archivePath);
      expect(result.manifest.version).toBe("1");
      expect(pgRestoreInput).toContain("CREATE TABLE test");

      const restoredConfig = await readFile(paths.configPath, "utf8");
      expect(restoredConfig).toContain("matrix.local.test");
    });

    it("calls docker compose down before restoring", async () => {
      const paths = buildPaths(tempRoot);
      const projectDir = join(paths.stateDir, "bundled-matrix", "matrix-local-test");
      await setupMatrixProjectDir(projectDir);
      await writeConfig(paths.configPath, projectDir);

      const { runner, calls } = createFakeExecRunner({
        pg_dump: () => ({ stdout: "-- dump" }),
        pg_isready: () => ({ exitCode: 0 }),
        dropdb: () => ({ exitCode: 0 }),
        createdb: () => ({ exitCode: 0 }),
        psql: () => ({ exitCode: 0 }),
        systemctl: () => ({ exitCode: 0 }),
      });

      const service = new RealBackupService(runner, createLogger(), paths);
      const backup = await service.create({});
      const result = await service.restore(backup.archivePath);

      const downCall = calls.find((c) => c.args?.includes("down"));
      expect(downCall).toBeDefined();
      expect(result.warnings).toBeDefined();
    });

    it("adds warnings for failed service stops instead of throwing", async () => {
      const paths = buildPaths(tempRoot);
      await mkdir(join(tempRoot, "etc"), { recursive: true });
      await writeFile(paths.configPath, "{}", "utf8");

      const { runner } = createFakeExecRunner({
        systemctl: () => ({ exitCode: 5, stderr: "Unit not found" }),
      });

      const service = new RealBackupService(runner, createLogger(), paths);
      const backup = await service.create({});
      const result = await service.restore(backup.archivePath);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes("Could not"))).toBe(true);
    });
  });

  describe("list()", () => {
    it("returns empty list when backups directory does not exist", async () => {
      const paths = buildPaths(tempRoot);
      const { runner } = createFakeExecRunner();
      const service = new RealBackupService(runner, createLogger(), paths);

      const result = await service.list();

      expect(result.backups).toHaveLength(0);
      expect(result.backupsDir).toBe(paths.backupsDir);
    });

    it("returns empty list when backups directory is empty", async () => {
      const paths = buildPaths(tempRoot);
      await mkdir(paths.backupsDir, { recursive: true });

      const { runner } = createFakeExecRunner();
      const service = new RealBackupService(runner, createLogger(), paths);

      const result = await service.list();

      expect(result.backups).toHaveLength(0);
    });

    it("lists matching backup files sorted by date descending", async () => {
      const paths = buildPaths(tempRoot);
      await mkdir(paths.backupsDir, { recursive: true });

      await writeFile(
        join(paths.backupsDir, "sovereign-node-backup-20260101T000000.tar.gz"),
        "fake1",
        "utf8",
      );
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(
        join(paths.backupsDir, "sovereign-node-backup-20260201T000000.tar.gz"),
        "fake2-longer",
        "utf8",
      );
      await writeFile(join(paths.backupsDir, "unrelated-file.txt"), "ignore", "utf8");

      const { runner } = createFakeExecRunner();
      const service = new RealBackupService(runner, createLogger(), paths);

      const result = await service.list();

      expect(result.backups).toHaveLength(2);
      expect(result.backups[0]?.filename).toBe("sovereign-node-backup-20260201T000000.tar.gz");
      expect(result.backups[1]?.filename).toBe("sovereign-node-backup-20260101T000000.tar.gz");
    });

    it("ignores non-matching files", async () => {
      const paths = buildPaths(tempRoot);
      await mkdir(paths.backupsDir, { recursive: true });
      await writeFile(join(paths.backupsDir, "notes.txt"), "not a backup", "utf8");
      await writeFile(join(paths.backupsDir, "backup.tar.gz"), "wrong prefix", "utf8");

      const { runner } = createFakeExecRunner();
      const service = new RealBackupService(runner, createLogger(), paths);

      const result = await service.list();

      expect(result.backups).toHaveLength(0);
    });
  });

  describe("manifest validation", () => {
    it("produces a manifest that passes Zod validation", async () => {
      const paths = buildPaths(tempRoot);
      await mkdir(join(tempRoot, "etc"), { recursive: true });
      await writeFile(paths.configPath, "{}", "utf8");

      const { runner } = createFakeExecRunner();
      const service = new RealBackupService(runner, createLogger(), paths);

      const result = await service.create({});
      const parsed = backupManifestSchema.safeParse(result.manifest);
      expect(parsed.success).toBe(true);
    });
  });
});
