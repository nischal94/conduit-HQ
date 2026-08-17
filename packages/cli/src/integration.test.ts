import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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

const execFileAsync = promisify(execFile);

/**
 * Ring-2 integration suite (Lane B Task 7): drives the REAL COMPILED conduit
 * CLI bin (`dist/bin.js serve`) over a real stdio child process — proves the
 * `serve` command actually starts the shared `runStdioServer` seam through
 * the CLI's own dispatch/bin door, and that the M8 stdout-purity invariant
 * (pinned in packages/mcp) survives that extra layer.
 *
 * Mirrors packages/mcp/src/integration.test.ts's fixtures and helpers; the
 * one difference is the spawned command: `node dist/bin.js serve` instead of
 * `node dist/bin.js`.
 */

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
const SESSION_ID = "sess-cli-integration-1";

/**
 * Loopback MCP upstream (same shape as packages/mcp's integration test),
 * upgraded to the streamable-HTTP pattern for `serve`'s traffic (mirrors
 * Task 6's `createStreamableFixture` helper in sdk/pipeline/upstream.test.ts
 * — copied local since test files don't share exports across packages).
 * `add-mcp`'s precondition fetch (mcp-fetch.ts, Lane B/Task 10) still speaks
 * the bare single-POST `tools/list` dialect — answered by its own branch
 * below, unchanged — so the same stub upstream serves both traffic shapes,
 * no second fixture server.
 */
function startMcpServer(): Promise<{
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
      const payload = JSON.parse(body || "{}") as {
        id: string;
        method: string;
        params?: { name: string; arguments: unknown };
      };
      // add-mcp's precondition fetch (mcp-fetch.ts) POSTs a bare `tools/list`
      // request with no `params` — answered here so the same stub upstream
      // serves both `serve`'s tools/call traffic and add-mcp's tools/list
      // fetch, no second fixture server.
      if (payload.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: mcpToolsList } }),
        );
        return;
      }
      if (payload.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": SESSION_ID,
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: NEGOTIATED_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "0" },
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
      if (req.method === "DELETE") {
        res.writeHead(200);
        res.end();
        return;
      }
      const params = payload.params as { name: string; arguments: unknown };
      upstreamCalls.push({
        name: params.name,
        arguments: params.arguments,
        sawAuthHeader: req.headers.authorization === SECRET,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: ISSUES_RESULT }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, upstreamCalls });
    });
  });
}

const scratch = mkdtempSync(join(tmpdir(), "conduit-cli-it-"));
/**
 * The daemon's state directory — 0700, as the §3.2 boundary check requires.
 *
 * Since Task 6 `conduit serve` opens no database: the daemon does, and it
 * derives its db path from this directory. A client that sets `CONDUIT_DB`
 * is refused at handshake (§9.3 item 3), so the state directory — not the
 * db path — is what a test varies.
 */
const stateDir = mkdtempSync(join(tmpdir(), "conduit-cli-it-state-"));
chmodSync(stateDir, 0o700);
const dbPath = join(stateDir, "conduit.db");
const masterKey = SecretBox.generateKeyBytes();
const masterKeyB64 = Buffer.from(masterKey).toString("base64");
const cliBinPath = join(process.cwd(), "dist", "bin.js");
/** The compiled mcp bin — `--daemon --state-dir` is the by-hand start path. */
const mcpBinPath = join(process.cwd(), "..", "mcp", "dist", "bin.js");

/** Every daemon this suite starts, killed in afterAll. */
const daemons: ChildProcess[] = [];

/**
 * Starts a daemon by hand against `dir` and resolves once it is listening.
 *
 * `CONDUIT_MASTER_KEY` and the egress opt-in are set HERE, on the daemon,
 * because the daemon is what opens the store and makes upstream calls —
 * §9.3 default-only means a client's own values never transfer to it.
 */
function startDaemonAt(dir: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpBinPath, "--daemon", "--state-dir", dir], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CONDUIT_MASTER_KEY: masterKeyB64,
        CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1",
      },
    });
    daemons.push(child);
    const timer = setTimeout(() => reject(new Error("daemon did not report listening")), 30_000);
    let seen = "";
    // The daemon logs lifecycle lines to stderr by default (bin.ts), which
    // is also where its inherited log descriptor points in production.
    const watch = (chunk: Buffer): void => {
      seen += chunk.toString("utf8");
      if (seen.includes("listening")) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early with code ${code}. Output: ${seen}`));
    });
  });
}

/** Seeds one source/integration/connection/secret + tools, in-process. */
async function seedStore(): Promise<void> {
  return seedStoreAt(dbPath);
}

/**
 * Seeds a database directly. Only ever called while NO daemon owns that
 * path — a direct open beside a live daemon is the second writer §17
 * exists to eliminate.
 */
async function seedStoreAt(targetDb: string): Promise<void> {
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
    action: "allow",
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

/** Spawns `conduit serve` via the compiled CLI bin + a connected Client. */
async function spawnClient(env: Record<string, string>, dir = stateDir): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [cliBinPath, "serve", "--state-dir", dir],
    env,
    stderr: "pipe",
  });
  transports.push(transport);
  const client = new Client({ name: "cli-it-client", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function textPayload(res: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = res.content as Array<{ type: string; text: string }>;
  const first = content[0];
  if (first === undefined) {
    throw new Error("[integration.test] callTool response had no content entries.");
  }
  return JSON.parse(first.text);
}

/**
 * The environment a `conduit serve` process runs under.
 *
 * Carries NO `CONDUIT_DB`: a client that sets it is refused at handshake
 * (§9.3 item 3), so exporting it would exercise the refusal path by
 * accident. `CONDUIT_MASTER_KEY` stays because the approvals command —
 * still a direct-store consumer until Task 7 — needs it; it is inert for
 * `serve`, which opens nothing.
 */
const baseEnv = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  CONDUIT_DB: dbPath,
  CONDUIT_MASTER_KEY: masterKeyB64,
  CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1",
});

/** `serve`'s own env — the one that must NOT carry CONDUIT_DB. */
const serveEnv = (): Record<string, string> => {
  const env = baseEnv();
  delete (env as Record<string, string | undefined>).CONDUIT_DB;
  return env;
};

beforeAll(async () => {
  upstream = await startMcpServer();
  mcpLocation = `http://127.0.0.1:${upstream.port}/mcp`;
  // Seed BEFORE the daemon opens the db and becomes its sole owner.
  await seedStore();
  await startDaemonAt(stateDir);
}, 60_000);

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
  // READY-granted connection, and teardown need not exercise that path.
  for (const child of daemons) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await new Promise<void>((resolve) => {
    upstream.server.close(() => resolve());
  });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("ring-2: conduit serve (spawned CLI bin)", () => {
  it("workflow: conduit serve exposes the two-tool MCP surface via tools/list", async () => {
    const client = await spawnClient(serveEnv());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_execution", "execute"]);

    // Also drive a real call through, proving the server started for real —
    // not just that listTools happens to work.
    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: `
          const { items } = await tools.search({ query: "list issues" });
          const path = items[0].path;
          const result = await tools.github.list_issues({ owner: "acme", repo: "site" });
          return { path, result };
        `,
      },
    });
    const payload = textPayload(res) as {
      status: string;
      result: { path: string; result: unknown };
    };
    expect(payload.status).toBe("completed");
    expect(payload.result).toEqual({ path: "github.list_issues", result: ISSUES_RESULT });
  });

  it("INVARIANT /mcp M8: stdout purity holds through conduit serve — every stdout byte the client transport did NOT consume is protocol-framed", async () => {
    // A fresh, UNSEEDED daemon + the egress opt-in on the client: startup
    // writes both diagnostics (the client-side egress WARNING and the
    // empty-catalog "0 sources" hint, from the shared runStdioServer seam)
    // — both MUST land on stderr only, or the JSON-RPC framing below would
    // desync.
    //
    // Its own state directory rather than its own CONDUIT_DB: the hint
    // fires on an EMPTY catalog and the suite's daemon is seeded, and the
    // state directory is the unit of isolation now that the db path
    // derives from it.
    const emptyStateDir = mkdtempSync(join(tmpdir(), "conduit-cli-it-purity-"));
    chmodSync(emptyStateDir, 0o700);
    await startDaemonAt(emptyStateDir);
    const transport = new StdioClientTransport({
      command: "node",
      args: [cliBinPath, "serve", "--state-dir", emptyStateDir],
      env: serveEnv(),
      stderr: "pipe",
    });
    transports.push(transport);
    const client = new Client({ name: "cli-it-client-purity", version: "0" });
    await client.connect(transport);
    clients.push(client);

    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: 'const { items } = await tools.search({ query: "anything" }); return items.length;',
      },
    });
    const payload = textPayload(res) as { status: string; result: unknown };
    expect(payload.status).toBe("completed");
    expect(payload.result).toBe(0);

    const stderr = await new Promise<string>((resolve) => {
      const stream = transport.stderr;
      if (stream === null) {
        resolve("");
        return;
      }
      let data = "";
      stream.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      setTimeout(() => resolve(data), 50);
    });
    expect(stderr).toMatch(/CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS/); // egress warning
    expect(stderr).toMatch(/0 sources in catalog/); // empty-catalog hint

    // The protocol conversation succeeded end-to-end (initialize + callTool +
    // listTools round-trips) — if either diagnostic line had leaked onto
    // stdout, the client's JSON-RPC framing would have desynced and this
    // would have thrown or hung instead.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_execution", "execute"]);
  });
});

describe("ring-2: conduit add-mcp (spawned CLI bin)", () => {
  const addMcpDbPath = join(scratch, "add-mcp-it.db"); // cleaned with scratch in afterAll

  async function runAddMcp(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr } = await execFileAsync("node", [cliBinPath, "add-mcp", ...args], {
        env: { ...process.env, ...baseEnv(), CONDUIT_DB: addMcpDbPath, ...env },
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
    }
  }

  async function openAddMcpDb() {
    const client = createClient({ url: `file:${addMcpDbPath}` });
    const store = await openSqliteStore({
      client,
      secretBox: await SecretBox.fromKeyBytes(masterKey),
    });
    return { store, close: () => client.close() };
  }

  it("writes rows against a stub upstream, and re-syncs on a second run against the same url", async () => {
    const upstreamUrl = `http://127.0.0.1:${upstream.port}/mcp`;

    const first = await runAddMcp([
      "--url",
      upstreamUrl,
      "--namespace",
      "ghadd",
      "--prefix",
      "github.acme.add",
    ]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(
      /seeded \d+ tools for connection github\.acme\.add \(namespace ghadd\):/,
    );

    {
      const { store, close } = await openAddMcpDb();
      const source = await store.sources.get("src_ghadd");
      expect(source?.location).toBe(upstreamUrl);
      const tools = await store.tools.list("ghadd");
      expect(tools.length).toBeGreaterThan(0);
      close();
    }

    // Second run against the SAME url: idempotent re-sync, still 0-exit.
    const second = await runAddMcp([
      "--url",
      upstreamUrl,
      "--namespace",
      "ghadd",
      "--prefix",
      "github.acme.add",
    ]);
    expect(second.exitCode).toBe(0);

    {
      const { store, close } = await openAddMcpDb();
      const tools = await store.tools.list("ghadd");
      expect(tools.length).toBeGreaterThan(0);
      close();
    }
  });

  it("INVARIANT /cli add-mcp: a dead url exits non-zero and writes 0 rows", async () => {
    const result = await runAddMcp([
      "--url",
      "http://127.0.0.1:1/mcp-dead",
      "--namespace",
      "ghdead",
      "--prefix",
      "github.acme.dead",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/upstream unreachable/);

    const { store, close } = await openAddMcpDb();
    const source = await store.sources.get("src_ghdead");
    expect(source).toBeUndefined();
    close();
  });
});

describe("ring-2: conduit approvals (spawned CLI bin) drives the whole loop through conduit serve", () => {
  /**
   * Its own state directory, because this suite mixes the two access
   * models that Task 6 left temporarily side by side:
   *
   * - `conduit serve` reaches the database ONLY through the daemon.
   * - `conduit approvals` still opens the store DIRECTLY — converting it
   *   is Task 7's job, not Task 6's.
   *
   * Those cannot both be live against one database without recreating the
   * dual-ownership §17 exists to eliminate, so the daemon is stopped
   * before the approvals commands run and a fresh one is started after —
   * the same stop-first posture `key rotate` takes (§3.4). This is an
   * INTERIM shape: once Task 7 lands, `approvals` becomes a daemon client
   * and the stop/restart dance disappears.
   */
  const approvalsStateDir = mkdtempSync(join(tmpdir(), "conduit-cli-it-appr-"));
  chmodSync(approvalsStateDir, 0o700);
  const approvalsDbPath = join(approvalsStateDir, "conduit.db");

  async function runApprovals(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr } = await execFileAsync("node", [cliBinPath, "approvals", ...args], {
        env: { ...process.env, ...baseEnv(), CONDUIT_DB: approvalsDbPath },
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
    }
  }

  /**
   * Stops ONLY this suite's daemon, so a direct opener is alone against
   * `approvalsDbPath`. Scoped to a single child rather than the shared
   * `daemons` registry — killing the suite-wide daemon here would break
   * every other case.
   */
  async function stopDaemon(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }

  beforeAll(async () => {
    const client = createClient({ url: `file:${approvalsDbPath}` });
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
    // The one policy override that matters for this suite: delete_repo
    // requires a human decision, unlike the "allow" seeded in seedStore()'s db.
    await store.policies.upsert({
      toolName: `${NAMESPACE}.delete_repo`,
      action: "require_approval",
      seededFrom: "destructive",
      manualOverride: true,
      redactFields: [],
    });
    client.close();
  }, 30_000);

  it("workflow: execute pauses on require_approval → approvals list shows it → approvals approve resumes it to completion", async () => {
    const first = await startDaemonAt(approvalsStateDir);
    const client = await spawnClient(serveEnv(), approvalsStateDir);
    const paused = await client.callTool({
      name: "execute",
      arguments: {
        code: 'return await tools.github.delete_repo({ repo: "prod" });',
        requestKey: "rk-ring2-approve",
      },
    });
    const pausedPayload = textPayload(paused) as { status: string; executionId: string };
    expect(pausedPayload.status).toBe("paused");
    const { executionId } = pausedPayload;

    // Stop the daemon before the direct-store approvals commands run — see
    // the suite docblock for why the two access models cannot overlap yet.
    await stopDaemon(first);

    // `approvals list` (a SEPARATE spawned process) shows the paused
    // execution, read from the same durable state the daemon left behind.
    const listResult = await runApprovals(["list", "--json"]);
    expect(listResult.exitCode).toBe(0);
    const rows = JSON.parse(listResult.stdout) as Array<{ executionId: string; tool: string }>;
    expect(rows.some((r) => r.executionId === executionId && r.tool === "github.delete_repo")).toBe(
      true,
    );

    // `approvals approve` (another separate spawned process) resumes it.
    const approveResult = await runApprovals(["approve", executionId]);
    expect(approveResult.exitCode).toBe(0);
    expect(approveResult.stdout.trim()).toBe("completed");
    expect(upstream.upstreamCalls.some((c) => c.name === "delete_repo")).toBe(true);

    // `approvals list` is now empty — the resumed execution is no longer
    // paused. Read while the daemon is still stopped, so this is the last
    // of the direct-store reads.
    const listAfter = await runApprovals(["list", "--json"]);
    const rowsAfter = JSON.parse(listAfter.stdout) as Array<{ executionId: string }>;
    expect(rowsAfter.some((r) => r.executionId === executionId)).toBe(false);

    // A NEW daemon and a NEW serve session confirm the persisted result:
    // the approval was granted by a process that this session never saw,
    // and it is visible because the state is durable rather than in-memory.
    await startDaemonAt(approvalsStateDir);
    const poller = await spawnClient(serveEnv(), approvalsStateDir);
    const checked = await poller.callTool({
      name: "check_execution",
      arguments: { executionId },
    });
    const checkedPayload = textPayload(checked) as { status: string };
    expect(checkedPayload.status).toBe("completed");
  }, 60_000);
});
