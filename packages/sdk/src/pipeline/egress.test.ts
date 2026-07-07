import { lookup } from "node:dns/promises";
import { describe, expect, it, vi } from "vitest";
import { assertEgressAllowed, isPrivateAddress } from "./egress.js";

// Real lookup by default (the "localhost" test depends on it); individual
// tests override per-call to simulate attacker-controlled DNS.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
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
