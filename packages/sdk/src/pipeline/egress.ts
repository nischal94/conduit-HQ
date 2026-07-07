import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** §9.3: loopback/private egress OFF by default; opt-in only for trusted code. */
export interface EgressOptions {
  allowPrivate?: boolean;
}

/**
 * The §9.3 gate every outbound upstream URL passes through. Protocol is
 * checked unconditionally; the private-address check resolves hostnames
 * (WHATWG URL has already normalized encoded-IP forms like
 * `http://2130706433/` to dotted-quad) and rejects if ANY resolved address
 * is loopback, private, link-local, or unspecified. DNS-rebinding between
 * this check and the actual connect is a named residual risk — per-connect
 * pinning is a follow-up, not v1.
 */
export async function assertEgressAllowed(target: URL, options: EgressOptions = {}): Promise<void> {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(
      `[EgressGuard] Blocked: protocol not allowed for upstream calls. Context: { protocol: ${target.protocol} }`,
    );
  }
  if (options.allowPrivate === true) {
    return;
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch (cause) {
      // Fail closed with our own message: raw getaddrinfo errors are
      // OS-flavored and this message may cross to the guest.
      throw new Error(
        `[EgressGuard] Blocked: hostname did not resolve for the egress check. Context: { host: ${target.hostname} }`,
        { cause },
      );
    }
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(
        `[EgressGuard] Blocked: loopback/private egress is off by default (spec §9.3). Context: { host: ${target.hostname} }`,
      );
    }
  }
}

/**
 * Classifies one literal address. IPv6 is fully expanded rather than
 * prefix-sniffed: WHATWG URL serializes v4-mapped literals to hex form
 * (`::ffff:7f00:1`), which a first-group check would misread as public.
 * Anything unparseable is private (fail closed).
 */
export function isPrivateAddress(address: string): boolean {
  // Zone id (fe80::1%eth0) never changes the range classification.
  const bare = address.split("%")[0]?.toLowerCase() ?? "";
  if (isIP(bare) === 4) {
    return isPrivateV4(bare.split(".").map(Number));
  }
  const groups = expandV6Groups(bare);
  if (groups === undefined) {
    return true;
  }
  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isV4Mapped) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    return isPrivateV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  if (groups.every((g) => g === 0)) {
    return true; // :: unspecified
  }
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }
  const first = groups[0] ?? 0;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}

function isPrivateV4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Expands an IPv6 literal to its eight 16-bit groups; undefined if malformed. */
function expandV6Groups(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const left = parseV6Side(halves[0] ?? "");
  const right = halves.length === 2 ? parseV6Side(halves[1] ?? "") : [];
  if (left === undefined || right === undefined) {
    return undefined;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : undefined;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) {
    return undefined;
  }
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function parseV6Side(side: string): number[] | undefined {
  if (side === "") {
    return [];
  }
  const groups: number[] = [];
  for (const part of side.split(":")) {
    if (part.includes(".")) {
      // Dotted-quad tail (::ffff:127.0.0.1) occupies two groups.
      const octets = part.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        return undefined;
      }
      const [a = 0, b = 0, c = 0, d = 0] = octets;
      groups.push((a << 8) | b, (c << 8) | d);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return undefined;
      }
      groups.push(Number.parseInt(part, 16));
    }
  }
  return groups;
}
