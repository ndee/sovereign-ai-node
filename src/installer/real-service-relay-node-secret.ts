import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord, parseJsonDocument, summarizeText } from "./real-service-shared.js";

/**
 * Per-node relay enrollment secret.
 *
 * The managed relay control plane issues a secret for a node ONCE (on the
 * first successful enroll, or on the first re-enroll that adopts a legacy
 * record). Every later call that touches the same assignment must present it
 * as `Authorization: Bearer <secret>`. The node persists it next to the other
 * managed secrets and never writes it into install request or job records.
 */
export const RELAY_NODE_SECRET_FILE_NAME = "relay-node-secret";
export const RELAY_NODE_SECRET_PATH = `/etc/sovereign-node/secrets/${RELAY_NODE_SECRET_FILE_NAME}`;

const isErrno = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";

/**
 * Read the persisted node secret from the first candidate secrets dir that
 * holds a non-empty file. A missing file means "not enrolled with a secret
 * yet" and yields undefined; any other read failure is surfaced.
 */
export const readRelayNodeSecretFile = async (
  secretsDirs: readonly string[],
): Promise<string | undefined> => {
  for (const dir of secretsDirs) {
    try {
      const value = (await readFile(join(dir, RELAY_NODE_SECRET_FILE_NAME), "utf8")).trim();
      if (value.length > 0) {
        return value;
      }
    } catch (error) {
      if (isErrno(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        continue;
      }
      throw error;
    }
  }
  return undefined;
};

/** Bearer header for a present secret; empty when the node has none yet. */
export const relayNodeSecretAuthHeaders = (
  nodeSecret: string | undefined,
): Record<string, string> => {
  const trimmed = nodeSecret?.trim() ?? "";
  return trimmed.length === 0 ? {} : { Authorization: `Bearer ${trimmed}` };
};

/** Extract the machine-readable relay error code (`code` or `error.code`). */
export const extractRelayErrorCode = (responseText: string): string | undefined => {
  const parsed = parseJsonDocument(responseText);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const candidate =
    typeof parsed.code === "string"
      ? parsed.code
      : isRecord(parsed.error) && typeof parsed.error.code === "string"
        ? parsed.error.code
        : "";
  return candidate.length === 0 ? undefined : candidate;
};

export type RelayNodeAuthFailure = {
  code: "RELAY_NODE_SECRET_REJECTED" | "RELAY_SLUG_TAKEN" | "RELAY_THROTTLED";
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
};

/**
 * Translate a relay authentication/ownership failure into an operator-facing
 * error. Returns null for statuses the caller handles itself.
 *
 * - 401: the relay already knows this node but no valid node secret was sent.
 *        Never retried; the relay operator must re-key the node.
 * - 409 `SLUG_TAKEN` (or any 409 while a secret was presented): the requested
 *        name belongs to another node. Never retried.
 * - 429: throttled; safe to retry later, not in a tight loop.
 */
export const describeRelayNodeAuthFailure = (input: {
  status: number;
  responseText: string;
  controlUrl: string;
  requestedSlug?: string;
  presentedNodeSecret?: boolean;
}): RelayNodeAuthFailure | null => {
  const relayCode = extractRelayErrorCode(input.responseText);
  const details: Record<string, unknown> = {
    controlUrl: input.controlUrl,
    status: input.status,
    ...(input.requestedSlug === undefined ? {} : { requestedSlug: input.requestedSlug }),
    ...(relayCode === undefined ? {} : { relayCode }),
    body: summarizeText(input.responseText, 600),
  };

  if (input.status === 401) {
    return {
      code: "RELAY_NODE_SECRET_REJECTED",
      message:
        "The relay already has an assignment for this node but no valid node secret was " +
        "presented (HTTP 401). This node must be re-keyed by the relay operator: ask them " +
        `to issue a new node secret and place it at ${RELAY_NODE_SECRET_PATH} (mode 0600), ` +
        "or restore that file from a backup, then rerun the installer.",
      retryable: false,
      details: { ...details, secretPath: RELAY_NODE_SECRET_PATH },
    };
  }

  if (input.status === 409 && (relayCode === "SLUG_TAKEN" || input.presentedNodeSecret === true)) {
    const name =
      input.requestedSlug === undefined ? "requested node name" : `"${input.requestedSlug}"`;
    return {
      code: "RELAY_SLUG_TAKEN",
      message: `The relay rejected the node name ${name}: it is owned by another node (HTTP 409). Choose a different name.`,
      retryable: false,
      details,
    };
  }

  if (input.status === 429) {
    return {
      code: "RELAY_THROTTLED",
      message:
        "The relay throttled this node (HTTP 429): too many enrollment attempts. Wait a few minutes and retry.",
      retryable: true,
      details,
    };
  }

  return null;
};

/** Return a copy of an enrollment-shaped object with the node secret removed. */
export const stripRelayNodeSecret = <T extends { nodeSecret?: string }>(
  value: T,
): Omit<T, "nodeSecret"> => {
  const { nodeSecret: _omitted, ...rest } = value;
  return rest;
};
