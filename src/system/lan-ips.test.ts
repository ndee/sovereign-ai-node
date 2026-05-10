import { describe, expect, it } from "vitest";

import { detectLanIPv4 } from "./lan-ips.js";

const makeIface = (overrides: Record<string, unknown> = {}) => ({
  address: "10.0.0.1",
  netmask: "255.0.0.0",
  family: "IPv4" as const,
  mac: "aa:bb:cc:dd:ee:ff",
  internal: false,
  cidr: null,
  ...overrides,
});

describe("detectLanIPv4", () => {
  it("returns RFC1918 addresses, sorted by range preference", () => {
    const addrs = detectLanIPv4({
      eth0: [makeIface({ address: "192.168.0.181" })],
      eth1: [makeIface({ address: "10.42.0.5" })],
      eth2: [makeIface({ address: "172.20.5.7" })],
    });
    // 10/8 first, then 192.168/16, then 172.16/12 — order matches the
    // PRIVATE_RANGES array in lan-ips.ts.
    expect(addrs).toEqual(["10.42.0.5", "192.168.0.181", "172.20.5.7"]);
  });

  it("excludes loopback and link-local", () => {
    const addrs = detectLanIPv4({
      lo: [makeIface({ address: "127.0.0.1", internal: true })],
      eth0: [makeIface({ address: "192.168.1.10" })],
      eth1: [makeIface({ address: "169.254.5.5" })],
    });
    expect(addrs).toEqual(["192.168.1.10"]);
  });

  it("excludes IPv6 entries", () => {
    const addrs = detectLanIPv4({
      eth0: [
        makeIface({ address: "192.168.5.5" }),
        makeIface({ family: "IPv6", address: "fe80::1" }),
      ],
    });
    expect(addrs).toEqual(["192.168.5.5"]);
  });

  it("includes public IPv4 addresses after RFC1918, sorted alphabetically among themselves", () => {
    const addrs = detectLanIPv4({
      eth0: [makeIface({ address: "192.168.0.5" })],
      eth1: [makeIface({ address: "203.0.113.10" })],
      eth2: [makeIface({ address: "198.51.100.7" })],
    });
    expect(addrs).toEqual(["192.168.0.5", "198.51.100.7", "203.0.113.10"]);
  });

  it("de-duplicates addresses", () => {
    const addrs = detectLanIPv4({
      eth0: [makeIface({ address: "192.168.0.10" })],
      eth0Alias: [makeIface({ address: "192.168.0.10" })],
    });
    expect(addrs).toEqual(["192.168.0.10"]);
  });

  it("returns empty array when no candidates", () => {
    expect(
      detectLanIPv4({
        lo: [makeIface({ address: "127.0.0.1", internal: true })],
      }),
    ).toEqual([]);
  });
});
