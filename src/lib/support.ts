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
  type DisclosureItem,
  diagnosticsFileName,
  EXCLUDED_CONTENT,
  IDENTIFYING_DATA,
  INSTALL_DIAGNOSTICS_FORMAT_VERSION,
  type InstallDiagnosticsOptions,
  type InstallDiagnosticsResult,
  NEVER_INCLUDED,
  npmLogsDir,
  pickFields,
  pickInstallJobRecord,
  REDACTION_POLICY,
  scrubDiagnosticText,
  scrubDiagnosticValue,
} from "../support/install-diagnostics.js";
export {
  countMaskTokens,
  findUnmaskedIpClasses,
  type IpClass,
  IpMasker,
  MASK_CLASSES,
  type MaskClass,
  maskIpAddresses,
  maskIpAddressesInValue,
} from "../support/ip-mask.js";
export {
  KnownSecretSet,
  type KnownSecretSources,
  loadKnownSecrets,
  REDACTED_KNOWN,
} from "../support/known-secrets.js";
export { maskEmailLocalParts, REDACTED, REDACTED_PII, redactText } from "../support/redact.js";
export { findSecretShapes } from "../support/shape-guard.js";
export {
  type ReadConstraints,
  readFileTail,
  readSmallFile,
  tailText,
} from "../support/tail.js";
export { crc32, createZip, readZip, type ZipEntry } from "../support/zip.js";
