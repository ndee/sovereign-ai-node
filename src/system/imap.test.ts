import { createServer, type Server } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const runWithImapClientMock = vi.fn();
const listImapCapabilitiesMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

vi.mock("./imap-client.js", async () => {
  // Keep the real ImapConnectionError so instanceof checks behave; stub the
  // network-touching helpers so tests stay hermetic.
  const actual = await vi.importActual<typeof import("./imap-client.js")>("./imap-client.js");
  return {
    ...actual,
    runWithImapClient: (...args: unknown[]) => runWithImapClientMock(...args),
    listImapCapabilities: (...args: unknown[]) => listImapCapabilitiesMock(...args),
  };
});

import type { TestImapRequest } from "../contracts/api.js";
import { createLogger } from "../logging/logger.js";
import { SocketImapTester } from "./imap.js";
import { ImapConnectionError } from "./imap-client.js";

const baseReq = (overrides: Partial<TestImapRequest["imap"]> = {}): TestImapRequest => ({
  imap: {
    host: "imap.example.com",
    port: 993,
    tls: true,
    username: "user@example.com",
    password: "hunter2",
    ...overrides,
  },
});

describe("SocketImapTester", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    runWithImapClientMock.mockReset();
    listImapCapabilitiesMock.mockReset();
    listImapCapabilitiesMock.mockReturnValue([]);
  });

  afterEach(() => {
    delete process.env.IMAP_TEST_SECRET;
  });

  it("returns ok with capabilities when the connection succeeds", async () => {
    runWithImapClientMock.mockResolvedValueOnce(["IDLE", "MOVE"]);
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq({ mailbox: "Archive" }));

    expect(result).toEqual({
      ok: true,
      protocol: "imap",
      host: "imap.example.com",
      port: 993,
      tls: true,
      auth: "ok",
      mailbox: "Archive",
      capabilities: ["IDLE", "MOVE"],
    });
    const [, runner] = runWithImapClientMock.mock.calls[0] as [unknown, unknown];
    expect(typeof runner).toBe("function");
  });

  it("defaults the mailbox to INBOX and omits empty capabilities", async () => {
    runWithImapClientMock.mockResolvedValueOnce([]);
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq());

    expect(result).toMatchObject({ ok: true, mailbox: "INBOX", auth: "ok" });
    expect("capabilities" in result).toBe(false);
  });

  it("invokes the client callback to open the mailbox read-only and list capabilities", async () => {
    const mailboxOpen = vi.fn().mockResolvedValue(undefined);
    listImapCapabilitiesMock.mockReturnValueOnce(["UIDPLUS"]);
    runWithImapClientMock.mockImplementationOnce(async (_opts, cb) => cb({ mailboxOpen } as never));
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq({ mailbox: "Sent" }));

    expect(mailboxOpen).toHaveBeenCalledWith("Sent", { readOnly: true });
    expect(listImapCapabilitiesMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, capabilities: ["UIDPLUS"] });
  });

  it("fails when neither password nor secretRef is provided", async () => {
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq({ password: undefined, secretRef: undefined }));

    expect(result).toMatchObject({ ok: false, auth: "failed" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("IMAP_CREDENTIALS_MISSING");
    }
    expect(runWithImapClientMock).not.toHaveBeenCalled();
  });

  it("resolves a password from a file: secretRef and strips a trailing newline", async () => {
    readFileMock.mockResolvedValueOnce("filesecret\n");
    runWithImapClientMock.mockResolvedValueOnce([]);
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(
      baseReq({ password: undefined, secretRef: "file:/run/secrets/imap" }),
    );

    expect(readFileMock).toHaveBeenCalledWith("/run/secrets/imap", "utf8");
    const [opts] = runWithImapClientMock.mock.calls[0] as [{ account: { password: string } }];
    expect(opts.account.password).toBe("filesecret");
    expect(result).toMatchObject({ ok: true });
  });

  it("fails when a file: secretRef resolves to an empty secret", async () => {
    readFileMock.mockResolvedValueOnce("\n");
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(
      baseReq({ password: undefined, secretRef: "file:/run/secrets/empty" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("IMAP_SECRET_READ_FAILED");
      expect(result.error?.message).toContain("empty");
    }
  });

  it("fails when a file: secretRef cannot be read", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq({ password: undefined, secretRef: "file:/missing" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("IMAP_SECRET_READ_FAILED");
      expect(result.error?.details?.error).toBe("ENOENT: no such file");
    }
  });

  it("stringifies a non-Error file read rejection", async () => {
    readFileMock.mockRejectedValueOnce("disk on fire");
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq({ password: undefined, secretRef: "file:/missing" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.details?.error).toBe("disk on fire");
    }
  });

  it("resolves a password from an env: secretRef", async () => {
    process.env.IMAP_TEST_SECRET = "envsecret";
    runWithImapClientMock.mockResolvedValueOnce([]);
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(
      baseReq({ password: undefined, secretRef: "env:IMAP_TEST_SECRET" }),
    );

    const [opts] = runWithImapClientMock.mock.calls[0] as [{ account: { password: string } }];
    expect(opts.account.password).toBe("envsecret");
    expect(result).toMatchObject({ ok: true });
  });

  it("fails when the env: secretRef variable is unset", async () => {
    delete process.env.IMAP_TEST_SECRET;
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(
      baseReq({ password: undefined, secretRef: "env:IMAP_TEST_SECRET" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("IMAP_SECRET_READ_FAILED");
    }
  });

  it("fails for an unsupported secretRef scheme", async () => {
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq({ password: undefined, secretRef: "vault:/kv/imap" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("IMAP_SECRET_REF_UNSUPPORTED");
    }
  });

  it("maps an ImapConnectionError thrown during connection into the error detail", async () => {
    runWithImapClientMock.mockRejectedValueOnce(
      new ImapConnectionError("IMAP_TLS_FAILED", "tls handshake failed", true, { stage: "tls" }),
    );
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "IMAP_TLS_FAILED",
        message: "tls handshake failed",
        retryable: true,
        details: { stage: "tls" },
      });
    }
  });

  it("classifies a generic mailbox Error as IMAP_MAILBOX_OPEN_FAILED", async () => {
    runWithImapClientMock.mockRejectedValueOnce(new Error("mailbox does not exist"));
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("IMAP_MAILBOX_OPEN_FAILED");
    }
  });

  it("classifies a generic non-mailbox Error as IMAP_CONNECTION_FAILED", async () => {
    runWithImapClientMock.mockRejectedValueOnce(new Error("connection refused"));
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.code).toBe("IMAP_CONNECTION_FAILED");
    }
  });

  it("stringifies a thrown non-Error value", async () => {
    runWithImapClientMock.mockRejectedValueOnce("socket exploded");
    const tester = new SocketImapTester(createLogger());

    const result = await tester.test(baseReq());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "IMAP_CONNECTION_FAILED",
        message: "socket exploded",
        retryable: false,
      });
    }
  });
});

/** Tiny loopback POP3 responder: accepts exactly one password. */
const startPop3 = async (
  password: string,
): Promise<{ port: number; close: () => Promise<void> }> => {
  const server: Server = createServer((socket) => {
    socket.write("+OK ready\r\n");
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const [command, ...args] = line.split(" ");
        switch (command) {
          case "USER":
            socket.write("+OK\r\n");
            break;
          case "PASS":
            socket.write(args.join(" ") === password ? "+OK\r\n" : "-ERR nope\r\n");
            break;
          case "STAT":
            socket.write("+OK 2 400\r\n");
            break;
          case "CAPA":
            socket.write("+OK\r\nUIDL\r\nTOP\r\n.\r\n");
            break;
          case "QUIT":
            socket.write("+OK\r\n");
            socket.end();
            break;
          default:
            socket.write("-ERR\r\n");
        }
        index = buffer.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("SocketImapTester (POP3 branch)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((close) => close()));
  });

  it("validates POP3 credentials read-only and reports the protocol", async () => {
    const server = await startPop3("app-password");
    cleanups.push(server.close);
    const tester = new SocketImapTester(createLogger(), 2_000);
    const result = await tester.test({
      imap: {
        protocol: "pop3",
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        username: "ops@example.org",
        password: "app-password",
        mailbox: "Ignored",
      },
    });
    expect(result).toMatchObject({
      ok: true,
      protocol: "pop3",
      auth: "ok",
      mailbox: "INBOX",
      capabilities: ["UIDL", "TOP"],
    });
  });

  it("maps POP3 auth failures to a structured error that never contains the password", async () => {
    const server = await startPop3("app-password");
    cleanups.push(server.close);
    const tester = new SocketImapTester(createLogger(), 2_000);
    const result = await tester.test({
      imap: {
        protocol: "pop3",
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        username: "ops@example.org",
        password: "totally-wrong",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.auth).toBe("failed");
    expect(result.error?.code).toBe("POP3_AUTH_FAILED");
    expect(JSON.stringify(result)).not.toContain("totally-wrong");
  });

  it("refuses plaintext POP3 to a remote host", async () => {
    const tester = new SocketImapTester(createLogger(), 2_000);
    const result = await tester.test({
      imap: {
        protocol: "pop3",
        host: "pop.example.org",
        port: 110,
        tls: false,
        username: "ops@example.org",
        password: "x",
      },
    });
    expect(result.error?.code).toBe("POP3_PLAINTEXT_REFUSED");
  });

  it("reports missing credentials with a protocol-neutral message", async () => {
    const tester = new SocketImapTester(createLogger(), 2_000);
    const result = await tester.test({
      imap: { host: "127.0.0.1", port: 993, tls: true, username: "ops@example.org" },
    });
    expect(result.error?.code).toBe("IMAP_CREDENTIALS_MISSING");
    expect(result.protocol).toBe("imap");
  });
});
