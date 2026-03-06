import { describe, expect, it } from "vitest";

import {
  buildImapConnectionPlans,
  runWithImapClient,
  type ImapClientLike,
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

describe("imap-client", () => {
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
          const label = options.doSTARTTLS === true
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
