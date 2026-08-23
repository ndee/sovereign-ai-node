import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import { SocketImapTester } from "./imap.js";

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
