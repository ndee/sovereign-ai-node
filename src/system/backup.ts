import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import JSON5 from "json5";

import type { SovereignPaths } from "../config/paths.js";
import type {
  BackupCreateResult,
  BackupListResult,
  BackupManifest,
  BackupManifestItem,
  BackupRestoreResult,
} from "../contracts/backup.js";
import { backupManifestSchema } from "../contracts/backup.js";
import { CONTRACT_VERSION } from "../contracts/common.js";
import {
  DEFAULT_INSTALL_REQUEST_FILE,
  SOVEREIGN_GATEWAY_SYSTEMD_UNIT,
} from "../installer/real-service-shared.js";
import type { Logger } from "../logging/logger.js";
import type { ExecResult, ExecRunner } from "./exec.js";

const SOVEREIGN_NODE_VERSION = "2.0.0";
const COMPOSE_COMMAND_TIMEOUT_MS = 600_000;
const PG_READY_POLL_INTERVAL_MS = 2_000;
const PG_READY_TIMEOUT_MS = 60_000;
const BACKUP_FILENAME_PREFIX = "sovereign-node-backup-";

const EXCLUDED_STATE_DIRS = new Set(["bundled-matrix", "backups", "install-jobs"]);

export interface BackupService {
  create(options: { outputPath?: string }): Promise<BackupCreateResult>;
  restore(archivePath: string): Promise<BackupRestoreResult>;
  list(): Promise<BackupListResult>;
}

export class RealBackupService implements BackupService {
  constructor(
    private readonly execRunner: ExecRunner,
    private readonly logger: Logger,
    private readonly paths: SovereignPaths,
  ) {}

  async create(options: { outputPath?: string }): Promise<BackupCreateResult> {
    const createdAt = new Date().toISOString();
    const stagingDir = await this.createTempDir("sovereign-node-backup-staging-");

    try {
      const items: BackupManifestItem[] = [];
      const projectDir = await this.discoverMatrixProjectDir();
      let homeserverDomain: string | undefined;

      if (projectDir !== null) {
        homeserverDomain = await this.resolveHomeserverDomain(projectDir);

        await this.collectPgDump(stagingDir, projectDir, items);
        await this.collectSigningKey(stagingDir, projectDir, items);
        await this.collectDir(
          stagingDir,
          join(projectDir, "synapse", "media_store"),
          "matrix/media_store",
          "synapse_media_store",
          "Synapse media store",
          items,
        );
        await this.collectDir(
          stagingDir,
          join(projectDir, "reverse-proxy-data"),
          "matrix/reverse-proxy-data",
          "caddy_tls_state",
          "Caddy TLS state and certificates",
          items,
        );
        await this.collectFile(
          stagingDir,
          join(projectDir, ".env"),
          "matrix/dot-env",
          "matrix_env",
          "Matrix Docker Compose environment",
          items,
        );
        await this.collectFile(
          stagingDir,
          join(projectDir, "synapse", "homeserver.yaml"),
          "matrix/homeserver.yaml",
          "matrix_homeserver_yaml",
          "Synapse homeserver configuration",
          items,
        );
        await this.collectFile(
          stagingDir,
          join(projectDir, "reverse-proxy", "Caddyfile"),
          "matrix/Caddyfile",
          "matrix_caddyfile",
          "Caddy reverse proxy configuration",
          items,
        );
        await this.collectFile(
          stagingDir,
          join(projectDir, "compose.yaml"),
          "matrix/compose.yaml",
          "matrix_compose_yaml",
          "Docker Compose service definitions",
          items,
        );
      } else {
        this.logger.warn("No bundled Matrix project directory found; skipping Matrix backup items");
      }

      await this.collectFile(
        stagingDir,
        this.paths.configPath,
        "config/sovereign-node.json5",
        "sovereign_config",
        "Sovereign Node configuration",
        items,
      );
      await this.collectDir(
        stagingDir,
        this.paths.secretsDir,
        "config/secrets",
        "secrets",
        "Secrets directory (passwords, API keys)",
        items,
      );
      await this.collectFile(
        stagingDir,
        DEFAULT_INSTALL_REQUEST_FILE,
        "config/install-request.json",
        "install_request",
        "Installation request parameters",
        items,
      );
      await this.collectFile(
        stagingDir,
        this.paths.provenancePath,
        "config/install-provenance.json",
        "install_provenance",
        "Installation provenance audit trail",
        items,
      );
      await this.collectAgentState(stagingDir, items);
      await this.collectDir(
        stagingDir,
        this.paths.openclawServiceHome,
        "openclaw-home",
        "openclaw_home",
        "OpenClaw service home",
        items,
      );

      const manifest: BackupManifest = {
        version: "1",
        createdAt,
        sovereignNodeVersion: SOVEREIGN_NODE_VERSION,
        contractVersion: CONTRACT_VERSION,
        ...(homeserverDomain !== undefined ? { homeserverDomain } : {}),
        items,
      };
      await writeFile(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

      await mkdir(this.paths.backupsDir, { recursive: true });
      const timestamp = createdAt.replace(/[:.]/g, "").replace("T", "T");
      const defaultFilename = `${BACKUP_FILENAME_PREFIX}${timestamp}.tar.gz`;
      const outputPath = options.outputPath ?? join(this.paths.backupsDir, defaultFilename);
      await mkdir(dirname(outputPath), { recursive: true });

      const tarResult = await this.execRunner.run({
        command: "tar",
        args: ["-czf", outputPath, "-C", stagingDir, "."],
        options: { timeout: COMPOSE_COMMAND_TIMEOUT_MS },
      });
      if (tarResult.exitCode !== 0) {
        throw {
          code: "BACKUP_ARCHIVE_FAILED",
          message: `Failed to create backup archive: ${tarResult.stderr}`,
          retryable: false,
        };
      }

      const archiveStat = await stat(outputPath);

      return {
        archivePath: outputPath,
        sizeBytes: archiveStat.size,
        createdAt,
        manifest,
      };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  async restore(archivePath: string): Promise<BackupRestoreResult> {
    const restoredAt = new Date().toISOString();
    const warnings: string[] = [];

    await access(archivePath, fsConstants.R_OK);

    const extractDir = await this.createTempDir("sovereign-node-backup-restore-");

    try {
      const extractResult = await this.execRunner.run({
        command: "tar",
        args: ["-xzf", archivePath, "-C", extractDir],
        options: { timeout: COMPOSE_COMMAND_TIMEOUT_MS },
      });
      if (extractResult.exitCode !== 0) {
        throw {
          code: "BACKUP_EXTRACT_FAILED",
          message: `Failed to extract backup archive: ${extractResult.stderr}`,
          retryable: false,
        };
      }

      const manifestRaw = await readFile(join(extractDir, "manifest.json"), "utf8");
      const manifest = backupManifestSchema.parse(JSON.parse(manifestRaw));

      const existingProjectDir = await this.discoverMatrixProjectDir();
      await this.stopServices(existingProjectDir, warnings);

      await this.restoreConfigFiles(extractDir, manifest, warnings);

      const projectDir = await this.resolveOrCreateMatrixProjectDir(manifest);
      if (projectDir !== null) {
        await this.restoreMatrixFiles(extractDir, projectDir, manifest, warnings);
      }

      await this.restoreAgentState(extractDir, manifest, warnings);
      await this.restoreOpenclawHome(extractDir, manifest, warnings);

      if (projectDir !== null) {
        await this.restorePostgres(extractDir, projectDir, manifest, warnings);
        await this.startMatrixStack(projectDir, warnings);
      }

      await this.startServices(warnings);

      return {
        archivePath,
        restoredAt,
        manifest,
        warnings,
      };
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  }

  async list(): Promise<BackupListResult> {
    await mkdir(this.paths.backupsDir, { recursive: true });

    const entries = await readdir(this.paths.backupsDir, { withFileTypes: true });
    const backups: BackupListResult["backups"] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(BACKUP_FILENAME_PREFIX) || !entry.name.endsWith(".tar.gz"))
        continue;

      const filePath = join(this.paths.backupsDir, entry.name);
      const fileStat = await stat(filePath);
      backups.push({
        filename: entry.name,
        path: filePath,
        sizeBytes: fileStat.size,
        createdAt: fileStat.mtime.toISOString(),
      });
    }

    backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      backupsDir: this.paths.backupsDir,
      backups,
    };
  }

  // --- Private helpers ---

  private async createTempDir(prefix: string): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    return mkdtemp(join(tmpdir(), prefix));
  }

  private async discoverMatrixProjectDir(): Promise<string | null> {
    try {
      const raw = await readFile(this.paths.configPath, "utf8");
      const parsed = parseJsonDocument(raw);
      if (isRecord(parsed)) {
        const matrix = parsed.matrix;
        if (isRecord(matrix)) {
          if (typeof matrix.projectDir === "string" && matrix.projectDir.length > 0) {
            try {
              await access(matrix.projectDir, fsConstants.R_OK);
              return matrix.projectDir;
            } catch {
              // projectDir configured but does not exist
            }
          }
        }
      }
    } catch {
      // config file may not exist
    }

    return this.scanForMatrixProjectDir();
  }

  private async scanForMatrixProjectDir(): Promise<string | null> {
    const baseDir = join(this.paths.stateDir, "bundled-matrix");
    try {
      const entries = await readdir(baseDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());
      const first = dirs[0];
      if (dirs.length === 1 && first !== undefined) {
        return join(baseDir, first.name);
      }
      if (dirs.length > 1 && first !== undefined) {
        this.logger.warn(
          `Multiple bundled Matrix project directories found; using first: ${first.name}`,
        );
        return join(baseDir, first.name);
      }
    } catch {
      // baseDir does not exist
    }
    return null;
  }

  private async resolveHomeserverDomain(projectDir: string): Promise<string | undefined> {
    try {
      const envRaw = await readFile(join(projectDir, ".env"), "utf8");
      for (const line of envRaw.split("\n")) {
        const match = line.match(/^MATRIX_HOMESERVER_DOMAIN=(.+)$/);
        if (match !== null && match[1] !== undefined) {
          return match[1].trim();
        }
      }
    } catch {
      // .env file may not exist
    }

    return basename(projectDir) !== "bundled-matrix" ? basename(projectDir) : undefined;
  }

  private async collectPgDump(
    stagingDir: string,
    projectDir: string,
    items: BackupManifestItem[],
  ): Promise<void> {
    const composeFile = join(projectDir, "compose.yaml");
    try {
      await access(composeFile, fsConstants.R_OK);
    } catch {
      this.logger.warn("No compose.yaml found; skipping PostgreSQL dump");
      return;
    }

    const result = await this.runComposeCommand(projectDir, composeFile, [
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "synapse",
      "synapse",
    ]);

    if (result.exitCode !== 0) {
      this.logger.warn(`pg_dump failed (exit ${result.exitCode}): ${result.stderr}`);
      items.push({
        key: "postgres_dump",
        relativePath: "pg_dump.sql",
        description: "PostgreSQL database dump (FAILED)",
        optional: true,
      });
      return;
    }

    await writeFile(join(stagingDir, "pg_dump.sql"), result.stdout, "utf8");
    items.push({
      key: "postgres_dump",
      relativePath: "pg_dump.sql",
      description: "PostgreSQL database dump",
    });
  }

  private async collectSigningKey(
    stagingDir: string,
    projectDir: string,
    items: BackupManifestItem[],
  ): Promise<void> {
    const synapseDir = join(projectDir, "synapse");
    try {
      const entries = await readdir(synapseDir);
      const keyFile = entries.find((e) => e.endsWith(".signing.key"));
      if (keyFile === undefined) {
        this.logger.warn("No Synapse signing key found");
        return;
      }

      const targetDir = join(stagingDir, "matrix");
      await mkdir(targetDir, { recursive: true });
      const content = await readFile(join(synapseDir, keyFile), "utf8");
      await writeFile(join(targetDir, "synapse-signing.key"), content, "utf8");
      items.push({
        key: "synapse_signing_key",
        relativePath: "matrix/synapse-signing.key",
        description: "Synapse server signing key",
      });
    } catch {
      this.logger.warn("Could not read Synapse signing key");
    }
  }

  private async collectFile(
    stagingDir: string,
    sourcePath: string,
    relativePath: string,
    key: string,
    description: string,
    items: BackupManifestItem[],
  ): Promise<void> {
    try {
      const content = await readFile(sourcePath);
      const targetPath = join(stagingDir, relativePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
      items.push({ key, relativePath, description });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.logger.info(`Skipping ${key}: ${sourcePath} not found`);
        items.push({
          key,
          relativePath,
          description: `${description} (not found)`,
          optional: true,
        });
        return;
      }
      throw error;
    }
  }

  private async collectDir(
    stagingDir: string,
    sourceDir: string,
    relativePath: string,
    key: string,
    description: string,
    items: BackupManifestItem[],
  ): Promise<void> {
    try {
      await access(sourceDir, fsConstants.R_OK);
    } catch {
      this.logger.info(`Skipping ${key}: ${sourceDir} not found`);
      items.push({ key, relativePath, description: `${description} (not found)`, optional: true });
      return;
    }

    const targetDir = join(stagingDir, relativePath);
    await mkdir(dirname(targetDir), { recursive: true });

    const result = await this.execRunner.run({
      command: "cp",
      args: ["-a", sourceDir, targetDir],
    });
    if (result.exitCode !== 0) {
      this.logger.warn(`Failed to copy ${sourceDir}: ${result.stderr}`);
      items.push({
        key,
        relativePath,
        description: `${description} (copy failed)`,
        optional: true,
      });
      return;
    }
    items.push({ key, relativePath, description });
  }

  private async collectAgentState(stagingDir: string, items: BackupManifestItem[]): Promise<void> {
    try {
      const entries = await readdir(this.paths.stateDir, { withFileTypes: true });
      const agentDirs = entries.filter((e) => e.isDirectory() && !EXCLUDED_STATE_DIRS.has(e.name));

      if (agentDirs.length === 0) {
        return;
      }

      const stateTarget = join(stagingDir, "state");
      await mkdir(stateTarget, { recursive: true });

      for (const dir of agentDirs) {
        const source = join(this.paths.stateDir, dir.name);
        const dest = join(stateTarget, dir.name);
        await this.execRunner.run({
          command: "cp",
          args: ["-a", source, dest],
        });
      }

      items.push({
        key: "agent_state",
        relativePath: "state",
        description: "Agent workspace state",
      });
    } catch {
      this.logger.info("No agent state directories found");
    }
  }

  private async stopServices(projectDir: string | null, warnings: string[]): Promise<void> {
    const apiStop = await this.execRunner.run({
      command: "systemctl",
      args: ["stop", "sovereign-node-api.service"],
    });
    if (apiStop.exitCode !== 0) {
      warnings.push(`Could not stop sovereign-node-api.service: ${apiStop.stderr}`);
    }

    const gwStop = await this.execRunner.run({
      command: "systemctl",
      args: ["stop", SOVEREIGN_GATEWAY_SYSTEMD_UNIT],
    });
    if (gwStop.exitCode !== 0) {
      warnings.push(`Could not stop ${SOVEREIGN_GATEWAY_SYSTEMD_UNIT}: ${gwStop.stderr}`);
    }

    if (projectDir !== null) {
      const composeFile = join(projectDir, "compose.yaml");
      try {
        await access(composeFile, fsConstants.R_OK);
        const result = await this.runComposeCommand(projectDir, composeFile, ["down"]);
        if (result.exitCode !== 0) {
          warnings.push(`docker compose down failed: ${result.stderr}`);
        }
      } catch {
        warnings.push("No compose.yaml found; skipping docker compose down");
      }
    }
  }

  private async restoreConfigFiles(
    extractDir: string,
    manifest: BackupManifest,
    warnings: string[],
  ): Promise<void> {
    const configItem = manifest.items.find((i) => i.key === "sovereign_config");
    if (configItem !== undefined && !configItem.optional) {
      await this.restoreFile(
        join(extractDir, configItem.relativePath),
        this.paths.configPath,
        warnings,
        "sovereign config",
      );
    }

    const secretsItem = manifest.items.find((i) => i.key === "secrets");
    if (secretsItem !== undefined && !secretsItem.optional) {
      await this.restoreDir(
        join(extractDir, secretsItem.relativePath),
        this.paths.secretsDir,
        warnings,
        "secrets",
      );
    }

    const requestItem = manifest.items.find((i) => i.key === "install_request");
    if (requestItem !== undefined && !requestItem.optional) {
      await this.restoreFile(
        join(extractDir, requestItem.relativePath),
        DEFAULT_INSTALL_REQUEST_FILE,
        warnings,
        "install request",
      );
    }

    const provenanceItem = manifest.items.find((i) => i.key === "install_provenance");
    if (provenanceItem !== undefined && !provenanceItem.optional) {
      await this.restoreFile(
        join(extractDir, provenanceItem.relativePath),
        this.paths.provenancePath,
        warnings,
        "install provenance",
      );
    }
  }

  private async resolveOrCreateMatrixProjectDir(manifest: BackupManifest): Promise<string | null> {
    const hasMatrixItems = manifest.items.some(
      (i) => i.key.startsWith("matrix_") || i.key === "synapse_signing_key",
    );
    if (!hasMatrixItems && !manifest.items.some((i) => i.key === "postgres_dump")) {
      return null;
    }

    let projectDir = await this.discoverMatrixProjectDir();
    if (projectDir !== null) {
      return projectDir;
    }

    const domain = manifest.homeserverDomain;
    if (domain === undefined) {
      return null;
    }

    const slug = slugifyProjectName(domain);
    projectDir = join(this.paths.stateDir, "bundled-matrix", slug);
    await mkdir(projectDir, { recursive: true });
    return projectDir;
  }

  private async restoreMatrixFiles(
    extractDir: string,
    projectDir: string,
    manifest: BackupManifest,
    warnings: string[],
  ): Promise<void> {
    const homeserverDomain =
      manifest.homeserverDomain ?? (await this.resolveHomeserverDomain(projectDir));

    for (const item of manifest.items) {
      if (item.optional) continue;

      const source = join(extractDir, item.relativePath);
      let target: string;

      switch (item.key) {
        case "synapse_signing_key":
          target = join(
            projectDir,
            "synapse",
            homeserverDomain !== undefined
              ? `${homeserverDomain}.signing.key`
              : "server.signing.key",
          );
          await this.restoreFile(source, target, warnings, "signing key");
          break;
        case "synapse_media_store":
          target = join(projectDir, "synapse", "media_store");
          await this.restoreDir(source, target, warnings, "media store");
          break;
        case "caddy_tls_state":
          target = join(projectDir, "reverse-proxy-data");
          await this.restoreDir(source, target, warnings, "Caddy TLS state");
          break;
        case "matrix_env":
          target = join(projectDir, ".env");
          await this.restoreFile(source, target, warnings, "Matrix .env");
          break;
        case "matrix_homeserver_yaml":
          target = join(projectDir, "synapse", "homeserver.yaml");
          await this.restoreFile(source, target, warnings, "homeserver.yaml");
          break;
        case "matrix_caddyfile":
          target = join(projectDir, "reverse-proxy", "Caddyfile");
          await this.restoreFile(source, target, warnings, "Caddyfile");
          break;
        case "matrix_compose_yaml":
          target = join(projectDir, "compose.yaml");
          await this.restoreFile(source, target, warnings, "compose.yaml");
          break;
        default:
          break;
      }
    }
  }

  private async restoreAgentState(
    extractDir: string,
    manifest: BackupManifest,
    warnings: string[],
  ): Promise<void> {
    const stateItem = manifest.items.find((i) => i.key === "agent_state");
    if (stateItem === undefined || stateItem.optional) return;

    const source = join(extractDir, stateItem.relativePath);
    try {
      await access(source, fsConstants.R_OK);
    } catch {
      return;
    }

    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dest = join(this.paths.stateDir, entry.name);
      await mkdir(dest, { recursive: true });
      const result = await this.execRunner.run({
        command: "cp",
        args: ["-a", `${join(source, entry.name)}/.`, dest],
      });
      if (result.exitCode !== 0) {
        warnings.push(`Failed to restore agent state ${entry.name}: ${result.stderr}`);
      }
    }
  }

  private async restoreOpenclawHome(
    extractDir: string,
    manifest: BackupManifest,
    warnings: string[],
  ): Promise<void> {
    const item = manifest.items.find((i) => i.key === "openclaw_home");
    if (item === undefined || item.optional) return;

    await this.restoreDir(
      join(extractDir, item.relativePath),
      this.paths.openclawServiceHome,
      warnings,
      "OpenClaw home",
    );
  }

  private async restorePostgres(
    extractDir: string,
    projectDir: string,
    manifest: BackupManifest,
    warnings: string[],
  ): Promise<void> {
    const dumpItem = manifest.items.find((i) => i.key === "postgres_dump");
    if (dumpItem === undefined || dumpItem.optional) return;

    const dumpPath = join(extractDir, dumpItem.relativePath);
    try {
      await access(dumpPath, fsConstants.R_OK);
    } catch {
      warnings.push("PostgreSQL dump file not found in archive");
      return;
    }

    const composeFile = join(projectDir, "compose.yaml");
    try {
      await access(composeFile, fsConstants.R_OK);
    } catch {
      warnings.push("No compose.yaml found; skipping PostgreSQL restore");
      return;
    }

    const startResult = await this.runComposeCommand(projectDir, composeFile, [
      "up",
      "-d",
      "postgres",
    ]);
    if (startResult.exitCode !== 0) {
      warnings.push(`Failed to start postgres container: ${startResult.stderr}`);
      return;
    }

    const ready = await this.waitForPostgres(projectDir, composeFile);
    if (!ready) {
      warnings.push("PostgreSQL did not become ready within timeout");
      return;
    }

    const dropResult = await this.runComposeCommand(projectDir, composeFile, [
      "exec",
      "-T",
      "postgres",
      "dropdb",
      "-U",
      "synapse",
      "--if-exists",
      "synapse",
    ]);
    if (dropResult.exitCode !== 0) {
      warnings.push(`Failed to drop existing database: ${dropResult.stderr}`);
    }

    const createResult = await this.runComposeCommand(projectDir, composeFile, [
      "exec",
      "-T",
      "postgres",
      "createdb",
      "-U",
      "synapse",
      "synapse",
    ]);
    if (createResult.exitCode !== 0) {
      warnings.push(`Failed to create database: ${createResult.stderr}`);
      return;
    }

    const dumpSql = await readFile(dumpPath, "utf8");
    const restoreResult = await this.runComposeCommand(
      projectDir,
      composeFile,
      ["exec", "-T", "postgres", "psql", "-U", "synapse", "-d", "synapse"],
      { input: dumpSql },
    );
    if (restoreResult.exitCode !== 0) {
      warnings.push(`PostgreSQL restore had errors: ${restoreResult.stderr}`);
    }
  }

  private async waitForPostgres(projectDir: string, composeFile: string): Promise<boolean> {
    const deadline = Date.now() + PG_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await this.runComposeCommand(projectDir, composeFile, [
        "exec",
        "-T",
        "postgres",
        "pg_isready",
        "-U",
        "synapse",
      ]);
      if (result.exitCode === 0) {
        return true;
      }
      await sleep(PG_READY_POLL_INTERVAL_MS);
    }
    return false;
  }

  private async startMatrixStack(projectDir: string, warnings: string[]): Promise<void> {
    const composeFile = join(projectDir, "compose.yaml");
    try {
      await access(composeFile, fsConstants.R_OK);
    } catch {
      return;
    }

    const result = await this.runComposeCommand(projectDir, composeFile, ["up", "-d"]);
    if (result.exitCode !== 0) {
      warnings.push(`Failed to start Matrix stack: ${result.stderr}`);
    }
  }

  private async startServices(warnings: string[]): Promise<void> {
    const apiStart = await this.execRunner.run({
      command: "systemctl",
      args: ["start", "sovereign-node-api.service"],
    });
    if (apiStart.exitCode !== 0) {
      warnings.push(`Could not start sovereign-node-api.service: ${apiStart.stderr}`);
    }

    const gwStart = await this.execRunner.run({
      command: "systemctl",
      args: ["start", SOVEREIGN_GATEWAY_SYSTEMD_UNIT],
    });
    if (gwStart.exitCode !== 0) {
      warnings.push(`Could not start ${SOVEREIGN_GATEWAY_SYSTEMD_UNIT}: ${gwStart.stderr}`);
    }
  }

  private async restoreFile(
    source: string,
    target: string,
    warnings: string[],
    label: string,
  ): Promise<void> {
    try {
      const content = await readFile(source);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        warnings.push(`${label}: source not found in archive`);
        return;
      }
      warnings.push(
        `Failed to restore ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async restoreDir(
    source: string,
    target: string,
    warnings: string[],
    label: string,
  ): Promise<void> {
    try {
      await access(source, fsConstants.R_OK);
    } catch {
      warnings.push(`${label}: source not found in archive`);
      return;
    }

    await mkdir(target, { recursive: true });
    const result = await this.execRunner.run({
      command: "cp",
      args: ["-a", `${source}/.`, target],
    });
    if (result.exitCode !== 0) {
      warnings.push(`Failed to restore ${label}: ${result.stderr}`);
    }
  }

  private async runComposeCommand(
    projectDir: string,
    composeFilePath: string,
    trailingArgs: string[],
    extraOptions?: Record<string, unknown>,
  ): Promise<ExecResult> {
    const commonArgs = ["compose", "-f", composeFilePath, "--project-directory", projectDir];
    const options = { cwd: projectDir, timeout: COMPOSE_COMMAND_TIMEOUT_MS, ...extraOptions };

    const dockerCompose = await this.safeExec("docker", [...commonArgs, ...trailingArgs], options);
    if (dockerCompose.ok && dockerCompose.result.exitCode === 0) {
      return dockerCompose.result;
    }

    const legacyArgs = ["-f", composeFilePath, ...trailingArgs];
    const dockerComposeLegacy = await this.safeExec("docker-compose", legacyArgs, options);
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
      code: "BACKUP_COMPOSE_UNAVAILABLE",
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
    options: Record<string, unknown>,
  ): Promise<{ ok: true; result: ExecResult } | { ok: false; error: string }> {
    try {
      const result = await this.execRunner.run({ command, args, options });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// --- Utilities ---

const slugifyProjectName = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "matrix-local-dev";
};

const parseJsonDocument = (raw: string): unknown => {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    try {
      return JSON5.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
