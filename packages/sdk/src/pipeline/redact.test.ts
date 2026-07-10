import { describe, expect, it } from "vitest";
import { redactSensitiveFields } from "./redact.js";

describe("redactSensitiveFields (spec §11, design R2/R5)", () => {
  it("masks builtin keys at any depth, across arrays, in all naming variants", () => {
    const input = {
      user: "octocat",
      password: "hunter2",
      nested: { api_key: "sk-123", keep: "visible" },
      items: [{ "X-API-Key": "sk-456", id: 7 }, { Authorization: "Bearer abc" }],
    };
    const out = redactSensitiveFields(input, []) as Record<string, unknown>;
    expect(out).toEqual({
      user: "octocat",
      password: "[redacted]",
      nested: { api_key: "[redacted]", keep: "visible" },
      items: [{ "X-API-Key": "[redacted]", id: 7 }, { Authorization: "[redacted]" }],
    });
  });

  it("masks per-tool extra keys with the same normalization, and a matched key's whole subtree", () => {
    const input = {
      customerEmail: "a@b.com",
      details: { customer_email: "c@d.com", note: "hi" },
      payload: { secretBlob: { inner: "x" } },
    };
    const out = redactSensitiveFields(input, ["customer-email", "secret_blob"]);
    expect(out).toEqual({
      customerEmail: "[redacted]",
      details: { customer_email: "[redacted]", note: "hi" },
      payload: { secretBlob: "[redacted]" },
    });
  });

  it("normalized matching is exact, not substring: author does not match auth", () => {
    const out = redactSensitiveFields({ author: "kernighan", auth: "abc" }, []);
    expect(out).toEqual({ author: "kernighan", auth: "[redacted]" });
  });

  it("passes non-object roots through unchanged", () => {
    expect(redactSensitiveFields("a bare string with password inside", [])).toBe(
      "a bare string with password inside",
    );
    expect(redactSensitiveFields(42, [])).toBe(42);
    expect(redactSensitiveFields(null, [])).toBe(null);
    expect(redactSensitiveFields(undefined, [])).toBe(undefined);
  });

  it("fails CLOSED past the depth cap: the deep subtree becomes the marker, never raw", () => {
    // Build an object 70 levels deep with a sensitive leaf below the cap of 64.
    let deep: Record<string, unknown> = { password: "leaf-secret" };
    for (let i = 0; i < 70; i += 1) {
      deep = { level: deep };
    }
    const serialized = JSON.stringify(redactSensitiveFields(deep, []));
    expect(serialized).not.toContain("leaf-secret");
    expect(serialized).toContain("[redacted]");
  });

  it("fails CLOSED on a cycle: the back-reference becomes the marker instead of hanging", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    const out = redactSensitiveFields(node, []) as Record<string, unknown>;
    expect(out.name).toBe("a");
    expect(out.self).toBe("[redacted]");
  });

  it("does not conflate a shared (non-cyclic) subtree with a cycle", () => {
    const shared = { v: 1 };
    const out = redactSensitiveFields({ a: shared, b: shared }, []);
    expect(out).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it("NEVER mutates its argument (load-bearing: the journal serializes the same reference after appendTrace — design R5)", () => {
    const input = { password: "hunter2", nested: { token: "t", ok: 1 }, list: [{ secret: "s" }] };
    const snapshot = structuredClone(input);
    redactSensitiveFields(input, ["ok"]);
    expect(input).toEqual(snapshot);
  });
});
