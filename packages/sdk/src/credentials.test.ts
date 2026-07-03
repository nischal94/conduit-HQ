import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { InMemoryCatalog } from "./catalog.js";
import { createStoreCredentialResolver } from "./credentials.js";
import { createCatalogToolHost, type ToolInvoker } from "./execute.js";
import { QuickJSSandbox } from "./sandbox/quickjs.js";
import { SecretBox } from "./secrets.js";
import { openSqliteStore } from "./store/sqlite.js";
import type { SecretRepository } from "./store/store.js";
import type { Connection, Tool } from "./types.js";

function fakeSecrets(entries: Record<string, string> = {}): SecretRepository {
  const map = new Map(Object.entries(entries));
  return {
    put: async (ref, secret) => void map.set(ref, secret),
    reveal: async (ref) => map.get(ref),
    remove: async (ref) => void map.delete(ref),
  };
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    integrationId: "int_1",
    prefix: "github.org.main",
    credentialRef: "cred_github_main",
    ...overrides,
  };
}

describe("createStoreCredentialResolver", () => {
  it("resolves a declared credential into Authorization header material", async () => {
    const resolver = createStoreCredentialResolver(
      fakeSecrets({ cred_github_main: "Bearer ghp_abc123" }),
    );
    const auth = await resolver.resolve(connection());
    expect(auth.headers).toEqual({ Authorization: "Bearer ghp_abc123" });
  });

  it("carries the stored value verbatim — the secret owns its scheme prefix", async () => {
    const resolver = createStoreCredentialResolver(
      fakeSecrets({ cred_github_main: "token legacy_style_pat" }),
    );
    const auth = await resolver.resolve(connection());
    expect(auth.headers.Authorization).toBe("token legacy_style_pat");
  });

  it("resolves credential-less connections to empty material (spec §9.1: auth optional)", async () => {
    const resolver = createStoreCredentialResolver(fakeSecrets());
    const { credentialRef: _omitted, ...publicConnection } = connection();
    const auth = await resolver.resolve(publicConnection);
    expect(auth.headers).toEqual({});
  });

  it("fails closed on a dangling credentialRef — never a silently unauthenticated request", async () => {
    const resolver = createStoreCredentialResolver(fakeSecrets());
    await expect(resolver.resolve(connection())).rejects.toThrow(
      /Failed to resolve credential.*cred_github_main/,
    );
  });

  it("fails closed on an empty stored secret", async () => {
    const resolver = createStoreCredentialResolver(fakeSecrets({ cred_github_main: "" }));
    await expect(resolver.resolve(connection())).rejects.toThrow(/missing or empty/);
  });

  it("resolves at call time, not setup time — rotation is live on the next call (spec §5.3)", async () => {
    const secrets = fakeSecrets({ cred_github_main: "Bearer old_token" });
    const resolver = createStoreCredentialResolver(secrets);
    expect((await resolver.resolve(connection())).headers.Authorization).toBe("Bearer old_token");

    await secrets.put("cred_github_main", "Bearer rotated_token");
    expect((await resolver.resolve(connection())).headers.Authorization).toBe(
      "Bearer rotated_token",
    );

    await secrets.remove("cred_github_main");
    await expect(resolver.resolve(connection())).rejects.toThrow(/Failed to resolve credential/);
  });
});

describe("credential boundary", () => {
  it("INVARIANT §9.2: a secret never enters sandbox heap / agent code / agent / model — only the upstream request", async () => {
    // The full real stack, no mocks on the boundary itself: encrypted
    // store → resolver → §5.3-shaped invoker → QuickJS sandbox running
    // adversarial agent code. The attack surface is everything the
    // sandbox/agent/model can read back: the execution result, the
    // journal, and the agent code — if the secret shows up in any of
    // them, the product's core promise is broken.
    const SECRET = "Bearer ghp_c0nduit_live_secret_9x7";
    const store = await openSqliteStore({
      client: createClient({ url: ":memory:" }),
      secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
    });
    await store.secrets.put("cred_github_main", SECRET);
    await store.connections.upsert(connection());

    const catalog = new InMemoryCatalog();
    const tool: Tool = {
      name: "github.issues.list",
      namespace: "github",
      description: "List issues",
      inputSchema: { type: "object" },
      outputSchema: {},
      riskClass: "safe",
      sourceSemantics: { kind: "openapi", method: "get", path: "/issues" },
    };
    catalog.upsert([tool]);

    // Phase 0 stand-in for the §5.3 pipeline: resolve connection (step 1),
    // attach credentials host-side (step 3), "call upstream" (step 4).
    const upstreamRequests: Array<{ path: string; headers: Record<string, string> }> = [];
    const invoke: ToolInvoker = async (path, _input) => {
      const conn = await store.connections.getByPrefix("github.org.main");
      if (conn === undefined) {
        throw new Error("test wiring: connection missing");
      }
      const auth = await createStoreCredentialResolver(store.secrets).resolve(conn);
      upstreamRequests.push({ path, headers: { ...auth.headers } });
      return { issues: [{ number: 1, title: "hello" }] };
    };

    // Adversarial guest: makes a legitimate call, then probes every
    // surface reachable from inside the sandbox and returns the loot.
    const agentCode = `
      const loot = {};
      loot.result = await tools.github.issues.list({ owner: "o", repo: "r" });
      loot.globals = Object.getOwnPropertyNames(globalThis);
      loot.toolsSurface = Object.getOwnPropertyNames(tools);
      loot.search = await tools.search({ query: "issues" });
      loot.describe = await tools.describe.tool({ path: "github.issues.list", includeSchemas: true });
      try {
        await tools.github.issues.list.call({ hijack: true });
      } catch (error) {
        loot.callProbeError = String(error);
      }
      return loot;
    `;
    const result = await new QuickJSSandbox().execute({
      code: agentCode,
      tools: createCatalogToolHost(catalog, invoke),
    });

    // Positive control first: the boundary let the credential through to
    // exactly the one place it belongs. Without this, the negative
    // assertions below would also pass on a broken pipeline.
    expect(result.status).toBe("completed");
    expect(upstreamRequests.length).toBeGreaterThanOrEqual(1);
    expect(upstreamRequests[0]?.headers.Authorization).toBe(SECRET);

    // Zone 2 (agent code): the code we ran never contained the secret.
    expect(agentCode).not.toContain(SECRET);

    // Zones 1, 3, 4 (sandbox heap / agent / model): everything that
    // crossed the membrane back — result value, seeds, and the complete
    // tool-call journal — serialized and scanned. A partial-leak check
    // on a distinctive fragment guards against truncation or encoding
    // shenanigans hiding a substring match.
    const membrane = JSON.stringify(result);
    expect(membrane).not.toContain(SECRET);
    expect(membrane).not.toContain("c0nduit_live_secret");
    expect(membrane).not.toContain("ghp_");
  });
});
