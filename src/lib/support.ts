/**
 * Public support surface for in-process consumers (sovereign-ai-node-pro).
 *
 * Named exports, not wildcards: `version-inventory.ts` exports `UNKNOWN` and
 * `build-info.ts` exports `UNKNOWN_BUILD_VALUE`, and a barrel that wildcards
 * both invites a silent collision the next time either module grows a name.
 */

export {
  getNodeBuildInfo,
  isNodeBuildIdentityComplete,
  type NodeBuildInfo,
  shortCommit,
} from "../build-info.js";
export {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_RETENTION_DAYS,
  type BundleDependencies,
  type BundleManifest,
  type BundleResult,
  cleanupOldBundles,
  ensureBundleDirectory,
  generateSupportBundle,
  MAX_BUNDLE_BYTES,
  type ManifestEntry,
} from "../support/bundle.js";
export {
  listSanErrorIds,
  lookupSanError,
  SAN_ERRORS,
  type SanComponent,
  type SanErrorDefinition,
  type SanPrivacy,
  type SanSeverity,
} from "../support/codes.js";
export { CODES_DOC_RELATIVE_PATH, renderCodesDocument } from "../support/codes-doc.js";
export {
  buildDiagnosticsPresentation,
  DIAGNOSTICS_COMPONENT_IDS,
  type DiagnosticsComponent,
  type DiagnosticsComponentId,
  type DiagnosticsComponentStatus,
  type DiagnosticsInputs,
  type DiagnosticsOverall,
  type DiagnosticsPresentation,
  diagnosticsComponentSchema,
  diagnosticsComponentStatusSchema,
  diagnosticsOverallSchema,
  diagnosticsPresentationSchema,
  type UpdateServiceSummary,
} from "../support/presentation.js";
export {
  isPiiKey,
  isSecretKey,
  REDACTED,
  REDACTED_PII,
  type RedactionSummary,
  redactText,
  redactValue,
  summarizeRedactions,
} from "../support/redact.js";
export {
  buildVersionInventory,
  type ComponentVersion,
  type InventoryInputs,
  type OperatingEnvironment,
  summarizeInventory,
  type VersionInventory,
} from "../support/version-inventory.js";
