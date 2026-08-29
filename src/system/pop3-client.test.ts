import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  Pop3ConnectionError,
  runWithPop3Client,
  SocketPop3Client,
  unstuffDotLines,
} from "./pop3-client.js";

type FakeMessage = { uidl: string; raw: string };

/**
 * Minimal in-process POP3 server speaking plaintext on loopback (the client
 * allows plaintext only for loopback hosts, which is exactly what makes this
 * fixture hermetic). Records every command so tests can assert that DELE is
 * never sent.
 */
const startFakePop3 = async (options: {
  messages: FakeMessage[];
  password?: string;
  stls?: boolean;
  greeting?: string;
  /** Full `-ERR …` line the server sends for a wrong password. */
  passFailureReply?: string;
}): Promise<{ port: number; commands: string[]; close: () => Promise<void> }> => {
  const commands: string[] = [];
  const password = options.password ?? "secret";
  const server: Server = createServer((socket: Socket) => {
    let authenticatedUser: string | null = null;
    let buffer = "";
    socket.write(`${options.greeting ?? "+OK fake pop3 ready"}\r\n`);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        commands.push(line.split(" ")[0] === "PASS" ? "PASS <redacted>" : line);
        const [command, ...args] = line.split(" ");
        switch ((command ?? "").toUpperCase()) {
          case "CAPA":
            socket.write(`+OK\r\nUIDL\r\nTOP\r\n${options.stls === true ? "STLS\r\n" : ""}.\r\n`);
            break;
          case "STLS":
            socket.write("-ERR not supported here\r\n");
            break;
          case "USER":
            authenticatedUser = args[0] ?? null;
            socket.write("+OK\r\n");
            break;
          case "PASS":
            socket.write(
              args.join(" ") === password
                ? "+OK logged in\r\n"
                : `${options.passFailureReply ?? "-ERR auth failed"}\r\n`,
            );
            break;
          case "STAT":
            socket.write(
              `+OK ${String(options.messages.length)} ${String(
                options.messages.reduce((sum, entry) => sum + entry.raw.length, 0),
              )}\r\n`,
            );
            break;
          case "LIST":
            socket.write(
              `+OK\r\n${options.messages
                .map((entry, position) => `${String(position + 1)} ${String(entry.raw.length)}`)
                .join("\r\n")}${options.messages.length > 0 ? "\r\n" : ""}.\r\n`,
            );
            break;
          case "UIDL":
            socket.write(
              `+OK\r\n${options.messages
                .map((entry, position) => `${String(position + 1)} ${entry.uidl}`)
                .join("\r\n")}${options.messages.length > 0 ? "\r\n" : ""}.\r\n`,
            );
            break;
          case "TOP":
          case "RETR": {
            const message = options.messages[Number.parseInt(args[0] ?? "0", 10) - 1];
            if (message === undefined) {
              socket.write("-ERR no such message\r\n");
              break;
            }
            const body =
              command === "TOP"
                ? `${message.raw.split("\r\n\r\n")[0] ?? message.raw}\r\n\r\n`
                : message.raw;
            const stuffed = body
              .split("\r\n")
              .map((entry) => (entry.startsWith(".") ? `.${entry}` : entry))
              .join("\r\n");
            socket.write(`+OK\r\n${stuffed}${stuffed.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
            break;
          }
          case "DELE":
            socket.write("+OK marked\r\n");
            break;
          case "QUIT":
            socket.write("+OK bye\r\n");
            socket.end();
            break;
          default:
            socket.write("-ERR unknown\r\n");
        }
        index = buffer.indexOf("\r\n");
      }
    });
    void authenticatedUser;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    commands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const SAMPLE_RAW = [
  "From: Alice <alice@example.org>",
  "To: ops@example.org",
  "Subject: Invoice overdue",
  "Message-ID: <one@example.org>",
  "Date: Mon, 10 Aug 2026 10:00:00 +0000",
  "",
  "Body line",
  ". leading dot line",
  "",
].join("\r\n");

describe("SocketPop3Client", () => {
  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((close) => close()));
  });

  it("authenticates, lists, fetches and never issues DELE", async () => {
    const fake = await startFakePop3({ messages: [{ uidl: "u1", raw: SAMPLE_RAW }] });
    servers.push(fake.close);

    const result = await runWithPop3Client(
      {
        account: {
          host: "127.0.0.1",
          port: fake.port,
          tls: false,
          username: "ops@example.org",
          password: "secret",
        },
      },
      async (client) => {
        const stat = await client.stat();
        const list = await client.list();
        const uidl = await client.uidl();
        const top = await client.top(1, 0);
        const retr = await client.retr(1);
        const capa = await client.capa();
        return {
          stat,
          list,
          uidl,
          top: top.toString("latin1"),
          retr: retr.toString("latin1"),
          capa,
        };
      },
    );

    expect(result.stat.count).toBe(1);
    expect(result.list).toEqual([{ number: 1, size: SAMPLE_RAW.length }]);
    expect(result.uidl).toEqual([{ number: 1, uidl: "u1" }]);
    expect(result.top).toContain("Subject: Invoice overdue");
    expect(result.retr).toBe(SAMPLE_RAW);
    expect(result.capa).toEqual(["UIDL", "TOP"]);
    expect(fake.commands).toContain("QUIT");
    expect(fake.commands.some((entry) => entry.startsWith("DELE"))).toBe(false);
    expect(fake.commands.join("\n")).not.toContain("secret");
  });

  it("reports POP3_AUTH_FAILED on a rejected password without leaking it", async () => {
    const fake = await startFakePop3({ messages: [] });
    servers.push(fake.close);

    await expect(
      SocketPop3Client.connect({
        host: "127.0.0.1",
        port: fake.port,
        tls: false,
        username: "ops@example.org",
        password: "wrong-password",
      }),
    ).rejects.toMatchObject({ code: "POP3_AUTH_FAILED" });
    const error: unknown = await SocketPop3Client.connect({
      host: "127.0.0.1",
      port: fake.port,
      tls: false,
      username: "ops@example.org",
      password: "wrong-password",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Pop3ConnectionError);
    const serialized = JSON.stringify({
      ...(error as Pop3ConnectionError),
      message: (error as Pop3ConnectionError).message,
    });
    expect(serialized).not.toContain("wrong-password");
  });

  it("keeps the server's own words in a genuine credential rejection", async () => {
    const fake = await startFakePop3({
      messages: [],
      passFailureReply: "-ERR [AUTH] Username and password not accepted",
    });
    servers.push(fake.close);
    const error: unknown = await SocketPop3Client.connect({
      host: "127.0.0.1",
      port: fake.port,
      tls: false,
      username: "ops@example.org",
      password: "wrong-password",
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "POP3_AUTH_FAILED",
      retryable: false,
    });
    expect((error as Pop3ConnectionError).message).toContain(
      "server said: [AUTH] Username and password not accepted",
    );
  });

  it.each([
    "-ERR [IN-USE] Unable to lock maildrop: mailbox is locked by another POP session",
    "-ERR [AUTH] Account exceeded pop command or bandwidth limits (Failure)",
    "-ERR [LOGIN-DELAY] Minimum time between logins not met",
    "-ERR [SYS/TEMP] Temporary system problem. Please try again later.",
    "-ERR [AUTH] Web login required: https://support.google.com/mail/answer/78754",
  ])("classifies a transient login refusal as retryable, not bad credentials: %s", async (reply) => {
    // Gmail answers PASS with these while the credentials are perfectly fine
    // (mailbox lock held by a concurrent session, per-account rate limits).
    // Telling the operator to check the password would send them rotating
    // working credentials for a condition that clears on its own.
    const fake = await startFakePop3({ messages: [], passFailureReply: reply });
    servers.push(fake.close);
    const error: unknown = await SocketPop3Client.connect({
      host: "127.0.0.1",
      port: fake.port,
      tls: false,
      username: "ops@example.org",
      password: "wrong-password",
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "POP3_LOGIN_TEMPORARILY_REJECTED",
      retryable: true,
    });
    const message = (error as Pop3ConnectionError).message;
    expect(message).toContain(reply.replace(/^-ERR\s*/, ""));
    expect(message).not.toContain("check the email address / username and password");
    expect(JSON.stringify({ message })).not.toContain("wrong-password");
  });

  it("refuses plaintext for non-loopback hosts before opening a socket", async () => {
    await expect(
      SocketPop3Client.connect({
        host: "pop.example.org",
        port: 110,
        tls: false,
        username: "ops@example.org",
        password: "secret",
      }),
    ).rejects.toMatchObject({ code: "POP3_PLAINTEXT_REFUSED" });
  });

  it("fails with POP3_STLS_UNSUPPORTED when TLS is requested on port 110 and STLS is refused", async () => {
    const fake = await startFakePop3({ messages: [] });
    servers.push(fake.close);
    await expect(
      SocketPop3Client.connect(
        {
          host: "127.0.0.1",
          port: fake.port,
          tls: true,
          username: "ops@example.org",
          password: "secret",
        },
        { startTls: true },
      ).then(async (client) => {
        await client.quit();
      }),
    ).rejects.toMatchObject({ code: "POP3_STLS_UNSUPPORTED" });
  }, 15_000);

  it("rejects a server greeting that is not +OK", async () => {
    const fake = await startFakePop3({ messages: [], greeting: "-ERR maintenance" });
    servers.push(fake.close);
    await expect(
      SocketPop3Client.connect({
        host: "127.0.0.1",
        port: fake.port,
        tls: false,
        username: "ops@example.org",
        password: "secret",
      }),
    ).rejects.toMatchObject({ code: "POP3_CONNECTION_FAILED" });
  });

  it("rejects credentials containing line breaks instead of sending them", async () => {
    const fake = await startFakePop3({ messages: [] });
    servers.push(fake.close);
    await expect(
      SocketPop3Client.connect({
        host: "127.0.0.1",
        port: fake.port,
        tls: false,
        username: "ops@example.org\r\nDELE 1",
        password: "secret",
      }),
    ).rejects.toMatchObject({ code: "POP3_PROTOCOL_ERROR" });
    expect(fake.commands.some((entry) => entry.startsWith("DELE"))).toBe(false);
  });

  it("reports a connection failure for a closed port", async () => {
    const probe = await startFakePop3({ messages: [] });
    const port = probe.port;
    await probe.close();
    await expect(
      SocketPop3Client.connect(
        { host: "127.0.0.1", port, tls: false, username: "a", password: "b" },
        { timeoutMs: 2_000 },
      ),
    ).rejects.toMatchObject({ code: "POP3_CONNECTION_FAILED" });
  });
});

describe("pop3 helpers", () => {
  it("unstuffs RFC 1939 dot lines", () => {
    expect(unstuffDotLines(Buffer.from("a\r\n..b\r\n...c\r\n")).toString()).toBe(
      "a\r\n.b\r\n..c\r\n",
    );
    expect(unstuffDotLines(Buffer.from("plain\r\n")).toString()).toBe("plain\r\n");
  });

  it("detects loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("pop.example.org")).toBe(false);
  });
});
