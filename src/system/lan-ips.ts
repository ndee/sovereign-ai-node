import { networkInterfaces } from "node:os";

const PRIVATE_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/**
 * Returns all IPv4 addresses on non-loopback, non-internal network
 * interfaces of this host. Preferred for LAN-reachable URLs / certs.
 *
 * - RFC1918 ranges (10/8, 172.16/12, 192.168/16) come first.
 * - Public IPv4 addresses come next (a node directly on a public IP).
 * - Loopback (127.0.0.0/8) and link-local (169.254.x) are excluded.
 *
 * If none are found, returns an empty array.
 */
export const detectLanIPv4 = (
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] => {
  const found: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (list === undefined) continue;
    for (const entry of list) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4") continue;
      const addr = entry.address;
      if (addr.startsWith("127.")) continue;
      if (addr.startsWith("169.254.")) continue;
      found.push(addr);
    }
  }
  // Sort: RFC1918 first (in declared order), then everything else, then alphabetic.
  found.sort((a, b) => {
    const pa = PRIVATE_RANGES.findIndex((re) => re.test(a));
    const pb = PRIVATE_RANGES.findIndex((re) => re.test(b));
    const wa = pa === -1 ? PRIVATE_RANGES.length : pa;
    const wb = pb === -1 ? PRIVATE_RANGES.length : pb;
    if (wa !== wb) return wa - wb;
    return a.localeCompare(b);
  });
  // De-dup while preserving order.
  return Array.from(new Set(found));
};
