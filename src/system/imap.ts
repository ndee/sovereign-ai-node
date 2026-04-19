import { readFile } from "node:fs/promises";

import type { TestImapRequest } from "../contracts/api.js";
import type { ErrorDetail } from "../contracts/common.js";
import type { TestImapResult } from "../contracts/index.js";
import type { Logger } from "../logging/logger.js";
import { ImapConnectionError, listImapCapabilities, runWithImapClient } from "./imap-client.js";

const DEFAULT_IMAP_TIMEOUT_MS = 10_000;

export interface ImapTester {
  test(req: TestImapRequest): Promise<TestImapResult>;
}

export class SocketImapTester implements ImapTester {
  constructor(
    private readonly logger: Logger,
    private readonly timeoutMs: number = DEFAULT_IMAP_TIMEOUT_MS,
  ) {}

  async test(req: TestImapRequest): Promise<TestImapResult> {
    const mailbox = req.imap.mailbox ?? "INBOX";
    const base = {
      host: req.imap.host,
      port: req.imap.port,
      tls: req.imap.tls,
      mailbox,
    } as const;

    const passwordResult = await this.resolvePassword(req);
    if (!passwordResult.ok) {
      return {
        ok: false,
        host: base.host,
        port: base.port,
        tls: base.tls,
        auth: "failed",
        mailbox,
        error: passwordResult.error,
      };
    }

    try {
      const capabilities = await runWithImapClient(
        {
          account: {
            host: req.imap.host,
            port: req.imap.port,
            tls: req.imap.tls,
            username: req.imap.username,
            password: passwordResult.password,
          },
          logger: this.logger,
          timeoutMs: this.timeoutMs,
        },
        async (client) => {
          await client.mailboxOpen(mailbox, { readOnly: true });
          return listImapCapabilities(client);
        },
      );

      return {
        ok: true,
        host: base.host,
        port: base.port,
        tls: base.tls,
        auth: "ok",
        mailbox,
        ...(capabilities.length === 0 ? {} : { capabilities }),
      };
    } catch (error) {
      return {
        ok: false,
        host: base.host,
        port: base.port,
        tls: base.tls,
        auth: "failed",
        mailbox,
        error: normalizeImapTestError(error),
      };
    }
  }

  private async resolvePassword(
    req: TestImapRequest,
  ): Promise<{ ok: true; password: string } | { ok: false; error: ErrorDetail }> {
    if (req.imap.password !== undefined && req.imap.password.length > 0) {
      return { ok: true, password: req.imap.password };
    }

    const secretRef = req.imap.secretRef;
    if (secretRef === undefined || secretRef.length === 0) {
      return {
        ok: false,
        error: {
          code: "IMAP_CREDENTIALS_MISSING",
          message: "IMAP password or secretRef is required for credential validation",
          retryable: false,
        },
      };
    }

    if (secretRef.startsWith("file:")) {
      const filePath = secretRef.slice("file:".length);
      try {
        const raw = await readFile(filePath, "utf8");
        const password = stripSingleTrailingNewline(raw);
        if (password.length === 0) {
          return {
            ok: false,
            error: {
              code: "IMAP_SECRET_READ_FAILED",
              message: "IMAP secret file is empty",
              retryable: false,
              details: { secretRef },
            },
          };
        }
        return { ok: true, password };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "IMAP_SECRET_READ_FAILED",
            message: "Failed to read IMAP password from secretRef",
            retryable: false,
            details: {
              secretRef,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    }

    if (secretRef.startsWith("env:")) {
      const key = secretRef.slice("env:".length);
      const value = process.env[key];
      if (value !== undefined && value.length > 0) {
        return { ok: true, password: value };
      }
      return {
        ok: false,
        error: {
          code: "IMAP_SECRET_READ_FAILED",
          message: "Environment variable referenced by IMAP secretRef is not set",
          retryable: false,
          details: { secretRef },
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "IMAP_SECRET_REF_UNSUPPORTED",
        message: "Unsupported IMAP secretRef format",
        retryable: false,
        details: { secretRef },
      },
    };
  }
}

const normalizeImapTestError = (error: unknown): ErrorDetail => {
  if (error instanceof ImapConnectionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (error instanceof Error) {
    return {
      code: /mailbox/i.test(error.message) ? "IMAP_MAILBOX_OPEN_FAILED" : "IMAP_CONNECTION_FAILED",
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: "IMAP_CONNECTION_FAILED",
    message: String(error),
    retryable: false,
  };
};

const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");
