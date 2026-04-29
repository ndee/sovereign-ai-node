import { describe, expect, it } from "vitest";

import { createSessionStore } from "./sessions.js";

const seq = (start = 0): (() => string) => {
  let n = start;
  return () => `id-${++n}`;
};

describe("createSessionStore", () => {
  it("creates sessions with sid, csrf, principal, and expiresAt", () => {
    const store = createSessionStore({ ttlMs: 1000, now: () => 100, generateId: seq() });
    const session = store.create({ kind: "bootstrap", username: "admin" });
    expect(session).toEqual({
      sid: "id-1",
      csrf: "id-2",
      principal: { kind: "bootstrap", username: "admin" },
      expiresAt: 1100,
    });
    expect(store.get("id-1")).toEqual(session);
  });

  it("returns null for missing or empty sid", () => {
    const store = createSessionStore({ ttlMs: 1000 });
    expect(store.get(undefined)).toBeNull();
    expect(store.get("")).toBeNull();
    expect(store.get("never-issued")).toBeNull();
  });

  it("expires sessions after ttl elapses", () => {
    let t = 100;
    const store = createSessionStore({ ttlMs: 1000, now: () => t, generateId: seq() });
    const session = store.create({ kind: "matrix", username: "@admin:example" });
    expect(store.get(session.sid)).not.toBeNull();
    t = 1101;
    expect(store.get(session.sid)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("revokes sessions immediately", () => {
    const store = createSessionStore({ ttlMs: 1000, generateId: seq() });
    const session = store.create({ kind: "bootstrap", username: "admin" });
    store.revoke(session.sid);
    expect(store.get(session.sid)).toBeNull();
  });

  it("gc removes expired sessions", () => {
    let t = 0;
    const store = createSessionStore({ ttlMs: 1000, now: () => t, generateId: seq() });
    store.create({ kind: "bootstrap", username: "a" }); // expires at 1000
    t = 500;
    store.create({ kind: "bootstrap", username: "b" }); // expires at 1500
    expect(store.size()).toBe(2);
    t = 1200;
    store.gc();
    expect(store.size()).toBe(1);
    t = 1600;
    store.gc();
    expect(store.size()).toBe(0);
  });

  it("uses crypto-random ids when generateId is omitted", () => {
    const store = createSessionStore({ ttlMs: 1000 });
    const session = store.create({ kind: "bootstrap", username: "admin" });
    expect(session.sid.length).toBeGreaterThanOrEqual(40);
    expect(session.csrf.length).toBeGreaterThanOrEqual(40);
    expect(session.sid).not.toBe(session.csrf);
  });
});
