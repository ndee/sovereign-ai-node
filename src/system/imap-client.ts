import net from "node:net";

import { ImapFlow, type ImapFlowOptions } from "imapflow";

import type { Logger } from "../logging/logger.js";

const DEFAULT_IMAP_CONNECTION_TIMEOUT_MS = 10_000;

export type ImapAccountCredentials = {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
};

export type ImapConnectionPlan = {
  label: "plain" | "starttls" | "implicit-tls";
  options: ImapFlowOptions;
};

export type ImapClientLike = Pick<
  ImapFlow,
  | "authenticated"
  | "capabilities"
  | "close"
  | "connect"
  | "fetchAll"
  | "fetchOne"
  | "getMailboxLock"
  | "logout"
  | "mailboxOpen"
  | "search"
>;

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClientLike;

export class ImapConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ImapConnectionError";
  }
}

const createDefaultImapClient = (options: ImapFlowOptions): ImapClientLike => new ImapFlow(options);

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1"
  ) {
    return true;
  }
  return net.isIPv4(normalized) && normalized.startsWith("127.");
};

const shouldSendServername = (host: string): boolean => net.isIP(host.trim()) === 0;

const describeUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const isAuthenticationFailure = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "authenticationFailed" in error &&
  error.authenticationFailed === true;

const buildBaseOptions = (input: {
  account: ImapAccountCredentials;
  logger?: Logger;
  timeoutMs: number;
}): ImapFlowOptions => {
  const allowSelfSignedTls = isLoopbackHost(input.account.host);
  const options: ImapFlowOptions = {
    host: input.account.host,
    port: input.account.port,
    auth: {
      user: input.account.username,
      pass: input.account.password,
    },
    logger: input.logger ?? false,
    disableAutoIdle: true,
    connectionTimeout: input.timeoutMs,
    greetingTimeout: input.timeoutMs,
    socketTimeout: input.timeoutMs * 3,
  };

  if (allowSelfSignedTls) {
    options.tls = {
      rejectUnauthorized: false,
    };
  }

  if (shouldSendServername(input.account.host)) {
    options.servername = input.account.host;
  }

  return options;
};

export const buildImapConnectionPlans = (input: {
  account: ImapAccountCredentials;
  logger?: Logger;
  timeoutMs?: number;
}): ImapConnectionPlan[] => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_IMAP_CONNECTION_TIMEOUT_MS;
  const base = buildBaseOptions({
    account: input.account,
    timeoutMs,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  if (!input.account.tls) {
    return [
      {
        label: "plain",
        options: {
          ...base,
          secure: false,
          doSTARTTLS: false,
        },
      },
    ];
  }

  const starttls: ImapConnectionPlan = {
    label: "starttls",
    options: {
      ...base,
      secure: false,
      doSTARTTLS: true,
    },
  };
  const implicitTls: ImapConnectionPlan = {
    label: "implicit-tls",
    options: {
      ...base,
      secure: true,
    },
  };

  if (input.account.port === 993 && !isLoopbackHost(input.account.host)) {
    return [implicitTls];
  }

  if (
    input.account.port === 143 ||
    input.account.port === 1143 ||
    isLoopbackHost(input.account.host)
  ) {
    return [starttls, implicitTls];
  }

  return [implicitTls, starttls];
};

const closeClientQuietly = async (client: ImapClientLike): Promise<void> => {
  try {
    if (client.authenticated) {
      await client.logout();
      return;
    }
  } catch {
    // Fall back to a hard close below.
  }

  try {
    client.close();
  } catch {
    // no-op
  }
};

export const listImapCapabilities = (client: ImapClientLike): string[] =>
  Array.from(client.capabilities.keys()).sort((left, right) => left.localeCompare(right));

export const runWithImapClient = async <T>(
  input: {
    account: ImapAccountCredentials;
    logger?: Logger;
    timeoutMs?: number;
    clientFactory?: ImapClientFactory;
  },
  handler: (client: ImapClientLike, plan: ImapConnectionPlan) => Promise<T>,
): Promise<T> => {
  const clientFactory = input.clientFactory ?? createDefaultImapClient;
  const attempts = buildImapConnectionPlans({
    account: input.account,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  const failures: Array<{ strategy: string; reason: string }> = [];

  for (const attempt of attempts) {
    const client = clientFactory(attempt.options);

    try {
      await client.connect();
    } catch (error) {
      failures.push({
        strategy: attempt.label,
        reason: describeUnknownError(error),
      });
      await closeClientQuietly(client);

      if (isAuthenticationFailure(error)) {
        throw new ImapConnectionError(
          "IMAP_AUTH_FAILED",
          "IMAP authentication failed for the provided account",
          false,
          {
            strategy: attempt.label,
            reason: describeUnknownError(error),
          },
          { cause: error instanceof Error ? error : undefined },
        );
      }

      continue;
    }

    try {
      return await handler(client, attempt);
    } finally {
      await closeClientQuietly(client);
    }
  }

  throw new ImapConnectionError(
    "IMAP_CONNECTION_FAILED",
    failures.length === 1
      ? `IMAP connection failed: ${failures[0]?.reason ?? "unknown failure"}`
      : `IMAP connection failed after ${failures.length} attempts`,
    true,
    {
      attempts: failures,
    },
  );
};
