import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConduitStore, McpClientError, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AddMcpArgs, type AddMcpDeps, runAddMcp, USAGE } from "./commands/add-mcp.js";

const TOOLS_LIST = [
  {
    name: "list_issues",
    description: "List open issues",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Create an issue",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_repo",
    description: "Permanently delete a repo",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: true },
  },
];

let scratch: string;
let dbPath: string;
let masterKeyBytes: Uint8Array<ArrayBuffer>;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "conduit-cli-add-mcp-"));
  dbPath = join(scratch, "test.db");
  masterKeyBytes = SecretBox.generateKeyBytes();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function openTestStore(): Promise<ConduitStore> {
  const client = createClient({ url: `file:${dbPath}` });
  return openSqliteStore({ client, secretBox: await SecretBox.fromKeyBytes(masterKeyBytes) });
}

/** Builds a deps bag around a REAL store (opened once, reused across calls —
 * mirrors a real CLI process's env-driven single-open). Only fetchTools is
 * mocked; stdout/stderr are captured into arrays for assertions. */
function makeDeps(
  overrides: Partial<AddMcpDeps> & { store: ConduitStore },
): AddMcpDeps & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const { store, ...rest } = overrides;
  return {
    fetchTools: vi.fn(async () => TOOLS_LIST),
    openStore: async () => ({ store }),
    env: {},
    stdout: (line: string) => stdoutLines.push(line),
    stderr: (line: string) => stderrLines.push(line),
    stdoutLines,
    stderrLines,
    ...rest,
  };
}

const BASE_ARGS: AddMcpArgs = {
  url: "http://127.0.0.1:9/mcp",
  namespace: "github",
  prefix: "github.acme.prod",
  replace: false,
  clearCredential: false,
  json: false,
};

describe("USAGE (D5 — add-mcp --help)", () => {
  it("lists every flag and mentions CONDUIT_ADD_SECRET", () => {
    for (const flag of [
      "--url",
      "--namespace",
      "--prefix",
      "--replace",
      "--clear-credential",
      "--json",
    ]) {
      expect(USAGE).toContain(flag);
    }
    expect(USAGE).toContain("CONDUIT_ADD_SECRET");
  });
});

describe("runAddMcp", () => {
  it("malformed --namespace is rejected before any write", async () => {
    const store = await openTestStore();
    const deps = makeDeps({ store, fetchTools: vi.fn() });

    const result = await runAddMcp({ ...BASE_ARGS, namespace: "A B" }, deps);

    expect(result.exitCode).not.toBe(0);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
  });

  it("D5: no flags at all → ONE stderr line naming ALL missing required flags, exit 1", async () => {
    const store = await openTestStore();
    const deps = makeDeps({ store, fetchTools: vi.fn() });

    const result = await runAddMcp({ replace: false, clearCredential: false, json: false }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
    expect(deps.stderrLines).toHaveLength(1);
    const stderr = deps.stderrLines[0];
    expect(stderr).toContain("--namespace");
    expect(stderr).toContain("--url");
    expect(stderr).toContain("--prefix");
  });

  it("D5: an unparseable --url fails Step-1 validation (ONE stderr line, exit 1, fetch never called)", async () => {
    const store = await openTestStore();
    const deps = makeDeps({ store, fetchTools: vi.fn() });

    const result = await runAddMcp({ ...BASE_ARGS, url: "not-a-url" }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
    expect(deps.stderrLines).toHaveLength(1);
    const stderr = deps.stderrLines[0];
    expect(stderr).toContain("Missing/invalid required flags");
    expect(stderr).toContain("--url (must be a valid http(s) URL)");
    // NOT the "upstream unreachable" line — a bad url is a validation error.
    expect(stderr).not.toContain("upstream unreachable");
  });

  it("D5: a non-http(s) --url scheme fails Step-1 validation (ONE stderr line, exit 1, fetch never called)", async () => {
    const store = await openTestStore();
    const deps = makeDeps({ store, fetchTools: vi.fn() });

    const result = await runAddMcp({ ...BASE_ARGS, url: "ftp://host/mcp" }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
    expect(deps.stderrLines).toHaveLength(1);
    expect(deps.stderrLines[0]).toContain("--url (must be a valid http(s) URL)");
  });

  it("INVARIANT /cli add-mcp: unreachable --url fails loud and writes nothing", async () => {
    const store = await openTestStore();
    const deps = makeDeps({
      store,
      fetchTools: vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).not.toBe(0);
    expect(deps.stderrLines.join("")).toMatch(
      /upstream unreachable at http:\/\/127\.0\.0\.1:9\/mcp; nothing was written\. Re-run when reachable\./,
    );
    expect(await store.sources.list()).toEqual([]);
  });

  it("schema-invalid tools/list body (fetch OK, normalizeMcp throws) goes through the fail-loud path with 0 writes", async () => {
    const store = await openTestStore();
    const deps = makeDeps({
      store,
      // HTTP-level success: an array, so the fetch layer's shape check
      // passes — but a non-string tool name fails normalizeMcp's envelope.
      fetchTools: vi.fn(async () => [{ name: 42 }]),
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).not.toBe(0);
    const stderr = deps.stderrLines.join("");
    expect(stderr).toMatch(/^\[conduit add-mcp\]/);
    expect(stderr).toMatch(/nothing was written/);
    expect(await store.sources.list()).toEqual([]);
  });

  it("a plain-Error rejection carrying a cap message fails loud with 0 writes (fallback path, not the McpClientError cap mapping)", async () => {
    const store = await openTestStore();
    const deps = makeDeps({
      store,
      // NOTE: this throws a PLAIN Error, so it exercises runAddMcp's
      // non-McpClientError fallback — NOT the real byte-cap enforcement, which
      // lives in the shared client and is pinned by mcp-fetch.test.ts /
      // mcp-client.test.ts (the INVARIANTS.md cap rows). Kept as fallback-path
      // coverage; the INVARIANT prefix was dropped as an overclaim.
      fetchTools: vi.fn(async () => {
        throw new Error(
          "[conduit add-mcp] upstream tools/list response exceeds the 5242880-byte cap; nothing was written.",
        );
      }),
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).not.toBe(0);
    expect(await store.sources.list()).toEqual([]);
  });

  it("a plain-Error rejection carrying an over-count message fails loud with 0 writes (fallback path, not the McpClientError cap mapping)", async () => {
    const store = await openTestStore();
    const deps = makeDeps({
      store,
      // Plain Error → non-McpClientError fallback path (see the byte-cap test
      // above); real over-count enforcement is pinned in mcp-client.test.ts.
      fetchTools: vi.fn(async () => {
        throw new Error(
          "[conduit add-mcp] upstream tools/list response exceeds the 1024-tool cap (got 2000); nothing was written.",
        );
      }),
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).not.toBe(0);
    expect(await store.sources.list()).toEqual([]);
  });

  it("duplicate-after-namespacing tool names (normalizeMcp throws) also fail loud with 0 writes", async () => {
    const store = await openTestStore();
    const deps = makeDeps({
      store,
      // Both normalize to `github.a.b` — normalizeMcp refuses.
      fetchTools: vi.fn(async () => [
        { name: "a/b", inputSchema: { type: "object" } },
        { name: "a.b", inputSchema: { type: "object" } },
      ]),
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).not.toBe(0);
    const stderr = deps.stderrLines.join("");
    expect(stderr).toMatch(/^\[conduit add-mcp\]/);
    expect(stderr).toMatch(/nothing was written/);
    expect(await store.sources.list()).toEqual([]);
  });

  it("existing namespace with a differing --url, no --replace, refuses with 0 writes", async () => {
    const store = await openTestStore();
    // First run: seeds the namespace.
    await runAddMcp(BASE_ARGS, makeDeps({ store }));
    const beforeTools = await store.tools.list();

    // Second run: same namespace, different url, no --replace.
    const deps = makeDeps({ store });
    const result = await runAddMcp({ ...BASE_ARGS, url: "http://127.0.0.1:9/mcp-different" }, deps);

    expect(result.exitCode).not.toBe(0);
    // The C3 gate refuses BEFORE any fetch to the new url.
    expect(deps.fetchTools).not.toHaveBeenCalled();
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe(BASE_ARGS.url); // unchanged
    expect(await store.tools.list()).toEqual(beforeTools); // unchanged
  });

  it("--replace allows retargeting to a new url", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store }));

    const result = await runAddMcp(
      { ...BASE_ARGS, url: "http://127.0.0.1:9/mcp-new", replace: true },
      makeDeps({ store }),
    );

    expect(result.exitCode).toBe(0);
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe("http://127.0.0.1:9/mcp-new");
  });

  it("INVARIANT /cli add-mcp: cross-namespace --prefix collision fails loud with 0 writes to the new namespace, and does not disturb the existing owner", async () => {
    const store = await openTestStore();
    // Namespace A seeds prefix P.
    await runAddMcp(BASE_ARGS, makeDeps({ store }));

    // Namespace B tries to claim the same prefix P.
    const deps = makeDeps({ store });
    const result = await runAddMcp(
      { ...BASE_ARGS, namespace: "gitlab", url: "http://127.0.0.1:9/mcp-other" },
      deps,
    );

    expect(result.exitCode).not.toBe(0);
    const stderr = deps.stderrLines.join("");
    expect(stderr).toMatch(/^\[conduit add-mcp\]/);
    expect(stderr).toMatch(/prefix github\.acme\.prod is already used by another source/);
    expect(stderr).toMatch(/nothing was written/);
    // The collision is caught read-first, BEFORE any fetch to the new url.
    expect(deps.fetchTools).not.toHaveBeenCalled();

    // Namespace B got 0 rows.
    expect(await store.sources.get("src_gitlab")).toBeUndefined();

    // Namespace A (the original owner) is untouched.
    const sourceA = await store.sources.get("src_github");
    expect(sourceA?.location).toBe(BASE_ARGS.url);
    const connA = (await store.connections.list()).find((c) => c.integrationId === "int_github");
    expect(connA?.prefix).toBe(BASE_ARGS.prefix);
  });

  it("same-namespace re-sync with the SAME prefix still succeeds (prefix collision check does not false-positive on self)", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store }));

    // Re-run: same namespace, same prefix — idempotent re-sync path.
    const result = await runAddMcp(BASE_ARGS, makeDeps({ store }));

    expect(result.exitCode).toBe(0);
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe(BASE_ARGS.url);
  });

  it("--replace on an UNCHANGED url/prefix prints no retargeting warning", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store }));

    const deps = makeDeps({ store });
    const result = await runAddMcp({ ...BASE_ARGS, replace: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.stderrLines.join("")).not.toMatch(/retargeting/);
  });

  it("re-sync with no CONDUIT_ADD_SECRET but an existing credentialRef preserves it", async () => {
    const store = await openTestStore();
    // First run WITH a secret.
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } }));

    const connectionsBefore = await store.connections.list();
    const existingRef = connectionsBefore.find(
      (c) => c.integrationId === "int_github",
    )?.credentialRef;
    expect(existingRef).toBeDefined();

    // Second run WITHOUT CONDUIT_ADD_SECRET (env has no key at all).
    const result = await runAddMcp(BASE_ARGS, makeDeps({ store, env: {} }));

    expect(result.exitCode).toBe(0);
    const connectionsAfter = await store.connections.list();
    const conn = connectionsAfter.find((c) => c.integrationId === "int_github");
    expect(conn?.credentialRef).toBeDefined();
    expect(conn?.credentialRef).toBe(existingRef);
    // The secret itself must still resolve (never nulled/orphaned).
    expect(await store.secrets.reveal(existingRef as string)).toBe("Bearer tok123");
  });

  it("--clear-credential clears the ref and removes the stored secret", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } }));
    const connectionsBefore = await store.connections.list();
    const existingRef = connectionsBefore.find((c) => c.integrationId === "int_github")
      ?.credentialRef as string;

    const result = await runAddMcp(
      { ...BASE_ARGS, clearCredential: true },
      makeDeps({ store, env: {} }),
    );

    expect(result.exitCode).toBe(0);
    const connectionsAfter = await store.connections.list();
    const conn = connectionsAfter.find((c) => c.integrationId === "int_github");
    expect(conn?.credentialRef).toBeUndefined();
    expect(await store.secrets.reveal(existingRef)).toBeUndefined();
  });

  it("--clear-credential: a REJECTING provisionSource leaves the old secret and old credentialRef fully intact (batch rollback, not ordering)", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } }));
    const connectionsBefore = await store.connections.list();
    const existingRef = connectionsBefore.find((c) => c.integrationId === "int_github")
      ?.credentialRef as string;

    // Wrap the real store so provisionSource rejects. The secret DELETE is
    // now issued INSIDE provisionSource's own atomic batch (T-I2 amendment)
    // via removeSecretRef, so a rejecting provisionSource guarantees the
    // delete never lands — this is a storage-layer rollback guarantee, not
    // a call-ordering discipline in add-mcp.ts (there is no longer a
    // separate post-success `store.secrets.remove` call to order against).
    const failingStore: ConduitStore = {
      ...store,
      provisionSource: async () => {
        throw new Error("simulated provisionSource failure");
      },
    };

    await expect(
      runAddMcp(
        { ...BASE_ARGS, clearCredential: true },
        makeDeps({ store: failingStore, env: {} }),
      ),
    ).rejects.toThrow("simulated provisionSource failure");

    // Old connection still carries the old ref, and the old secret still
    // reveals — the rejected batch rolled back the delete along with
    // everything else.
    const connectionsAfter = await store.connections.list();
    const conn = connectionsAfter.find((c) => c.integrationId === "int_github");
    expect(conn?.credentialRef).toBe(existingRef);
    expect(await store.secrets.reveal(existingRef)).toBe("Bearer tok123");
  });

  it("INVARIANT /cli add-mcp: secret is never echoed to stdout or stderr on a successful add", async () => {
    const store = await openTestStore();
    const SECRET = "Bearer super_secret_value_do_not_leak";
    const deps = makeDeps({ store, env: { CONDUIT_ADD_SECRET: SECRET } });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).toBe(0);
    const allOutput = [...deps.stdoutLines, ...deps.stderrLines].join("");
    expect(allOutput).not.toContain(SECRET);
  });

  it("secret is never echoed even on a --replace warning path", async () => {
    const store = await openTestStore();
    const SECRET = "Bearer super_secret_value_do_not_leak";
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: SECRET } }));

    const deps = makeDeps({
      store,
      env: { CONDUIT_ADD_SECRET: SECRET },
    });
    const result = await runAddMcp(
      { ...BASE_ARGS, url: "http://127.0.0.1:9/mcp-new", replace: true },
      deps,
    );

    expect(result.exitCode).toBe(0);
    const allOutput = [...deps.stdoutLines, ...deps.stderrLines].join("");
    expect(allOutput).not.toContain(SECRET);
  });

  it("success prints a risk-class count summary", async () => {
    const store = await openTestStore();
    const deps = makeDeps({ store });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).toBe(0);
    const line = deps.stdoutLines.join("");
    expect(line).toMatch(/seeded 3 tools for connection github\.acme\.prod \(namespace github\):/);
    expect(line).toMatch(/1 safe \(auto-allow\)/);
    expect(line).toMatch(/1 review \(approval\)/);
    expect(line).toMatch(/1 destructive \(approval\)/);
  });

  it("--json prints the {safe,review,destructive} shape plus credential presence", async () => {
    const store = await openTestStore();
    const deps = makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer tok" } });

    const result = await runAddMcp({ ...BASE_ARGS, json: true }, deps);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(deps.stdoutLines.join("").trim());
    expect(parsed).toEqual({ safe: 1, review: 1, destructive: 1, credential: "present" });
  });

  it("--json reports credential absent when no secret is supplied or preserved", async () => {
    const store = await openTestStore();
    const deps = makeDeps({ store, env: {} });

    const result = await runAddMcp({ ...BASE_ARGS, json: true }, deps);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(deps.stdoutLines.join("").trim());
    expect(parsed.credential).toBe("absent");
  });

  // --- Retarget credential-leak guard (design §18-C4 D2) ------------------
  //
  // A `--replace` to a NEW url while a stored credential exists, with no fresh
  // CONDUIT_ADD_SECRET and no --clear-credential, is REFUSED OUTRIGHT — the
  // stored secret is bound to the old upstream and must never be sent to a
  // different host. The matrix pins refuse / proceed-with-env / proceed-with-
  // clear.

  it("INVARIANT /cli add-mcp: refuses --replace retarget to a new url while a stored credential exists (no env, no clear) — 0 writes, old cred intact", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } }));
    const before = await store.connections.list();
    const existingRef = before.find((c) => c.integrationId === "int_github")
      ?.credentialRef as string;
    const beforeTools = await store.tools.list();

    const deps = makeDeps({ store, env: {}, fetchTools: vi.fn(async () => TOOLS_LIST) });
    const result = await runAddMcp(
      { ...BASE_ARGS, url: "http://127.0.0.1:9/mcp-new", replace: true },
      deps,
    );

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join("")).toContain(
      `[conduit add-mcp] refusing to retarget "github" to a new url while a stored credential exists: pass CONDUIT_ADD_SECRET for the new upstream or --clear-credential to drop it. Nothing was written.`,
    );
    // The refusal happened BEFORE any network request to the new host.
    expect(deps.fetchTools).not.toHaveBeenCalled();
    // Zero writes: url unchanged, tools unchanged, secret still resolves.
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe(BASE_ARGS.url);
    expect(await store.tools.list()).toEqual(beforeTools);
    expect(await store.secrets.reveal(existingRef)).toBe("Bearer tok123");
  });

  it("retarget to a new url PROCEEDS when a fresh CONDUIT_ADD_SECRET is supplied (fetch carried the FRESH secret, new secret sealed)", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer old" } }));

    // Spy the fetch: the retarget fetch to the NEW host must carry the FRESH
    // secret ("Bearer new"), never the old stored one bound to the old host.
    const freshFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });
    const result = await runAddMcp(
      { ...BASE_ARGS, url: "http://127.0.0.1:9/mcp-new", replace: true },
      makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer new" }, fetchTools: freshFetch }),
    );

    expect(result.exitCode).toBe(0);
    expect(freshFetch.mock.calls[0]?.[1]).toEqual({ authorization: "Bearer new" });
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe("http://127.0.0.1:9/mcp-new");
    const conn = (await store.connections.list()).find((c) => c.integrationId === "int_github");
    expect(conn?.credentialRef).toBeDefined();
    expect(await store.secrets.reveal(conn?.credentialRef as string)).toBe("Bearer new");
  });

  it("retarget to a new url PROCEEDS with --clear-credential (cred dropped in-batch, fetch sent NO auth)", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer old" } }));
    const before = await store.connections.list();
    const oldRef = before.find((c) => c.integrationId === "int_github")?.credentialRef as string;

    // Spy the fetch: --clear-credential drops the old secret AND must send NO
    // Authorization to the new host — the stored secret is bound to the old
    // upstream and must never reach a different one.
    const clearFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });
    const result = await runAddMcp(
      { ...BASE_ARGS, url: "http://127.0.0.1:9/mcp-new", replace: true, clearCredential: true },
      makeDeps({ store, env: {}, fetchTools: clearFetch }),
    );

    expect(result.exitCode).toBe(0);
    // The fetch to the NEW host carried no auth (undefined, not the old secret).
    expect(clearFetch.mock.calls[0]?.[1]?.authorization).toBeUndefined();
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe("http://127.0.0.1:9/mcp-new");
    const conn = (await store.connections.list()).find((c) => c.integrationId === "int_github");
    expect(conn?.credentialRef).toBeUndefined();
    expect(await store.secrets.reveal(oldRef)).toBeUndefined();
  });

  // --- Stored-credential reuse only on an UNCHANGED url -------------------

  it("reuses the stored credential for the fetch ONLY when the url is unchanged", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } }));

    // Same url, no env secret: the stored credential is resolved and passed
    // to the fetch as the Authorization header.
    const sameUrlFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });
    const result = await runAddMcp(
      BASE_ARGS,
      makeDeps({ store, env: {}, fetchTools: sameUrlFetch }),
    );

    expect(result.exitCode).toBe(0);
    expect(sameUrlFetch).toHaveBeenCalledTimes(1);
    expect(sameUrlFetch.mock.calls[0]?.[0]).toBe(BASE_ARGS.url);
    expect(sameUrlFetch.mock.calls[0]?.[1]).toEqual({ authorization: "Bearer tok123" });
  });

  it("does NOT pass the stored credential when no auth is available (fresh add, no env)", async () => {
    const store = await openTestStore();
    const noAuthFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });

    const result = await runAddMcp(
      BASE_ARGS,
      makeDeps({ store, env: {}, fetchTools: noAuthFetch }),
    );

    expect(result.exitCode).toBe(0);
    // Either called with no opts or opts without an authorization key.
    expect(noAuthFetch.mock.calls[0]?.[1]?.authorization).toBeUndefined();
  });

  it("passes the fresh CONDUIT_ADD_SECRET (not the stored ref) to the fetch when both exist", async () => {
    const store = await openTestStore();
    await runAddMcp(BASE_ARGS, makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer stored" } }));

    const envFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });
    const result = await runAddMcp(
      BASE_ARGS,
      makeDeps({ store, env: { CONDUIT_ADD_SECRET: "Bearer fresh" }, fetchTools: envFetch }),
    );

    expect(result.exitCode).toBe(0);
    expect(envFetch.mock.calls[0]?.[1]).toEqual({ authorization: "Bearer fresh" });
  });

  // --- Error mapping per McpClientError kind (replaces the discard-all catch)

  const errorCases: {
    label: string;
    error: McpClientError;
    expected: string;
  }[] = [
    {
      label: "http_status 401 → authorization guidance",
      error: new McpClientError("http_status", "MCP endpoint returned HTTP 401", { status: 401 }),
      expected:
        "[conduit add-mcp] upstream requires authorization (HTTP 401): set CONDUIT_ADD_SECRET; nothing was written.",
    },
    {
      label: "http_status 403 → authorization guidance",
      error: new McpClientError("http_status", "MCP endpoint returned HTTP 403", { status: 403 }),
      expected:
        "[conduit add-mcp] upstream requires authorization (HTTP 403): set CONDUIT_ADD_SECRET; nothing was written.",
    },
    {
      label: "cap → the client cap message verbatim",
      error: new McpClientError("cap", "MCP response exceeded the cumulative byte budget"),
      expected:
        "[conduit add-mcp] MCP response exceeded the cumulative byte budget; nothing was written.",
    },
    {
      label: "timeout → onboarding-budget line",
      error: new McpClientError("timeout", "MCP response body read timed out"),
      expected:
        "[conduit add-mcp] upstream did not complete within the onboarding budget; nothing was written.",
    },
    {
      label: "protocol → the client message",
      error: new McpClientError("protocol", "MCP response never carried the expected id"),
      expected:
        "[conduit add-mcp] MCP response never carried the expected id; nothing was written.",
    },
    {
      label: "network → today's unreachable line",
      error: new McpClientError("network", "MCP request failed before a response arrived"),
      expected: `[conduit add-mcp] upstream unreachable at ${BASE_ARGS.url}; nothing was written. Re-run when reachable.`,
    },
  ];

  for (const { label, error, expected } of errorCases) {
    it(`error mapping: ${label} — exit 1, exact stderr, 0 writes`, async () => {
      const store = await openTestStore();
      const deps = makeDeps({
        store,
        fetchTools: vi.fn(async () => {
          throw error;
        }),
      });

      const result = await runAddMcp(BASE_ARGS, deps);

      expect(result.exitCode).toBe(1);
      expect(deps.stderrLines.join("")).toContain(expected);
      expect(await store.sources.list()).toEqual([]);
    });
  }

  it("a non-McpClientError rejection still fails loud via the network fallback line", async () => {
    const store = await openTestStore();
    const deps = makeDeps({
      store,
      fetchTools: vi.fn(async () => {
        throw new Error("some other error");
      }),
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join("")).toContain(
      `[conduit add-mcp] upstream unreachable at ${BASE_ARGS.url}; nothing was written. Re-run when reachable.`,
    );
    expect(await store.sources.list()).toEqual([]);
  });
});
