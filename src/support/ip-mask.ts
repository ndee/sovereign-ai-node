/**
 * IP and MAC address masking for diagnostics exports.
 *
 * A diagnostics file is meant to be read and then handed to someone else. A
 * public IP address in it identifies the household it came from; a MAC
 * address (standalone, inside an EUI-64 IPv6 interface id, or in a USB NIC
 * name like `enx<mac>`) identifies the hardware. Neither is needed to explain
 * an install failure — the address CLASS is ("was IPv4 or IPv6 used, and was
 * the IPv6 address global?") and so is address EQUALITY ("did both names
 * resolve to the same address?"). So every identifying address becomes a
 * class token with a per-bundle sequence number:
 *
 *     203.0.113.7:443        → <public-ipv4#1>:443
 *     [2001:db8::1]:993      → [<global-ipv6#1>]:993
 *     fe80::1%eth0           → <link-local-ipv6#1>%eth0
 *     aa:bb:cc:dd:ee:ff      → <mac#1>
 *     enxaabbccddeeff        → enx<mac#1>
 *
 * Addresses inside the home network (RFC 1918), loopback, unspecified,
 * IPv4 link-local, multicast and broadcast stay readable: they identify
 * nothing outside the LAN and are often exactly what a diagnosis needs.
 * Documentation ranges are treated as PUBLIC on purpose, so tests can use them
 * as stand-ins for real addresses.
 *
 * # Two stages: liberal candidate scan, strict parse
 *
 * Bounded regexes find candidates (including `%3A`-encoded colons, so an
 * address in a URL query is masked rather than merely withheld). Each
 * candidate is then parsed strictly; anything that does not parse —
 * `12:34:56`, `std::vector`, a 5-part dotted version — is left alone.
 *
 * # Numbers mean nothing outside one bundle
 *
 * `#n` is a first-seen ordinal per class, issued by one `IpMasker` shared by
 * every file of one bundle. The same address gets the same number in every
 * file of that bundle; a new bundle starts again at 1, so two bundles cannot be
 * linked through the tokens.
 *
 * Pure TypeScript with no `node:` imports, so a browser port can be checked
 * against it byte for byte.
 */

import { decodeEscapes } from "./shape-guard.js";

export type IpClass =
  | "public-ipv4"
  | "cgnat-ipv4"
  | "global-ipv6"
  | "link-local-ipv6"
  | "ula-ipv6"
  | "multicast-ipv6"
  | "other-ipv6";

export type MaskClass = IpClass | "mac";

/** Every token class, in a stable order (manifest counts use it). */
export const MASK_CLASSES: readonly MaskClass[] = [
  "public-ipv4",
  "cgnat-ipv4",
  "global-ipv6",
  "link-local-ipv6",
  "ula-ipv6",
  "multicast-ipv6",
  "other-ipv6",
  "mac",
];

// ── Candidate scan ─────────────────────────────────────────────────────────

/**
 * What may precede a candidate: start of text, a non-word character, a
 * percent escape (`%3D2001:…`), or a JSON/JS escape (`\n2001:…`, `"2001:…`).
 * A letter or digit directly before it means it is part of a longer token.
 */
const BEFORE = String.raw`(?<=^|[^0-9A-Za-z_.]|%[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|\\[bfnrt])`;
/** Same for IPv4, which additionally never follows `@` (`pkg@1.2.3.4`). */
const BEFORE_V4 = String.raw`(?<=^|[^0-9A-Za-z_.@]|%[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|\\[bfnrt])`;

/** A colon, literal or percent-encoded. */
const COLON = "(?::|%3[Aa])";
const HEX = "[0-9A-Fa-f]";
const DOTTED = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;

/**
 * IPv6 candidate: 2–9 colon-terminated hex groups (9 admits a trailing
 * `:port`), an optional last group or dotted-quad tail, an optional zone id.
 * Every repetition consumes a colon, so backtracking is linear.
 */
const IPV6_RE = new RegExp(
  String.raw`${BEFORE}((?:${HEX}{0,4}${COLON}){2,9}(?:${DOTTED}|${HEX}{1,4})?)(%(?!3[Aa])(?:25)?[0-9A-Za-z_.-]{1,32})?(?![0-9A-Za-z_:]|%3[Aa]|\.\d)`,
  "gu",
);

const IPV4_RE = new RegExp(
  String.raw`${BEFORE_V4}(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![0-9A-Za-z_]|\.\d)`,
  "gu",
);

const MAC_RE = new RegExp(
  String.raw`(?<![0-9A-Za-z_:-])(${HEX}{2}(?:(?::|%3[Aa]|-)${HEX}{2}){5})(?![0-9A-Za-z_:-]|%3[Aa])`,
  "gu",
);

/** Predictable interface names that embed the MAC (USB ethernet, USB wifi). */
const MAC_IFNAME_RE = new RegExp(
  String.raw`(?<![0-9A-Za-z_])(enx|wlx)(${HEX}{12})(?![0-9A-Za-z_])`,
  "gu",
);

/**
 * A dotted quad right after a `ver` / `version` keyword in the same token is a
 * version string, not an address (`version=1.2.3.4`, `"openclawVersion":"…`).
 */
const VERSION_PREFIX_RE =
  /(?:(?:^|[^A-Za-z])[Vv][Ee][Rr](?:[Ss][Ii][Oo][Nn])?|[a-z]Version)[^\sA-Za-z0-9]{0,4}$/u;

// ── Strict parse ───────────────────────────────────────────────────────────

/** Parse a dotted quad strictly: four octets ≤ 255, no leading zeros. */
export const parseIpv4 = (text: string): number[] | undefined => {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) {
      return undefined;
    }
    const value = Number(part);
    if (value > 255) {
      return undefined;
    }
    octets.push(value);
  }
  return octets;
};

/**
 * Parse an IPv6 address (colons already decoded, no zone) into eight 16-bit
 * groups: ≤ 8 groups, at most one `::`, an embedded dotted quad only in the
 * last 32 bits.
 */
export const parseIpv6 = (text: string): number[] | undefined => {
  let body = text;
  const tail: number[] = [];
  const lastColon = body.lastIndexOf(":");
  if (body.includes(".")) {
    const octets = parseIpv4(body.slice(lastColon + 1));
    if (octets === undefined) {
      return undefined;
    }
    tail.push(((octets[0] as number) << 8) | (octets[1] as number));
    tail.push(((octets[2] as number) << 8) | (octets[3] as number));
    // Drop the colon before the tail, but keep a "::" intact ("1::1.2.3.4").
    body = body.slice(0, Math.max(0, lastColon));
    if (body.endsWith(":")) {
      body = `${body}:`;
    }
  }
  const halves = body.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const parseGroups = (half: string): number[] | undefined => {
    if (half.length === 0) {
      return [];
    }
    const groups: number[] = [];
    for (const group of half.split(":")) {
      if (!/^[0-9A-Fa-f]{1,4}$/u.test(group)) {
        return undefined;
      }
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] as string);
  const rest = halves.length === 2 ? parseGroups(halves[1] as string) : [];
  if (head === undefined || rest === undefined) {
    return undefined;
  }
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (explicit > 7) {
      return undefined;
    }
    return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest, ...tail];
  }
  return explicit === 8 ? [...head, ...tail] : undefined;
};

// ── Classification ─────────────────────────────────────────────────────────

/** `undefined` means readable: the address identifies nothing outside the LAN. */
export const classifyIpv4 = (octets: readonly number[]): IpClass | undefined => {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a >= 224 && a <= 239) ||
    (a === 0 && b === 0 && c === 0 && d === 0) ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  ) {
    return undefined;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "cgnat-ipv4";
  }
  return "public-ipv4";
};

type Ipv6Verdict =
  | { readonly kind: "readable" }
  | { readonly kind: "embedded-v4"; readonly prefix: string; readonly octets: number[] }
  | { readonly kind: "masked"; readonly cls: IpClass };

const classifyIpv6 = (groups: readonly number[]): Ipv6Verdict => {
  const g = (index: number): number => groups[index] as number;
  const zeroUpTo = (count: number): boolean => groups.slice(0, count).every((value) => value === 0);
  if (zeroUpTo(7) && (g(7) === 0 || g(7) === 1)) {
    return { kind: "readable" };
  }
  const embedded = [g(6) >> 8, g(6) & 0xff, g(7) >> 8, g(7) & 0xff];
  if (zeroUpTo(5) && g(5) === 0xffff) {
    return { kind: "embedded-v4", prefix: "::ffff:", octets: embedded };
  }
  if (g(0) === 0x64 && g(1) === 0xff9b && groups.slice(2, 6).every((value) => value === 0)) {
    return { kind: "embedded-v4", prefix: "64:ff9b::", octets: embedded };
  }
  const first = g(0);
  if ((first & 0xffc0) === 0xfe80) {
    return { kind: "masked", cls: "link-local-ipv6" };
  }
  if ((first & 0xfe00) === 0xfc00) {
    return { kind: "masked", cls: "ula-ipv6" };
  }
  if ((first & 0xff00) === 0xff00) {
    return { kind: "masked", cls: "multicast-ipv6" };
  }
  if ((first & 0xe000) === 0x2000) {
    return { kind: "masked", cls: "global-ipv6" };
  }
  return { kind: "masked", cls: "other-ipv6" };
};

const decodeColons = (text: string): string => text.replace(/%3[Aa]/gu, ":");

/** Split a trailing `:port` off an unbracketed candidate that only parses without it. */
const PORT_SUFFIX_RE = /^(.*?)((?::|%3[Aa])\d{1,5})$/u;

interface Ipv6Match {
  readonly groups: number[];
  /** Text after the address that is kept verbatim (a split-off `:port`). */
  readonly suffix: string;
}

const matchIpv6 = (candidate: string): Ipv6Match | undefined => {
  const whole = parseIpv6(decodeColons(candidate));
  if (whole !== undefined) {
    return { groups: whole, suffix: "" };
  }
  const split = PORT_SUFFIX_RE.exec(candidate);
  if (split === null) {
    return undefined;
  }
  const groups = parseIpv6(decodeColons(split[1] as string));
  return groups === undefined ? undefined : { groups, suffix: split[2] as string };
};

const isVersionContext = (text: string, offset: number): boolean =>
  VERSION_PREFIX_RE.test(text.slice(Math.max(0, offset - 40), offset));

// ── Masker ─────────────────────────────────────────────────────────────────

/** All-zero and broadcast MACs identify no hardware (`brd ff:ff:ff:ff:ff:ff`). */
const isReadableMac = (key: string): boolean => key === "000000000000" || key === "ffffffffffff";

/**
 * One instance per bundle: it remembers which address got which number, so
 * every file of the bundle (and its manifest) agrees.
 */
export class IpMasker {
  private readonly seen = new Map<string, string>();
  private readonly next = new Map<MaskClass, number>();

  /** The token for `key` in `cls`, issuing the next number on first sight. */
  private token(cls: MaskClass, key: string): string {
    const id = `${cls}|${key}`;
    const existing = this.seen.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const number = (this.next.get(cls) ?? 0) + 1;
    this.next.set(cls, number);
    const token = `<${cls}#${number}>`;
    this.seen.set(id, token);
    return token;
  }

  private ipv4Token(octets: readonly number[]): string | undefined {
    const cls = classifyIpv4(octets);
    return cls === undefined ? undefined : this.token(cls, octets.join("."));
  }

  /** Mask every identifying IP and MAC address in `text`. */
  mask(text: string): string {
    let output = text.replace(IPV6_RE, (match, candidate: string, zone: string | undefined) => {
      const parsed = matchIpv6(candidate);
      if (parsed === undefined) {
        return match;
      }
      const verdict = classifyIpv6(parsed.groups);
      const keep = `${parsed.suffix}${zone ?? ""}`;
      if (verdict.kind === "readable") {
        return match;
      }
      if (verdict.kind === "embedded-v4") {
        const v4 = this.ipv4Token(verdict.octets);
        return v4 === undefined ? match : `${verdict.prefix}${v4}${keep}`;
      }
      const key = parsed.groups.map((group) => group.toString(16)).join(":");
      return `${this.token(verdict.cls, key)}${keep}`;
    });
    output = output.replace(IPV4_RE, (match, candidate: string, offset: number, whole: string) => {
      const octets = parseIpv4(candidate);
      if (octets === undefined || isVersionContext(whole, offset)) {
        return match;
      }
      return this.ipv4Token(octets) ?? match;
    });
    output = output.replace(MAC_RE, (match, candidate: string) => {
      const key = decodeColons(candidate).replace(/[:-]/gu, "").toLowerCase();
      return isReadableMac(key) ? match : this.token("mac", key);
    });
    return output.replace(MAC_IFNAME_RE, (match, prefix: string, hex: string) => {
      const key = hex.toLowerCase();
      return isReadableMac(key) ? match : `${prefix}${this.token("mac", key)}`;
    });
  }
}

/** Mask `text`; pass the bundle's masker so numbers agree across files. */
export const maskIpAddresses = (text: string, masker: IpMasker = new IpMasker()): string =>
  masker.mask(text);

// ── Fail-closed guard ──────────────────────────────────────────────────────

const ipClassesIn = (text: string): Set<IpClass> => {
  const found = new Set<IpClass>();
  for (const match of text.matchAll(IPV6_RE)) {
    const parsed = matchIpv6(match[1] as string);
    if (parsed === undefined) {
      continue;
    }
    const verdict = classifyIpv6(parsed.groups);
    if (verdict.kind === "masked") {
      found.add(verdict.cls);
    } else if (verdict.kind === "embedded-v4") {
      const cls = classifyIpv4(verdict.octets);
      if (cls !== undefined) {
        found.add(cls);
      }
    }
  }
  for (const match of text.matchAll(IPV4_RE)) {
    const octets = parseIpv4(match[1] as string);
    const cls = octets === undefined ? undefined : classifyIpv4(octets);
    if (cls !== undefined && !isVersionContext(text, match.index)) {
      found.add(cls);
    }
  }
  return found;
};

/**
 * Classes of every identifying IP address still present in `text` or in its
 * escape-decoded copy (`:`, `\x3a`, doubled backslashes). Empty means the
 * text may be shipped; anything else means the masker missed an encoding and
 * the whole file must be withheld. Never returns the addresses themselves.
 */
export const findUnmaskedIpClasses = (text: string): IpClass[] => {
  const decoded = decodeEscapes(text);
  const found = ipClassesIn(text);
  if (decoded !== text) {
    for (const cls of ipClassesIn(decoded)) {
      found.add(cls);
    }
  }
  return MASK_CLASSES.filter((cls): cls is IpClass => found.has(cls as IpClass));
};

// ── Counting ───────────────────────────────────────────────────────────────

const TOKEN_RE =
  /<(public-ipv4|cgnat-ipv4|global-ipv6|link-local-ipv6|ula-ipv6|multicast-ipv6|other-ipv6|mac)#\d{1,9}>/gu;

/** How many mask tokens of each class `text` carries. Counts only, never values. */
export const countMaskTokens = (text: string): Partial<Record<MaskClass, number>> => {
  const counts: Partial<Record<MaskClass, number>> = {};
  for (const match of text.matchAll(TOKEN_RE)) {
    const cls = match[1] as MaskClass;
    counts[cls] = (counts[cls] ?? 0) + 1;
  }
  return counts;
};
