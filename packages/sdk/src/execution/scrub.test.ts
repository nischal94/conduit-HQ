import { describe, expect, it } from "vitest";
import { scrubCredential } from "./scrub.js";

describe("scrubCredential", () => {
  it("removes a verbatim credential echo from a result (best-effort)", () => {
    const out = scrubCredential(
      { echoed: "Bearer ghp_secret_123", data: 1 },
      "Bearer ghp_secret_123",
    );
    expect(JSON.stringify(out)).not.toContain("ghp_secret_123");
    expect((out as { data: number }).data).toBe(1);
  });

  it("removes a BARE-TOKEN echo (secret without its scheme word) — shares upstream.ts tokens", () => {
    // The upstream scan matches whitespace-segmented sub-tokens (>=5 chars) of
    // the credential, so a bare-token echo is caught. scrubCredential now goes
    // through the SAME primitive, so it catches it too — the divergence the
    // review flagged is closed.
    const out = scrubCredential({ echoed: "ghp_secret_123", data: 1 }, "Bearer ghp_secret_123");
    expect(JSON.stringify(out)).not.toContain("ghp_secret_123");
    expect((out as { data: number }).data).toBe(1);
  });

  it("does not redact the scheme word alone (no over-redaction)", () => {
    const out = scrubCredential(
      { note: "Use a Bearer token to authenticate." },
      "Bearer ghp_long_enough_secret_9z",
    );
    // "Bearer" is a scheme word below/at the exclusion set — benign text survives.
    expect(out).toEqual({ note: "Use a Bearer token to authenticate." });
  });

  it("preserves non-secret content", () => {
    const out = scrubCredential({ a: 1, b: "hello world" }, "Bearer ghp_secret_123");
    expect(out).toEqual({ a: 1, b: "hello world" });
  });

  it("no-op when secret is undefined", () => {
    expect(scrubCredential({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("no-op when secret is the empty string (must NOT redact everything)", () => {
    // Redacting on "" would splice the marker between every character and
    // destroy the whole result — guard against it.
    const result = { a: 1, b: "hello" };
    expect(scrubCredential(result, "")).toEqual({ a: 1, b: "hello" });
  });

  it("no-op when the result serializes to undefined (bare undefined / function / symbol)", () => {
    // JSON.stringify(undefined) === undefined — nothing to scrub, return as-is.
    expect(scrubCredential(undefined, "Bearer ghp_secret_123")).toBeUndefined();
    const fn = (): void => {};
    expect(scrubCredential(fn, "Bearer ghp_secret_123")).toBe(fn);
  });
});
