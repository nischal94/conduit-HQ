import { describe, expect, it } from "vitest";
import { resolveEnv } from "./env.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("resolveEnv (design M7/M8)", () => {
  it("resolves defaults and decodes the key", () => {
    const r = resolveEnv({ CONDUIT_MASTER_KEY: KEY });
    expect(r.dbPath.endsWith("/.conduit/conduit.db")).toBe(true);
    expect(r.keyBytes.length).toBe(32);
    expect(r.allowPrivateEgress).toBe(false);
  });
  it("missing key → per-cause message including the generation one-liner", () => {
    expect(() => resolveEnv({})).toThrow(/CONDUIT_MASTER_KEY.*randomBytes\(32\)/s);
  });
  it("malformed key (wrong length) → per-cause message", () => {
    expect(() => resolveEnv({ CONDUIT_MASTER_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /32 bytes/,
    );
  });
  it("non-canonical base64 (invalid characters) → per-cause message, not silent 32 bytes", () => {
    const valid = Buffer.alloc(32, 7).toString("base64");
    expect(() => resolveEnv({ CONDUIT_MASTER_KEY: `!!${valid.slice(2)}` })).toThrow(
      /canonical|encoding/i,
    );
  });
  it("non-canonical base64 (valid 32-byte length, non-zero padding bits) → per-cause message", () => {
    // Buffer.from silently ignores unused padding bits instead of rejecting
    // them, so a corrupted-but-same-length key must still fail loudly.
    const valid = Buffer.alloc(32, 7).toString("base64");
    const nonCanonical = `${valid.slice(0, -2)}B=`;
    expect(Buffer.from(nonCanonical, "base64").length).toBe(32);
    expect(() => resolveEnv({ CONDUIT_MASTER_KEY: nonCanonical })).toThrow(/canonical|encoding/i);
  });
  it("egress opt-in", () => {
    expect(
      resolveEnv({ CONDUIT_MASTER_KEY: KEY, CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1" })
        .allowPrivateEgress,
    ).toBe(true);
  });
});
