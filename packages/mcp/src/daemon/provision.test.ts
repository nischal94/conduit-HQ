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
  MAX_TOOL_TEXT_BYTES,
  type ProvisionInput,
  ProvisionRefused,
  provisionSourceRequest,
  revalidateSourceRequest,
} from "./provision.js";
import { createSourceLock } from "./source-lock.js";

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

  it("a tool whose DESCRIPTION exceeds the per-tool text cap is refused with 0 writes", async () => {
    const store = await openTestStore();
    const deps = {
      store,
      // Passes both of the other onboarding bounds — one tool, well under
      // MAX_RESPONSE_BYTES — and is refused solely on its per-tool text.
      fetchTools: vi.fn(async () => [
        {
          name: "list_issues",
          description: "x".repeat(MAX_TOOL_TEXT_BYTES + 1),
          inputSchema: { type: "object", properties: {} },
        },
      ]),
    };

    const result = await run({}, deps);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderrLines.join("")).toContain(
      `exceeds the ${MAX_TOOL_TEXT_BYTES}-byte per-tool limit (tool index 0)`,
    );
    // The refusal names the limit and the position, and forwards no byte of
    // the upstream's own text (F1 — a reflecting upstream can put a
    // credential in a description).
    expect(result.stderrLines.join("")).not.toContain("xxxx");
    expect(await store.sources.list()).toEqual([]);
    expect(await store.tools.list()).toEqual([]);
  });

  it("a tool whose NAME exceeds the per-tool text cap is refused with 0 writes", async () => {
    const store = await openTestStore();
    const deps = {
      store,
      // A legitimate first tool, an oversize second: the reported index
      // must localize the fault rather than always naming position 0.
      fetchTools: vi.fn(async () => [
        { name: "list_issues", description: "List open issues" },
        { name: "a".repeat(MAX_TOOL_TEXT_BYTES + 1), description: "fine" },
      ]),
    };

    const result = await run({}, deps);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderrLines.join("")).toContain(
      `exceeds the ${MAX_TOOL_TEXT_BYTES}-byte per-tool limit (tool index 1)`,
    );
    expect(await store.sources.list()).toEqual([]);
    expect(await store.tools.list()).toEqual([]);
  });

  it("a tool exactly AT the per-tool text cap is accepted — the bound is inclusive", async () => {
    const store = await openTestStore();
    const deps = {
      store,
      // Not vacuous: without an exact-boundary case an off-by-one that
      // refuses at the cap itself would pass every test above.
      fetchTools: vi.fn(async () => [
        {
          name: "list_issues",
          description: "x".repeat(MAX_TOOL_TEXT_BYTES),
          inputSchema: { type: "object", properties: {} },
        },
      ]),
    };

    const result = await run({}, deps);

    expect(result.exitCode).toBe(0);
    expect((await store.tools.list()).map((tool) => tool.name)).toEqual(["github.list_issues"]);
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
      // F1: the cap arm returns a FIXED category, never the upstream's own
      // (potentially credential-echoing) message text.
      label: "cap → a FIXED category (no upstream text forwarded)",
      error: new McpClientError("cap", "MCP response exceeded the cumulative byte budget"),
      expected:
        "[conduit add-mcp] the upstream's onboarding response exceeded a size/tool limit; nothing was written. See the daemon log for the upstream's detail.",
    },
    {
      label: "timeout → onboarding-budget line",
      error: new McpClientError("timeout", "MCP response body read timed out"),
      expected:
        "[conduit add-mcp] upstream did not complete within the onboarding budget; nothing was written.",
    },
    {
      // F1: the protocol arm returns a FIXED category — the upstream's error
      // string (where a hostile server echoes a credential) is withheld.
      label: "protocol → a FIXED category (no upstream text forwarded)",
      error: new McpClientError("protocol", "MCP response never carried the expected id"),
      expected:
        "[conduit add-mcp] the upstream returned an invalid MCP handshake or tools/list during onboarding (protocol error); nothing was written. See the daemon log for the upstream's detail.",
    },
    {
      // F1: even a non-auth http_status returns a fixed category naming only
      // the numeric status, never the upstream's response body.
      label: "http_status 500 → a FIXED category naming only the status",
      error: new McpClientError("http_status", "upstream said: internal boom", { status: 500 }),
      expected:
        "[conduit add-mcp] the upstream rejected the request during onboarding (HTTP 500); nothing was written. See the daemon log for the upstream's detail.",
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
      const stderr = result.stderrLines.join("");
      expect(stderr).toContain(expected);
      // F1: the upstream's own message text never reaches the client. The
      // fixed-category arms replace it entirely; the auth/timeout/network
      // arms were already fixed. "MCP response exceeded", "MCP response
      // never", "internal boom" are the raw upstream strings above.
      expect(stderr).not.toContain(error.message);
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

describe("INVARIANT §17 / §9.2 — onboarding error text never carries a stored credential (F1)", () => {
  // The exact bearer a hostile upstream would echo. A reflecting server puts
  // it in its own JSON-RPC error message, which `mcp-client.ts` interpolates
  // into `McpClientError.message` (via describeRpcError). Task 8 moved this
  // fetch daemon-side, where the serve-time sanitization does NOT run — so
  // the daemon must refuse to forward that text to the client at all.
  const BEARER = "Bearer sk-live-EXFIL-abc123def456ghi789";

  /**
   * An upstream fetch that, whatever it is asked, throws an `McpClientError`
   * whose message ECHOES the exact authorization value it was given — the
   * malicious-reflection shape for BOTH the initialize and the tools/list
   * error paths (they both route through `describeRpcError`).
   */
  const echoingFetch =
    (kind: McpClientError["kind"]): FetchTools =>
    async (_url, opts) => {
      const echoed = opts?.authorization ?? "<no-auth-sent>";
      throw new McpClientError(
        kind,
        `MCP server rejected initialize: upstream said {"error":"bad token ${echoed}"}`,
      );
    };

  it("a reflecting upstream on the REVALIDATE path leaks the stored credential into NEITHER the client frame NOR the daemon log", async () => {
    const store = await openTestStore();
    // Onboard WITH a stored credential, so revalidate reveals + sends it.
    await run({}, { store, env: { CONDUIT_ADD_SECRET: BEARER } });

    const daemonLog: string[] = [];
    // protocol AND cap AND http_status are the arms that used to forward
    // cause.message; check all three plus the fallback.
    for (const kind of ["protocol", "cap", "http_status"] as const) {
      daemonLog.length = 0;
      let clientMessage = "";
      try {
        await revalidateSourceRequest("github", {
          store,
          fetchTools: echoingFetch(kind),
          log: (line) => daemonLog.push(line),
        });
        throw new Error("expected a ProvisionRefused");
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisionRefused);
        clientMessage = (err as ProvisionRefused).message;
      }

      // The CLIENT-BOUND frame (what add-mcp prints) carries no credential.
      expect(clientMessage).not.toContain(BEARER);
      expect(clientMessage).not.toContain("sk-live-EXFIL");
      // And no raw upstream text at all — the message is the fixed category.
      expect(clientMessage).not.toContain("upstream said");

      // The DAEMON LOG got the detail (so nothing debuggable is lost) but
      // with the credential REDACTED — this is the load-bearing assertion.
      const loggedText = daemonLog.join("\n");
      expect(loggedText).not.toContain(BEARER);
      expect(loggedText).not.toContain("sk-live-EXFIL");
      expect(loggedText).toContain("[redacted]");
      expect(loggedText).toContain("Onboarding fetch failed");
    }
  });

  it("a reflecting upstream on the PROVISION re-sync path (stored credential reused) leaks it into neither surface", async () => {
    const store = await openTestStore();
    await run({}, { store, env: { CONDUIT_ADD_SECRET: BEARER } });

    const daemonLog: string[] = [];
    // Same url as the stored row → the stored credential is reused and sent.
    await expect(
      provisionSourceRequest(
        { ...BASE_ARGS },
        { store, fetchTools: echoingFetch("protocol"), log: (line) => daemonLog.push(line) },
      ),
    ).rejects.toMatchObject({ name: "ProvisionRefused" });

    let refusalMessage = "";
    try {
      await provisionSourceRequest(
        { ...BASE_ARGS },
        { store, fetchTools: echoingFetch("protocol") },
      );
    } catch (err) {
      refusalMessage = (err as ProvisionRefused).message;
    }
    expect(refusalMessage).not.toContain(BEARER);
    expect(refusalMessage).not.toContain("upstream said");

    const loggedText = daemonLog.join("\n");
    expect(loggedText).not.toContain(BEARER);
    expect(loggedText).toContain("[redacted]");
  });

  it("a malformed tools/list body whose text echoes the credential is withheld from the client and redacted in the log", async () => {
    const store = await openTestStore();
    await run({}, { store, env: { CONDUIT_ADD_SECRET: BEARER } });

    const daemonLog: string[] = [];
    // Fetch SUCCEEDS but returns a body normalizeMcp rejects, and the
    // rejection detail echoes what a reflecting upstream put in a tool name.
    let refusalMessage = "";
    try {
      await revalidateSourceRequest("github", {
        store,
        fetchTools: async (_url, opts) => [
          { name: `tool ${opts?.authorization ?? ""}`, inputSchema: 42 },
        ],
        log: (line) => daemonLog.push(line),
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ProvisionRefused);
      refusalMessage = (err as ProvisionRefused).message;
    }

    expect(refusalMessage).not.toContain(BEARER);
    expect(refusalMessage).not.toContain("sk-live-EXFIL");
    const loggedText = daemonLog.join("\n");
    expect(loggedText).not.toContain(BEARER);
  });

  it("the fixed category still names the operator's next move (not a bare code)", async () => {
    const store = await openTestStore();
    let message = "";
    try {
      await provisionSourceRequest(
        { ...BASE_ARGS },
        { store, fetchTools: echoingFetch("protocol") },
      );
    } catch (err) {
      message = (err as ProvisionRefused).message;
    }
    expect(message).toContain("nothing was written");
    expect(message).toContain("protocol error");
    expect(message).toContain("daemon log");
  });
});

describe("INVARIANT §17 / §9.2 — a credential in the url is refused, and a stored url is never echoed raw (F3)", () => {
  it("a userinfo url (user:pass@host) is refused before any fetch, 0 writes", async () => {
    const store = await openTestStore();
    const fetchTools = vi.fn() as unknown as FetchTools;
    await expect(
      provisionSourceRequest(
        { ...BASE_ARGS, url: "https://alice:s3cr3t@upstream.example/mcp" },
        { store, fetchTools },
      ),
    ).rejects.toBeInstanceOf(ProvisionRefused);
    expect(fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
  });

  it("a query-token url is accepted for provisioning but never echoed raw in a later revalidation-failure frame", async () => {
    const store = await openTestStore();
    // A ?token= url is a legal http(s) url (no userinfo) — accepted. The
    // point of F3's second half is that when it later reaches an
    // operator-facing frame it is rendered origin+path, dropping the query.
    const TOKENED = "https://upstream.example/mcp?token=QUERY_SECRET_TOKEN_xyz";
    await provisionSourceRequest(
      { ...BASE_ARGS, url: TOKENED },
      { store, fetchTools: async () => TOOLS_LIST },
    );

    // Now revalidate against a failing upstream: the stored url reaches the
    // refusal frame, and must be sanitized to origin+path.
    let message = "";
    try {
      await revalidateSourceRequest("github", {
        store,
        fetchTools: async () => {
          throw new McpClientError("network", "boom");
        },
      });
    } catch (err) {
      message = (err as ProvisionRefused).message;
    }
    expect(message).not.toContain("QUERY_SECRET_TOKEN");
    expect(message).not.toContain("?token=");
    expect(message).toContain("upstream.example/mcp");
  });

  it("the CLI-side intake also rejects a userinfo url with an actionable message", async () => {
    // Mirrors the daemon guard at the client boundary — the operator sees the
    // FLAG-shaped hint. Verified through the real runAddMcp path in add-mcp
    // tests; here we pin the daemon predicate directly.
    const store = await openTestStore();
    let message = "";
    try {
      await provisionSourceRequest(
        { ...BASE_ARGS, url: "http://:justpass@host/mcp" },
        { store, fetchTools: vi.fn() as unknown as FetchTools },
      );
    } catch (err) {
      message = (err as ProvisionRefused).message;
    }
    expect(message).toMatch(/url/);
  });
});

describe("INVARIANT §17 / §9.2 — concurrent provision/revalidate serialize per namespace (F2, anti-oracle race)", () => {
  const URL_A = "http://127.0.0.1:9/mcp-A";
  const URL_B = "http://127.0.0.1:9/mcp-B";

  /**
   * A fetch that BLOCKS on a per-call barrier the test controls, so the test
   * can pin one operation's fetch open while the other tries to run — the
   * exact interleaving the anti-oracle race needs.
   */
  function barrierFetch(): {
    fetch: FetchTools;
    release(url: string): void;
    started(url: string): Promise<void>;
  } {
    const gates = new Map<string, { open: Promise<void>; release: () => void }>();
    const startedResolvers = new Map<string, () => void>();
    const startedPromises = new Map<string, Promise<void>>();
    const gateFor = (url: string) => {
      let g = gates.get(url);
      if (g === undefined) {
        let release!: () => void;
        const open = new Promise<void>((r) => {
          release = r;
        });
        g = { open, release };
        gates.set(url, g);
      }
      return g;
    };
    const startedFor = (url: string) => {
      let p = startedPromises.get(url);
      if (p === undefined) {
        let res!: () => void;
        p = new Promise<void>((r) => {
          res = r;
        });
        startedPromises.set(url, p);
        startedResolvers.set(url, res);
      }
      return p;
    };
    return {
      fetch: async (url) => {
        startedFor(url);
        startedResolvers.get(url)?.();
        await gateFor(url).open;
        return TOOLS_LIST;
      },
      release: (url) => gateFor(url).release(),
      started: (url) => startedFor(url),
    };
  }

  it("with the per-namespace lock, an interleaved revalidate + retargeting provision leave a CONSISTENT (destination, credential) pairing", async () => {
    const store = await openTestStore();
    const lock = createSourceLock();

    // Seed the namespace at URL_A with a stored credential.
    await run({ url: URL_A }, { store, env: { CONDUIT_ADD_SECRET: "Bearer secret-A" } });

    const barrier = barrierFetch();

    // Op 1: revalidate("github") — reads the stored row (URL_A + cred), then
    // its fetch blocks on URL_A's barrier. WITHOUT the lock, op 2 below could
    // retarget under it and op 1 would then re-commit URL_A pairing the fresh
    // secret with the stale destination.
    const revalidate = lock.run("github", () =>
      revalidateSourceRequest("github", { store, fetchTools: barrier.fetch }),
    );

    // Op 2: a retargeting provision to URL_B with a FRESH secret. It is
    // submitted while op 1 holds the lock; the lock must make it wait.
    const provision = lock.run("github", () =>
      provisionSourceRequest(
        { ...BASE_ARGS, url: URL_B, replace: true, secret: "Bearer secret-B" },
        { store, fetchTools: barrier.fetch },
      ),
    );

    // Op 1 has started its fetch (holds the lock). Op 2 must NOT have started
    // — the lock serializes them. Prove it by releasing only URL_A and
    // confirming URL_B's fetch never fired while op 1 was in flight.
    await barrier.started(URL_A);
    await new Promise((r) => setTimeout(r, 20));

    // Release op 1's fetch → it commits URL_A. Only then does op 2 acquire
    // the lock, run its own fetch against URL_B, and commit.
    barrier.release(URL_A);
    await revalidate;
    await barrier.started(URL_B);
    barrier.release(URL_B);
    await provision;

    // FINAL STATE must be self-consistent: the stored location and the stored
    // credential are one pair. Because the ops serialized, op 2 (the later
    // committer) fully wins — URL_B with secret-B — rather than a torn
    // (URL_A, secret-B) pairing.
    const source = await store.sources.get("src_github");
    const conn = (await store.connections.list()).find((c) => c.integrationId === "int_github");
    expect(source?.location).toBe(URL_B);
    expect(conn?.credentialRef).toBeDefined();
    expect(await store.secrets.reveal(conn?.credentialRef as string)).toBe("Bearer secret-B");
  });
});

describe("CX1 credential-reflection refusal (§9.2, success path)", () => {
  // The stored credential the daemon reveals and sends upstream as
  // `authorization`. A reflecting server echoes this token back inside a
  // successful, well-formed, sub-cap tools/list; the daemon must refuse the
  // whole provision before `normalizeMcp` and before any write.
  const SECRET = "Bearer refl-3cr3t-token-abc123";
  // The bare token, without the scheme word — the segment `redactionTokens`
  // also scans for, so an echo of just this substring is caught too.
  const BARE = "refl-3cr3t-token-abc123";

  // A minimal, VALID tool: `normalizeMcp` would accept it, so a stored result
  // is the only thing standing between the reflection and the agent. Each
  // case injects the credential in ONE position.
  function reflectingList(
    position: "description" | "name" | "schemaValue" | "schemaKey",
  ): unknown[] {
    const base = {
      name: "list_issues",
      description: "List open issues",
      inputSchema: { type: "object", properties: {} as Record<string, unknown> },
    };
    switch (position) {
      case "description":
        return [{ ...base, description: `List issues for ${BARE}` }];
      case "name":
        // A syntactically-fine tool name that embeds the bare token.
        return [{ ...base, name: `tool_${BARE}` }];
      case "schemaValue":
        return [
          {
            ...base,
            inputSchema: {
              type: "object",
              properties: { q: { type: "string", description: `default ${SECRET}` } },
            },
          },
        ];
      case "schemaKey":
        return [
          {
            ...base,
            inputSchema: { type: "object", properties: { [BARE]: { type: "string" } } },
          },
        ];
    }
  }

  it.each([
    ["a description", "description"],
    ["a tool name", "name"],
    ["a schema value", "schemaValue"],
    ["a schema KEY", "schemaKey"],
  ] as const)("rejects a reflection in %s: nothing written, catalog untouched, no upstream bytes in the message", async (_label, position) => {
    const store = await openTestStore();
    const fetchTools: FetchTools = vi.fn(async () => reflectingList(position));

    const result = await run(
      { url: "http://upstream.example/mcp" },
      { store, fetchTools, env: { CONDUIT_ADD_SECRET: SECRET } },
    );

    // Refused — exit 1, the fixed message, and NOT one byte of the
    // reflected token or a tool index in it.
    expect(result.exitCode).toBe(1);
    expect(result.stderrLines).toHaveLength(1);
    const stderr = result.stderrLines[0];
    expect(stderr).toContain("reflected credential material in its tools/list");
    expect(stderr).toContain("nothing was written");
    expect(stderr).not.toContain(BARE);
    expect(stderr).not.toContain(SECRET);

    // Nothing was written — the store is exactly as empty as before.
    expect(await store.sources.list()).toEqual([]);
    expect(await store.connections.list()).toEqual([]);
    expect(await store.tools.list()).toEqual([]);
  });

  it("MUTATION-CHECK: WITHOUT the scan, the reflecting description would be stored", async () => {
    // Proves the scan is load-bearing. A tools/list identical to the
    // description case, minus the credential (so no scan would fire), is a
    // clean provision that DOES store the tool. The delta between this pass
    // and the rejection above is exactly the reflection the scan catches: if
    // the scan were removed, the reflecting case would take THIS path and
    // land the credential-bearing description in the catalog.
    const store = await openTestStore();
    const cleanList: unknown[] = [
      {
        name: "list_issues",
        description: "List issues for a normal-project",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const fetchTools: FetchTools = vi.fn(async () => cleanList);

    const result = await run(
      { url: "http://upstream.example/mcp" },
      { store, fetchTools, env: { CONDUIT_ADD_SECRET: SECRET } },
    );

    expect(result.exitCode).toBe(0);
    const tools = await store.tools.list();
    expect(tools.length).toBe(1);
    expect(tools[0]?.description).toContain("List issues");
  });

  it("an UNAUTHENTICATED onboarding (no secret) does not scan — a token-like description is stored", async () => {
    // The scan is gated on `onboardingAuth !== undefined`: with no credential
    // sent, there is nothing to reflect, and text that merely resembles a
    // token must not be refused. This pins the gate so the scan cannot become
    // a denylist over arbitrary response text.
    const store = await openTestStore();
    const fetchTools: FetchTools = vi.fn(async () => [
      {
        name: "list_issues",
        description: `mentions ${BARE} but no credential was sent`,
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const result = await run({ url: "http://upstream.example/mcp" }, { store, fetchTools });

    expect(result.exitCode).toBe(0);
    expect((await store.tools.list()).length).toBe(1);
  });
});
