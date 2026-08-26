import { isIP, connect as netConnect, type Socket } from "node:net";
import { type ConnectionOptions as TlsConnectionOptions, connect as tlsConnect } from "node:tls";

/**
 * Minimal read-only POP3 client (RFC 1939 + RFC 2595 STLS).
 *
 * Deliberately tiny and deliberately incomplete: it implements exactly the
 * commands Mail Sentinel needs to *observe* a mailbox — USER/PASS, STAT, LIST,
 * UIDL, TOP, RETR, CAPA, NOOP, QUIT — and nothing that mutates server state.
 * There is no DELE on purpose: a POP3 server only commits deletions at QUIT
 * after a DELE was issued, so by never sending DELE this client can never
 * remove mail, even on a crash mid-session.
 *
 * Security posture mirrors the IMAP client: TLS with certificate validation
 * is the default, self-signed certificates are tolerated only for loopback
 * hosts (local Proton Bridge / dovecot test fixtures), and plaintext is
 * refused for anything that is not loopback. No logger is accepted — the
 * protocol stream contains the password, so nothing here ever logs.
 */

export type Pop3AccountCredentials = {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
};

export type Pop3ErrorCode =
  | "POP3_AUTH_FAILED"
  | "POP3_CONNECTION_FAILED"
  | "POP3_CONNECTION_LOST"
  /** Login refused by a transient server condition (lock, rate limit), not bad credentials. */
  | "POP3_LOGIN_TEMPORARILY_REJECTED"
  | "POP3_PLAINTEXT_REFUSED"
  | "POP3_PROTOCOL_ERROR"
  | "POP3_STLS_UNSUPPORTED";

export class Pop3ConnectionError extends Error {
  constructor(
    readonly code: Pop3ErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "Pop3ConnectionError";
  }
}

export type Pop3MessageListing = {
  number: number;
  size: number;
};

export type Pop3UidlListing = {
  number: number;
  uidl: string;
};

/** The structural seam test doubles implement. */
export interface Pop3ClientLike {
  capa(): Promise<string[]>;
  stat(): Promise<{ count: number; sizeBytes: number }>;
  list(): Promise<Pop3MessageListing[]>;
  uidl(): Promise<Pop3UidlListing[]>;
  /** Headers plus the first `lines` body lines (RFC 1939 §7). */
  top(messageNumber: number, lines: number): Promise<Buffer>;
  retr(messageNumber: number): Promise<Buffer>;
  quit(): Promise<void>;
}

export const DEFAULT_POP3_TIMEOUT_MS = 10_000;
/** POP3 servers may be slow to RETR large messages; keep the idle floor generous. */
const MIN_POP3_SOCKET_IDLE_TIMEOUT_MS = 60_000;
const CRLF = "\r\n";
const TERMINATOR = Buffer.from(`${CRLF}.${CRLF}`);
const LONE_TERMINATOR = Buffer.from(`.${CRLF}`);

export const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
};

type ResponseWaiter = {
  multiline: boolean;
  resolve: (value: { status: string; payload: Buffer }) => void;
  reject: (error: Error) => void;
};

const assertSafeArgument = (value: string, label: string): void => {
  if (/[\r\n\0]/.test(value)) {
    throw new Pop3ConnectionError(
      "POP3_PROTOCOL_ERROR",
      `POP3 ${label} must not contain line breaks`,
      false,
    );
  }
};

/** Reverse RFC 1939 byte-stuffing: a leading ".." on a line means ".". */
export const unstuffDotLines = (payload: Buffer): Buffer => {
  if (!payload.includes("\n.")) {
    return payload;
  }
  const text = payload.toString("latin1");
  const lines = text.split(CRLF);
  return Buffer.from(
    lines.map((line) => (line.startsWith("..") ? line.slice(1) : line)).join(CRLF),
    "latin1",
  );
};

export class SocketPop3Client implements Pop3ClientLike {
  private socket: Socket | null = null;

  private buffer: Buffer = Buffer.alloc(0);

  private waiters: ResponseWaiter[] = [];

  private closed = false;

  private constructor(
    private readonly account: Pop3AccountCredentials,
    private readonly timeoutMs: number,
  ) {}

  static async connect(
    account: Pop3AccountCredentials,
    options: { timeoutMs?: number; startTls?: boolean } = {},
  ): Promise<SocketPop3Client> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_POP3_TIMEOUT_MS;
    const client = new SocketPop3Client(account, timeoutMs);
    await client.open(options.startTls);
    return client;
  }

  private tlsOptions(): TlsConnectionOptions {
    const options: TlsConnectionOptions = {
      host: this.account.host,
      port: this.account.port,
      rejectUnauthorized: !isLoopbackHost(this.account.host),
    };
    if (isIP(this.account.host) === 0 && !isLoopbackHost(this.account.host)) {
      options.servername = this.account.host;
    }
    return options;
  }

  /**
   * `startTls` forces the STLS upgrade path instead of the port heuristic
   * (implicit TLS everywhere except port 110). Test seam; production callers
   * leave it undefined.
   */
  private async open(startTls?: boolean): Promise<void> {
    const loopback = isLoopbackHost(this.account.host);
    if (!this.account.tls && !loopback) {
      throw new Pop3ConnectionError(
        "POP3_PLAINTEXT_REFUSED",
        "Plaintext POP3 is only allowed for loopback hosts; enable TLS for remote mail servers",
        false,
        { host: this.account.host, port: this.account.port },
      );
    }

    const implicitTls = this.account.tls && !(startTls ?? this.account.port === 110);
    const socket = await this.establish(implicitTls);
    this.attach(socket);

    try {
      await this.readGreeting();
      if (this.account.tls && !implicitTls) {
        await this.upgradeWithStls();
      }
      await this.authenticate();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  private establish(implicitTls: boolean): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(
          new Pop3ConnectionError(
            "POP3_CONNECTION_FAILED",
            `Failed to connect to POP3 server ${this.account.host}:${String(this.account.port)}: ${error.message}`,
            true,
            { host: this.account.host, port: this.account.port },
            { cause: error },
          ),
        );
      };
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Pop3ConnectionError(
            "POP3_CONNECTION_FAILED",
            `Timed out connecting to POP3 server ${this.account.host}:${String(this.account.port)}`,
            true,
            { host: this.account.host, port: this.account.port, timeoutMs: this.timeoutMs },
          ),
        );
      }, this.timeoutMs);
      const onReady = (): void => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve(socket);
      };
      const socket: Socket = implicitTls
        ? tlsConnect(this.tlsOptions(), onReady)
        : netConnect({ host: this.account.host, port: this.account.port }, onReady);
      socket.once("error", onError);
    });
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    socket.setTimeout(Math.max(this.timeoutMs * 3, MIN_POP3_SOCKET_IDLE_TIMEOUT_MS));
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("timeout", () => {
      this.failAll(
        new Pop3ConnectionError("POP3_CONNECTION_LOST", "POP3 connection timed out", true),
      );
      socket.destroy();
    });
    socket.on("error", (error: Error) => {
      this.failAll(
        new Pop3ConnectionError(
          "POP3_CONNECTION_LOST",
          `POP3 connection error: ${error.message}`,
          true,
          undefined,
          {
            cause: error,
          },
        ),
      );
    });
    socket.on("close", () => {
      this.closed = true;
      this.failAll(
        new Pop3ConnectionError(
          "POP3_CONNECTION_LOST",
          "POP3 connection closed unexpectedly",
          true,
        ),
      );
    });
  }

  private failAll(error: Error): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      waiter.reject(error);
    }
  }

  private destroy(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter === undefined) {
        return;
      }
      const lineEnd = this.buffer.indexOf(CRLF);
      if (lineEnd === -1) {
        return;
      }
      const statusLine = this.buffer.subarray(0, lineEnd).toString("latin1");
      const ok = statusLine.startsWith("+OK");
      const err = statusLine.startsWith("-ERR");
      if (!ok && !err) {
        this.waiters.shift();
        waiter.reject(
          new Pop3ConnectionError(
            "POP3_PROTOCOL_ERROR",
            "POP3 server sent an unexpected response",
            false,
          ),
        );
        this.buffer = this.buffer.subarray(lineEnd + CRLF.length);
        continue;
      }
      if (!waiter.multiline || err) {
        this.buffer = this.buffer.subarray(lineEnd + CRLF.length);
        this.waiters.shift();
        waiter.resolve({ status: statusLine, payload: Buffer.alloc(0) });
        continue;
      }
      // Multi-line: payload runs from after the status line up to CRLF.CRLF.
      const bodyStart = lineEnd + CRLF.length;
      const body = this.buffer.subarray(bodyStart);
      const terminatorIndex = body.indexOf(TERMINATOR);
      let payloadEnd: number;
      let consumed: number;
      if (
        body.length >= LONE_TERMINATOR.length &&
        body.subarray(0, LONE_TERMINATOR.length).equals(LONE_TERMINATOR)
      ) {
        // Empty multi-line payload: status line directly followed by ".\r\n".
        payloadEnd = 0;
        consumed = LONE_TERMINATOR.length;
      } else if (terminatorIndex !== -1) {
        payloadEnd = terminatorIndex + CRLF.length;
        consumed = terminatorIndex + TERMINATOR.length;
      } else {
        return;
      }
      const payload = unstuffDotLines(body.subarray(0, payloadEnd));
      this.buffer = this.buffer.subarray(bodyStart + consumed);
      this.waiters.shift();
      waiter.resolve({ status: statusLine, payload });
    }
  }

  private expect(multiline: boolean): Promise<{ status: string; payload: Buffer }> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Pop3ConnectionError("POP3_CONNECTION_LOST", "POP3 connection is closed", true));
        return;
      }
      this.waiters.push({ multiline, resolve, reject });
      this.drain();
    });
  }

  private async command(
    line: string,
    multiline: boolean,
  ): Promise<{ status: string; payload: Buffer }> {
    const socket = this.socket;
    if (socket === null || this.closed) {
      throw new Pop3ConnectionError("POP3_CONNECTION_LOST", "POP3 connection is closed", true);
    }
    const pending = this.expect(multiline);
    socket.write(`${line}${CRLF}`);
    return await pending;
  }

  private async readGreeting(): Promise<void> {
    const greeting = await this.expect(false);
    if (!greeting.status.startsWith("+OK")) {
      throw new Pop3ConnectionError(
        "POP3_CONNECTION_FAILED",
        "POP3 server rejected the connection",
        false,
      );
    }
  }

  private async upgradeWithStls(): Promise<void> {
    const response = await this.command("STLS", false);
    if (!response.status.startsWith("+OK")) {
      throw new Pop3ConnectionError(
        "POP3_STLS_UNSUPPORTED",
        "POP3 server does not support STLS on this port; use the implicit TLS port (usually 995)",
        false,
        { host: this.account.host, port: this.account.port },
      );
    }
    const plain = this.socket;
    if (plain === null) {
      throw new Pop3ConnectionError("POP3_CONNECTION_LOST", "POP3 connection is closed", true);
    }
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    plain.removeAllListeners("timeout");
    const upgraded = await new Promise<Socket>((resolve, reject) => {
      const secure = tlsConnect({ ...this.tlsOptions(), socket: plain }, () => {
        secure.off("error", onError);
        resolve(secure);
      });
      const onError = (error: Error): void => {
        reject(
          new Pop3ConnectionError(
            "POP3_CONNECTION_FAILED",
            `POP3 STLS negotiation failed: ${error.message}`,
            false,
            { host: this.account.host, port: this.account.port },
            { cause: error },
          ),
        );
      };
      secure.once("error", onError);
    });
    this.buffer = Buffer.alloc(0);
    this.attach(upgraded);
  }

  private async authenticate(): Promise<void> {
    assertSafeArgument(this.account.username, "username");
    assertSafeArgument(this.account.password, "password");
    const user = await this.command(`USER ${this.account.username}`, false);
    if (!user.status.startsWith("+OK")) {
      throw this.loginRejectionError(
        user.status,
        "POP3 server rejected the email address / username",
      );
    }
    const pass = await this.command(`PASS ${this.account.password}`, false);
    if (!pass.status.startsWith("+OK")) {
      throw this.loginRejectionError(
        pass.status,
        "POP3 authentication failed; check the email address / username and password",
      );
    }
  }

  /**
   * POP3 collapses every login problem into a `-ERR` reply to USER/PASS, but
   * not every `-ERR` means bad credentials: Gmail (and others) answer the same
   * way for a maildrop locked by another session (`[IN-USE]`), per-account
   * rate/bandwidth limits, login delays (`[LOGIN-DELAY]`) and temporary system
   * trouble (`[SYS/TEMP]`). Reporting those as "check the username and
   * password" sends an operator off to rotate perfectly good credentials while
   * the condition clears on its own. Classify by the reply's RFC 2449 response
   * code / wording, and always keep the server's own words in the message —
   * they are the only record of what actually went wrong.
   */
  private loginRejectionError(status: string, credentialMessage: string): Pop3ConnectionError {
    const serverText = status.replace(/^-ERR\s*/, "").trim();
    const details = { host: this.account.host, port: this.account.port };
    const transient =
      /\[IN-USE\]|\[LOGIN-DELAY\]|\[SYS\/TEMP\]|web login required|rate limit|exceeded|too many|temporar|try again/i.test(
        serverText,
      );
    if (transient) {
      return new Pop3ConnectionError(
        "POP3_LOGIN_TEMPORARILY_REJECTED",
        `POP3 server temporarily refused the login${serverText.length === 0 ? "" : `: ${serverText}`}. This is usually a busy-mailbox lock or a rate limit, not a credential problem; it normally clears on its own within minutes.`,
        true,
        details,
      );
    }
    return new Pop3ConnectionError(
      "POP3_AUTH_FAILED",
      `${credentialMessage}${serverText.length === 0 ? "" : ` (server said: ${serverText})`}`,
      false,
      details,
    );
  }

  private async okOrThrow(
    line: string,
    multiline: boolean,
    code: Pop3ErrorCode = "POP3_PROTOCOL_ERROR",
  ): Promise<{ status: string; payload: Buffer }> {
    const response = await this.command(line, multiline);
    if (!response.status.startsWith("+OK")) {
      throw new Pop3ConnectionError(
        code,
        `POP3 ${line.split(" ")[0] ?? line} failed: ${response.status.replace(/^-ERR\s*/, "") || "server error"}`,
        false,
      );
    }
    return response;
  }

  async capa(): Promise<string[]> {
    const response = await this.command("CAPA", true);
    if (!response.status.startsWith("+OK")) {
      return [];
    }
    return response.payload
      .toString("latin1")
      .split(CRLF)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  async stat(): Promise<{ count: number; sizeBytes: number }> {
    const response = await this.okOrThrow("STAT", false);
    const [, count, size] = response.status.split(/\s+/);
    return {
      count: Number.parseInt(count ?? "0", 10) || 0,
      sizeBytes: Number.parseInt(size ?? "0", 10) || 0,
    };
  }

  async list(): Promise<Pop3MessageListing[]> {
    const response = await this.okOrThrow("LIST", true);
    return parseNumberedListing(response.payload).map(([number, value]) => ({
      number,
      size: Number.parseInt(value, 10) || 0,
    }));
  }

  async uidl(): Promise<Pop3UidlListing[]> {
    const response = await this.okOrThrow("UIDL", true);
    return parseNumberedListing(response.payload).map(([number, value]) => ({
      number,
      uidl: value,
    }));
  }

  async top(messageNumber: number, lines: number): Promise<Buffer> {
    const response = await this.okOrThrow(
      `TOP ${String(assertMessageNumber(messageNumber))} ${String(Math.max(0, Math.trunc(lines)))}`,
      true,
    );
    return response.payload;
  }

  async retr(messageNumber: number): Promise<Buffer> {
    const response = await this.okOrThrow(
      `RETR ${String(assertMessageNumber(messageNumber))}`,
      true,
    );
    return response.payload;
  }

  async quit(): Promise<void> {
    if (this.closed || this.socket === null) {
      return;
    }
    try {
      await this.command("QUIT", false);
    } catch {
      // The server may close the socket before acknowledging QUIT; that is fine.
    } finally {
      this.destroy();
    }
  }
}

const assertMessageNumber = (value: number): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Pop3ConnectionError(
      "POP3_PROTOCOL_ERROR",
      `Invalid POP3 message number ${String(value)}`,
      false,
    );
  }
  return value;
};

const parseNumberedListing = (payload: Buffer): Array<[number, string]> =>
  payload
    .toString("latin1")
    .split(CRLF)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [numberText, value] = line.split(/\s+/, 2);
      const number = Number.parseInt(numberText ?? "", 10);
      if (!Number.isInteger(number) || number <= 0 || value === undefined) {
        return [];
      }
      return [[number, value] as [number, string]];
    });

/**
 * Open a POP3 session, run the handler, and always QUIT afterwards. Because
 * the client never issues DELE, QUIT commits nothing — the mailbox is left
 * exactly as it was found.
 */
export const runWithPop3Client = async <T>(
  input: {
    account: Pop3AccountCredentials;
    timeoutMs?: number;
    clientFactory?: (
      account: Pop3AccountCredentials,
      options: { timeoutMs?: number },
    ) => Promise<Pop3ClientLike>;
  },
  handler: (client: Pop3ClientLike) => Promise<T>,
): Promise<T> => {
  const factory = input.clientFactory ?? SocketPop3Client.connect;
  const client = await factory(
    input.account,
    input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
  );
  try {
    return await handler(client);
  } finally {
    await client.quit();
  }
};
