import type { LookupAddress } from "node:dns";
import { lookup as lookupCb } from "node:dns";
import { lookup } from "node:dns/promises";
import { describe, expect, it, vi } from "vitest";
import {
  assertEgressAllowed,
  createPinnedLookup,
  isEgressBlockedError,
  isPrivateAddress,
} from "./egress.js";

// Real lookup by default (the "localhost" test depends on it); individual
// tests override per-call to simulate attacker-controlled DNS.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

// The pinned-lookup tests drive the callback-form dns.lookup directly so we
// can simulate an attacker-controlled resolver at the exact seam the socket
// uses. Real by default; overridden per-test.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

describe("egress guard (spec §9.3)", () => {
  it("INVARIANT §9.3: loopback egress is blocked by default", async () => {
    await expect(assertEgressAllowed(new URL("http://127.0.0.1:9/"))).rejects.toThrow(
      /loopback\/private egress is off by default/,
    );
    await expect(assertEgressAllowed(new URL("http://127.8.8.8/"))).rejects.toThrow();
  });

  it("INVARIANT §9.3: private ranges are blocked (10/8, 172.16/12, 192.168/16)", async () => {
    await expect(assertEgressAllowed(new URL("http://10.0.0.1/"))).rejects.toThrow();
    await expect(assertEgressAllowed(new URL("http://172.16.0.1/"))).rejects.toThrow();
    await expect(assertEgressAllowed(new URL("http://172.31.255.255/"))).rejects.toThrow();
    await expect(assertEgressAllowed(new URL("http://192.168.1.1/"))).rejects.toThrow();
    // 172.32/16 is NOT private — the /12 boundary matters.
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
  });

  it("INVARIANT §9.3: link-local 169.254.169.254 (cloud metadata) is blocked", async () => {
    await expect(assertEgressAllowed(new URL("http://169.254.169.254/latest/"))).rejects.toThrow();
  });

  it("INVARIANT §9.3: 0.0.0.0/8 is blocked", async () => {
    await expect(assertEgressAllowed(new URL("http://0.0.0.0/"))).rejects.toThrow();
  });

  it("INVARIANT §9.3: IPv6 loopback ::1 and fc00::/7 and fe80::/10 are blocked", async () => {
    await expect(assertEgressAllowed(new URL("http://[::1]/"))).rejects.toThrow();
    await expect(assertEgressAllowed(new URL("http://[::]/"))).rejects.toThrow();
    await expect(assertEgressAllowed(new URL("http://[fc00::1]/"))).rejects.toThrow();
    await expect(assertEgressAllowed(new URL("http://[fd12:3456::1]/"))).rejects.toThrow();
    await expect(assertEgressAllowed(new URL("http://[fe80::1]/"))).rejects.toThrow();
  });

  it("INVARIANT §9.3: v4-mapped IPv6 (::ffff:127.0.0.1) is blocked", async () => {
    await expect(assertEgressAllowed(new URL("http://[::ffff:127.0.0.1]/"))).rejects.toThrow();
    await expect(assertEgressAllowed(new URL("http://[::ffff:10.0.0.1]/"))).rejects.toThrow();
  });

  it("INVARIANT §9.3: IPv6 site-local fec0::/10 and multicast ff00::/8 are blocked", () => {
    // Adversarial (codex): parity with the IPv4 >=224 block. fec0::/10 is
    // deprecated but still routable on legacy nets; ff00::/8 is multicast.
    expect(isPrivateAddress("fec0::1")).toBe(true);
    expect(isPrivateAddress("feff:ffff::1")).toBe(true); // top of fec0::/10, still site-local
    expect(isPrivateAddress("2001:db8::1")).toBe(false); // documentation range, globally-scoped form
    expect(isPrivateAddress("ff02::1")).toBe(true); // link-local all-nodes multicast
    expect(isPrivateAddress("ff0e::1")).toBe(true); // global multicast
    expect(isPrivateAddress("2606:2800:220:1::1")).toBe(false); // public sanity
  });

  it("INVARIANT §9.3: decimal-encoded IPv4 is blocked (URL normalizes http://2130706433/)", async () => {
    // Pins the WHATWG normalization the guard relies on: the encoded form
    // never reaches the checker as anything but dotted-quad.
    expect(new URL("http://2130706433/").hostname).toBe("127.0.0.1");
    await expect(assertEgressAllowed(new URL("http://2130706433/"))).rejects.toThrow();
  });

  it("INVARIANT §9.3: hostnames resolving to private addresses are blocked", async () => {
    // "localhost" resolves to 127.0.0.1 and/or ::1 on every platform —
    // exercises the DNS-resolve-and-check path without external lookups.
    await expect(assertEgressAllowed(new URL("http://localhost:9/"))).rejects.toThrow(
      /loopback\/private egress/,
    );
  });

  it("INVARIANT §9.3: a hostname is blocked when ANY resolved address is private (rebinding posture)", async () => {
    // Attacker-controlled DNS answering [public, private]: checking only
    // the first address would reopen the classic DNS-pinning bypass.
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    await expect(assertEgressAllowed(new URL("http://rebind.example/"))).rejects.toThrow(
      /loopback\/private egress/,
    );
  });

  it("fails closed with its own message when the hostname does not resolve", async () => {
    vi.mocked(lookup).mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" }),
    );
    await expect(assertEgressAllowed(new URL("http://nope.example/"))).rejects.toThrow(
      /hostname did not resolve/,
    );
  });

  it("INVARIANT §9.3: CGNAT, IETF-protocol, benchmarking, and multicast ranges are blocked", () => {
    expect(isPrivateAddress("100.64.0.1")).toBe(true); // RFC6598 CGNAT
    expect(isPrivateAddress("100.127.255.255")).toBe(true);
    expect(isPrivateAddress("100.63.0.1")).toBe(false); // just below the /10
    expect(isPrivateAddress("100.128.0.1")).toBe(false); // just above
    expect(isPrivateAddress("192.0.0.1")).toBe(true); // RFC6890 protocol assignments
    expect(isPrivateAddress("198.18.0.1")).toBe(true); // RFC2544 benchmarking
    expect(isPrivateAddress("198.19.255.255")).toBe(true);
    expect(isPrivateAddress("224.0.0.1")).toBe(true); // multicast
    expect(isPrivateAddress("255.255.255.255")).toBe(true); // broadcast
    expect(isPrivateAddress("8.8.8.8")).toBe(false); // still-public sanity
  });

  it("INVARIANT §9.3: NAT64 (64:ff9b::/96) addresses are classified by their embedded IPv4 (codex re-pass)", () => {
    // 64:ff9b::a9fe:a9fe embeds 169.254.169.254 — the cloud metadata endpoint.
    // On NAT64 networks this routes to link-local; must not read as public.
    expect(isPrivateAddress("64:ff9b::a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateAddress("64:ff9b::a00:1")).toBe(true); // 10.0.0.1
    expect(isPrivateAddress("64:ff9b::5db8:d822")).toBe(false); // 93.184.216.34, public
  });

  it("classifies unparseable addresses as private (fail closed)", () => {
    expect(isPrivateAddress("garbage")).toBe(true);
    expect(isPrivateAddress("1.2.3.4.5")).toBe(true);
    expect(isPrivateAddress(":::1")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });

  it("strips zone ids and classifies hex-form v4-mapped literals", () => {
    expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true); // 127.0.0.1, WHATWG hex serialization
    expect(isPrivateAddress("::ffff:5db8:d822")).toBe(false); // 93.184.216.34
  });

  it("INVARIANT §9.3: the opt-in flag allows private egress", async () => {
    await expect(
      assertEgressAllowed(new URL("http://127.0.0.1:9/"), { allowPrivate: true }),
    ).resolves.toBeUndefined();
    await expect(
      assertEgressAllowed(new URL("http://[::1]/"), { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  it("blocks non-http(s) protocols regardless of flag", async () => {
    await expect(assertEgressAllowed(new URL("file:///etc/passwd"))).rejects.toThrow(
      /protocol not allowed/,
    );
    await expect(
      assertEgressAllowed(new URL("ftp://127.0.0.1/"), { allowPrivate: true }),
    ).rejects.toThrow(/protocol not allowed/);
  });

  it("allows a public literal IP", async () => {
    // Literal IP: no DNS in unit tests.
    await expect(assertEgressAllowed(new URL("https://93.184.216.34/"))).resolves.toBeUndefined();
    await expect(
      assertEgressAllowed(new URL("http://[2606:2800:220:1::1]/")),
    ).resolves.toBeUndefined();
  });
});

// createPinnedLookup is the authoritative §9.3 check (spec §18 Phase-1): it
// resolves once and hands the socket only vetted addresses, so a DNS-rebinding
// answer cannot smuggle a private address past a prior text check. These tests
// drive the lookup callback at the exact seam the http.Agent uses.
describe("createPinnedLookup (spec §9.3 per-connect pinning)", () => {
  // Promisify the callback so assertions read cleanly. all:true asks for the
  // array shape (what a Node-22 Agent requests).
  function pin(
    lookupFn: ReturnType<typeof createPinnedLookup>,
    host: string,
    all = true,
  ): Promise<{ address: string; family: number }[]> {
    return new Promise((resolve, reject) => {
      lookupFn(host, { all } as never, (err, address, family) => {
        if (err !== null) {
          reject(err);
          return;
        }
        resolve(
          Array.isArray(address)
            ? (address as { address: string; family: number }[])
            : [{ address: address as string, family: family ?? 0 }],
        );
      });
    });
  }

  // dns.lookup is overloaded ~6 ways, so vi.mocked() can't infer the 3-arg
  // (host, opts, cb) form we exercise. Narrow the mock to that one overload.
  type LookupImpl = (
    host: string,
    opts: unknown,
    cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void,
  ) => void;
  const mockedLookup = vi.mocked(lookupCb) as unknown as {
    mockImplementationOnce(impl: LookupImpl): unknown;
  };

  // Stub the callback-form dns.lookup to return a fixed set of resolved
  // addresses, simulating an attacker-controlled resolver at the socket seam.
  function stubResolver(addresses: LookupAddress[]): void {
    mockedLookup.mockImplementationOnce((_host, _opts, cb) => {
      cb(null, addresses);
    });
  }

  it("INVARIANT §9.3: hands the socket only the public address when DNS answers [public, private] (rebinding closed)", async () => {
    // The attacker-controlled resolver returns a private address alongside a
    // public one. Pinning must drop the private one — the socket can only
    // connect to what survives, so there is no rebinding window.
    stubResolver([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const vetted = await pin(createPinnedLookup(), "rebind.example");
    expect(vetted).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("INVARIANT §9.3: fails closed when EVERY resolved address is private", async () => {
    stubResolver([
      { address: "10.0.0.5", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(pin(createPinnedLookup(), "allprivate.example")).rejects.toThrow(
      /every resolved address is loopback\/private/,
    );
  });

  it("tags the all-private rejection so the caller detects it structurally, not by message text", async () => {
    stubResolver([{ address: "10.0.0.5", family: 4 }]);
    const err = await pin(createPinnedLookup(), "allprivate.example").catch((e) => e);
    expect(isEgressBlockedError(err)).toBe(true);
    // A generic error is NOT flagged (no false positives).
    expect(isEgressBlockedError(new Error("getaddrinfo ENOTFOUND"))).toBe(false);
    expect(isEgressBlockedError(undefined)).toBe(false);
  });

  it("INVARIANT §9.3: a NAT64-resolving name is blocked by the embedded-v4 classifier, not a text rule", async () => {
    // The resolver returns the canonical expanded form; the classifier reads
    // the embedded 169.254.169.254 (cloud metadata) and rejects it. No text
    // spelling is involved — this is the whole point of canonicalizing.
    stubResolver([{ address: "64:ff9b::a9fe:a9fe", family: 6 }]);
    await expect(pin(createPinnedLookup(), "nat64.example")).rejects.toThrow(
      /every resolved address is loopback\/private/,
    );
  });

  it("allowPrivate short-circuits the filter for trusted code", async () => {
    stubResolver([{ address: "127.0.0.1", family: 4 }]);
    const vetted = await pin(createPinnedLookup({ allowPrivate: true }), "localhost");
    expect(vetted).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });

  it("propagates a resolver error unchanged (fail closed on NXDOMAIN)", async () => {
    mockedLookup.mockImplementationOnce((_host, _opts, cb) => {
      cb(Object.assign(new Error("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" }), []);
    });
    await expect(pin(createPinnedLookup(), "nope.example")).rejects.toThrow(/ENOTFOUND/);
  });

  it("honors the single-address shape when the socket does not request all", async () => {
    // Some connect paths call lookup with all:false; the pinned lookup must
    // still resolve every address internally, vet, then return one.
    stubResolver([
      { address: "10.0.0.1", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ]);
    const vetted = await pin(createPinnedLookup(), "mixed.example", false);
    // all:false → first vetted entry only; the private one is dropped first.
    expect(vetted).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("honors opts.family in the single-address path (no mismatched record)", async () => {
    // A family-constrained connect (all:false, family:4) must get an IPv4
    // record even when a public IPv6 sorts first — never a mismatched family.
    stubResolver([
      { address: "2606:2800:220:1::1", family: 6 }, // public v6, sorts first
      { address: "93.184.216.34", family: 4 }, // public v4, the requested family
    ]);
    const lookupFn = createPinnedLookup();
    const got = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
      lookupFn("dual.example", { all: false, family: 4 } as never, (err, address, family) => {
        if (err !== null) {
          reject(err);
          return;
        }
        resolve([{ address: address as string, family: family ?? 0 }]);
      });
    });
    expect(got).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});
