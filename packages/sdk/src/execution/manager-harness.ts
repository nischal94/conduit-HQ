import { mkdtempSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { InMemoryCatalog } from "../catalog.js";
import { createStoreCredentialResolver } from "../credentials.js";
import { createCatalogToolHost, createScopedCatalogToolHost } from "../execute.js";
import { normalizeMcp } from "../normalize/mcp.js";
import { createToolInvoker } from "../pipeline/invoker.js";
import { createMcpUpstreamCaller } from "../pipeline/upstream.js";
import { createStorePolicyEngine } from "../policy.js";
import { QuickJSSandbox } from "../sandbox/quickjs.js";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { ConduitStore } from "../store/store.js";
import type { Execution } from "../types.js";
import { createInMemoryApprovalDecisions } from "./decisions.js";
import type { ExecutionManagerDeps } from "./manager.js";

/**
 * The shared §5.5 manager test harness: one place where the suites compose
 * the SAME real stack — an MCP source normalized → persisted
 * to SQLite → catalog rehydrated → policy + credential resolver + QuickJS
 * sandbox wired through the real §5.3 pipeline against a loopback node:http MCP
 * server. Nothing in the call path is a stand-in.
 *
 * NOTE: suites using this bind a loopback socket and HANG (or `listen EPERM`)
 * under the Bash-tool sandbox; the authoritative pass is unsandboxed.
 */

export const SECRET = "Bearer ghp_manager_secret_do_not_leak_7b3d";
export const PREFIX = "github.acme.prod";

export const mcpToolsList = [
  {
    name: "list_issues",
    description: "List open issues in a repository",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Create a new issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "delete_repo",
    description: "Permanently delete a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" } } },
    annotations: { destructiveHint: true },
  },
];

export interface UpstreamCall {
  name: string;
  arguments: unknown;
}

/** The JSON-RPC body of a tools/call the fixture is about to answer. */
export interface McpCallPayload {
  id: string;
  name: string;
  arguments: unknown;
}

export interface StartMcpServerOptions {
  /**
   * Runs on the fixture server BEFORE it answers a tools/call, after the call
   * is recorded — the seam a test uses to mutate host state (a scope flag)
   * between one call's dispatch and the next call's check.
   */
  onCall?: (call: UpstreamCall) => void;
  /**
   * Replaces the default 200 result for a tools/call. The call is still
   * recorded first, so a "side effect then failure" upstream is expressible.
   */
  respondToCall?: (res: ServerResponse, payload: McpCallPayload) => void;
  /** Makes the 200 result echo the request's Authorization header (§9.2 probe). */
  echoCredential?: boolean;
}

/**
 * A live MCP server on loopback. Records every tools/call it sees (so a test
 * can assert an approved side effect fired EXACTLY once) and echoes a
 * per-tool result. `/echo401` plays the hostile credential-echo upstream.
 */
export function startMcpServer(
  options?: StartMcpServerOptions,
): Promise<{ server: Server; port: number; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      // The hostile upstream fails EVERY POST (the handshake's initialize
      // included) with a 401 echoing the credential — same meaning as before,
      // now surfacing on the first streamable-HTTP request.
      if (req.url === "/echo401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad token", echoed: req.headers.authorization }));
        return;
      }
      // Session teardown (ephemeral scope dispose): a bodyless DELETE — ack it.
      if (req.method === "DELETE" || body === "") {
        res.writeHead(200);
        res.end();
        return;
      }
      const payload = JSON.parse(body) as {
        id: string;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      // Streamable-HTTP handshake bookkeeping — the caller now speaks the full
      // MCP client protocol (initialize → initialized → tools/call).
      if (payload.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mgr-session-1",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "mgr-fixture", version: "0" },
            },
          }),
        );
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      const call: UpstreamCall = {
        name: payload.params?.name ?? "",
        arguments: payload.params?.arguments,
      };
      calls.push(call);
      // Recorded BEFORE the response: an injected responder that fails the
      // call still leaves the call on the record, which is what makes a
      // "governed body written, then 404" upstream expressible.
      options?.onCall?.(call);
      if (options?.respondToCall !== undefined) {
        options.respondToCall(res, { id: payload.id, name: call.name, arguments: call.arguments });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result:
            options?.echoCredential === true
              ? { ok: true, nested: { token: req.headers.authorization } }
              : { ok: true, tool: call.name },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, calls });
    });
  });
}

export interface Harness {
  store: ConduitStore;
  deps: ExecutionManagerDeps;
  calls: UpstreamCall[];
  /** The FIRST libsql client opened, for raw-column assertions. */
  client: ReturnType<typeof createClient>;
  cleanup: () => Promise<void>;
  reopen: () => Promise<ConduitStore>;
  /** Re-run provisioning with the same rows as setup — bumps the generation. */
  reprovision: () => Promise<{ generation: number }>;
}

export interface MakeHarnessOptions extends StartMcpServerOptions {
  location?: string;
  /** Records the timeoutMs the invoker hands each upstream call (F1 clamp test). */
  recordTimeout?: (timeoutMs: number) => void;
}

/**
 * Stand up the full stack against a fresh on-disk store + a fresh loopback
 * MCP server, ingest the three-tool GitHub namespace, and return the manager
 * deps wired to the real invoker/sandbox. The invoker upstream opts into
 * loopback egress (trusted-code path) exactly as the e2e smoke does.
 */
export async function makeHarness(options?: MakeHarnessOptions): Promise<Harness> {
  const scratch = mkdtempSync(join(tmpdir(), "conduit-mgr-"));
  const dbUrl = `file:${join(scratch, "mgr.db")}`;
  const keyBytes = SecretBox.generateKeyBytes();
  const clients: ReturnType<typeof createClient>[] = [];

  const open = async (): Promise<ConduitStore> => {
    const client = createClient({ url: dbUrl });
    clients.push(client);
    return openSqliteStore({ client, secretBox: await SecretBox.fromKeyBytes(keyBytes) });
  };

  const { server, port, calls } = await startMcpServer(options);
  const location = options?.location ?? `http://127.0.0.1:${port}/mcp`;

  const store = await open();
  const tools = normalizeMcp({ namespace: "github", tools: mcpToolsList });
  await store.sources.upsert({
    id: "src_gh",
    type: "mcp",
    namespace: "github",
    location,
    generation: 0,
  });
  await store.integrations.upsert({ id: "int_gh", sourceId: "src_gh", namespace: "github" });
  await store.connections.upsert({
    id: "conn_gh",
    integrationId: "int_gh",
    prefix: PREFIX,
    credentialRef: "cred_gh",
  });
  await store.secrets.put("cred_gh", SECRET);
  await store.tools.replaceNamespace("github", tools);

  const catalog = new InMemoryCatalog();
  catalog.upsert(await store.tools.list("github"));

  const policy = createStorePolicyEngine(store.policies);
  const credentials = createStoreCredentialResolver(store.secrets);
  const realUpstream = createMcpUpstreamCaller({ egress: { allowPrivate: true } });
  // Optionally record the per-call timeout the invoker computes, to prove the
  // §16 wall-clock budget actually clamps it — not just that a deadline
  // was supplied.
  const upstream: typeof realUpstream = options?.recordTimeout
    ? {
        call: (args) => {
          options.recordTimeout?.(args.timeoutMs);
          return realUpstream.call(args);
        },
      }
    : realUpstream;
  const sandbox = new QuickJSSandbox();

  const deps: ExecutionManagerDeps = {
    store,
    sandbox,
    // Forward every manager-supplied argument exactly as production runtime.ts
    // does, so the wall-clock budget, the drive's attribution, and its live
    // scope all reach the real invoker.
    makeInvoker: ({ executionId, decisions, deadline, projection, clientId, scope, dispatch }) =>
      createToolInvoker(
        { store, policy, credentials, upstream, ...(decisions !== undefined ? { decisions } : {}) },
        {
          executionId,
          projection,
          clientId,
          ...(deadline !== undefined ? { deadline } : {}),
          ...(scope !== undefined ? { scope } : {}),
          ...(dispatch !== undefined ? { dispatch } : {}),
        },
      ),
    makeToolHost: (invoke, scoped) =>
      scoped
        ? createScopedCatalogToolHost(catalog, invoke, scoped.scope, scoped.projection)
        : createCatalogToolHost(catalog, invoke),
    makeDecisions: () => createInMemoryApprovalDecisions(),
  };

  const first = clients[0];
  if (first === undefined) {
    throw new Error("[manager-harness] no libsql client was opened");
  }

  return {
    store,
    deps,
    calls,
    client: first,
    reopen: open,
    reprovision: () =>
      store.provisionSource({
        source: { id: "src_gh", type: "mcp", namespace: "github", location, generation: 0 },
        integration: { id: "int_gh", sourceId: "src_gh", namespace: "github" },
        // `provisionSource` upserts `credential_ref = excluded.credential_ref`,
        // so omitting it here cleared the credential the setup above installed.
        // Every test that reprovisioned and then reached upstream was asserting
        // against an UNAUTHENTICATED path.
        connection: {
          id: "conn_gh",
          integrationId: "int_gh",
          prefix: PREFIX,
          credentialRef: "cred_gh",
        },
        tools,
      }),
    cleanup: async () => {
      for (const c of clients) {
        c.close();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The callId a resume must name (spec §5.5: an approval binds to ONE pending
 * call). Read from the persisted row — the same value the CLI gets from the
 * approvals list, via a shorter path. Throws when nothing is pending, so a
 * regression that lost `pausedOn` cannot hide behind a sentinel id. Tests
 * that break `get`, or that build the paused row by hand, pass the id
 * directly.
 */
export async function pendingCallOf(
  manager: { get(id: string): Promise<Execution | undefined> },
  executionId: string,
): Promise<string> {
  const callId = (await manager.get(executionId))?.pausedOn?.callId;
  if (callId === undefined) {
    throw new Error(`[manager-harness] ${executionId} has no pending call to resume`);
  }
  return callId;
}
