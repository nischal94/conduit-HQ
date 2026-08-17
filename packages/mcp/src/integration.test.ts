import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeMcp, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundleDaemonHelper, type HelperBundle } from "./daemon/helpers/bundle.js";

/**
 * Ring-2 integration suite: drives the REAL stdio server over real child
 * processes against a REAL daemon on a REAL Unix socket — the only ring that
 * proves stdout purity, cross-process approval, and client-timeout survival,
 * none of which the ring-1 InMemoryTransport suite (server.test.ts) can
 * exercise. Each `it` spawns its own serve process so failures stay isolated;
 * the shared fixtures below (state dir, key, upstream server, daemon) are set
 * up once in beforeAll and reused across cases.
 *
 * Since Task 6 the topology is two processes deep — agent → serve → daemon →
 * db — and the pieces that moved are worth stating, because they are what the
 * cases now have to arrange:
 *
 * - The **state directory**, not `CONDUIT_DB`, is the unit of isolation: the
 *   daemon derives its db path from it, and a client that sets `CONDUIT_DB`
 *   is refused at handshake (§9.3 item 3).
 * - The **daemon is started by hand** (design §3.1's supported override
 *   path), because auto-start deliberately strips every `CONDUIT_*` and
 *   `HOME` — a test must not weaken that boundary to redirect it.
 * - The **egress opt-in belongs to the daemon**: it runs the sandbox and
 *   makes the upstream calls, so the fail-closed case starts a daemon
 *   without it rather than unsetting a client variable that is never read.
 * - **Direct store writes** (policy seeding, the slow-upstream repoint) are
 *   only legitimate when no daemon owns that database — hence the per-case
 *   state directories and the stop-first sequence in the approval case.
 *
 * `dist/bin.js` is still exercised directly by the flag/doctor cases below,
 * which are the paths that do not go through a daemon.
 *
 * NOT safe for `.concurrent`: cases mutate shared rows and must run
 * sequentially.
 */

const execFileAsync = promisify(execFile);

const PREFIX = "github.acme.prod";
const NAMESPACE = "github";
const SECRET = "Bearer it_secret_do_not_leak_7f3a";

const mcpToolsList = [
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
    name: "delete_repo",
    description: "Permanently delete a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" } } },
    annotations: { destructiveHint: true },
  },
];

const ISSUES_RESULT = { issues: [{ id: 1, title: "Fix login bug" }] };

interface UpstreamCall {
  name: string;
  arguments: unknown;
  sawAuthHeader: boolean;
}

const NEGOTIATED_VERSION = "2025-06-18";
const SESSION_ID = "sess-integration-1";

/**
 * Loopback MCP upstream (copied shape from sdk/e2e.smoke.test.ts's
 * startMcpServer — kept local per the brief), upgraded to the streamable-HTTP
 * pattern (mirrors Task 6's `createStreamableFixture` helper in
 * sdk/pipeline/upstream.test.ts — copied local since test files don't share
 * exports across packages). Owns the handshake bookkeeping — replies to
 * `initialize` and `notifications/initialized`, acks DELETE — and answers
 * tools/call for every tool except `delete_repo`, which it holds open for
 * `delayMs` before responding — the vehicle for the client-timeout case: the
 * sandbox has no real timers, so "slow" must come from the upstream response
 * itself.
 */
function startMcpServer(delayMs = 0): Promise<{
  server: Server;
  port: number;
  upstreamCalls: UpstreamCall[];
}> {
  const upstreamCalls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        id?: string;
        method?: string;
        params?: { name: string; arguments: unknown };
      };
      if (parsed.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": SESSION_ID,
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: NEGOTIATED_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "0" },
            },
          }),
        );
        return;
      }
      if (parsed.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200);
        res.end();
        return;
      }
      const params = parsed.params as { name: string; arguments: unknown };
      upstreamCalls.push({
        name: params.name,
        arguments: params.arguments,
        sawAuthHeader: req.headers.authorization === SECRET,
      });
      const respond = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: ISSUES_RESULT }));
      };
      if (params.name === "delete_repo" && delayMs > 0) {
        setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, upstreamCalls });
    });
  });
}

const scratch = mkdtempSync(join(tmpdir(), "conduit-mcp-it-"));
/**
 * The daemon's state directory — 0700, as `assertStateDir(bind)` requires.
 *
 * Since Task 6 the serve process opens no database: the DAEMON does, and it
 * derives every path from its state directory (`daemonPaths`), so the db
 * lives at `<stateDir>/conduit.db` rather than at a `CONDUIT_DB` of the
 * test's choosing. A client-supplied `CONDUIT_DB` is now refused at
 * handshake by design (§9.3 item 3), which is exactly why this suite
 * supplies the state directory instead — the one supported way to point a
 * daemon somewhere else is to start it BY HAND, which is what it does.
 */
const stateDir = mkdtempSync(join(tmpdir(), "conduit-mcp-it-state-"));
chmodSync(stateDir, 0o700);
const dbPath = join(stateDir, "conduit.db");
const masterKey = SecretBox.generateKeyBytes();
const masterKeyB64 = Buffer.from(masterKey).toString("base64");
const binPath = join(process.cwd(), "dist", "bin.js");

let bundle: HelperBundle | undefined;

/**
 * Starts the daemon by hand against `stateDir` and waits for "listening".
 *
 * Spawned with `CONDUIT_MASTER_KEY` set — design §3.1 supports the env
 * override precisely for a daemon an operator starts by hand, and never
 * through auto-start (`spawnDaemon` strips every `CONDUIT_*`). A test
 * daemon is that operator.
 */
function startDaemonAt(
  dir: string,
  opts: { allowPrivateEgress?: boolean } = {},
): Promise<ChildProcess> {
  if (bundle === undefined) throw new Error("[integration.test] helper bundle not built");
  return startDaemonWith(bundle.helper, dir, opts);
}

function startDaemonWith(
  helper: string,
  dir: string,
  opts: { allowPrivateEgress?: boolean } = {},
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, dir], {
      stdio: ["ignore", "pipe", "inherit"],
      // The egress opt-in belongs to the DAEMON now, not to the client:
      // it runs the sandbox and makes every upstream call, and §9.3's
      // default-only decision means a client's flag never transfers. The
      // loopback fixture upstream is a private address, so without this
      // every tool call in the suite is correctly refused. Set here, on a
      // daemon started BY HAND, which is the supported path (§3.1).
      env: daemonEnv(opts.allowPrivateEgress !== false),
    });
    const timer = setTimeout(() => reject(new Error("daemon did not report listening")), 30_000);
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.includes("listening")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early with code ${code}. Output: ${buf}`));
    });
    daemons.push(child);
  });
}

/** Every daemon this suite starts, killed in afterAll. */
const daemons: ChildProcess[] = [];

/**
 * The environment a hand-started test daemon runs under.
 *
 * When `allowPrivateEgress` is false the variable is DELETED rather than
 * merely left unset: the ambient environment that runs the test suite may
 * itself export it, and inheriting it there would silently turn the
 * fail-closed case into a fail-open one that still passes for the wrong
 * reason.
 */
function daemonEnv(allowPrivateEgress: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CONDUIT_MASTER_KEY: masterKeyB64 };
  if (allowPrivateEgress) {
    env.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS = "1";
  } else {
    delete env.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS;
  }
  return env;
}

/** Seeds one source/integration/connection/secret + tools into the suite's db. */
function seedStore(policy: "allow" | "require_approval"): Promise<void> {
  return seedStoreAt(dbPath, policy);
}

/**
 * Seeds a database directly, in-process.
 *
 * Only ever called while NO daemon owns that path — before the daemon
 * starts, or between the stop and restart of one. A direct open beside a
 * live daemon would be exactly the second writer §17 exists to eliminate.
 */
async function seedStoreAt(targetDb: string, policy: "allow" | "require_approval"): Promise<void> {
  const client = createClient({ url: `file:${targetDb}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(masterKey),
  });
  const tools = normalizeMcp({ namespace: NAMESPACE, tools: mcpToolsList });
  await store.sources.upsert({
    id: "src_gh",
    type: "mcp",
    namespace: NAMESPACE,
    location: mcpLocation,
  });
  await store.integrations.upsert({ id: "int_gh", sourceId: "src_gh", namespace: NAMESPACE });
  await store.connections.upsert({
    id: "conn_gh",
    integrationId: "int_gh",
    prefix: PREFIX,
    credentialRef: "cred_gh",
  });
  await store.secrets.put("cred_gh", SECRET);
  await store.tools.replaceNamespace(NAMESPACE, tools);
  await store.policies.upsert({
    toolName: `${NAMESPACE}.list_issues`,
    action: "allow",
    seededFrom: "safe",
    manualOverride: true,
    redactFields: [],
  });
  await store.policies.upsert({
    toolName: `${NAMESPACE}.delete_repo`,
    action: policy,
    seededFrom: "destructive",
    manualOverride: true,
    redactFields: [],
  });
  client.close();
}

let upstream: { server: Server; port: number; upstreamCalls: UpstreamCall[] };
let mcpLocation: string;

const clients: Client[] = [];
const transports: StdioClientTransport[] = [];

/**
 * Spawns a fresh serve process + connected Client; tracked for teardown.
 *
 * Runs the REAL `runStdioServer` in a REAL child over REAL stdio (the
 * `run-serve` fixture is a three-line wrapper that passes the state
 * directory and nothing else), so everything this ring exists to prove —
 * stdout purity, cross-process approval, client-timeout survival — is
 * still proven against genuine processes and a genuine socket.
 */
async function spawnClient(env: Record<string, string>, dir = stateDir): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serveHelper(), dir],
    env,
    stderr: "pipe",
  });
  transports.push(transport);
  const client = new Client({ name: "it-client", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function serveHelper(): string {
  if (bundle === undefined) throw new Error("[integration.test] helper bundle not built");
  return bundle.serve;
}

function textPayload(res: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = res.content as Array<{ type: string; text: string }>;
  const first = content[0];
  if (first === undefined) {
    throw new Error("[integration.test] callTool response had no content entries.");
  }
  return JSON.parse(first.text);
}

/** Reads all currently-buffered bytes off a piped stderr stream. */
function drainStderr(transport: StdioClientTransport): Promise<string> {
  return new Promise((resolve) => {
    const stream = transport.stderr;
    if (stream === null) {
      resolve("");
      return;
    }
    let data = "";
    stream.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    // Give the child a tick to flush any buffered writes before resolving.
    setTimeout(() => resolve(data), 50);
  });
}

/**
 * The environment a SERVE process runs under.
 *
 * Deliberately carries NO `CONDUIT_DB`: since Task 6 a client whose env
 * sets it is refused at handshake with `refused-custom-db` (§9.3 item 3),
 * so a test still exporting it would be testing the refusal path by
 * accident. The database is the daemon's, reached through its state
 * directory. `PATH` is inherited so the spawned `node` resolves.
 *
 * `CONDUIT_MASTER_KEY` stays only because it is inert here — the serve
 * process no longer opens a store, and it never transfers to the daemon
 * (`spawnDaemon` strips every `CONDUIT_*`). Keeping it proves that
 * inertness rather than assuming it.
 */
const baseEnv = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  CONDUIT_MASTER_KEY: masterKeyB64,
  CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1",
});

beforeAll(async () => {
  upstream = await startMcpServer();
  mcpLocation = `http://127.0.0.1:${upstream.port}/mcp`;
  // Seed BEFORE the daemon starts: it opens the db at startup and is then
  // its sole owner, so the fixture rows must already be there.
  await seedStore("allow");
  bundle = await bundleDaemonHelper();
  // The one daemon every serve process in this suite talks to; tracked in
  // `daemons` and killed in afterAll like every other.
  await startDaemonWith(bundle.helper, stateDir);
}, 120_000);

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => {
      // best-effort — the process may already be gone (killed by the test).
    });
  }
  for (const transport of transports.splice(0)) {
    await transport.close().catch(() => {
      // same as above.
    });
  }
});

afterAll(async () => {
  // SIGKILL, not SIGTERM: a clean drain waits out the grace window for any
  // connection that saw READY, and teardown does not need to exercise that
  // path — the drain tests own it.
  for (const child of daemons) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  bundle?.cleanup();
  await new Promise<void>((resolve) => {
    upstream.server.close(() => resolve());
  });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("ring-2: spawned bin integration", () => {
  it("4-step workflow end-to-end through the spawned bin", async () => {
    const client = await spawnClient(baseEnv());
    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: `
          const { items } = await tools.search({ query: "list issues" });
          const path = items[0].path;
          const details = await tools.describe.tool({ path, includeSchemas: true });
          const result = await tools.github.list_issues({ owner: "acme", repo: "site" });
          return { path, gotSchema: details.inputSchema !== undefined, result };
        `,
      },
    });
    const payload = textPayload(res) as {
      status: string;
      result: { path: string; gotSchema: boolean; result: unknown };
    };
    expect(payload.status).toBe("completed");
    expect(payload.result).toEqual({
      path: "github.list_issues",
      gotSchema: true,
      result: ISSUES_RESULT,
    });
    // The wire request the loopback upstream actually saw: prefix-stripped
    // name, original arguments, authenticated.
    const call = upstream.upstreamCalls.find((c) => c.name === "list_issues");
    expect(call).toEqual({
      name: "list_issues",
      arguments: { owner: "acme", repo: "site" },
      sawAuthHeader: true,
    });
  });

  it("INVARIANT M8: stdout purity — every stdout byte the client transport did NOT consume is protocol-framed", async () => {
    // A serve process against a FRESH, UNSEEDED daemon (its own empty state
    // directory) with the egress opt-in set: startup writes BOTH
    // diagnostics the brief names — the egress WARNING and the
    // empty-catalog "0 sources" hint — and both MUST land on stderr only.
    // A corrupted stdout kills the whole JSON-RPC session, so the full
    // protocol conversation below succeeding is itself the purity proof.
    //
    // Its own daemon, not the shared one: the hint fires on an EMPTY
    // catalog, and the suite's daemon is seeded. The state directory is
    // the unit of isolation now that the db path derives from it.
    const emptyStateDir = mkdtempSync(join(tmpdir(), "conduit-mcp-it-purity-"));
    chmodSync(emptyStateDir, 0o700);
    await startDaemonAt(emptyStateDir); // tracked in `daemons`, killed in afterAll
    const transport = new StdioClientTransport({
      command: "node",
      args: [serveHelper(), emptyStateDir],
      env: baseEnv(),
      stderr: "pipe",
    });
    transports.push(transport);
    const client = new Client({ name: "it-client-purity", version: "0" });
    await client.connect(transport);
    clients.push(client);

    // Drive a full call against the empty catalog: search legitimately
    // returns zero items and the execution completes — a clean protocol
    // round-trip while both diagnostics sit on stderr.
    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: 'const { items } = await tools.search({ query: "anything" }); return items.length;',
      },
    });
    const payload = textPayload(res) as { status: string; result: unknown };
    expect(payload.status).toBe("completed");
    expect(payload.result).toBe(0);

    const stderr = await drainStderr(transport);
    expect(stderr).toMatch(/CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS/); // egress warning
    expect(stderr).toMatch(/0 sources in catalog/); // empty-catalog hint

    // The protocol conversation succeeded end-to-end (initialize + callTool +
    // listTools round-trips) — if either diagnostic line had leaked onto
    // stdout, the client's JSON-RPC framing would have desynced and this
    // would have thrown or hung instead.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_execution", "execute"]);
  });

  it("pause → approve from a SEPARATE child process → poll sees the persisted result", async () => {
    // Its own state directory and its own daemon, for two reasons that are
    // both consequences of Task 6:
    //
    // 1. The `require_approval` policy is seeded by a DIRECT store write,
    //    which is only legitimate while no daemon owns that database — so
    //    the seeding happens before this daemon starts.
    // 2. `approve-demo.mjs` still opens the store directly (the approvals
    //    path is Task 7's conversion, not this one). Running it beside a
    //    live daemon would be the very second-writer situation §17 exists
    //    to eliminate, so the daemon is STOPPED first and restarted after —
    //    the same stop-first posture `key rotate` takes (§3.4).
    //
    // The property under test is unchanged and still real: an approval
    // granted by a different process is visible to a serve session that
    // never saw it happen, because the state is durable rather than
    // in-memory.
    const approvalStateDir = mkdtempSync(join(tmpdir(), "conduit-mcp-it-approve-"));
    chmodSync(approvalStateDir, 0o700);
    const approvalDb = join(approvalStateDir, "conduit.db");
    await seedStoreAt(approvalDb, "require_approval");

    const first = await startDaemonAt(approvalStateDir);
    const client = await spawnClient(baseEnv(), approvalStateDir);
    const paused = await client.callTool({
      name: "execute",
      arguments: {
        code: 'return await tools.github.delete_repo({ repo: "site" });',
        requestKey: "rk-approve-1",
      },
    });
    const pausedPayload = textPayload(paused) as {
      status: string;
      executionId: string;
      pending: { toolName: string };
    };
    expect(pausedPayload.status).toBe("paused");
    expect(pausedPayload.pending.toolName).toBe("github.delete_repo");
    const { executionId } = pausedPayload;

    // Stop the daemon so the direct-access approver is the ONLY opener.
    first.kill("SIGKILL");
    await new Promise<void>((resolve) => first.once("exit", () => resolve()));

    // Separate one-shot child process approver — never the process that
    // ran the execution.
    await execFileAsync("node", ["../../scripts/approve-demo.mjs", executionId], {
      cwd: process.cwd(),
      env: { ...process.env, ...baseEnv(), CONDUIT_DB: approvalDb },
    });

    // A NEW daemon over the same durable state, and a new serve session:
    // the approval must be visible to a process that did not witness it.
    await startDaemonAt(approvalStateDir);
    const poller = await spawnClient(baseEnv(), approvalStateDir);
    const checked = await poller.callTool({
      name: "check_execution",
      arguments: { executionId },
    });
    const checkedPayload = textPayload(checked) as { status: string; result: unknown };
    expect(checkedPayload.status).toBe("completed");
    expect(checkedPayload.result).toEqual(ISSUES_RESULT);
  }, 60_000);

  it("client timeout on a slow call: server survives; the row settles; requestKey recovers it", async () => {
    const slow = await startMcpServer(3_000);
    try {
      // Re-seed sources/tools to point at the SLOW upstream for this case
      // only; restore the fast one in `finally` so later cases are unaffected.
      const client = createClient({ url: `file:${dbPath}` });
      const store = await openSqliteStore({
        client,
        secretBox: await SecretBox.fromKeyBytes(masterKey),
      });
      await store.sources.upsert({
        id: "src_gh",
        type: "mcp",
        namespace: NAMESPACE,
        location: `http://127.0.0.1:${slow.port}/mcp`,
      });
      client.close();

      const mcpClient = await spawnClient(baseEnv());
      const call = mcpClient.callTool(
        {
          name: "execute",
          arguments: {
            code: 'return await tools.github.delete_repo({ repo: "slow-repo" });',
            requestKey: "slow-1",
          },
        },
        undefined,
        { timeout: 1_000 },
      );
      await expect(call).rejects.toThrow();

      // Poll check_execution (a FRESH bin, since the timed-out client's
      // session may be in an unknown state after the local timeout) until
      // the server-side execution settles.
      const poller = await spawnClient(baseEnv());
      const deadline = Date.now() + 10_000;
      let finalPayload: { status: string; result?: unknown } | undefined;
      while (Date.now() < deadline) {
        const res = await poller.callTool({
          name: "check_execution",
          arguments: { requestKey: "slow-1" },
        });
        const payload = textPayload(res) as { status: string; result?: unknown };
        if (payload.status === "completed") {
          finalPayload = payload;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(finalPayload?.status).toBe("completed");
      expect(finalPayload?.result).toEqual(ISSUES_RESULT);
    } finally {
      await new Promise<void>((resolve) => slow.server.close(() => resolve()));
      // Restore the fast upstream location for later cases.
      const client = createClient({ url: `file:${dbPath}` });
      const store = await openSqliteStore({
        client,
        secretBox: await SecretBox.fromKeyBytes(masterKey),
      });
      await store.sources.upsert({
        id: "src_gh",
        type: "mcp",
        namespace: NAMESPACE,
        location: mcpLocation,
      });
      client.close();
    }
  }, 20_000);

  it("parallel tools/call executes run concurrently and both settle", async () => {
    const client = await spawnClient(baseEnv());
    const [a, b] = await Promise.all([
      client.callTool({
        name: "execute",
        arguments: {
          code: 'return await tools.github.list_issues({ owner: "a", repo: "one" });',
          requestKey: "par-1",
        },
      }),
      client.callTool({
        name: "execute",
        arguments: {
          code: 'return await tools.github.list_issues({ owner: "a", repo: "two" });',
          requestKey: "par-2",
        },
      }),
    ]);
    const payloadA = textPayload(a) as { status: string; result: unknown };
    const payloadB = textPayload(b) as { status: string; result: unknown };
    expect(payloadA.status).toBe("completed");
    expect(payloadB.status).toBe("completed");
    expect(payloadA.result).toEqual(ISSUES_RESULT);
    expect(payloadB.result).toEqual(ISSUES_RESULT);
    const seenRepos = upstream.upstreamCalls
      .filter((c) => c.name === "list_issues")
      .map((c) => (c.arguments as { repo: string }).repo);
    expect(seenRepos).toEqual(expect.arrayContaining(["one", "two"]));
  });

  it("egress fail-closed: WITHOUT the opt-in on the DAEMON, the loopback call fails and the agent-visible error hints at the operator override WITHOUT naming the env var", async () => {
    // The opt-in is the DAEMON's property now: it runs the sandbox and
    // makes the upstream call, and §9.3 default-only means a client's own
    // env never transfers. So fail-closed is exercised by starting a
    // daemon WITHOUT it — deleting the variable from the client's
    // environment (what this test used to do) would now prove nothing,
    // since the client's value was never consulted in the first place.
    const closedStateDir = mkdtempSync(join(tmpdir(), "conduit-mcp-it-closed-"));
    chmodSync(closedStateDir, 0o700);
    await seedStoreAt(join(closedStateDir, "conduit.db"), "allow");
    await startDaemonAt(closedStateDir, { allowPrivateEgress: false });

    const client = await spawnClient(baseEnv(), closedStateDir);
    const res = await client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.github.list_issues({ owner: "a", repo: "b" });' },
    });
    const payload = textPayload(res) as {
      status: string;
      error: { hint?: string; message: string };
    };
    expect(payload.status).toBe("failed");
    expect(payload.error.hint).toMatch(/operator/i);
    expect(payload.error.hint).not.toContain("CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS");
    expect(payload.error.message).not.toContain("CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS");
  });
});

describe("ring-2: bin flag and doctor exit paths", () => {
  it("--version exits 0, prints to stderr only, stdout empty (INVARIANT M8 stdout purity)", async () => {
    const { stdout, stderr } = await execFileAsync("node", [binPath, "--version"], {
      env: { ...process.env, ...baseEnv() },
    });
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe("0.1.0");
  });

  it("--help exits 0, prints to stderr only, stdout empty (INVARIANT M8 stdout purity)", async () => {
    const { stdout, stderr } = await execFileAsync("node", [binPath, "--help"], {
      env: { ...process.env, ...baseEnv() },
    });
    expect(stdout).toBe("");
    expect(stderr).toMatch(/conduit-mcp/);
    expect(stderr).toMatch(/--doctor/);
  });

  // env.ts's resolveEnv falls back to reading `${HOME}/.conduit/master-key`
  // when CONDUIT_MASTER_KEY is absent — so a spawn env that merely deletes
  // the var still leaks the REAL key on any machine that has one. These
  // "missing key" cases point HOME at a fresh, empty temp dir (never
  // touching the real ~/.conduit) so the file fallback provably has nothing
  // to find and the missing-key path is exercised deterministically.
  it("--doctor against a missing CONDUIT_MASTER_KEY exits 1 with a stderr diagnostic", async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "conduit-mcp-it-nohome-"));
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...baseEnv(),
        HOME: emptyHome,
      };
      delete env.CONDUIT_MASTER_KEY;
      await expect(execFileAsync("node", [binPath, "--doctor"], { env })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(/Missing master key/),
      });
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("--doctor against a malformed CONDUIT_MASTER_KEY exits 1 with a stderr diagnostic", async () => {
    const env = {
      ...process.env,
      ...baseEnv(),
      CONDUIT_MASTER_KEY: "not-valid-base64-and-wrong-length",
    };
    await expect(execFileAsync("node", [binPath, "--doctor"], { env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/Malformed master key in CONDUIT_MASTER_KEY/),
    });
  });

  it("no flag + an unreachable daemon: startup fails, exits 1, and the diagnostic names the daemon log", async () => {
    // BEHAVIOR CHANGE, recorded deliberately (Task 6 / D-B1). This case
    // used to assert "Missing master key" from the serve process itself.
    // The serve process no longer resolves a key or opens a store — the
    // DAEMON does — so a missing key is now a daemon startup failure that
    // the client observes as an unreachable daemon.
    //
    // Design §5 anticipated exactly this and set the contract accordingly:
    // "An earlier revision promised byte-identical startup errors. That is
    // the wrong contract once auto-start introduces readiness,
    // child-process, and IPC failure layers. The contract is instead:
    // stable error codes, redacted cause, actionable operator guidance."
    //
    // So what is pinned here is the ACTIONABLE part: a non-zero exit, and
    // a message that points at the daemon's own log — the only place the
    // real cause (the missing key) can be read. The key-resolution
    // diagnostic itself is still pinned verbatim, on the paths that still
    // own it: the two `--doctor` cases above.
    const emptyHome = mkdtempSync(join(tmpdir(), "conduit-mcp-it-nohome-"));
    const isolatedStateDir = mkdtempSync(join(tmpdir(), "conduit-mcp-it-nokey-"));
    chmodSync(isolatedStateDir, 0o700);
    try {
      const env: Record<string, string | undefined> = { ...process.env, HOME: emptyHome };
      delete env.CONDUIT_MASTER_KEY;
      delete env.CONDUIT_DB;
      // The serve fixture rather than `binPath`: a state directory the test
      // owns is the only way to exercise auto-start without racing the
      // real `~/.conduit` daemon on the developer's machine.
      await expect(
        execFileAsync("node", [serveHelper(), isolatedStateDir], { env, timeout: 60_000 }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(/Daemon unavailable/),
      });
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
      rmSync(isolatedStateDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("--doctor resolves the default ~/.conduit/master-key path end-to-end with no CONDUIT_MASTER_KEY set", async () => {
    // Proves the headline default-path resolution: a valid 0600 key file at
    // the DEFAULT location (${HOME}/.conduit/master-key), no env override.
    const isolatedHome = mkdtempSync(join(tmpdir(), "conduit-mcp-it-defaultkey-"));
    try {
      const conduitDir = join(isolatedHome, ".conduit");
      mkdirSync(conduitDir, { recursive: true, mode: 0o700 });
      const keyBytes = SecretBox.generateKeyBytes();
      writeFileSync(
        join(conduitDir, "master-key"),
        `${Buffer.from(keyBytes).toString("base64")}\n`,
        {
          mode: 0o600,
        },
      );
      const env: Record<string, string | undefined> = {
        ...process.env,
        CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1",
        HOME: isolatedHome,
      };
      delete env.CONDUIT_MASTER_KEY;
      delete env.CONDUIT_DB;
      const { stdout, stderr } = await execFileAsync("node", [binPath, "--doctor"], { env });
      expect(stdout).toBe("");
      expect(stderr).toMatch(/ok: key decodes/);
      expect(stderr).toMatch(/ok: database opens/);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it("M8: a wide-perms (0644) default key file warns on stderr only, stdout carries no warning text", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "conduit-mcp-it-wideperms-"));
    try {
      const conduitDir = join(isolatedHome, ".conduit");
      mkdirSync(conduitDir, { recursive: true, mode: 0o700 });
      const keyBytes = SecretBox.generateKeyBytes();
      const keyPath = join(conduitDir, "master-key");
      writeFileSync(keyPath, `${Buffer.from(keyBytes).toString("base64")}\n`, { mode: 0o644 });
      const env: Record<string, string | undefined> = {
        ...process.env,
        CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1",
        HOME: isolatedHome,
      };
      delete env.CONDUIT_MASTER_KEY;
      delete env.CONDUIT_DB;
      const { stdout, stderr } = await execFileAsync("node", [binPath, "--doctor"], { env });
      expect(stderr).toMatch(
        new RegExp(`WARNING.*${keyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*0600`),
      );
      expect(stdout).not.toMatch(/WARNING/);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});
