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

  it("no-op when secret is undefined", () => {
    expect(scrubCredential({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});
