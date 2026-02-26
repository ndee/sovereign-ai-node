import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";

import type { TestImapRequest } from "../contracts/api.js";
import type { ErrorDetail } from "../contracts/common.js";
import type { TestImapResult } from "../contracts/index.js";
import type { Logger } from "../logging/logger.js";

const DEFAULT_IMAP_TIMEOUT_MS = 10_000;

type ImapSocket = net.Socket | tls.TLSSocket;

type TaggedResponse = {
  lines: string[];
  taggedStatus: string;
};

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

    let socket: ImapSocket | null = null;
    let lines: SocketLineQueue | null = null;

    try {
      socket = await connectImapSocket({
        host: req.imap.host,
        port: req.imap.port,
        useTls: req.imap.tls,
        timeoutMs: this.timeoutMs,
      });
      lines = new SocketLineQueue(socket);

      const greeting = await lines.nextLine(this.timeoutMs);
      if (!/^\*\s+(OK|PREAUTH)\b/i.test(greeting)) {
        throw imapProtocolError(
          "Unexpected IMAP greeting",
          { greeting: summarizeText(greeting) },
          true,
        );
      }

      let capabilities: string[] | undefined;
      try {
        const capabilityResponse = await runTaggedCommand(
          socket,
          lines,
          "A001",
          "CAPABILITY",
          this.timeoutMs,
        );
        capabilities = extractCapabilities(capabilityResponse.lines);
      } catch (error) {
        this.logger.debug(
          {
            host: req.imap.host,
            port: req.imap.port,
            error: error instanceof Error ? error.message : String(error),
          },
          "IMAP capability probe failed; continuing to LOGIN",
        );
      }

      const loginCommand = `LOGIN ${imapQuote(req.imap.username)} ${imapQuote(passwordResult.password)}`;
      const loginResponse = await runTaggedCommand(
        socket,
        lines,
        "A002",
        loginCommand,
        this.timeoutMs,
      );

      const loginOk = loginResponse.taggedStatus.toUpperCase() === "OK";
      try {
        await runTaggedCommand(socket, lines, "A003", "LOGOUT", 2_000);
      } catch {
        // Ignore logout failures; auth result is already known.
      }

      if (!loginOk) {
        return {
          ok: false,
          host: base.host,
          port: base.port,
          tls: base.tls,
          auth: "failed",
          mailbox,
          ...(capabilities === undefined ? {} : { capabilities }),
          error: {
            code: "IMAP_AUTH_FAILED",
            message: "IMAP authentication failed for the provided account",
            retryable: false,
            details: {
              taggedStatus: loginResponse.taggedStatus,
              response: summarizeText(loginResponse.lines.join(" ")),
            },
          },
        };
      }

      return {
        ok: true,
        host: base.host,
        port: base.port,
        tls: base.tls,
        auth: "ok",
        mailbox,
        ...(capabilities === undefined ? {} : { capabilities }),
      };
    } catch (error) {
      const normalized = normalizeImapError(error);
      return {
        ok: false,
        host: base.host,
        port: base.port,
        tls: base.tls,
        auth: "failed",
        mailbox,
        error: normalized,
      };
    } finally {
      try {
        lines?.close();
      } catch {
        // no-op
      }
      if (socket !== null && !socket.destroyed) {
        socket.destroy();
      }
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

type ConnectOptions = {
  host: string;
  port: number;
  useTls: boolean;
  timeoutMs: number;
};

const connectImapSocket = async (options: ConnectOptions): Promise<ImapSocket> =>
  new Promise<ImapSocket>((resolve, reject) => {
    let settled = false;
    let socket: ImapSocket;

    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        imapTransportError("IMAP connection failed", {
          host: options.host,
          port: options.port,
          tls: options.useTls,
          error: error.message,
        }),
      );
    };

    const onConnected = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.setTimeout(0);
      resolve(socket);
    };

    if (options.useTls) {
      socket = tls.connect({
        host: options.host,
        port: options.port,
        servername: options.host,
      });
      socket.once("secureConnect", onConnected);
    } else {
      socket = net.createConnection({
        host: options.host,
        port: options.port,
      });
      socket.once("connect", onConnected);
    }

    socket.once("error", onError);
    socket.setTimeout(options.timeoutMs, () => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(
        imapTransportError("IMAP connection timed out", {
          host: options.host,
          port: options.port,
          tls: options.useTls,
        }),
      );
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(
        imapTransportError("IMAP connection timed out", {
          host: options.host,
          port: options.port,
          tls: options.useTls,
        }),
      );
    }, options.timeoutMs + 250);
    timer.unref();
  });

const runTaggedCommand = async (
  socket: ImapSocket,
  lines: SocketLineQueue,
  tag: string,
  command: string,
  timeoutMs: number,
): Promise<TaggedResponse> => {
  await writeLine(socket, `${tag} ${command}`);

  const responseLines: string[] = [];
  while (true) {
    const line = await lines.nextLine(timeoutMs);
    responseLines.push(line);
    if (line.toUpperCase().startsWith(`${tag.toUpperCase()} `)) {
      const taggedStatus = parseTaggedStatus(line, tag);
      return {
        lines: responseLines,
        taggedStatus,
      };
    }
  }
};

const writeLine = async (socket: ImapSocket, line: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    socket.write(`${line}\r\n`, "utf8", (error) => {
      if (error !== undefined && error !== null) {
        reject(
          imapTransportError("Failed to write IMAP command to socket", {
            error: error.message,
          }),
        );
        return;
      }
      resolve();
    });
  });

class SocketLineQueue {
  private buffer = "";

  private readonly lines: string[] = [];

  private ended = false;

  private fatalError: unknown = null;

  private readonly waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private readonly socket: ImapSocket) {
    socket.setEncoding("utf8");
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.on("close", this.onClose);
  }

  close(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onClose);
    this.rejectAll(new Error("Socket line queue closed"));
  }

  async nextLine(timeoutMs: number): Promise<string> {
    if (this.lines.length > 0) {
      return this.lines.shift() as string;
    }
    if (this.fatalError !== null) {
      throw this.fatalError;
    }
    if (this.ended) {
      throw imapProtocolError("IMAP socket ended before a complete response was received");
    }

    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(resolve);
        reject(imapTransportError("Timed out waiting for IMAP server response"));
      }, timeoutMs);
      timer.unref();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private readonly onData = (chunk: string | Buffer): void => {
    this.buffer += chunk.toString();

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        this.lines.push(line);
      }

      newlineIndex = this.buffer.indexOf("\n");
    }
  };

  private readonly onError = (error: Error): void => {
    this.fatalError = imapTransportError("IMAP socket error", { error: error.message });
    this.rejectAll(this.fatalError);
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        this.lines.push(line);
      }
    }
    if (this.waiters.length > 0) {
      this.rejectAll(imapProtocolError("IMAP socket ended before tagged response was received"));
    }
  };

  private readonly onClose = (): void => {
    this.ended = true;
    if (this.waiters.length > 0 && this.fatalError === null) {
      this.rejectAll(imapProtocolError("IMAP socket closed before tagged response was received"));
    }
  };

  private rejectAll(error: unknown): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        break;
      }
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private removeWaiter(resolve: (line: string) => void): void {
    const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
      }
    }
  }
}

const parseTaggedStatus = (line: string, tag: string): string => {
  const regex = new RegExp(`^${escapeRegex(tag)}\\s+([A-Za-z]+)\\b`, "i");
  const match = line.match(regex);
  if (match?.[1] !== undefined) {
    return match[1].toUpperCase();
  }
  throw imapProtocolError("Failed to parse IMAP tagged status line", {
    line: summarizeText(line),
  });
};

const extractCapabilities = (lines: string[]): string[] | undefined => {
  const values = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^\*\s+CAPABILITY\s+(.+)$/i);
    if (match?.[1] === undefined) {
      continue;
    }
    for (const token of match[1].trim().split(/\s+/)) {
      if (token.length > 0) {
        values.add(token);
      }
    }
  }
  if (values.size === 0) {
    return undefined;
  }
  return [...values];
};

const imapQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;

const normalizeImapError = (error: unknown): ErrorDetail => {
  if (isErrorDetail(error)) {
    return error;
  }
  if (error instanceof Error) {
    return {
      code: "IMAP_PROTOCOL_ERROR",
      message: error.message,
      retryable: true,
    };
  }
  return {
    code: "IMAP_PROTOCOL_ERROR",
    message: String(error),
    retryable: true,
  };
};

const imapTransportError = (
  message: string,
  details?: Record<string, unknown>,
): ErrorDetail => ({
  code: "IMAP_CONNECT_FAILED",
  message,
  retryable: true,
  ...(details === undefined ? {} : { details }),
});

const imapProtocolError = (
  message: string,
  details?: Record<string, unknown>,
  retryable = true,
): ErrorDetail => ({
  code: "IMAP_PROTOCOL_ERROR",
  message,
  retryable,
  ...(details === undefined ? {} : { details }),
});

const isErrorDetail = (value: unknown): value is ErrorDetail => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ErrorDetail>;
  return (
    typeof candidate.code === "string"
    && typeof candidate.message === "string"
    && typeof candidate.retryable === "boolean"
  );
};

const summarizeText = (value: string): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}...(truncated)` : compact;
};

const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
