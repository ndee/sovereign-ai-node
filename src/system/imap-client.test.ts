import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  buildImapConnectionPlans,
  type ImapClientLike,
  ImapConnectionError,
  runWithImapClient,
} from "./imap-client.js";

const createNoopClient = (): ImapClientLike => ({
  authenticated: false,
  capabilities: new Map(),
  close: () => {},
  connect: async () => {},
  fetchAll: async () => [],
  fetchOne: async () => false,
  getMailboxLock: async () => ({
    path: "INBOX",
    release: () => {},
  }),
  logout: async () => {},
  mailbox: false,
  mailboxOpen: async () => ({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    uidValidity: 1n,
    uidNext: 1,
    exists: 0,
  }),
  search: async () => [],
});

const account = {
  host: "imap.example.com",
  port: 993,
  tls: true,
  username: "user",
  password: "pass",
};

/**
 * A client double with a real EventEmitter behind `on`/`off`, so a test can
 * make it "emit 'error'" the way imapflow does on a socket timeout.
 */
const createEmittingClient = (): ImapClientLike & { emitter: EventEmitter } => {
  const emitter = new EventEmitter();
  const client = createNoopClient() as ImapClientLike & { emitter: EventEmitter };
  client.emitter = emitter;
  client.on = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.on(event, listener);
    return client;
  }) as unknown as NonNullable<ImapClientLike["on"]>;
  client.off = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.off(event, listener);
    return client;
  }) as unknown as NonNullable<ImapClientLike["off"]>;
  client.connect = async () => {
    client.authenticated = "user";
  };
  return client;
};

describe("imap-client", () => {
  it("floors the idle socket timeout at 60s and keeps connect/greeting at the call timeout (#231)", () => {
    const [plan] = buildImapConnectionPlans({ account, timeoutMs: 10_000 });
    expect(plan?.options.connectionTimeout).toBe(10_000);
    expect(plan?.options.greetingTimeout).toBe(10_000);
    expect(plan?.options.socketTimeout).toBe(60_000);

    const [generous] = buildImapConnectionPlans({ account, timeoutMs: 30_000 });
    expect(generous?.options.socketTimeout).toBe(90_000);
  });

  describe("client 'error' events (#231)", () => {
    it("turns an emitted socket timeout into a structured, retryable connection error", async () => {
      const client = createEmittingClient();
      await expect(
        runWithImapClient({ account, clientFactory: () => client }, async () => {
          // imapflow: the socket idles out, the client emits 'error' and tears
          // the connection down, which rejects the in-flight command generically.
          client.emitter.emit(
            "error",
            Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" }),
          );
          throw new Error("Connection not available");
        }),
      ).rejects.toMatchObject({
        name: "ImapConnectionError",
        code: "IMAP_CONNECTION_LOST",
        retryable: true,
        message: "IMAP connection lost during implicit-tls session: Socket timeout",
        details: {
          strategy: "implicit-tls",
          reason: "Socket timeout",
          code: "ETIMEOUT",
          handlerError: "Connection not available",
        },
      });
      // The listener is removed again, so the next emit has no subscriber left.
      expect(client.emitter.listenerCount("error")).toBe(0);
    });

    it("keeps the first emitted error when several arrive", async () => {
      const client = createEmittingClient();
      await expect(
        runWithImapClient({ account, clientFactory: () => client }, async () => {
          client.emitter.emit("error", new Error("first"));
          client.emitter.emit("error", new Error("second"));
          throw new Error("closed");
        }),
      ).rejects.toMatchObject({ code: "IMAP_CONNECTION_LOST", details: { reason: "first" } });
    });

    it("does not wrap an ImapConnectionError the handler raised itself", async () => {
      const client = createEmittingClient();
      const own = new ImapConnectionError("IMAP_AUTH_FAILED", "own", false);
      await expect(
        runWithImapClient({ account, clientFactory: () => client }, async () => {
          client.emitter.emit("error", new Error("Socket timeout"));
          throw own;
        }),
      ).rejects.toBe(own);
    });

    it("passes a handler failure through unchanged when nothing was emitted", async () => {
      const client = createEmittingClient();
      const failure = new Error("plain failure");
      await expect(
        runWithImapClient({ account, clientFactory: () => client }, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(client.emitter.listenerCount("error")).toBe(0);
    });

    it("records a non-Error emitted value and omits a missing code", async () => {
      const client = createEmittingClient();
      await expect(
        runWithImapClient({ account, clientFactory: () => client }, async () => {
          client.emitter.emit("error", "stringy");
          throw new Error("closed");
        }),
      ).rejects.toMatchObject({
        code: "IMAP_CONNECTION_LOST",
        details: { reason: "stringy", handlerError: "closed" },
      });
    });

    it("removes the listener when connect itself fails", async () => {
      const client = createEmittingClient();
      client.connect = async () => {
        throw new Error("connect refused");
      };
      await expect(
        runWithImapClient({ account, clientFactory: () => client }, async () => "unreachable"),
      ).rejects.toMatchObject({ code: "IMAP_CONNECTION_FAILED" });
      expect(client.emitter.listenerCount("error")).toBe(0);
    });

    it("works with a client double that has no event API", async () => {
      const client = createNoopClient();
      client.connect = async () => {
        client.authenticated = "user";
      };
      await expect(
        runWithImapClient({ account, clientFactory: () => client }, async () => "ok"),
      ).resolves.toBe("ok");
    });
  });

  it("prefers STARTTLS and relaxes TLS verification for Proton Bridge style loopback configs", () => {
    const plans = buildImapConnectionPlans({
      account: {
        host: "127.0.0.1",
        port: 1143,
        tls: true,
        username: "bridge-user",
        password: "bridge-pass",
      },
    });

    expect(plans.map((plan) => plan.label)).toEqual(["starttls", "implicit-tls"]);
    expect(plans[0]?.options.secure).toBe(false);
    expect(plans[0]?.options.doSTARTTLS).toBe(true);
    expect(plans[0]?.options.tls?.rejectUnauthorized).toBe(false);
    expect(plans[1]?.options.secure).toBe(true);
    expect(plans[1]?.options.tls?.rejectUnauthorized).toBe(false);
  });

  it("uses implicit TLS only for standard remote port 993 configs", () => {
    const plans = buildImapConnectionPlans({
      account: {
        host: "imap.example.org",
        port: 993,
        tls: true,
        username: "operator@example.org",
        password: "secret",
      },
    });

    expect(plans.map((plan) => plan.label)).toEqual(["implicit-tls"]);
    expect(plans[0]?.options.secure).toBe(true);
  });

  it("falls back to the next TLS strategy when the first attempt fails", async () => {
    const connectedStrategies: string[] = [];
    const closedStrategies: string[] = [];
    const loggedOutStrategies: string[] = [];

    const result = await runWithImapClient(
      {
        account: {
          host: "127.0.0.1",
          port: 1143,
          tls: true,
          username: "bridge-user",
          password: "bridge-pass",
        },
        clientFactory: (options) => {
          const label =
            options.doSTARTTLS === true
              ? "starttls"
              : options.secure === true
                ? "implicit-tls"
                : "plain";
          const client = createNoopClient();
          client.connect = async () => {
            connectedStrategies.push(label);
            if (label === "starttls") {
              throw new Error("STARTTLS not available");
            }
            client.authenticated = "bridge-user";
          };
          client.close = () => {
            closedStrategies.push(label);
          };
          client.logout = async () => {
            loggedOutStrategies.push(label);
          };
          return client;
        },
      },
      async (_client, plan) => plan.label,
    );

    expect(result).toBe("implicit-tls");
    expect(connectedStrategies).toEqual(["starttls", "implicit-tls"]);
    expect(closedStrategies).toEqual(["starttls"]);
    expect(loggedOutStrategies).toEqual(["implicit-tls"]);
  });
});
