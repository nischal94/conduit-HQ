import { describe, expect, it } from "vitest";
import { assertEgressAllowed, isPrivateAddress } from "./egress.js";

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
