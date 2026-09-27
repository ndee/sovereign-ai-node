export {
  buildInstallDiagnostics,
  collectSystemSummary,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_SOURCE_CAPS,
  DIAGNOSTICS_PRIORITY,
  type DiagnosticsManifest,
  type DiagnosticsManifestEntry,
  type DiagnosticsRunCommand,
  type DiagnosticsSource,
  decodeThrottled,
  defaultDiagnosticsRun,
  defaultNodeDiagnosticsSources,
  defaultNodeKnownSecretSources,
  diagnosticsFileName,
  EXCLUDED_CONTENT,
  INSTALL_DIAGNOSTICS_FORMAT_VERSION,
  type InstallDiagnosticsOptions,
  type InstallDiagnosticsResult,
  npmLogsDir,
  pickFields,
  pickInstallJobRecord,
  REDACTION_POLICY,
  scrubDiagnosticText,
  scrubDiagnosticValue,
} from "../support/install-diagnostics.js";
export {
  KnownSecretSet,
  type KnownSecretSources,
  loadKnownSecrets,
  REDACTED_KNOWN,
} from "../support/known-secrets.js";
export { maskEmailLocalParts, REDACTED, REDACTED_PII, redactText } from "../support/redact.js";
export { findSecretShapes } from "../support/shape-guard.js";
export { readFileTail, readSmallFile, tailText } from "../support/tail.js";
export { crc32, createZip, readZip, type ZipEntry } from "../support/zip.js";
