import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConduitStore, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AddMcpArgs, type AddMcpDeps, runAddMcp } from "./commands/add-mcp.js";

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

describe("runAddMcp", () => {
  it("malformed --namespace is rejected before any write", async () => {
    const store = await openTestStore();
    const deps = makeDeps({ store, fetchTools: vi.fn() });

    const result = await runAddMcp({ ...BASE_ARGS, namespace: "A B" }, deps);

    expect(result.exitCode).not.toBe(0);
    expect(deps.fetchTools).not.toHaveBeenCalled();
    expect(await store.sources.list()).toEqual([]);
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

  it("existing namespace with a differing --url, no --replace, refuses with 0 writes", async () => {
    const store = await openTestStore();
    // First run: seeds the namespace.
    await runAddMcp(BASE_ARGS, makeDeps({ store }));
    const beforeTools = await store.tools.list();

    // Second run: same namespace, different url, no --replace.
    const result = await runAddMcp(
      { ...BASE_ARGS, url: "http://127.0.0.1:9/mcp-different" },
      makeDeps({ store }),
    );

    expect(result.exitCode).not.toBe(0);
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
    expect(line).toMatch(/seeded 3 tools under github\.acme\.prod:/);
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
});
