import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";

import { z } from "zod";

/**
 * Verified-release authorization for template pin transitions.
 *
 * A tool-template pin is an authorization boundary: reconcile refuses to feed
 * a changed template into the workspace compiler (`TEMPLATE_PIN_MISMATCH`).
 * When an operator-approved, signature-verified release legitimately changes a
 * template, the ROOT-owned updater captures — after manifest signature and
 * artifact digest verification, from the verified bundle bytes — an
 * attestation of exactly which bot manifests that release carries. Reconcile
 * may then transition a pin if and only if the installed catalog's raw
 * manifest bytes are byte-identical to what the verified release shipped.
 *
 * Trust properties this module enforces on the attestation file itself:
 * - it must be a regular file, not a symlink (opened with O_NOFOLLOW),
 * - it must be owned by root (the sovereign-node service user cannot create
 *   root-owned files, so it cannot mint its own authorization),
 * - it must not be writable by group or others,
 * - it is bounded in size and strictly schema-validated.
 *
 * A stale attestation cannot approve a later checkout: authorization is by
 * exact raw-byte digest, so any edit to the installed catalog manifest makes
 * every attestation digest mismatch and reconcile fails closed.
 */

/** Upper bound for the attestation file. Generous: it may embed one previous
 * bot manifest (informational, for the operator-visible diff). */
const MAX_AUTHORIZATION_BYTES = 1024 * 1024;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const authorizedBotSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.string().min(1).max(64),
    /** sha256 over the raw bytes of `bots/<id>/sovereign-bot.json` inside the
     * signature-verified release bundle. This is the authorization anchor. */
    manifestFileSha256: sha256Hex,
    /** The previously installed catalog manifest content, captured by the
     * updater before it replaced the bots tree. INFORMATIONAL ONLY — used to
     * render the capability/command diff, never consulted for authorization
     * (the old catalog was service-user-writable). */
    previousManifest: z
      .string()
      .max(512 * 1024)
      .optional(),
  })
  .strict();

export const releaseAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("sovereign-release-authorization"),
    runId: z.string().min(1).max(128),
    createdAt: z.string().min(1).max(64),
    releaseId: z.string().min(1).max(128),
    channel: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    artifactSha256: sha256Hex,
    signingKeyId: z.string().min(1).max(128),
    bots: z.array(authorizedBotSchema).max(64),
  })
  .strict();

export type ReleaseAuthorization = z.infer<typeof releaseAuthorizationSchema>;
export type AuthorizedReleaseBot = ReleaseAuthorization["bots"][number];

export type LoadReleaseAuthorizationOptions = {
  /**
   * Uids allowed to own the attestation file. Production default is root
   * only. Injectable exclusively so unit tests (which cannot create
   * root-owned files) can exercise the accept path; the CLI never exposes
   * this and never reads it from the environment.
   */
  allowedOwnerUids?: readonly number[];
};

const invalid = (reason: string, message: string, details?: Record<string, unknown>) => ({
  code: "RELEASE_AUTHORIZATION_INVALID" as const,
  message,
  retryable: false,
  details: { reason, ...(details ?? {}) },
});

/**
 * Load and validate a release-authorization attestation. Every failure is a
 * hard, structured `RELEASE_AUTHORIZATION_INVALID` error — callers must treat
 * any failure as "no authorization exists", never as a soft fallback.
 */
export const loadReleaseAuthorization = (
  path: string,
  options?: LoadReleaseAuthorizationOptions,
): ReleaseAuthorization => {
  const allowedOwnerUids = options?.allowedOwnerUids ?? [0];

  let fd: number;
  try {
    // O_NOFOLLOW: refuse a symlink at the final path component, so the caller
    // cannot be redirected into reading (or trusting) another file.
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw invalid("symlink", `Release authorization at '${path}' is a symlink; refusing`);
    }
    throw invalid(
      "unreadable",
      `Release authorization at '${path}' could not be opened (${code ?? "unknown error"})`,
    );
  }

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw invalid(
        "not-a-regular-file",
        `Release authorization at '${path}' is not a regular file`,
      );
    }
    if (!allowedOwnerUids.includes(stats.uid)) {
      throw invalid(
        "untrusted-owner",
        `Release authorization at '${path}' is not owned by a trusted uid`,
        { ownerUid: stats.uid },
      );
    }
    // Group- or world-writable would let a non-owner rewrite the
    // authorization after the updater created it.
    if ((stats.mode & 0o022) !== 0) {
      throw invalid(
        "unsafe-mode",
        `Release authorization at '${path}' is group- or world-writable`,
        {
          mode: (stats.mode & 0o777).toString(8),
        },
      );
    }
    if (stats.size > MAX_AUTHORIZATION_BYTES) {
      throw invalid("too-large", `Release authorization at '${path}' exceeds the size bound`, {
        size: stats.size,
      });
    }

    const buffer = Buffer.alloc(Number(stats.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) {
        break;
      }
      offset += read;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    } catch {
      throw invalid("parse-error", `Release authorization at '${path}' is not valid JSON`);
    }

    const result = releaseAuthorizationSchema.safeParse(parsed);
    if (!result.success) {
      throw invalid(
        "schema-invalid",
        `Release authorization at '${path}' does not match the schema`,
        {
          issues: result.error.issues.slice(0, 5).map((issue) => issue.path.join(".")),
        },
      );
    }
    return result.data;
  } finally {
    closeSync(fd);
  }
};

/**
 * Find the attestation entry that authorizes a bot package, by exact identity:
 * bot id, bot version, and the raw-byte digest of the installed catalog's
 * manifest file. Returns null when the attestation does not bind this exact
 * content — the caller must then refuse the transition.
 */
export const findAuthorizedReleaseBot = (
  authorization: ReleaseAuthorization,
  input: { botId: string; botVersion: string; manifestFileSha256: string },
): AuthorizedReleaseBot | null => {
  const entry = authorization.bots.find((bot) => bot.id === input.botId);
  if (entry === undefined) {
    return null;
  }
  if (entry.version !== input.botVersion) {
    return null;
  }
  if (entry.manifestFileSha256 !== input.manifestFileSha256) {
    return null;
  }
  return entry;
};
