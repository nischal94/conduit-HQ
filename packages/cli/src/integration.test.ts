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
      // Hermetic like `baseEnv()`: an ambient CONDUIT_DB would point this
      // daemon at a database the suite never seeded.
      env: (() => {
        const env = baseEnv();
        delete (env as Record<string, string | undefined>).CONDUIT_DB;
        return env;
      })(),
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
 * The environment the DIRECT-STORE commands run under (`approvals`,
 * `add-mcp`, `key`) — the ones not yet converted to daemon clients.
 *
 * HERMETIC BY CONSTRUCTION: every ambient `CONDUIT_*` is deleted after
 * the spread, then only what this suite means to set is added back. A
 * developer machine exporting `CONDUIT_DB` would otherwise silently
 * redirect these commands at a database the suite never seeded.
 */
const baseEnv = (): Record<string, string> => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CONDUIT_")) delete env[key];
  }
  env.CONDUIT_DB = dbPath;
  env.CONDUIT_MASTER_KEY = masterKeyB64;
  env.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS = "1";
  return env as Record<string, string>;
};

/**
 * `conduit serve`'s own env — the one that must NOT carry `CONDUIT_DB`.
 *
 * A serve client that sets it is refused at handshake with
 * `refused-custom-db` (§9.3 item 3), so leaving it in would exercise the
 * refusal path by accident rather than the behavior under test.
 */
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
   * Its own state directory, so this suite's `require_approval` policy
   * override does not disturb the shared one.
   *
   * Since Task 7 BOTH clients reach the database only through the daemon:
   * `conduit serve` over the `serve` capability row, `conduit approvals`
   * over the `approvals` row. The daemon is the single owner throughout,
   * which is why the commands below run against a LIVE daemon with no
   * stop/restart dance — Task 6's interim shape, now deleted.
   */
  const approvalsStateDir = mkdtempSync(join(tmpdir(), "conduit-cli-it-appr-"));
  chmodSync(approvalsStateDir, 0o700);
  const approvalsDbPath = join(approvalsStateDir, "conduit.db");

  /**
   * Runs `conduit approvals` against this suite's daemon.
   *
   * `--state-dir` rather than `CONDUIT_DB`: the state directory is what
   * selects the daemon (and therefore the database), and a client whose
   * env sets `CONDUIT_DB` is refused outright at handshake (§9.3 item 3).
   * The env is `serveEnv()` for exactly that reason.
   */
  async function runApprovals(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        "node",
        [cliBinPath, "approvals", ...args, "--state-dir", approvalsStateDir],
        { env: { ...process.env, ...serveEnv() } },
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
    }
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

  it("INVARIANT §17: a write made through ONE daemon client is visible to ANOTHER with no restart — approvals resumes, the live serve session sees it", async () => {
    // The whole loop against ONE live daemon, with THREE separate client
    // processes talking to it concurrently: a `serve` client (capability
    // `serve`), two `approvals` clients (capability `approvals`), and the
    // same `serve` client again afterwards. Before Task 7 this test could
    // not exist — `approvals` opened the database directly, so the daemon
    // had to be stopped first, and "no restart" was unobservable.
    await startDaemonAt(approvalsStateDir);
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

    // A SEPARATE spawned process, against the LIVE daemon — no stop, no
    // second opener. It sees the pause the serve client just produced.
    const listResult = await runApprovals(["list", "--json"]);
    expect(listResult.exitCode).toBe(0);
    const rows = JSON.parse(listResult.stdout) as Array<{ executionId: string; tool: string }>;
    expect(rows.some((r) => r.executionId === executionId && r.tool === "github.delete_repo")).toBe(
      true,
    );

    // `approvals approve` (another separate process) resumes it — a WRITE
    // through the approvals capability row, driven inside the daemon.
    const approveResult = await runApprovals(["approve", executionId]);
    expect(approveResult.exitCode).toBe(0);
    expect(approveResult.stdout.trim()).toBe("completed");
    expect(upstream.upstreamCalls.some((c) => c.name === "delete_repo")).toBe(true);

    // The queue is empty again, read through the same live daemon.
    const listAfter = await runApprovals(["list", "--json"]);
    const rowsAfter = JSON.parse(listAfter.stdout) as Array<{ executionId: string }>;
    expect(rowsAfter.some((r) => r.executionId === executionId)).toBe(false);

    // THE INVARIANT: the ORIGINAL serve session — never restarted, never
    // reconnected — sees the approval that a different client applied.
    // It holds because the daemon is the only writer and the serve process
    // caches nothing: every read is a fresh RPC.
    const checked = await client.callTool({
      name: "check_execution",
      arguments: { executionId },
    });
    const checkedPayload = textPayload(checked) as { status: string };
    expect(checkedPayload.status).toBe("completed");
  }, 60_000);

  it("a resume the daemon refuses reaches the operator as a typed non-zero answer, not a crash", async () => {
    // The daemon-side refusal path through a REAL spawned CLI process: an
    // execution id that was never paused produces a genuine `conflict`
    // from `manager.resume` inside the daemon, projected onto the wire and
    // reported here with the verb-truth exit code. Pre-conversion this
    // branch was only ever driven in-process against a local store.
    //
    // NOTE ON AUTO-START: there is deliberately no case here for
    // "approvals starts a daemon when none is running against THIS state
    // directory". `spawnDaemon` passes only `--daemon` and a constructed
    // env with no HOME, so an auto-started daemon always derives the
    // DEFAULT state directory (§3.1: the daemon resolves its own state
    // dir; a client may never smuggle one in). Auto-start is therefore
    // real for production's default path — pinned in
    // `daemon/client.test.ts` — but unreachable for a `--state-dir` test
    // fixture by design, not by omission.
    const denied = await runApprovals(["deny", "exec_never_existed"]);
    expect(denied.exitCode).toBe(1);
    expect(denied.stdout.trim()).toBe("conflict");
    expect(denied.stderr).toMatch(/not in a resumable \(paused\) state/);
  }, 60_000);
});
