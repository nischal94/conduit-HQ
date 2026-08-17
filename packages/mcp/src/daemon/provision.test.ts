/**
 * Daemon-side provisioning tests (§17 Task 8).
 *
 * These moved here from `packages/cli/src/add-mcp.test.ts` with the logic
 * they cover: every decision below — the retarget gate, the credential-leak
 * refusal, preserve-not-remove, the error mapping — now runs inside the
 * daemon, against the store the daemon owns, so this is where it is pinned.
 * The CLI's own (much smaller) surface is covered in
 * `packages/cli/src/add-mcp.test.ts`.
 *
 * The shim below keeps the assertions themselves faithful to the
 * pre-conversion originals: `run(...)` maps a `ProvisionRefused` back into
 * the `{exitCode, stderr}` shape the CLI used to produce, which is exactly
 * what `connection.ts` + `add-mcp.ts` do at runtime (refusal → `invalid`
 * error frame → stderr line + exit 1). A thrown NON-refusal still
 * propagates, because that is the fault path that must not be swallowed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConduitStore, McpClientError, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ProvisionInput,
  ProvisionRefused,
  provisionSourceRequest,
  revalidateSourceRequest,
} from "./provision.js";

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

type FetchTools = (url: string, opts?: { authorization?: string }) => Promise<unknown[]>;

/**
 * The outcome shape the CLI still presents, reconstructed from the daemon's
 * two possible answers. A `ProvisionRefused` becomes `{exitCode: 1}` plus
 * its message on stderr — the exact transformation `connection.ts` and
 * `add-mcp.ts` perform between them at runtime — so every assertion below
 * reads the same as it did before the conversion.
 */
interface RunOutcome {
  exitCode: number;
  stdoutLines: string[];
  stderrLines: string[];
  fetchTools: FetchTools;
}

const BASE_ARGS = {
  url: "http://127.0.0.1:9/mcp",
  namespace: "github",
  prefix: "github.acme.prod",
  replace: false,
  clearCredential: false,
} satisfies ProvisionInput;

/**
 * Drives `provisionSourceRequest` and renders its answer the way the CLI
 * does. `env.CONDUIT_ADD_SECRET` is threaded as the request's `secret`
 * field, mirroring `add-mcp.ts`'s one client→daemon secret.
 */
async function run(
  args: Partial<ProvisionInput> & { namespace?: string },
  opts: { store: ConduitStore; fetchTools?: FetchTools; env?: NodeJS.ProcessEnv },
): Promise<RunOutcome> {
  const fetchTools = opts.fetchTools ?? (vi.fn(async () => TOOLS_LIST) as FetchTools);
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const secret = opts.env?.CONDUIT_ADD_SECRET;
  const input: ProvisionInput = {
    ...BASE_ARGS,
    ...args,
    ...(secret !== undefined && secret.trim() !== "" ? { secret } : {}),
  };
  try {
    const payload = await provisionSourceRequest(input, { store: opts.store, fetchTools });
    for (const warning of payload.warnings ?? []) stderrLines.push(`${warning}\n`);
    stdoutLines.push(
      `seeded ${payload.toolCount} tools for connection ${payload.prefix} (namespace ${payload.namespace}): ` +
        `${payload.counts.safe} safe (auto-allow), ${payload.counts.review} review (approval), ` +
        `${payload.counts.destructive} destructive (approval)\n`,
    );
    return { exitCode: 0, stdoutLines, stderrLines, fetchTools };
  } catch (err) {
    if (!(err instanceof ProvisionRefused)) throw err;
    stderrLines.push(`${err.message}\n`);
    return { exitCode: 1, stdoutLines, stderrLines, fetchTools };
  }
}

describe("provisionSourceRequest (add-mcp, daemon-side)", () => {
  it("a malformed namespace is rejected before any write", async () => {
    const store = await openTestStore();
    const deps = { store, fetchTools: vi.fn() };

    const result = await run({ namespace: "A B" }, deps);

    expect(result.exitCode).not.toBe(0);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
  });

  it("every field empty/invalid → ONE refusal naming ALL of them, no fetch, 0 writes", async () => {
    // The daemon re-validates independently of any CLI: a hand-crafted
    // frame need not have passed through `runAddMcp`'s Step-1 check, and
    // this is the authorization boundary.
    const store = await openTestStore();
    const deps = { store, fetchTools: vi.fn() as unknown as FetchTools };

    const result = await run({ namespace: "", url: "", prefix: "" }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
    expect(result.stderrLines).toHaveLength(1);
    const stderr = result.stderrLines[0];
    expect(stderr).toContain("namespace");
    expect(stderr).toContain("url");
    expect(stderr).toContain("prefix");
  });

  it("an unparseable url is refused before any fetch (ONE refusal line, 0 writes)", async () => {
    const store = await openTestStore();
    const deps = { store, fetchTools: vi.fn() };

    const result = await run({ url: "not-a-url" }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
    expect(result.stderrLines).toHaveLength(1);
    const stderr = result.stderrLines[0];
    expect(stderr).toContain("Missing/invalid required flags");
    expect(stderr).toContain("url (must be a valid http(s) URL)");
    // NOT the "upstream unreachable" line — a bad url is a validation error.
    expect(stderr).not.toContain("upstream unreachable");
  });

  it("a non-http(s) url scheme is refused before any fetch (ONE refusal line, 0 writes)", async () => {
    const store = await openTestStore();
    const deps = { store, fetchTools: vi.fn() };

    const result = await run({ url: "ftp://host/mcp" }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
    expect(result.stderrLines).toHaveLength(1);
    expect(result.stderrLines[0]).toContain("url (must be a valid http(s) URL)");
  });

  it("INVARIANT /cli add-mcp: unreachable --url fails loud and writes nothing", async () => {
    const store = await openTestStore();
    const deps = {
      store,
      fetchTools: vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    };

    const result = await run({}, deps);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderrLines.join("")).toMatch(
      /upstream unreachable at http:\/\/127\.0\.0\.1:9\/mcp; nothing was written\. Re-run when reachable\./,
    );
    expect(await store.sources.list()).toEqual([]);
  });

  it("schema-invalid tools/list body (fetch OK, normalizeMcp throws) goes through the fail-loud path with 0 writes", async () => {
    const store = await openTestStore();
    const deps = {
      store,
      // HTTP-level success: an array, so the fetch layer's shape check
      // passes — but a non-string tool name fails normalizeMcp's envelope.
      fetchTools: vi.fn(async () => [{ name: 42 }]),
    };

    const result = await run({}, deps);

    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderrLines.join("");
    expect(stderr).toMatch(/^\[conduit add-mcp\]/);
    expect(stderr).toMatch(/nothing was written/);
    expect(await store.sources.list()).toEqual([]);
  });

  it("a plain-Error rejection carrying a cap message fails loud with 0 writes (fallback path, not the McpClientError cap mapping)", async () => {
    const store = await openTestStore();
    const deps = {
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
    };

    const result = await run({}, deps);

    expect(result.exitCode).not.toBe(0);
    expect(await store.sources.list()).toEqual([]);
  });

  it("a plain-Error rejection carrying an over-count message fails loud with 0 writes (fallback path, not the McpClientError cap mapping)", async () => {
    const store = await openTestStore();
    const deps = {
      store,
      // Plain Error → non-McpClientError fallback path (see the byte-cap test
      // above); real over-count enforcement is pinned in mcp-client.test.ts.
      fetchTools: vi.fn(async () => {
        throw new Error(
          "[conduit add-mcp] upstream tools/list response exceeds the 1024-tool cap (got 2000); nothing was written.",
        );
      }),
    };

    const result = await run({}, deps);

    expect(result.exitCode).not.toBe(0);
    expect(await store.sources.list()).toEqual([]);
  });

  it("duplicate-after-namespacing tool names (normalizeMcp throws) also fail loud with 0 writes", async () => {
    const store = await openTestStore();
    const deps = {
      store,
      // Both normalize to `github.a.b` — normalizeMcp refuses.
      fetchTools: vi.fn(async () => [
        { name: "a/b", inputSchema: { type: "object" } },
        { name: "a.b", inputSchema: { type: "object" } },
      ]),
    };

    const result = await run({}, deps);

    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderrLines.join("");
    expect(stderr).toMatch(/^\[conduit add-mcp\]/);
    expect(stderr).toMatch(/nothing was written/);
    expect(await store.sources.list()).toEqual([]);
  });

  it("existing namespace with a differing --url, no --replace, refuses with 0 writes", async () => {
    const store = await openTestStore();
    // First run: seeds the namespace.
    await run({}, { store });
    const beforeTools = await store.tools.list();

    // Second run: same namespace, different url, no --replace.
    const deps = { store, fetchTools: vi.fn() as unknown as FetchTools };
    const result = await run({ url: "http://127.0.0.1:9/mcp-different" }, deps);

    expect(result.exitCode).not.toBe(0);
    // The C3 gate refuses BEFORE any fetch to the new url.
    expect(deps.fetchTools).not.toHaveBeenCalled();
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe(BASE_ARGS.url); // unchanged
    expect(await store.tools.list()).toEqual(beforeTools); // unchanged
  });

  it("--replace allows retargeting to a new url", async () => {
    const store = await openTestStore();
    await run({}, { store });

    const result = await run({ url: "http://127.0.0.1:9/mcp-new", replace: true }, { store });

    expect(result.exitCode).toBe(0);
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe("http://127.0.0.1:9/mcp-new");
  });

  it("INVARIANT /cli add-mcp: cross-namespace --prefix collision fails loud with 0 writes to the new namespace, and does not disturb the existing owner", async () => {
    const store = await openTestStore();
    // Namespace A seeds prefix P.
    await run({}, { store });

    // Namespace B tries to claim the same prefix P.
    const deps = { store, fetchTools: vi.fn() as unknown as FetchTools };
    const result = await run({ namespace: "gitlab", url: "http://127.0.0.1:9/mcp-other" }, deps);

    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderrLines.join("");
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
    await run({}, { store });

    // Re-run: same namespace, same prefix — idempotent re-sync path.
    const result = await run({}, { store });

    expect(result.exitCode).toBe(0);
    const source = await store.sources.get("src_github");
    expect(source?.location).toBe(BASE_ARGS.url);
  });

  it("--replace on an UNCHANGED url/prefix produces no retargeting warning", async () => {
    const store = await openTestStore();
    await run({}, { store });

    const deps = { store };
    const result = await run({ replace: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(result.stderrLines.join("")).not.toMatch(/retargeting/);
  });

  it("re-sync with no CONDUIT_ADD_SECRET but an existing credentialRef preserves it", async () => {
    const store = await openTestStore();
    // First run WITH a secret.
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } });

    const connectionsBefore = await store.connections.list();
    const existingRef = connectionsBefore.find(
      (c) => c.integrationId === "int_github",
    )?.credentialRef;
    expect(existingRef).toBeDefined();

    // Second run WITHOUT CONDUIT_ADD_SECRET (env has no key at all).
    const result = await run({}, { store, env: {} });

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
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } });
    const connectionsBefore = await store.connections.list();
    const existingRef = connectionsBefore.find((c) => c.integrationId === "int_github")
      ?.credentialRef as string;

    const result = await run({ clearCredential: true }, { store, env: {} });

    expect(result.exitCode).toBe(0);
    const connectionsAfter = await store.connections.list();
    const conn = connectionsAfter.find((c) => c.integrationId === "int_github");
    expect(conn?.credentialRef).toBeUndefined();
    expect(await store.secrets.reveal(existingRef)).toBeUndefined();
  });

  it("--clear-credential: a REJECTING provisionSource leaves the old secret and old credentialRef fully intact (batch rollback, not ordering)", async () => {
    const store = await openTestStore();
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } });
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

    await expect(run({ clearCredential: true }, { store: failingStore, env: {} })).rejects.toThrow(
      "simulated provisionSource failure",
    );

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
    const deps = { store, env: { CONDUIT_ADD_SECRET: SECRET } };

    const result = await run({}, deps);

    expect(result.exitCode).toBe(0);
    const allOutput = [...result.stdoutLines, ...result.stderrLines].join("");
    expect(allOutput).not.toContain(SECRET);
  });

  it("secret is never echoed even on a --replace warning path", async () => {
    const store = await openTestStore();
    const SECRET = "Bearer super_secret_value_do_not_leak";
    await run({}, { store, env: { CONDUIT_ADD_SECRET: SECRET } });

    const deps = {
      store,
      env: { CONDUIT_ADD_SECRET: SECRET },
    };
    const result = await run({ url: "http://127.0.0.1:9/mcp-new", replace: true }, deps);

    expect(result.exitCode).toBe(0);
    const allOutput = [...result.stdoutLines, ...result.stderrLines].join("");
    expect(allOutput).not.toContain(SECRET);
  });

  it("success prints a risk-class count summary", async () => {
    const store = await openTestStore();
    const deps = { store };

    const result = await run({}, deps);

    expect(result.exitCode).toBe(0);
    const line = result.stdoutLines.join("");
    expect(line).toMatch(/seeded 3 tools for connection github\.acme\.prod \(namespace github\):/);
    expect(line).toMatch(/1 safe \(auto-allow\)/);
    expect(line).toMatch(/1 review \(approval\)/);
    expect(line).toMatch(/1 destructive \(approval\)/);
  });

  it("the projection reports credential PRESENT when a secret was supplied", async () => {
    const store = await openTestStore();
    const payload = await provisionSourceRequest(
      { ...BASE_ARGS, secret: "Bearer tok" },
      { store, fetchTools: async () => TOOLS_LIST },
    );

    expect(payload.counts).toEqual({ safe: 1, review: 1, destructive: 1 });
    expect(payload.credential).toBe("present");
  });

  it("the projection reports credential ABSENT when none is supplied or preserved", async () => {
    const store = await openTestStore();
    const payload = await provisionSourceRequest(BASE_ARGS, {
      store,
      fetchTools: async () => TOOLS_LIST,
    });

    expect(payload.credential).toBe("absent");
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
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } });
    const before = await store.connections.list();
    const existingRef = before.find((c) => c.integrationId === "int_github")
      ?.credentialRef as string;
    const beforeTools = await store.tools.list();

    const deps = { store, env: {}, fetchTools: vi.fn(async () => TOOLS_LIST) };
    const result = await run({ url: "http://127.0.0.1:9/mcp-new", replace: true }, deps);

    expect(result.exitCode).toBe(1);
    expect(result.stderrLines.join("")).toContain(
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
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer old" } });

    // Spy the fetch: the retarget fetch to the NEW host must carry the FRESH
    // secret ("Bearer new"), never the old stored one bound to the old host.
    const freshFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });
    const result = await run(
      { url: "http://127.0.0.1:9/mcp-new", replace: true },
      { store, env: { CONDUIT_ADD_SECRET: "Bearer new" }, fetchTools: freshFetch },
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
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer old" } });
    const before = await store.connections.list();
    const oldRef = before.find((c) => c.integrationId === "int_github")?.credentialRef as string;

    // Spy the fetch: --clear-credential drops the old secret AND must send NO
    // Authorization to the new host — the stored secret is bound to the old
    // upstream and must never reach a different one.
    const clearFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });
    const result = await run(
      { url: "http://127.0.0.1:9/mcp-new", replace: true, clearCredential: true },
      { store, env: {}, fetchTools: clearFetch },
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
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer tok123" } });

    // Same url, no env secret: the stored credential is resolved and passed
    // to the fetch as the Authorization header.
    const sameUrlFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });
    const result = await run({}, { store, env: {}, fetchTools: sameUrlFetch });

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

    const result = await run({}, { store, env: {}, fetchTools: noAuthFetch });

    expect(result.exitCode).toBe(0);
    // Either called with no opts or opts without an authorization key.
    expect(noAuthFetch.mock.calls[0]?.[1]?.authorization).toBeUndefined();
  });

  it("passes the fresh CONDUIT_ADD_SECRET (not the stored ref) to the fetch when both exist", async () => {
    const store = await openTestStore();
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer stored" } });

    const envFetch = vi.fn(async (_url: string, opts?: { authorization?: string }) => {
      void opts;
      return TOOLS_LIST;
    });
    const result = await run(
      {},
      { store, env: { CONDUIT_ADD_SECRET: "Bearer fresh" }, fetchTools: envFetch },
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
      const deps = {
        store,
        fetchTools: vi.fn(async () => {
          throw error;
        }),
      };

      const result = await run({}, deps);

      expect(result.exitCode).toBe(1);
      expect(result.stderrLines.join("")).toContain(expected);
      expect(await store.sources.list()).toEqual([]);
    });
  }

  it("a non-McpClientError rejection still fails loud via the network fallback line", async () => {
    const store = await openTestStore();
    const deps = {
      store,
      fetchTools: vi.fn(async () => {
        throw new Error("some other error");
      }),
    };

    const result = await run({}, deps);

    expect(result.exitCode).toBe(1);
    expect(result.stderrLines.join("")).toContain(
      `[conduit add-mcp] upstream unreachable at ${BASE_ARGS.url}; nothing was written. Re-run when reachable.`,
    );
    expect(await store.sources.list()).toEqual([]);
  });
});

describe("revalidateSourceRequest (the anti-oracle half)", () => {
  it("derives BOTH the url and the credential from the STORED row — the client supplies only a namespace", async () => {
    const store = await openTestStore();
    await run({}, { store, env: { CONDUIT_ADD_SECRET: "Bearer stored" } });

    // The ONLY input is the namespace. There is no parameter by which a
    // caller could name a destination or a credential, which is the whole
    // §3.3.1 argument expressed as a function signature.
    const seen: { url: string; auth?: string }[] = [];
    const payload = await revalidateSourceRequest("github", {
      store,
      fetchTools: async (url, opts) => {
        seen.push({
          url,
          ...(opts?.authorization !== undefined ? { auth: opts.authorization } : {}),
        });
        return TOOLS_LIST;
      },
    });

    // The stored url, and the stored credential — neither nameable by a client.
    expect(seen).toEqual([{ url: BASE_ARGS.url, auth: "Bearer stored" }]);
    expect(payload).toMatchObject({
      namespace: "github",
      prefix: BASE_ARGS.prefix,
      credential: "present",
    });
    // The projection carries no ref and no secret.
    expect(JSON.stringify(payload)).not.toContain("Bearer stored");
    expect(JSON.stringify(payload)).not.toContain("cred_");
  });

  it("sends NO auth when the stored source has no credential", async () => {
    const store = await openTestStore();
    await run({}, { store });

    const seen: (string | undefined)[] = [];
    await revalidateSourceRequest("github", {
      store,
      fetchTools: async (_url, opts) => {
        seen.push(opts?.authorization);
        return TOOLS_LIST;
      },
    });

    expect(seen).toEqual([undefined]);
  });

  it("refuses an unknown namespace rather than implicitly onboarding it, with 0 writes and no fetch", async () => {
    // Onboarding needs a url, and the ONLY request that may carry one is
    // `source.provision` — where the operator supplies their own
    // destination alongside their own secret. Revalidate must never become
    // a second door to that.
    const store = await openTestStore();
    const fetchTools = vi.fn() as unknown as FetchTools;

    await expect(revalidateSourceRequest("nope", { store, fetchTools })).rejects.toThrow(
      ProvisionRefused,
    );
    expect(fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
  });

  it("refuses a malformed namespace before touching the store", async () => {
    const store = await openTestStore();
    await expect(
      revalidateSourceRequest("A B", { store, fetchTools: async () => TOOLS_LIST }),
    ).rejects.toThrow(ProvisionRefused);
  });

  it("re-seeds the namespace's tools from the fresh fetch (it is a re-sync, not a no-op)", async () => {
    const store = await openTestStore();
    await run({}, { store });
    expect(await store.tools.list()).toHaveLength(3);

    // The upstream now advertises ONE tool: the revalidate must replace the
    // namespace, not merely confirm it.
    const payload = await revalidateSourceRequest("github", {
      store,
      fetchTools: async () => [TOOLS_LIST[0]],
    });

    expect(payload.toolCount).toBe(1);
    expect(await store.tools.list()).toHaveLength(1);
  });
});
