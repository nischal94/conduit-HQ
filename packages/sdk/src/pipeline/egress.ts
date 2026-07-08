import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as lookupCb } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

/** §9.3: loopback/private egress OFF by default; opt-in only for trusted code. */
export interface EgressOptions {
  allowPrivate?: boolean;
}

/**
 * The §9.3 PRE-FLIGHT gate every outbound upstream URL passes through before
 * a request is built. Protocol is checked unconditionally (the pinned lookup
 * governs only the DNS/IP layer, so a `file:`/`ftp:` URL must be rejected
 * here). The private-address check resolves hostnames (WHATWG URL has already
 * normalized encoded-IP forms like `http://2130706433/` to dotted-quad) and
 * rejects if ANY resolved address is loopback, private, link-local, or
 * unspecified — an early, clear failure for an obviously-private target.
 *
 * This is no longer the ONLY line of defense: the authoritative, TOCTOU-free
 * check is {@link createPinnedLookup}, which resolves once at connect time and
 * forces the socket to a vetted IP. Keeping this pre-flight is deliberate
 * defense-in-depth (same canonical classifier, applied earlier), not a
 * redundant denylist — it fast-fails without opening a socket and gives the
 * agent a ref-free reason.
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
 * §9.3 per-connect pinning (spec §18 Phase-1 answer). Returns a Node
 * `lookup` callback for an http(s) Agent: it resolves the hostname ONCE and
 * hands the socket only the addresses that pass {@link isPrivateAddress}, so
 * the connection is forced to a vetted binary IP.
 *
 * This is the canonical-form fix for what used to be a denylist. The old
 * split — guard resolves + checks, then `fetch` re-resolves independently —
 * left two gaps that this closes together:
 *   1. Encoding bypasses: every textual spelling of an address (decimal,
 *      hex, v4-mapped, NAT64) resolves to the same bytes, which is what the
 *      classifier now sees. There is no spelling left to add.
 *   2. DNS-rebinding TOCTOU: there is no second, independent resolution to
 *      disagree with the checked one — the socket connects to a member of
 *      the vetted set (spec §18 item 6).
 *
 * `allowPrivate` short-circuits the filter for trusted code (self-host to a
 * private upstream), matching {@link assertEgressAllowed}'s opt-in. Fails
 * closed: an all-private answer, or a resolver error, aborts the connect.
 */
export function createPinnedLookup(options: EgressOptions = {}): LookupFunction {
  return (hostname: string, opts: LookupOptions, callback): void => {
    // Always resolve with all:true so EVERY address is vetted, regardless of
    // what the socket's `opts` asked for; re-narrow to the requested shape
    // only when handing the result back.
    lookupCb(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
      if (err !== null) {
        callback(err, "", 0);
        return;
      }
      const resolved = addresses as LookupAddress[];
      const vetted =
        options.allowPrivate === true
          ? resolved
          : resolved.filter((entry) => !isPrivateAddress(entry.address));
      if (vetted.length === 0) {
        // Fail closed with our own message: the connect never happens. The
        // classifier already rejected every resolved address.
        callback(
          new Error(
            `[EgressGuard] Blocked: every resolved address is loopback/private (spec §9.3). Context: { host: ${hostname} }`,
          ),
          "",
          0,
        );
        return;
      }
      if (opts.all === true) {
        callback(null, vetted);
        return;
      }
      // Single-address shape: hand back the first vetted entry.
      const [first] = vetted;
      callback(null, first?.address ?? "", first?.family ?? 0);
    });
  };
}

/**
 * Classifies one literal address. IPv6 is fully expanded rather than
 * prefix-sniffed: WHATWG URL serializes v4-mapped literals to hex form
 * (`::ffff:7f00:1`), which a first-group check would misread as public.
 * Anything unparseable is private (fail closed).
 *
 * This is the canonical-form CLASSIFIER, not the egress boundary: it runs on
 * addresses that DNS has already resolved to canonical dotted-quad / expanded
 * IPv6 (via {@link createPinnedLookup}), never on raw URL hostnames. That is
 * why it is not extended per textual encoding — the encodings collapse before
 * they reach it (see {@link createPinnedLookup} and the §9.3 convergence note
 * in CLAUDE.md / INVARIANTS.md).
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
  // Both v4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) embed an IPv4
  // address in the low 32 bits; classify by the embedded v4 so a NAT64
  // literal like 64:ff9b::a9fe:a9fe (169.254.169.254, the metadata endpoint)
  // is blocked on NAT64-capable networks, not read as public.
  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isNat64 =
    groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (isV4Mapped || isNat64) {
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
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated, still routable on legacy nets)
    (first & 0xff00) === 0xff00 // ff00::/8 multicast (parity with the IPv4 >=224 block)
  );
}

function isPrivateV4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 127 || // loopback
    a === 10 || // RFC1918
    a === 0 || // "this network"
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 100 && b >= 64 && b <= 127) || // RFC6598 carrier-grade NAT
    (a === 192 && b === 0 && c === 0) || // RFC6890 IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // RFC2544 benchmarking
    a >= 224 // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
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
