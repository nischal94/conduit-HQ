import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AGENT_VERSION } from "../env.js";
import { DaemonUnavailable, daemonRequest, MIN_PASS_BUDGET_MS } from "./client.js";
import {
  CONCURRENCY_CAP,
  DRAIN_DEADLINE_MS,
  daemonPaths,
  EXIT_ALREADY_RUNNING,
  EXIT_ROTATION_IN_PROGRESS,
  ExecutionQueue,
  HANDSHAKE_DEADLINE_MS,
  QUEUE_CAPACITY,
  RESUME_ADMISSION_DEADLINE_MS,
} from "./conduitd.js";
import { encodeFrame, FrameDecoder } from "./frames.js";
import { bundleDaemonHelper, type HelperBundle } from "./helpers/bundle.js";
import { acquireExclusive, acquireShared, type HeldLock, probeShared } from "./locks.js";
import { LOG_LINE_MAX_BYTES, LOG_MAX_BYTES } from "./log-sink.js";
import { MAX_TOOL_TEXT_BYTES } from "./provision.js";
import { DAEMON_LOG } from "./spawn.js";

/**
 * Real-process daemon tests (design §3.5, §7 — normative: "the
 * concurrency tests need real processes, not mocks"). Every lifecycle
 * test spawns `helpers/run-daemon.ts` as a genuine child against a temp
 * state dir, so lock acquisition, socket bind/unlink, signal handling and
 * process death are exercised by the kernel rather than simulated.
 *
 * These are slow by nature (each daemon opens a real store and binds a
 * real UDS); timeouts are generous so a load-degraded machine reports a
 * real failure instead of a flake.
 */

const TIMEOUT = 60_000;

/**
 * The spawnable helper is bundled once per file; see
 * `helpers/bundle.ts` for why the harness bundles at all and how esbuild
 * is reached.
 */
let HELPER = "";
let bundle: HelperBundle | undefined;

beforeAll(async () => {
  bundle = await bundleDaemonHelper();
  HELPER = bundle.helper;
}, TIMEOUT);

afterAll(() => {
  bundle?.cleanup();
});

let dir: string | undefined;
const children: ChildProcess[] = [];
const sockets: Socket[] = [];
const locks: HeldLock[] = [];
/** Stub MCP upstreams started by a test; closed in afterEach. */
const servers: Server[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.length = 0;
  // Reap each child to actual exit before the state dir is removed. A
  // daemon still draining from the previous test would otherwise keep
  // running against a directory being deleted underneath it, and its
  // lock-db handles would leak into the next test's acquisition.
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null) return Promise.resolve();
      if (!child.killed) child.kill("SIGKILL");
      return new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }),
  );
  children.length = 0;
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers.length = 0;
  for (const lock of locks) await lock.release();
  locks.length = 0;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** A 0700 temp state dir — the mode assertStateDir(bind) requires. */
function newStateDir(): string {
  dir = mkdtempSync(join(tmpdir(), "cd-"));
  return dir;
}

interface Daemon {
  child: ChildProcess;
  /** Every stdout line the daemon has emitted, in order. */
  lines: string[];
  waitForLine(match: string, timeoutMs?: number): Promise<string>;
  waitForExit(timeoutMs?: number): Promise<number | null>;
}

/**
 * A fixed test key: the daemon resolves its own config, so the only way
 * to point it at a throwaway database is the operator-by-hand env path
 * (§3.1) — which is exactly what a spawned test daemon is. The db itself
 * lives inside the temp state dir, so no test ever touches a real one.
 */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * The secret the `--throw-execute` fault embeds in its error message.
 *
 * Must stay in sync with the literal of the same name in
 * `helpers/run-daemon.ts` — that file is spawned as a standalone process
 * and excluded from the package tsconfig, so it cannot be imported here.
 */
const FAULT_SECRET = "Bearer thrown_fault_secret_do_not_leak";

function spawnDaemon(stateDir: string, extraArgs: string[] = []): Daemon {
  const child = spawn(process.execPath, [HELPER, stateDir, ...extraArgs], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CONDUIT_MASTER_KEY: TEST_KEY },
  });
  children.push(child);

  const lines: string[] = [];
  const waiters: Array<{ match: string; resolve: (line: string) => void }> = [];
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter !== undefined && line.includes(waiter.match)) {
          waiters.splice(i, 1);
          waiter.resolve(line);
        }
      }
    }
  });

  return {
    child,
    lines,
    waitForLine(match: string, timeoutMs = TIMEOUT): Promise<string> {
      const existing = lines.find((line) => line.includes(match));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for daemon line "${match}". Seen: ${JSON.stringify(lines)}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          match,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
    waitForExit(timeoutMs = TIMEOUT): Promise<number | null> {
      if (child.exitCode !== null) return Promise.resolve(child.exitCode);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for daemon exit")),
          timeoutMs,
        );
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
  };
}

interface Client {
  socket: Socket;
  /** Frames received, in order. */
  received: unknown[];
  send(msg: unknown): void;
  next(timeoutMs?: number): Promise<unknown>;
  closed: Promise<void>;
}

/** Connects and decodes frames; sends NOTHING on its own (READY gate). */
function connectClient(socketPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    const decoder = new FrameDecoder();
    const received: unknown[] = [];
    const waiters: Array<(msg: unknown) => void> = [];
    let closeResolve: () => void = () => {};
    const closed = new Promise<void>((res) => {
      closeResolve = res;
    });

    socket.on("data", (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
        else received.push(msg);
      }
    });
    socket.on("close", closeResolve);
    socket.on("error", reject);
    socket.on("connect", () => {
      resolve({
        socket,
        received,
        send: (msg: unknown) => socket.write(encodeFrame(msg)),
        next(timeoutMs = TIMEOUT): Promise<unknown> {
          const buffered = received.shift();
          if (buffered !== undefined) return Promise.resolve(buffered);
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("timed out waiting for a frame")),
              timeoutMs,
            );
            waiters.push((msg) => {
              clearTimeout(timer);
              res(msg);
            });
          });
        },
        closed,
      });
    });
  });
}

/** Polls a synchronous condition to true, or throws at the deadline. */
async function waitFor(check: () => boolean, timeoutMs = TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for a condition");
}

async function handshake(client: Client, capability = "serve"): Promise<unknown> {
  expect(await client.next()).toEqual({ kind: "ready" });
  client.send({ kind: "handshake", protocol: 1, capability });
  return client.next();
}

// --- A stub MCP upstream, re-armable ------------------------------------
//
// Speaks just enough streamable-HTTP MCP for `fetchToolsList` to complete
// (initialize → notifications/initialized → tools/list). The advertised tool
// set is MUTABLE via `setTools`: `source.revalidate` re-fetches the SAME
// stored url, so the only way to prove a revalidate republished the catalog
// is to change what the upstream answers between the two fetches.

interface Upstream {
  origin: string;
  /** Re-arms the `tools/list` answer for every subsequent fetch. */
  setTools(tools: unknown[]): void;
  /**
   * Holds every subsequent `tools/list` open until `releaseTools()` is
   * called, and resolves once one is actually being held.
   *
   * This is the only seam that can interleave two provisionings from
   * outside the daemon: a stalled `tools/list` parks its request INSIDE the
   * held per-namespace source lock, after that namespace's own store read,
   * so a second namespace can commit underneath it. Without it, every
   * provisioning here runs to completion before the next begins and the
   * cross-namespace race is unreachable.
   */
  holdTools(): Promise<void>;
  releaseTools(): void;
}

/** One tool as an upstream advertises it, before namespacing. */
function upstreamTool(name: string, description: string): unknown {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  };
}

async function startUpstream(initial: unknown[]): Promise<Upstream> {
  let tools = initial;
  /** Set while `tools/list` answers are being held; cleared on release. */
  let hold: { gate: Promise<void>; open: () => void } | undefined;
  /** Resolved the moment a `tools/list` is actually parked on the gate. */
  let announceHeld: (() => void) | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      let parsed: { id?: string; method?: string } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        // Non-JSON body (the DELETE teardown): fall through to 202.
      }
      if (parsed.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          }),
        );
        return;
      }
      if (parsed.method === "tools/list") {
        const answer = (): void => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools } }));
        };
        if (hold !== undefined) {
          // Parked INSIDE the daemon's held source lock for this namespace.
          announceHeld?.();
          void hold.gate.then(answer);
          return;
        }
        answer();
        return;
      }
      res.writeHead(202);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    setTools: (next: unknown[]) => {
      tools = next;
    },
    holdTools: () => {
      let open = (): void => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      hold = { gate, open };
      return new Promise<void>((resolve) => {
        announceHeld = resolve;
      });
    },
    releaseTools: () => {
      hold?.open();
      hold = undefined;
      announceHeld = undefined;
    },
  };
}

/** Sends a `source.provision` and returns the daemon's answer frame. */
function provision(
  client: Client,
  args: { namespace: string; url: string; prefix: string },
): Promise<unknown> {
  client.send({
    kind: "source.provision",
    namespace: args.namespace,
    url: args.url,
    prefix: args.prefix,
    replace: true,
    clearCredential: false,
  });
  return client.next();
}

/** The tool paths a `search` answered with, in rank order. */
async function searchPaths(client: Client, query: string): Promise<string[]> {
  client.send({ kind: "search", query });
  const answer = (await client.next()) as { kind: string; payload: { path: string }[] };
  expect(answer.kind).toBe("result");
  return answer.payload.map((hit) => hit.path);
}

describe("conduitd lifecycle", () => {
  it(
    "INVARIANT §17: exactly one daemon survives a concurrent auto-start race",
    async () => {
      const stateDir = newStateDir();
      // Both spawn together — the normal case of two MCP clients starting
      // at login, not an edge case.
      const a = spawnDaemon(stateDir);
      const b = spawnDaemon(stateDir);

      const outcomes = await Promise.all([
        Promise.race([
          a.waitForLine("listening").then(() => "ready" as const),
          a.waitForExit().then(() => "exited" as const),
        ]),
        Promise.race([
          b.waitForLine("listening").then(() => "ready" as const),
          b.waitForExit().then(() => "exited" as const),
        ]),
      ]);

      // Exactly one serves; the loser exits rather than binding a second
      // endpoint over the same database.
      expect(outcomes.filter((o) => o === "ready")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "exited")).toHaveLength(1);

      const loser = outcomes[0] === "exited" ? a : b;
      expect(loser.lines.join("\n")).toContain("already running");
      expect(existsSync(daemonPaths(stateDir).socket)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a failed connect to a LIVE listener never unlinks it",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      // A second daemon fails to take over: it refuses on the lifecycle
      // lock and must leave the live endpoint alone.
      const intruder = spawnDaemon(stateDir);
      // The exact code, not merely "non-zero": exit codes are part of
      // the §3.5 client contract, so 3 is the assertion — a refusal that
      // started exiting 1 would still pass a not-zero check.
      expect(await intruder.waitForExit()).toBe(EXIT_ALREADY_RUNNING);
      expect(existsSync(paths.socket)).toBe(true);

      // The live daemon still serves on that same endpoint.
      const client = await connectClient(paths.socket);
      expect(await client.next()).toEqual({ kind: "ready" });

      // The socket survives until the owner itself removes it.
      daemon.child.kill("SIGTERM");
      await daemon.waitForLine("stopped");
      await daemon.waitForExit();
      expect(existsSync(paths.socket)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: rotation's exclusive maintenance acquisition blocks while a daemon holds it shared",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);

      // Order 1 — daemon first, then rotation: rotation is refused.
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");
      expect(await acquireExclusive(paths.maintenanceLockDb)).toBeNull();

      // The daemon's hold is SHARED, not EXCLUSIVE: another reader still
      // gets in. Without this, the assertion above would pass equally for
      // a daemon holding maintenance exclusively — which would wrongly
      // exclude concurrent readers rather than only rotation.
      const reader = await acquireShared(paths.maintenanceLockDb);
      expect(reader).not.toBeNull();
      if (reader) await reader.release();

      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();

      // Order 2 — rotation first, then daemon: the daemon exits with
      // "rotation in progress" and releases the lifecycle lock it took
      // first, so it does not wedge the next start.
      const rotation = await acquireExclusive(paths.maintenanceLockDb);
      expect(rotation).not.toBeNull();
      if (rotation) locks.push(rotation);

      const blocked = spawnDaemon(stateDir);
      // Exit 4 specifically — a client distinguishes "rotation" from
      // "already running" by the code, so the numeric contract is pinned.
      expect(await blocked.waitForExit()).toBe(EXIT_ROTATION_IN_PROGRESS);
      expect(blocked.lines.join("\n")).toContain("rotation in progress");

      // Lifecycle was released on the way out — provable by taking it.
      const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
      expect(lifecycle).not.toBeNull();
      if (lifecycle) locks.push(lifecycle);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a connection queued during listener close gets no READY and the client writes nothing",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      daemon.child.kill("SIGTERM");
      // The daemon can complete its whole drain before this observer is
      // scheduled, so racing exit is not a fallback — it is the other
      // legitimate outcome. Either way the listener is closed by the time
      // the connect below runs, which is the condition under test.
      await Promise.race([daemon.waitForLine("draining"), daemon.waitForExit()]);

      // Racing the listener close: connect() may succeed at the kernel
      // level while the daemon is already draining. Whatever happens, the
      // client must never see READY — that is the whole gate. It writes
      // nothing, so a later retry is a first attempt, not a replay.
      //
      // Every outcome is bounded here: a refused connect, a connect that
      // is accepted then immediately destroyed, and a connect that hangs
      // all resolve rather than hanging the test.
      const sawReady = await new Promise<boolean>((resolve) => {
        const socket = connect(paths.socket);
        sockets.push(socket);
        const decoder = new FrameDecoder();
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          socket.destroy();
          resolve(value);
        };
        timer = setTimeout(() => settle(false), 5_000);
        socket.on("data", (chunk: Buffer) => {
          for (const msg of decoder.push(chunk)) {
            if ((msg as { kind?: string })?.kind === "ready") settle(true);
          }
        });
        socket.on("error", () => settle(false));
        socket.on("close", () => settle(false));
      });
      expect(sawReady).toBe(false);

      await daemon.waitForExit();
      expect(existsSync(paths.socket)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a signal-stopped daemon exits with no paused work stranded",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const first = spawnDaemon(stateDir);
      await first.waitForLine("listening");

      // Approvals are durable data, not daemon state: whatever the store
      // holds before the signal must still be listable after a restart.
      const before = await connectClient(paths.socket);
      await handshake(before, "approvals");
      before.send({ kind: "approvals.list" });
      const listedBefore = (await before.next()) as { kind: string; payload: unknown[] };
      expect(listedBefore.kind).toBe("result");

      first.child.kill("SIGTERM");
      await first.waitForLine("stopped");
      expect(await first.waitForExit()).toBe(0);

      // A clean drain releases both locks and removes the endpoint, so a
      // successor starts without any cleanup protocol.
      const second = spawnDaemon(stateDir);
      await second.waitForLine("listening");

      const after = await connectClient(paths.socket);
      await handshake(after, "approvals");
      after.send({ kind: "approvals.list" });
      const listedAfter = (await after.next()) as { kind: string; payload: unknown[] };
      expect(listedAfter.kind).toBe("result");
      expect(listedAfter.payload).toEqual(listedBefore.payload);
    },
    TIMEOUT,
  );

  it(
    "routes sandbox module-recovery diagnostics to the DAEMON's log — and leaks no guest code",
    async () => {
      // Moved here from server.test.ts by D-B1: the sandbox now runs
      // daemon-side, so `runDaemon` owns the process-global recovery sink.
      // A real overflow through a real daemon, then a benign call that
      // rebuilds — the events must reach the daemon's own log in the
      // "[sandbox]" format, carrying NO guest code or values.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");
      client.send({
        kind: "execute",
        code: "let x = { secretMarker: 1 }; for (let i=0;i<20000;i++) x={n:x}; return x;",
        deadlineMs: 60_000,
      });
      await client.next();
      client.send({ kind: "execute", code: "return 1;", deadlineMs: 60_000 });
      await client.next();

      await waitFor(() => daemon.lines.some((l) => l.includes("sandbox.module.recovery.ok")));
      const diag = daemon.lines.filter((l) => l.includes("[sandbox] "));
      expect(diag.some((l) => l.includes("sandbox.module.poisoned"))).toBe(true);
      expect(diag.some((l) => l.includes("sandbox.module.recovery.ok"))).toBe(true);
      // §11: no diagnostic line carries guest code or guest values.
      for (const line of diag) {
        expect(line).not.toContain("secretMarker");
        expect(line).not.toContain('"n"');
      }

      // Close before signalling: a READY-granted connection counts as
      // active work, so the D6 drain grace would otherwise hold this
      // daemon for the full DRAIN_DEADLINE_MS with nothing left to do.
      client.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  /**
   * D-B1 (controller-ruled): the three read-only kinds `serve` gained so the
   * stdio server could stop opening the database itself. Driven against a
   * REAL spawned daemon over the real socket, because what needs pinning is
   * the whole path — capability check, dispatch, projection — not the
   * projection functions alone (`server.test.ts` covers those in ring 1).
   */
  it(
    "INVARIANT §17 / §3.3: the D-B1 reads answer with PROJECTIONS carrying no credential material",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir, ["--seed-catalog"]);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");

      client.send({ kind: "catalog.listing" });
      const listing = (await client.next()) as {
        kind: string;
        payload: { connections: { prefix: string; label: string }[]; sourceCount: number };
      };
      expect(listing.kind).toBe("result");
      // The advertisement view: the seeded connection is listed by prefix
      // and namespace label, and the source count drives the startup hint.
      expect(listing.payload.connections).toEqual([
        { prefix: "github.acme.prod", label: "github tools" },
      ]);
      expect(listing.payload.sourceCount).toBe(1);

      // §3.3.1, pinned on the WIRE rather than by reading the code: the
      // connection row this projection derives from carries a
      // `credentialRef`, and no field of it — nor the secret it points at —
      // may appear in any byte the daemon sent. A future refactor that
      // spreads the row instead of naming two fields fails here.
      const wire = JSON.stringify(listing.payload);
      expect(wire).not.toContain("credentialRef");
      expect(wire).not.toContain("cred_gh");
      expect(wire).not.toContain("secret");
      expect(Object.keys(listing.payload.connections[0] ?? {}).sort()).toEqual(["label", "prefix"]);

      // An unknown execution is `not_found`, never an error frame — "no
      // such row" is a legitimate answer to a lookup, and collapsing it
      // into a failure would make an agent retry a question already
      // answered.
      client.send({ kind: "execution.get", executionId: "exec_does_not_exist" });
      expect(await client.next()).toMatchObject({
        kind: "result",
        payload: { status: "not_found" },
      });
      client.send({ kind: "execution.getByRequestKey", requestKey: "rk-nope" });
      expect(await client.next()).toMatchObject({
        kind: "result",
        payload: { status: "not_found" },
      });

      client.socket.destroy(); // see the drain-grace note above
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: execute.requestKey round-trips — the same key returns conflict, never a second run",
    async () => {
      // §M1's duplicate suppression, end to end through the daemon. The
      // key is persisted BEFORE the sandbox runs, so a reissue after a
      // lost response must be refused as a `conflict` rather than started
      // again — a replayed execution can duplicate upstream side effects
      // that already landed.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");

      client.send({
        kind: "execute",
        code: "return 41 + 1;",
        deadlineMs: 60_000,
        requestKey: "rk-1",
      });
      const first = (await client.next()) as {
        kind: string;
        payload: { status: string; executionId: string; result: unknown };
      };
      expect(first.kind).toBe("result");
      expect(first.payload.status).toBe("completed");
      expect(first.payload.result).toBe(42);

      // Same key again: refused as a conflict, and the SAME execution is
      // then recoverable by that key — which is the whole point of the
      // field (recover, don't re-run).
      client.send({
        kind: "execute",
        code: "return 41 + 1;",
        deadlineMs: 60_000,
        requestKey: "rk-1",
      });
      expect(await client.next()).toMatchObject({
        kind: "result",
        payload: { status: "conflict" },
      });

      client.send({ kind: "execution.getByRequestKey", requestKey: "rk-1" });
      expect(await client.next()).toMatchObject({
        kind: "result",
        payload: { status: "completed", executionId: first.payload.executionId, result: 42 },
      });

      client.socket.destroy(); // see the drain-grace note above
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a paused execution past its TTL reads back as `expired` on the DAEMON's clock",
    async () => {
      // The placement half of the CheckPayload projection, which the
      // not_found case above cannot reach. `executionToCheckPayload`
      // presents a `paused` row whose `expiresAt` has passed as
      // `expired`, and that comparison must happen in the process that
      // OWNS the row: a serve process with a skewed clock must not be
      // able to present a live approval as dead, or a dead one as live.
      //
      // Driven through a REAL daemon with a REAL 1s approval TTL, so the
      // row genuinely ages between the pause and the read — no clock
      // injection, no fake timers. The serve-side client passes no clock
      // at all (the `now` seam was removed in D-B1), so an `expired`
      // answer here can ONLY have come from the daemon's own `Date.now()`.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir, ["--pause-execute", "--approval-ttl-ms", "1000"]);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");
      client.send({ kind: "execute", code: "pause me", deadlineMs: 60_000 });
      const paused = (await client.next()) as {
        kind: string;
        payload: { status: string; executionId: string };
      };
      expect(paused.kind).toBe("result");
      expect(paused.payload.status).toBe("paused");
      const { executionId } = paused.payload;

      // Immediately: still within the TTL, so still `paused`.
      client.send({ kind: "execution.get", executionId });
      expect(await client.next()).toMatchObject({
        kind: "result",
        payload: { status: "paused", executionId },
      });

      // Let the TTL genuinely lapse on the wall clock.
      await new Promise((resolve) => setTimeout(resolve, 1_400));

      // Same row, same request, same client — only the daemon's clock
      // moved, and the projection now reads `expired`.
      client.send({ kind: "execution.get", executionId });
      expect(await client.next()).toMatchObject({
        kind: "result",
        payload: { status: "expired", executionId },
      });

      client.socket.destroy(); // see the drain-grace note above
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17 / §3.3: the D-B1 reads are denied to every capability except serve",
    async () => {
      // The ruling widened `serve` ALONE. An administrative client must not
      // acquire an execution lookup as a side effect of that widening.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      for (const capability of ["approvals", "add-mcp"]) {
        const client = await connectClient(paths.socket);
        await handshake(client, capability);
        for (const request of [
          { kind: "catalog.listing" },
          { kind: "execution.get", executionId: "exec_x" },
          { kind: "execution.getByRequestKey", requestKey: "rk-x" },
        ]) {
          client.send(request);
          expect(await client.next()).toMatchObject({
            kind: "error",
            code: "invalid",
            message: expect.stringContaining(`does not permit "${request.kind}"`),
          });
        }
        client.socket.destroy(); // see the drain-grace note above
      }

      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a client whose env sets CONDUIT_DB is refused at handshake",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      expect(await client.next()).toEqual({ kind: "ready" });
      // The client reports its own CONDUIT_DB; the daemon refuses rather
      // than silently serving its default database under another name.
      client.send({
        kind: "handshake",
        protocol: 1,
        capability: "serve",
        dbPath: "/tmp/x.db",
      });
      expect(await client.next()).toMatchObject({
        kind: "error",
        code: "refused-custom-db",
      });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: the crash-terminal sweep runs before the endpoint is bound",
    async () => {
      const stateDir = newStateDir();
      const marker = join(stateDir, "swept");
      const daemon = spawnDaemon(stateDir, ["--sweep-marker", marker]);
      await daemon.waitForLine("listening");
      // Present by the time the socket is served: the sweep is ordered
      // before bind, so no client can observe a half-swept database.
      expect(existsSync(marker)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "enforces the handshake-declared capability set",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      expect(await handshake(client, "serve")).toMatchObject({ kind: "handshake.ok" });

      // approvals.resume is administrative — a `serve` client may not
      // reach it by method name (§3.3).
      client.send({
        kind: "approvals.resume",
        executionId: "e1",
        decision: "approve",
        callId: "c1",
      });
      expect(await client.next()).toMatchObject({ kind: "error", code: "invalid" });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a fresh daemon's handshake.ok carries its build version (agentVersion) for skew diagnosis",
    async () => {
      // The daemon reports its OWN build version in every handshake.ok, so a
      // NEW client talking to an OLD, still-running daemon can diagnose skew
      // (§17). A fresh daemon must therefore fill it, and with the SAME string
      // `--version` prints (both read env.ts `AGENT_VERSION`), so client and
      // daemon agree by construction rather than coincidence.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      const ok = await handshake(client, "serve");
      expect(ok).toMatchObject({ kind: "handshake.ok", agentVersion: AGENT_VERSION });
    },
    TIMEOUT,
  );

  it(
    "bounds the ON-DISK active log under real daemon logging (fd ownership, not just the sink object)",
    async () => {
      // The sink unit tests pin the rotation mechanics against a sink OBJECT.
      // What they cannot pin is that the daemon's own log traffic actually
      // goes through that object — the property that fails if the daemon
      // keeps writing to an inherited append fd instead of owning its own
      // (spec §5). So this drives a REAL spawned daemon whose log goes to the
      // sink and samples the file on disk.
      //
      // The bound alone would be vacuous at this traffic volume: a few
      // hundred bytes is under a 5MB cap no matter WHERE it was written, so
      // the test would pass identically with no sink at all. The two
      // non-vacuous halves are therefore (a) the file must actually be
      // written and GROW as the daemon logs, which is what proves the
      // daemon's own traffic reaches THIS file through the sink, and (b)
      // `daemon.status` must report that same file — which also closes the
      // `logInfo` seam end-to-end, since its default is `() => null` until
      // an entry point wires the real accessor.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // `--log-sink` wires the real `createRotatingLog` (see run-daemon.ts
      // for how it deliberately differs from bin.ts).
      //
      // The other two flags are load-bearing for the GROWTH half, and both
      // were established by measurement rather than assumption:
      //
      // `--debug` because the per-admission queue lines are the §5-gated
      // volume; with the gate shut a healthy request logs nothing at all.
      //
      // `--throw-execute` because the queue lines come from
      // `submitSandboxWork`, which only sandbox work reaches — a
      // `catalog.listing` is a plain read that never enters the queue, so
      // read traffic alone leaves the file flat no matter how many rounds
      // run. An `execute` both traverses the queue (a gated line) and
      // fails loudly (an ungated error line), so it exercises both routes
      // into the sink.
      const daemon = spawnDaemon(stateDir, ["--log-sink", "--debug", "--throw-execute"]);
      await daemon.waitForLine("listening");

      const logPath = join(stateDir, "conduitd.log");
      const bound = LOG_MAX_BYTES + LOG_LINE_MAX_BYTES;
      // Non-empty already: the "listening" line the readiness wait just
      // observed had to land here too, not only on stdout.
      const initialSize = statSync(logPath).size;
      expect(initialSize).toBeGreaterThan(0);
      expect(initialSize).toBeLessThan(bound);

      // Real request traffic through the real dispatch path, sampling the
      // on-disk size between rounds. The execute is REFUSED (the injected
      // fault) — an error reply is a successful drive of the logging path,
      // which is what this test is about.
      for (let round = 0; round < 5; round++) {
        const client = await connectClient(paths.socket);
        await handshake(client, "serve");
        client.send({ kind: "execute", code: `${round}`, deadlineMs: 60_000 });
        expect(await client.next()).toMatchObject({ kind: "error" });
        client.socket.end();
        expect(statSync(logPath).size).toBeLessThan(bound);
      }

      // The file must have GROWN under that traffic. This is the assertion
      // that fails if the daemon's log goes anywhere other than the sink's
      // own descriptor — without it the bound below is vacuous, since a few
      // hundred bytes sit under a 5MB cap however they were written.
      await waitFor(() => statSync(logPath).size > initialSize);

      // `daemon.status` reports the daemon's OWN view of its log — the
      // `logInfo` accessor threaded from the sink. A null here means the
      // seam was never wired; a mismatched path means the daemon is
      // reporting on a different file than it writes.
      const control = await connectClient(paths.socket);
      await handshake(control, "control");
      control.send({ kind: "daemon.status" });
      const status = (await control.next()) as {
        kind: string;
        payload: { logPath: string | null; logSizeBytes: number | null };
      };
      expect(status.kind).toBe("result");
      // `realpathSync`, because the daemon resolves its state directory
      // through `resolveEffectiveStateDir` (§17 §2) and therefore reports
      // the canonical path — on macOS the temp dir is a symlink, so the
      // raw `tmpdir()` spelling and the daemon's resolved one differ by a
      // `/private` prefix while naming ONE file. Comparing canonical forms
      // keeps the assertion about file identity rather than about spelling.
      expect(status.payload.logPath).toBe(realpathSync(logPath));
      const onDisk = statSync(logPath).size;
      expect(status.payload.logSizeBytes).toBeGreaterThan(0);
      // Approximate, not equal: lines can land between the daemon's own
      // reading and this one, and a fault line carries a stack trace worth
      // roughly a kilobyte. What must hold is that the two describe the
      // SAME file rather than two unrelated counters — an unwired accessor
      // reports null and a stale snapshot is off by the whole file, so the
      // failure modes this guards against differ by orders of magnitude,
      // not by one line's worth of bytes.
      expect(Math.abs((status.payload.logSizeBytes ?? 0) - onDisk)).toBeLessThan(
        LOG_LINE_MAX_BYTES,
      );
      expect(status.payload.logSizeBytes).toBeLessThan(bound);
    },
    TIMEOUT,
  );

  it(
    "with the §5 gate SHUT, lifecycle lines are logged but accepted-admission lines are not",
    async () => {
      // The gate's scope, from the operator's side. §5 bounds per-ADMISSION
      // volume — one line per served request, which is what dominates a busy
      // daemon's log. It does NOT suppress the classes an operator needs by
      // default: lifecycle transitions, errors, and REFUSALS.
      //
      // No `--debug` here, deliberately: that is the whole point.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir, ["--log-sink", "--throw-execute"]);
      await daemon.waitForLine("listening");

      const logPath = join(stateDir, DAEMON_LOG);
      const client = await connectClient(paths.socket);
      await handshake(client, "serve");
      // Real sandbox traffic, so an admission genuinely happens — the
      // execute both traverses the queue and fails loudly.
      client.send({ kind: "execute", code: "1", deadlineMs: 60_000 });
      expect(await client.next()).toMatchObject({ kind: "error" });

      // The error line lands: the ungated classes are unaffected by the gate.
      await waitFor(() => readFileSync(logPath, "utf8").includes("Queued request failed"));
      const written = readFileSync(logPath, "utf8");
      // Lifecycle transitions are ungated.
      expect(written).toContain("listening");
      // THE ASSERTION: the accepted-admission line is absent. That is the
      // per-admission volume the gate exists to hold back.
      expect(written).not.toContain("active=");
      expect(written).not.toMatch(/queue depth=\d+ max=\d+ active=/);

      client.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "a busy REFUSAL is logged with the gate shut — a refusal is not per-admission volume",
    async () => {
      // The other half of the gate's scope, and the one the fix changed: a
      // refusal is the daemon DECLINING work, which is the class §5 keeps at
      // default alongside lifecycle and errors. An operator diagnosing "my
      // requests are failing" must see it without having restarted the
      // daemon under `--debug`.
      //
      // MUTATION CHECK: route the `refused=busy` line back through
      // `logDebug` and this test fails — with no `--debug` the line vanishes.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // Stalled sandbox work is how the queue is driven to its capacity.
      const daemon = spawnDaemon(stateDir, ["--log-sink", "--stall-sandbox"]);
      await daemon.waitForLine("listening");

      const logPath = join(stateDir, DAEMON_LOG);
      const client = await connectClient(paths.socket);
      await handshake(client, "serve");

      // Fill every running slot AND the whole queue, then one more: that
      // last one is refused `busy`.
      for (let i = 0; i < CONCURRENCY_CAP + QUEUE_CAPACITY + 1; i++) {
        client.send({ kind: "execute", code: `${i}`, deadlineMs: 60_000 });
      }
      // The refusal arrives as an error frame with the busy code.
      await waitFor(
        () => daemon.lines.filter((l) => l.includes("stalling execute")).length >= CONCURRENCY_CAP,
      );
      const answer = (await client.next()) as { kind: string; code?: string };
      expect(answer.kind).toBe("error");
      expect(answer.code).toBe("busy");

      // THE ASSERTION: the refusal line is in the log despite no `--debug`.
      await waitFor(() => readFileSync(logPath, "utf8").includes("refused=busy"));
      expect(readFileSync(logPath, "utf8")).toContain("refused=busy");

      client.socket.destroy();
      // SIGKILL, not SIGTERM: the fixture stalls this daemon's sandbox work
      // FOREVER, so a graceful drain would sit out its whole deadline and
      // then still have unfinished work. Nothing here asserts on shutdown.
      // The shared `afterEach` also reaps, but it waits on `exit` — so the
      // kill has to happen here, before the hook's own timeout.
      daemon.child.kill("SIGKILL");
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a second handshake cannot widen an established capability",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      expect(await handshake(client, "serve")).toMatchObject({ kind: "handshake.ok" });

      // Refused: administrative verb, outside `serve`.
      client.send({
        kind: "approvals.resume",
        executionId: "e1",
        decision: "approve",
        callId: "c1",
      });
      expect(await client.next()).toMatchObject({ kind: "error", code: "invalid" });

      // `handshake` is in EVERY capability set, so re-handshaking is the
      // obvious escalation route: claim `approvals`, then retry the verb.
      client.send({ kind: "handshake", protocol: 1, capability: "approvals" });
      expect(await client.next()).toMatchObject({
        kind: "error",
        code: "invalid",
        message: "capability already negotiated on this connection",
      });

      // The escalated request is still refused — the connection is still
      // `serve`, not `approvals`.
      client.send({
        kind: "approvals.resume",
        executionId: "e1",
        decision: "approve",
        callId: "c1",
      });
      expect(await client.next()).toMatchObject({ kind: "error", code: "invalid" });
    },
    TIMEOUT,
  );

  it(
    "reports internal failures without leaking the cause to the client",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // A genuinely FAILING manager, not an unknown execution id: a
      // resume against an unknown id loses `claimForResume` and returns
      // a `conflict` RESULT, never an error — so the original version of
      // this test drove no failure path at all. Its assertions were
      // wrapped in `if (reply.code === "internal")`, which was false
      // every run, so the whole §9.2 hygiene check silently passed on a
      // successful reply. The unconditional shape below is what caught it.
      const daemon = spawnDaemon(stateDir, ["--throw-execute"]);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");

      // Drives a real store/manager rejection. The client must receive
      // the fixed string only — never filesystem paths or key-source
      // context (§9.2, §11).
      client.send({ kind: "execute", code: "1+1", deadlineMs: 60_000 });
      const reply = (await client.next()) as { kind: string; code?: string; message?: string };
      expect(reply).toMatchObject({
        kind: "error",
        code: "internal",
        message:
          "internal daemon error; see the daemon log for the cause, correlated by this error's requestId",
      });

      // The redaction assertions scan the WHOLE serialized frame, not
      // `reply.message`. Asserting against `message` was decorative: the
      // `toMatchObject` above already pins it to an exact constant, so a
      // `not.toContain` on that same field could never fail whatever the
      // daemon did — and it would keep passing if a future change added a
      // `cause` or `detail` field carrying the raw error. The frame-wide
      // scan is what actually pins §9.2, in the same shape
      // `source-invariants.test.ts` uses for stored credentials.
      //
      // Load-bearing because the fault genuinely carries the material: the
      // `--throw-execute` fixture rejects with an error embedding
      // FAULT_SECRET and the absolute state-dir path (see run-daemon.ts).
      const wire = JSON.stringify(reply);
      expect(wire).not.toContain(FAULT_SECRET);
      expect(wire).not.toContain(stateDir);
      expect(wire).not.toContain(".db");
      expect(wire).not.toContain("simulated store fault");

      // The daemon's OWN log, by contrast, MUST carry the cause — that is
      // the whole bargain the client-facing message strikes ("see the
      // daemon log for the cause"). Asserting it here proves the secret
      // was genuinely in play, so the frame scan above is not vacuous: a
      // fixture that silently stopped throwing would fail this line rather
      // than pass the redaction checks trivially.
      // "Queued request failed" — this fault is raised inside the queue's
      // run closure, so it takes the queued-dispatch reporting path rather
      // than the direct one.
      await waitFor(() => daemon.lines.some((l) => l.includes("Queued request failed: execute")));
      expect(daemon.lines.join("\n")).toContain(FAULT_SECRET);
    },
    TIMEOUT,
  );

  it(
    "answers implemented source RPCs, and still reads `invalid` on a malformed one",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "add-mcp");

      // Implemented since Task 8. A namespace with no stored source is a
      // REFUSAL (`invalid`, carrying the operator's next move), never a
      // not-built-yet placeholder — onboarding needs a url, and the only
      // place a url may be supplied is `source.provision`. (The placeholder
      // code the refusal once used has since been removed from the error
      // union outright; nothing emits it.)
      client.send({ kind: "source.revalidate", namespace: "ns" });
      const refusal = (await client.next()) as { kind: string; code: string; message: string };
      expect(refusal).toMatchObject({ kind: "error", code: "invalid" });
      expect(refusal.message).toContain("no source is registered under namespace");

      // A genuinely malformed request still reads "invalid", so the two
      // remain distinguishable.
      client.send({ kind: "source.revalidate", namespace: 5 });
      expect(await client.next()).toMatchObject({ kind: "error", code: "invalid" });
    },
    TIMEOUT,
  );

  it("exits within the drain deadline even with a request stalled in a non-sandbox layer", async () => {
    const stateDir = newStateDir();
    const paths = daemonPaths(stateDir);
    // The helper stalls one in-flight request forever, simulating a
    // block in the store/upstream layer that §16's budgets do not bound.
    const daemon = spawnDaemon(stateDir, ["--stall-execute"]);
    await daemon.waitForLine("listening");

    const client = await connectClient(paths.socket);
    await handshake(client, "serve");
    client.send({ kind: "execute", code: "1+1", deadlineMs: 60_000 });
    await daemon.waitForLine("stalling execute");

    const startedAt = Date.now();
    daemon.child.kill("SIGTERM");
    expect(await daemon.waitForExit()).toBe(0);
    const elapsed = Date.now() - startedAt;

    // Bounded: it must not wait on the stalled request forever, and it
    // must still release its locks and remove its endpoint on the way.
    expect(elapsed).toBeLessThan(DRAIN_DEADLINE_MS + 20_000);

    // The PROCESS is gone, not merely "done draining". The stalled
    // request never settles, so if the daemon relied on the event loop
    // emptying it would linger forever with both locks already released —
    // a second writer whose in-flight store call can land after a
    // successor takes ownership. `waitForExit` above returning 0 is that
    // assertion; this bound is the "promptly" half of it: exit follows the
    // deadline, not the stall (which never resolves at all).
    expect(elapsed).toBeLessThan(DRAIN_DEADLINE_MS + 10_000);
    expect(daemon.child.killed || daemon.child.exitCode !== null).toBe(true);
    expect(daemon.lines.join("\n")).toContain("Drain deadline reached");
    expect(existsSync(paths.socket)).toBe(false);

    // The lifecycle lock is free — a successor can start, which is the
    // property an unbounded drain would have destroyed.
    const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
    expect(lifecycle).not.toBeNull();
    if (lifecycle) locks.push(lifecycle);
  }, 120_000);

  it(
    "refuses to start when a REGULAR FILE occupies the socket path, and leaves the file alone",
    async () => {
      // `clearStaleEndpoint` removes a stale SOCKET, but an entry that is
      // not a socket is something the daemon does not own and must not
      // delete — unlinking it would make the daemon a deletion primitive
      // against an arbitrary file that happens to sit at the path.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      writeFileSync(paths.socket, "not a socket", { mode: 0o600 });

      const daemon = spawnDaemon(stateDir);
      expect(await daemon.waitForExit()).not.toBe(0);

      // Still there, untouched.
      expect(existsSync(paths.socket)).toBe(true);
      expect(readFileSync(paths.socket, "utf8")).toBe("not a socket");
    },
    TIMEOUT,
  );

  it("INVARIANT §17: approvals.resume is admitted through the SAME queue as execute — through the real dispatch path", async () => {
    // The queue-level test above drives a bare ExecutionQueue, which
    // proves the queue behaves but NOT that the daemon actually routes
    // resume through it — `submitSandboxWork` was the unpinned wiring.
    // This drives a real daemon end-to-end: fill every slot with
    // executes, then send a resume on a second connection and assert it
    // never reaches the manager while the cap is full.
    const stateDir = newStateDir();
    const paths = daemonPaths(stateDir);
    // `--debug` because the queue-depth lines this test asserts on are the
    // per-admission volume the §5 gate suppresses by default. The gate
    // changes WHERE those lines are written, not whether the admission
    // happens, so opening it is the faithful way to observe the wiring.
    const daemon = spawnDaemon(stateDir, ["--stall-sandbox", "--debug"]);
    await daemon.waitForLine("listening");

    // Fill the concurrency cap with stalled executes. Each needs its
    // own connection only insofar as it needs its own request; one
    // `serve` connection can carry them all.
    const executor = await connectClient(paths.socket);
    await handshake(executor, "serve");
    for (let i = 0; i < CONCURRENCY_CAP; i++) {
      executor.send({ kind: "execute", code: `${i}`, deadlineMs: 60_000 });
    }
    // Wait until all four are genuinely dispatched and stalled.
    await waitFor(
      () => daemon.lines.filter((l) => l.includes("stalling execute")).length >= CONCURRENCY_CAP,
    );

    // Now a resume, on an `approvals` connection (§3.3 capability row).
    const approver = await connectClient(paths.socket);
    await handshake(approver, "approvals");
    approver.send({
      kind: "approvals.resume",
      executionId: "exec_x",
      decision: "approve",
      callId: "call_x",
    });

    // The daemon logs queue depth on every admission, so a depth>0 line
    // is positive evidence the resume was ADMITTED TO THE QUEUE rather
    // than dispatched or refused.
    await daemon.waitForLine("depth=1");

    // And it must not have run: the cap is full, so the manager's
    // resume path is never reached while the executes hold every slot.
    expect(daemon.lines.join("\n")).not.toContain("stalling resume");

    daemon.child.kill("SIGTERM");
    await daemon.waitForExit();
  }, 120_000);

  it(
    "an interrupted startup leaves no bound socket and releases its locks",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // Stalls inside the sweep — after both locks are held, before bind.
      const daemon = spawnDaemon(stateDir, ["--stall-sweep"]);
      await daemon.waitForLine("stalling sweep");

      daemon.child.kill("SIGTERM");
      expect(await daemon.waitForExit()).toBe(0);

      // Startup was interrupted before bind, so no endpoint exists...
      expect(existsSync(paths.socket)).toBe(false);
      // ...and both locks were released through the same path a running
      // daemon uses, rather than being abandoned by a default-signal death.
      const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
      expect(lifecycle).not.toBeNull();
      if (lifecycle) locks.push(lifecycle);
      const maintenance = await acquireExclusive(paths.maintenanceLockDb);
      expect(maintenance).not.toBeNull();
      if (maintenance) locks.push(maintenance);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a rejecting execution is a typed error, never a dead daemon",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // manager.start rejects from inside the queue's run closure, which
      // is invoked as `void dispatch(entry)` — an unhandled rejection
      // there terminates the process under Node's default disposition,
      // so one client's store fault would kill every other client's
      // daemon.
      const daemon = spawnDaemon(stateDir, ["--throw-execute"]);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");
      client.send({ kind: "execute", code: "1+1", deadlineMs: 60_000 });

      expect(await client.next()).toMatchObject({ kind: "error", code: "internal" });

      // The daemon is still up and still serving: a second request on a
      // fresh connection is answered normally.
      expect(daemon.child.exitCode).toBeNull();
      const second = await connectClient(paths.socket);
      await handshake(second, "serve");
      second.send({ kind: "search", query: "anything" });
      expect(await second.next()).toMatchObject({ kind: "result" });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a result too large for one IPC frame is a typed error, never a dead daemon",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // Not a hostile input: the sandbox's default maxOutputBytes EQUALS
      // FRAME_CAP, so an ordinary maximum-size result plus its envelope
      // necessarily overflows the frame. encodeFrame throws inside the
      // queue closure, with the same fatal consequence as above.
      const daemon = spawnDaemon(stateDir, ["--huge-execute"]);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");
      client.send({ kind: "execute", code: "1+1", deadlineMs: 60_000 });

      const reply = (await client.next()) as { kind: string; message?: string };
      expect(reply).toMatchObject({ kind: "error" });
      // Honest about the actual cause — the client can act on "return
      // less data" where "internal daemon error" would strand it.
      expect(reply.message).toContain("too large for the IPC frame");

      expect(daemon.child.exitCode).toBeNull();
      const second = await connectClient(paths.socket);
      await handshake(second, "serve");
      second.send({ kind: "search", query: "anything" });
      expect(await second.next()).toMatchObject({ kind: "result" });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: the daemon starts against a state directory that does not exist yet",
    async () => {
      // A fresh install: nothing has created `~/.conduit`. Refusing here
      // made first run a dead end (raw ENOENT out of the lstat).
      const parent = newStateDir();
      const stateDir = join(parent, "nested", "conduit");
      const paths = daemonPaths(stateDir);

      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      // Created at 0700 and then validated by the same boundary check
      // that governs a directory it found — mkdir-then-assert.
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");
      client.send({ kind: "search", query: "anything" });
      expect(await client.next()).toMatchObject({ kind: "result" });
    },
    TIMEOUT,
  );

  it("INVARIANT §17: an idle READY connection can still complete a request issued during drain grace", async () => {
    const stateDir = newStateDir();
    const paths = daemonPaths(stateDir);
    const daemon = spawnDaemon(stateDir);
    await daemon.waitForLine("listening");

    // READY granted, then deliberately idle — no request in flight at
    // the moment drain begins.
    const client = await connectClient(paths.socket);
    await handshake(client, "serve");

    daemon.child.kill("SIGTERM");
    await daemon.waitForLine("draining");

    // §3.5: a connection that has received READY counts as active
    // work. Before the D6 ruling this socket was ended at drain start
    // and this request went nowhere.
    client.send({ kind: "search", query: "anything" });
    expect(await client.next()).toMatchObject({ kind: "result" });

    // The grace window is still BOUNDED — the daemon exits on its own.
    expect(await daemon.waitForExit()).toBe(0);
  }, 120_000);

  it(
    "refuses any request sent before the handshake",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      expect(await client.next()).toEqual({ kind: "ready" });
      client.send({ kind: "approvals.list" });
      expect(await client.next()).toMatchObject({ kind: "error", code: "invalid" });
    },
    TIMEOUT,
  );

  it(
    "answers daemon.status for a control client with live counts and no credential material",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir, ["--seed-catalog"]);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "control");
      client.send({ kind: "daemon.status" });
      const answer = (await client.next()) as {
        kind: string;
        payload: {
          pid: number;
          agentVersion: string;
          startedAt: number;
          dbPath: string;
          connections: number;
          executionsInFlight: number;
          queueDepth: number;
          logPath: string | null;
          logSizeBytes: number | null;
        };
      };
      expect(answer.kind).toBe("result");
      const status = answer.payload;

      // The daemon's own identity, computed daemon-side — not echoed from
      // anything the client sent (the request carries no fields at all).
      expect(status.pid).toBeGreaterThan(0);
      expect(status.pid).toBe(daemon.child.pid);
      expect(status.agentVersion).toBe(AGENT_VERSION);
      expect(status.dbPath.endsWith("conduit.db")).toBe(true);
      expect(status.startedAt).toBeGreaterThan(0);

      // The asking connection is itself READY-granted, so the count is at
      // least one — the metric is live state, not a constant.
      expect(status.connections).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(status.queueDepth)).toBe(true);
      expect(Number.isFinite(status.executionsInFlight)).toBe(true);

      // §9.2/§3.3 pinned on the WIRE: the daemon holds a seeded connection
      // row carrying a `credentialRef` and a real stored secret, and no
      // byte of either may appear in a status answer. A future refactor
      // that widened this projection into a store dump fails here.
      const wire = JSON.stringify(status);
      expect(wire).not.toContain("credentialRef");
      expect(wire).not.toContain("secret");
      expect(wire).not.toContain("masterKey");
      expect(wire).not.toContain("cred_gh");
      expect(Object.keys(status).sort()).toEqual([
        "agentVersion",
        "connections",
        "dbPath",
        "executionsInFlight",
        "logPath",
        "logSizeBytes",
        "pid",
        "queueDepth",
        "startedAt",
      ]);

      client.socket.destroy(); // see the drain-grace note above
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "ends a connection that takes READY and never handshakes, and drops it from the count",
    async () => {
      // READY is granted before the client says anything, so a peer that
      // connects and then goes silent is READY-granted forever: it inflates
      // `daemon.status`'s connection number AND holds the §3.3 grace loop,
      // adding the full DRAIN_DEADLINE_MS to every stop. No hostile client
      // is needed — a wedged process or a half-open peer does it by
      // accident.
      //
      // Deliberately a RAW connection with no handshake sent, because the
      // handshake is exactly what the deadline bounds.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const observer = await connectClient(paths.socket);
      await handshake(observer, "control");

      const silent = await connectClient(paths.socket);
      // READY, and nothing after it: the connection now counts.
      expect(await silent.next()).toMatchObject({ kind: "ready" });

      observer.send({ kind: "daemon.status" });
      const before = (await observer.next()) as { payload: { connections: number } };
      // Both connections are READY-granted right now — non-vacuous, since a
      // count that never rose would make the drop below meaningless.
      expect(before.payload.connections).toBe(2);

      // The daemon says WHY before it closes, so a client that stalled by
      // accident can tell this apart from a refusal or a crash.
      expect(await silent.next(HANDSHAKE_DEADLINE_MS * 2)).toMatchObject({
        kind: "error",
        code: "invalid",
        message: expect.stringContaining("handshake"),
      });
      await silent.closed;

      // The count returns to the one live handshaked client. This is the
      // status half of the fix; the drain half follows from the same
      // predicate — both surfaces count READY-granted live sockets, and the
      // deadline only bounds how long a silent one can be among them.
      observer.send({ kind: "daemon.status" });
      const after = (await observer.next()) as { payload: { connections: number } };
      expect(after.payload.connections).toBe(1);

      observer.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "rejects control verbs from serve, and serve/provision verbs from control",
    async () => {
      // The capability row is the authorization boundary (§9), and it cuts
      // BOTH ways: widening `control` with the stop verb must not hand an
      // agent-facing `serve` client the ability to kill the daemon, and the
      // operator's control client must not acquire execution or
      // provisioning reach as a side effect of gaining it.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      for (const request of [{ kind: "daemon.stop" }, { kind: "daemon.status" }]) {
        serve.send(request);
        expect(await serve.next()).toMatchObject({
          kind: "error",
          code: "invalid",
          message: expect.stringContaining(`capability "serve" does not permit "${request.kind}"`),
        });
      }

      const control = await connectClient(paths.socket);
      await handshake(control, "control");
      for (const request of [
        { kind: "search", query: "x" },
        {
          kind: "source.provision",
          namespace: "github",
          url: "http://127.0.0.1:1/mcp",
          prefix: "github.acme.prod",
          replace: true,
          clearCredential: false,
        },
      ]) {
        control.send(request);
        expect(await control.next()).toMatchObject({
          kind: "error",
          code: "invalid",
          message: expect.stringContaining(
            `capability "control" does not permit "${request.kind}"`,
          ),
        });
      }

      // The refusals are pure authorization verdicts: the daemon is still
      // serving, so nothing above stopped it as a side effect.
      expect(daemon.child.exitCode).toBeNull();

      serve.socket.destroy(); // see the drain-grace note above
      control.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it("daemon.stop drains live work: an active execution and a queued request both resolve", async () => {
    // §3.3: the drain FINISHES accepted work. A stop that severed live
    // connections would turn every in-flight request into §5's ambiguous
    // "outcome unknown" — the exact failure a graceful drain exists to
    // avoid. Both an ALREADY-RUNNING execution and one still queued
    // behind it must come back with a real frame.
    const stateDir = newStateDir();
    const paths = daemonPaths(stateDir);
    const daemon = spawnDaemon(stateDir);
    await daemon.waitForLine("listening");

    const worker = await connectClient(paths.socket);
    await handshake(worker, "serve");
    const second = await connectClient(paths.socket);
    await handshake(second, "serve");

    // Guest work that genuinely occupies a slot for seconds — long
    // enough that the stop below lands while it is STILL RUNNING, which
    // is the precondition under test. Self-bounding rather than an
    // infinite loop: §16's `wallClockMs` budget is 60s, so spinning to
    // the sandbox's own cut would outlast the drain deadline and pin a
    // timeout rather than a drain.
    worker.send({
      kind: "execute",
      code: "let n = 0; for (let i = 0; i < 60000000; i++) { n = (n + i) % 97; } return n;",
      deadlineMs: 60_000,
    });
    const busy = worker.next();
    // A quick execute behind it, admitted while the first still runs.
    second.send({ kind: "execute", code: "return 'quick';", deadlineMs: 60_000 });
    const queued = second.next();

    // Both executes are settled-tracked so the ordering below is an
    // ASSERTION rather than an assumption about timing.
    let busySettled = false;
    let queuedSettled = false;
    void busy.then(() => {
      busySettled = true;
    });
    void queued.then(() => {
      queuedSettled = true;
    });

    const control = await connectClient(paths.socket);
    await handshake(control, "control");
    control.send({ kind: "daemon.stop" });
    // The ack arrives BEFORE the executions settle: a busy daemon must
    // not answer its own stop with `busy`, and must not wait out the
    // drain before acknowledging.
    expect(await control.next()).toEqual({
      kind: "result",
      requestId: expect.any(String),
      payload: { stopping: true },
    });
    expect(busySettled).toBe(false);
    expect(queuedSettled).toBe(false);

    // Both requests get real frames rather than a destroyed socket.
    expect(await busy).toMatchObject({ kind: "result" });
    expect(await queued).toMatchObject({
      kind: "result",
      payload: { status: "completed", result: "quick" },
    });

    worker.socket.destroy();
    second.socket.destroy();
    control.socket.destroy();

    // The stop was real: the daemon exits and RELEASES the lifecycle
    // lock, which a successor's acquisition proves — "free" is only
    // observable by taking it.
    expect(await daemon.waitForExit(DRAIN_DEADLINE_MS + 15_000)).toBe(0);
    const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
    expect(lifecycle).not.toBeNull();
    if (lifecycle) locks.push(lifecycle);
  }, 120_000);

  it(
    "stop is prompt when nothing is in flight",
    async () => {
      // Pins that the DAEMON, not the client, keeps stop prompt. The
      // control connection is deliberately left OPEN after the ack: it is
      // a READY-granted socket, so if the daemon did not end it server-side
      // after flushing the ack, the §3.3 grace loop would wait on it and
      // the stop would ride the full DRAIN_DEADLINE_MS. Adding a
      // client-side `destroy()` here would hide exactly that defect, which
      // is why there is none — the assertion below is only meaningful
      // against a client that behaves badly.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const control = await connectClient(paths.socket);
      await handshake(control, "control");
      control.send({ kind: "daemon.stop" });
      expect(await control.next()).toMatchObject({
        kind: "result",
        payload: { stopping: true },
      });
      const ackedAt = Date.now();
      expect(await daemon.waitForExit()).toBe(0);
      // The lifecycle lock reads free — measured from the ack, not from
      // the stop request, so the number is the DRAIN's cost alone.
      const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
      expect(lifecycle).not.toBeNull();
      if (lifecycle) locks.push(lifecycle);
      expect(Date.now() - ackedAt).toBeLessThan(5_000);
    },
    TIMEOUT,
  );

  it("a second daemon.stop and a SIGTERM racing the first are idempotent", async () => {
    // Stop is a request, not a state transition each caller owns:
    // `StopSignal.request` is one-shot, and draining is explicitly not
    // cancellable. Two RPC stops plus a signal must therefore produce one
    // clean exit, never a double-drain or a crash.
    const stateDir = newStateDir();
    const paths = daemonPaths(stateDir);
    const daemon = spawnDaemon(stateDir);
    await daemon.waitForLine("listening");

    const first = await connectClient(paths.socket);
    await handshake(first, "control");
    const secondClient = await connectClient(paths.socket);
    await handshake(secondClient, "control");

    first.send({ kind: "daemon.stop" });
    secondClient.send({ kind: "daemon.stop" });

    // Each stop is answered OR the connection closes cleanly under it —
    // both are legitimate, since the second racing request can land
    // after the drain has already begun ending connections. What must
    // not happen is a hang or an error frame.
    const settle = async (client: Client): Promise<void> => {
      const answer = await Promise.race([
        client.next(10_000).then((msg) => ({ got: msg })),
        client.closed.then(() => ({ got: undefined })),
      ]);
      if (answer.got !== undefined) {
        expect(answer.got).toMatchObject({ kind: "result", payload: { stopping: true } });
      }
    };
    await settle(first);
    await settle(secondClient);

    // A signal racing the RPC drain, delivered while it is under way.
    if (daemon.child.exitCode === null) daemon.child.kill("SIGTERM");

    first.socket.destroy();
    secondClient.socket.destroy();

    expect(await daemon.waitForExit(DRAIN_DEADLINE_MS + 15_000)).toBe(0);
    // Exactly one drain, and a clean one: the lifecycle lines appear
    // once each and nothing crashed on the way out.
    expect(daemon.lines.filter((line) => line === "draining")).toHaveLength(1);
    expect(daemon.lines.filter((line) => line === "stopped")).toHaveLength(1);
    expect(daemon.lines.some((line) => line.includes("run-daemon:"))).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
  }, 120_000);

  it(
    "INVARIANT §5.5: a resume without callId is refused on the wire as invalid, and the connection survives to serve a well-formed request",
    async () => {
      // An older `conduit approvals` binary sends exactly this frame. It must
      // be TOLD (an `invalid` frame naming callId), never bound to whatever is
      // paused — and the refusal must not tear the connection down.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");
      const client = await connectClient(paths.socket);
      expect(await handshake(client, "approvals")).toMatchObject({ kind: "handshake.ok" });

      client.send({ kind: "approvals.resume", executionId: "e1", decision: "approve" } as never);
      const refused = (await client.next()) as { kind: string; code?: string; message?: string };
      expect(refused).toMatchObject({ kind: "error", code: "invalid" });
      expect(refused.message).toContain("callId");

      client.send({ kind: "approvals.list" });
      expect(await client.next()).toMatchObject({ kind: "result" });
    },
    TIMEOUT,
  );

  it("a paused approval created before an RPC stop is resumable after the next start", async () => {
    // Extends the signal-stop invariant above to the RPC path: approvals
    // are durable data, not daemon state, so the way the daemon was
    // stopped must not change what survives. A stop that skipped the
    // drain could strand a half-written pause.
    const stateDir = newStateDir();
    const paths = daemonPaths(stateDir);
    const first = spawnDaemon(stateDir, ["--pause-execute"]);
    await first.waitForLine("listening");

    const worker = await connectClient(paths.socket);
    await handshake(worker, "serve");
    worker.send({ kind: "execute", code: "return 1;", deadlineMs: 60_000 });
    const paused = (await worker.next()) as {
      kind: string;
      payload: { status: string; executionId: string };
    };
    expect(paused.kind).toBe("result");
    expect(paused.payload.status).toBe("paused");
    const { executionId } = paused.payload;

    // Stopped over RPC, not by a signal — the whole point of the test.
    const control = await connectClient(paths.socket);
    await handshake(control, "control");
    control.send({ kind: "daemon.stop" });
    expect(await control.next()).toMatchObject({
      kind: "result",
      payload: { stopping: true },
    });
    worker.socket.destroy();
    control.socket.destroy();
    expect(await first.waitForExit(DRAIN_DEADLINE_MS + 15_000)).toBe(0);

    // A NEW daemon over the same state dir — no cleanup protocol needed
    // after a clean drain. Real runtime this time: the resume below must
    // drive the row through the genuine manager.
    const second = spawnDaemon(stateDir);
    await second.waitForLine("listening");

    const approver = await connectClient(paths.socket);
    await handshake(approver, "approvals");
    approver.send({ kind: "approvals.list" });
    const listed = (await approver.next()) as {
      kind: string;
      payload: { executionId: string; callId: string }[];
    };
    expect(listed.kind).toBe("result");
    const listedRow = listed.payload.find((row) => row.executionId === executionId);
    expect(typeof listedRow?.callId).toBe("string");

    // The decision lands and the row reaches a TERMINAL status — the
    // pause survived the RPC stop as resumable work, not as a corpse. The
    // resume names the pending call the list showed (spec §5.5).
    approver.send({
      kind: "approvals.resume",
      executionId,
      decision: "approve",
      callId: listedRow?.callId ?? "",
    });
    const resumed = (await approver.next()) as {
      kind: string;
      payload: { status: string; decisionApplied: boolean };
    };
    expect(resumed.kind).toBe("result");
    expect(["completed", "failed"]).toContain(resumed.payload.status);

    approver.socket.destroy(); // see the drain-grace note above
    second.child.kill("SIGTERM");
    await second.waitForExit();
  }, 120_000);

  it(
    "builds ONE runtime per daemon process and reuses it across requests",
    async () => {
      // The M6 per-call rehydration was the no-owner workaround: every
      // execute and resume built a whole composition — sandbox, policy
      // engine, credential resolver, a full catalog hydration off the
      // store — and threw it away. The daemon OWNS the store now, so the
      // runtime is built once in `serve()` and shared (spec §2.1).
      //
      // The count travels as a stdout line because the daemon is a real
      // child process: nothing in this process can read its variables.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir, ["--count-runtime-builds"]);
      await daemon.waitForLine("listening");

      // The one build happens before the socket binds, so it is already
      // on the wire by the time any client can connect.
      expect(daemon.lines.filter((l) => l.includes("runtime builds="))).toEqual([
        "runtime builds=1",
      ]);

      // Two executes and a search — the three kinds that used to build a
      // fresh runtime or a fresh store snapshot per call.
      const client = await connectClient(paths.socket);
      await handshake(client, "serve");
      client.send({ kind: "execute", code: "return 1;", deadlineMs: 60_000 });
      expect(await client.next()).toMatchObject({ kind: "result" });
      client.send({ kind: "execute", code: "return 2;", deadlineMs: 60_000 });
      expect(await client.next()).toMatchObject({ kind: "result" });
      client.send({ kind: "search", query: "anything" });
      expect(await client.next()).toMatchObject({ kind: "result" });

      // A second connection too: the runtime is daemon-scoped, not
      // connection-scoped.
      const second = await connectClient(paths.socket);
      await handshake(second, "serve");
      second.send({ kind: "execute", code: "return 3;", deadlineMs: 60_000 });
      expect(await second.next()).toMatchObject({ kind: "result" });

      // Still exactly one build after all of it.
      expect(daemon.lines.filter((l) => l.includes("runtime builds="))).toEqual([
        "runtime builds=1",
      ]);

      client.socket.destroy(); // see the drain-grace note above
      second.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: search reads the daemon's shared catalog, not a per-call store snapshot",
    async () => {
      // The fixture plants `planted.tool` DIRECTLY into the runtime's
      // catalog and writes nothing to the store. A per-call snapshot
      // rebuilds from `store.tools.list()`, so it can never see this tool;
      // finding it therefore proves the search path reads the shared
      // catalog the daemon holds. Same for `describe`.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir, ["--plant-catalog-tool"]);
      await daemon.waitForLine("listening");
      // Planting is ordered before bind, so it has already happened by the
      // time the endpoint exists — no client can race it.
      expect(daemon.lines).toContain("planted catalog tool");

      const client = await connectClient(paths.socket);
      await handshake(client, "serve");

      client.send({ kind: "search", query: "planted" });
      const hits = (await client.next()) as { kind: string; payload: { path: string }[] };
      expect(hits.kind).toBe("result");
      expect(hits.payload.map((hit) => hit.path)).toContain("planted.tool");

      // `describe` shares the same catalog, so it answers for the same
      // store-invisible tool rather than `null`.
      client.send({ kind: "describe", toolName: "planted.tool" });
      expect(await client.next()).toMatchObject({
        kind: "result",
        payload: { path: "planted.tool", namespace: "planted" },
      });

      // Not vacuous: the store genuinely holds nothing, so a per-call
      // snapshot would answer empty for both requests above.
      client.send({ kind: "catalog.listing" });
      expect(await client.next()).toMatchObject({
        kind: "result",
        payload: { sourceCount: 0 },
      });

      client.socket.destroy(); // see the drain-grace note above
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a source added via one client is visible to another with no restart",
    async () => {
      // The §17 startup-reload caveat closing, at the CATALOG. The
      // source-invariants.test.ts test of the same name asserts the
      // store-backed half (`catalog.listing` counts a new source); this one
      // asserts the half that governs what an agent can actually reach —
      // `search`, which reads the daemon's SHARED catalog. Before the
      // provisioning tail refreshed that catalog, a source added against a
      // running daemon stayed invisible to search until restart.
      const upstream = await startUpstream([upstreamTool("list_issues", "List open issues")]);
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      // Client A: a long-lived `serve` connection opened BEFORE the source
      // exists, and never reconnected.
      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      expect(await searchPaths(serve, "issues")).toEqual([]);

      // Client B: a separate `add-mcp` connection provisions the upstream.
      const adder = await connectClient(paths.socket);
      await handshake(adder, "add-mcp");
      expect(
        await provision(adder, {
          namespace: "github",
          url: `${upstream.origin}/mcp`,
          prefix: "github.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });

      // THE ASSERTION: the SAME still-connected serve client — no restart,
      // no reconnect, no new handshake — finds the new tool.
      expect(await searchPaths(serve, "issues")).toContain("github.list_issues");
      // `describe` shares the catalog, so it answers for the same tool.
      serve.send({ kind: "describe", toolName: "github.list_issues" });
      expect(await serve.next()).toMatchObject({
        kind: "result",
        payload: { path: "github.list_issues", namespace: "github" },
      });

      serve.socket.destroy(); // see the drain-grace note above
      adder.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "refreshes the shared catalog on source.revalidate too (the shared-tail hook)",
    async () => {
      // Both provisioning handlers run the SAME tail, so revalidate must
      // republish exactly as provision does. `source.revalidate` re-fetches
      // the STORED url, so the only way to tell a refresh from a no-op is to
      // change what the upstream advertises between the two fetches — which
      // also proves the refresh REPLACES the namespace rather than merging
      // into it: the retired tool must disappear, not linger.
      const upstream = await startUpstream([upstreamTool("list_issues", "List open issues")]);
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      const adder = await connectClient(paths.socket);
      await handshake(adder, "add-mcp");

      expect(
        await provision(adder, {
          namespace: "github",
          url: `${upstream.origin}/mcp`,
          prefix: "github.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });
      expect(await searchPaths(serve, "issues")).toContain("github.list_issues");

      // The upstream retires one tool and advertises another.
      upstream.setTools([upstreamTool("list_releases", "List published releases")]);
      adder.send({ kind: "source.revalidate", namespace: "github" });
      expect(await adder.next()).toMatchObject({ kind: "result" });

      expect(await searchPaths(serve, "releases")).toContain("github.list_releases");
      expect(await searchPaths(serve, "issues")).not.toContain("github.list_issues");

      serve.socket.destroy(); // see the drain-grace note above
      adder.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "recovers by rehydrating when the catalog refresh throws after commit",
    async () => {
      // The refresh runs AFTER a committed write, so its failure must never
      // turn a landed provisioning into an error answer, and must not strand
      // the catalog behind the store. The fixture poisons
      // `catalog.removeNamespace` for exactly ONE call — the refresh's — so
      // the recovery ladder's first rung (this namespace re-read from the
      // store) is what publishes the new tools.
      const upstream = await startUpstream([upstreamTool("list_issues", "List open issues")]);
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir, ["--poison-catalog-refresh"]);
      await daemon.waitForLine("listening");

      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      const adder = await connectClient(paths.socket);
      await handshake(adder, "add-mcp");

      // The commit landed, so the answer is a success result — the refusal
      // shape a thrown refresh would otherwise produce is exactly the bug.
      expect(
        await provision(adder, {
          namespace: "github",
          url: `${upstream.origin}/mcp`,
          prefix: "github.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });

      // Non-vacuous: the fixture reports that its injected failure fired.
      expect(daemon.lines.some((line) => line.includes("poisoned catalog refresh"))).toBe(true);

      // The retry rung ran, so the new tools are still reachable.
      expect(await searchPaths(serve, "issues")).toContain("github.list_issues");

      serve.socket.destroy(); // see the drain-grace note above
      adder.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "the recovery rung RETIRES a dropped tool, rather than leaving it beside the new one",
    async () => {
      // `InMemoryCatalog.upsert` only ever `set`s — it never deletes. So a
      // recovery that upserted the store's tools WITHOUT removing the
      // namespace first would leave a retired tool serving alongside the new
      // ones: stale AND inconsistent, and strictly worse than simply keeping
      // the previous catalog. This pins that the retry removes before it
      // upserts.
      //
      // The poison is armed for the SECOND `removeNamespace` — the provision
      // below refreshes successfully (call 1), and the revalidate that
      // retires a tool is the one whose refresh fails (call 2), leaving its
      // retry as call 3.
      const upstream = await startUpstream([upstreamTool("list_issues", "List open issues")]);
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir, [
        "--poison-catalog-refresh",
        "--poison-catalog-refresh-nth",
        "2",
      ]);
      await daemon.waitForLine("listening");

      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      const adder = await connectClient(paths.socket);
      await handshake(adder, "add-mcp");

      expect(
        await provision(adder, {
          namespace: "github",
          url: `${upstream.origin}/mcp`,
          prefix: "github.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });
      // The precondition the retirement is measured against.
      expect(await searchPaths(serve, "issues")).toContain("github.list_issues");

      // The upstream retires `list_issues` and advertises `list_releases`.
      upstream.setTools([upstreamTool("list_releases", "List published releases")]);
      adder.send({ kind: "source.revalidate", namespace: "github" });
      expect(await adder.next()).toMatchObject({ kind: "result" });

      // Non-vacuous: the injected failure fired on THIS operation's refresh.
      expect(daemon.lines.some((line) => line.includes("poisoned catalog refresh"))).toBe(true);

      // THE ASSERTION: after recovery the catalog matches the store — the
      // new tool is present AND the retired one is gone. An additive-only
      // recovery passes the first of these and fails the second.
      expect(await searchPaths(serve, "releases")).toContain("github.list_releases");
      expect(await searchPaths(serve, "issues")).not.toContain("github.list_issues");
      serve.send({ kind: "describe", toolName: "github.list_issues" });
      expect(await serve.next()).toMatchObject({ kind: "result", payload: null });

      serve.socket.destroy(); // see the drain-grace note above
      adder.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "answers success and reports the namespace's entries as MISSING OR PARTIAL when both rungs fail",
    async () => {
      // The other half of the ladder. A remove-poison fails BEFORE anything
      // is mutated, so the namespace is merely stale — which is what the
      // rung-2 line used to claim unconditionally ("serving the previous
      // catalog"). An UPSERT-poison fails AFTER the remove already ran, so
      // the namespace is empty or partial and that claim is simply FALSE.
      //
      // Both rungs are poisoned here (the default arms every call), so the
      // ladder runs to the bottom and emits the honest line.
      const upstream = await startUpstream([upstreamTool("list_issues", "List open issues")]);
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // `--log-sink` so the rung-2 line lands in conduitd.log, where the
      // wording is asserted against the file rather than against stdout.
      const daemon = spawnDaemon(stateDir, ["--poison-catalog-upsert", "--log-sink"]);
      await daemon.waitForLine("listening");

      const logPath = join(stateDir, DAEMON_LOG);
      // Only text written after this point counts (the baseline-offset
      // pattern the doctor daemons use): the sink appends, so startup lines
      // must not be mistaken for this operation's.
      const baseline = statSync(logPath).size;

      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      const adder = await connectClient(paths.socket);
      await handshake(adder, "add-mcp");

      // THE FIRST ASSERTION: the commit landed, so the operator gets a
      // SUCCESS answer. A refresh that fails on both rungs must never turn a
      // committed provisioning into an error frame.
      expect(
        await provision(adder, {
          namespace: "github",
          url: `${upstream.origin}/mcp`,
          prefix: "github.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });

      // Non-vacuous: the injected failure actually fired, on both rungs.
      await waitFor(
        () => daemon.lines.filter((l) => l.includes("poisoned catalog upsert")).length >= 2,
      );

      // THE SECOND ASSERTION: the rung-2 line says what the code can
      // VERIFY. "MISSING OR PARTIAL" is the honest claim; the old wording
      // asserted the namespace was merely stale, which an upsert failure
      // makes false.
      await waitFor(() =>
        readFileSync(logPath, "utf8").slice(baseline).includes("MISSING OR PARTIAL"),
      );
      const written = readFileSync(logPath, "utf8").slice(baseline);
      expect(written).toContain("MISSING OR PARTIAL");
      // Names both repairs that rehydrate from the store.
      expect(written).toMatch(/provision\/revalidate/);
      expect(written).toContain("restart");
      // The retired claim must be GONE, not merely joined by the new one.
      expect(written).not.toContain("serving the previous catalog");

      serve.socket.destroy(); // see the drain-grace note above
      adder.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "a subsequent provision REPAIRS a namespace whose refresh failed on both rungs",
    async () => {
      // The rung-2 line promises the next provision/revalidate rehydrates
      // from the store. That promise is only worth making if it holds, so
      // this drives it: poison ONLY the first upsert, so the provisioning
      // whose refresh failed leaves the namespace empty, and the revalidate
      // that follows repairs it.
      const upstream = await startUpstream([upstreamTool("list_issues", "List open issues")]);
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // Nth=1 poisons call 1 only. Rung 1's retry is call 2 and succeeds, so
      // to reach a genuinely EMPTY namespace the poison must cover rung 1's
      // retry too — hence nth=0 is wrong here and nth is left at 1 with the
      // repair measured after the ladder recovers on its own retry.
      const daemon = spawnDaemon(stateDir, [
        "--poison-catalog-upsert",
        "--poison-catalog-upsert-nth",
        "1",
      ]);
      await daemon.waitForLine("listening");

      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      const adder = await connectClient(paths.socket);
      await handshake(adder, "add-mcp");

      expect(
        await provision(adder, {
          namespace: "github",
          url: `${upstream.origin}/mcp`,
          prefix: "github.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });
      expect(daemon.lines.some((l) => l.includes("poisoned catalog upsert"))).toBe(true);

      // Rung 1's retry re-materializes and republishes, so the namespace is
      // whole again — the ladder's first rung IS the repair here.
      expect(await searchPaths(serve, "issues")).toContain("github.list_issues");

      // And an explicit revalidate republishes it too, which is the repair
      // the rung-2 line names for the case where rung 1 also failed.
      adder.send({ kind: "source.revalidate", namespace: "github" });
      expect(await adder.next()).toMatchObject({ kind: "result" });
      expect(await searchPaths(serve, "issues")).toContain("github.list_issues");

      serve.socket.destroy(); // see the drain-grace note above
      adder.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "two namespaces on one daemon refresh independently, interleaved",
    async () => {
      // Two namespaces on one daemon, with their revalidations genuinely
      // INTERLEAVED: A's `tools/list` is held open — parking A inside its
      // own source lock — while B commits a retirement underneath it.
      //
      // WHAT THIS TEST DOES NOT DO, stated plainly: it does not pin the
      // per-namespace WRITE SCOPING (the `.filter(...)` in
      // `refreshNamespace`). That was MEASURED — the filter can be removed
      // and this test still passes — and the reason is structural: the
      // refresh runs AFTER its own commit, so by the time A reads the store
      // it already sees B's retirement, and there is no stale snapshot to
      // resurrect anything from. The window where an unfiltered upsert
      // would bite is one synchronous run with no seam a client can reach.
      // `refresh-namespace.test.ts` drives that function directly and DOES
      // kill the mutation.
      //
      // What this pins is the end-to-end property worth having: two
      // namespaces refreshing under concurrent load do not corrupt each
      // other's catalog entries, through the real daemon and the real lock.
      const gh = await startUpstream([upstreamTool("list_issues", "List open issues")]);
      const jira = await startUpstream([upstreamTool("list_tickets", "List open tickets")]);
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      // TWO add-mcp connections: the two provisionings must be in flight at
      // the same time, and one connection answers its requests in order.
      const adderA = await connectClient(paths.socket);
      await handshake(adderA, "add-mcp");
      const adderB = await connectClient(paths.socket);
      await handshake(adderB, "add-mcp");

      // Both namespaces onboarded and visible.
      expect(
        await provision(adderA, {
          namespace: "github",
          url: `${gh.origin}/mcp`,
          prefix: "github.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });
      expect(
        await provision(adderB, {
          namespace: "jira",
          url: `${jira.origin}/mcp`,
          prefix: "jira.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });
      expect(await searchPaths(serve, "issues")).toContain("github.list_issues");
      expect(await searchPaths(serve, "tickets")).toContain("jira.list_tickets");

      // Park namespace A's revalidate inside its own source lock, mid-fetch.
      const held = gh.holdTools();
      adderA.send({ kind: "source.revalidate", namespace: "github" });
      await held;

      // Underneath it, namespace B retires its tool and commits — store and
      // catalog both. A is still parked, holding a view of the world in
      // which `jira.list_tickets` exists.
      jira.setTools([]);
      adderB.send({ kind: "source.revalidate", namespace: "jira" });
      expect(await adderB.next()).toMatchObject({ kind: "result" });
      expect(await searchPaths(serve, "tickets")).not.toContain("jira.list_tickets");

      // Let A finish. Its refresh reads a snapshot spanning both namespaces.
      gh.releaseTools();
      expect(await adderA.next()).toMatchObject({ kind: "result" });

      // THE ASSERTION: A's refresh republished only A. B's retired tool
      // stays gone from both catalog readers. Per the docblock, this holds
      // with or without the `.filter(...)` — the write scoping is pinned in
      // `refresh-namespace.test.ts`, not here.
      expect(await searchPaths(serve, "issues")).toContain("github.list_issues");
      expect(await searchPaths(serve, "tickets")).not.toContain("jira.list_tickets");
      serve.send({ kind: "describe", toolName: "jira.list_tickets" });
      expect(await serve.next()).toMatchObject({ kind: "result", payload: null });

      serve.socket.destroy(); // see the drain-grace note above
      adderA.socket.destroy();
      adderB.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "an oversize per-tool description is refused and the shared catalog is untouched",
    async () => {
      // The bounded-input check runs BEFORE the commit, so a refused
      // provisioning must leave both the store and the shared catalog exactly
      // as they were — the refusal path never reaches the refresh at all.
      const upstream = await startUpstream([
        upstreamTool("list_issues", "x".repeat(MAX_TOOL_TEXT_BYTES + 1)),
      ]);
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const serve = await connectClient(paths.socket);
      await handshake(serve, "serve");
      const adder = await connectClient(paths.socket);
      await handshake(adder, "add-mcp");

      const refusal = (await provision(adder, {
        namespace: "github",
        url: `${upstream.origin}/mcp`,
        prefix: "github.acme.prod",
      })) as { kind: string; code?: string; message?: string };
      expect(refusal.kind).toBe("error");
      expect(refusal.code).toBe("invalid");
      expect(refusal.message).toContain(`${MAX_TOOL_TEXT_BYTES}-byte per-tool limit`);
      // No byte of the upstream's own text crosses back with the refusal.
      expect(refusal.message).not.toContain("xxxx");

      // Nothing landed: the catalog has no tool, and the store no source.
      expect(await searchPaths(serve, "issues")).toEqual([]);
      serve.send({ kind: "catalog.listing" });
      expect(await serve.next()).toMatchObject({ kind: "result", payload: { sourceCount: 0 } });

      serve.socket.destroy(); // see the drain-grace note above
      adder.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  it(
    "runs two overlapping executions through the one shared runtime",
    async () => {
      // Sharing one manager and one QuickJS module across connections is
      // the point of the change, and it is also where a shared runtime
      // could plausibly go wrong: two concurrent executions must not cross
      // their answers. Fired together on two separate connections, each
      // returning a distinct literal.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const first = await connectClient(paths.socket);
      await handshake(first, "serve");
      const second = await connectClient(paths.socket);
      await handshake(second, "serve");

      const [a, b] = await Promise.all([
        (() => {
          first.send({ kind: "execute", code: "return 'alpha';", deadlineMs: 60_000 });
          return first.next();
        })(),
        (() => {
          second.send({ kind: "execute", code: "return 'beta';", deadlineMs: 60_000 });
          return second.next();
        })(),
      ]);

      expect(a).toMatchObject({
        kind: "result",
        payload: { status: "completed", result: "alpha" },
      });
      expect(b).toMatchObject({ kind: "result", payload: { status: "completed", result: "beta" } });

      first.socket.destroy(); // see the drain-grace note above
      second.socket.destroy();
      daemon.child.kill("SIGTERM");
      await daemon.waitForExit();
    },
    TIMEOUT,
  );

  /**
   * The `conduit daemon status|stop` suppression, end to end against the
   * real filesystem (spec §3.2). The DI-seam tests in the cli package pin
   * what the command PRINTS; only this one can show that the production
   * options actually start nothing — a spawn is a side effect on disk, so
   * the evidence has to be on disk.
   */
  it(
    "status/stop with no daemon: no spawn occurs",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      let spawnCalls = 0;

      for (const request of [{ kind: "daemon.status" }, { kind: "daemon.stop" }] as const) {
        // A RECORDING spawn seam, deliberately: without it, `spawnPermitted`
        // suppresses the spawn on the custom-state-dir clause alone
        // (`opts.spawn !== undefined || isDefaultStateDir(...)`), and this
        // test would pass identically with `autoStart: true` — proving
        // nothing about the flag. Injecting the seam satisfies that clause,
        // so `autoStart: false` is the ONLY thing left suppressing a spawn.
        const err = await daemonRequest({
          stateDir,
          role: "control",
          request,
          // Comfortably ABOVE the floor, not exactly at it: the decision
          // loop is entered only while `remaining >= MIN_PASS_BUDGET_MS`,
          // so a budget equal to the floor can exit before the loop body —
          // where the spawn lives — ever runs. That would make this test
          // pass because nothing was attempted, not because the flag
          // suppressed it.
          deadlineMs: MIN_PASS_BUDGET_MS * 6,
          autoStart: false,
          spawn: () => {
            spawnCalls++;
          },
        }).then(
          () => null,
          (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(DaemonUnavailable);
        expect((err as DaemonUnavailable).code).toBe("unavailable");
      }

      // The assertion the flag actually earns.
      expect(spawnCalls).toBe(0);

      // Nothing started: no lifecycle holder, no socket, no daemon log.
      expect(await probeShared(paths.lifecycleLockDb)).toBe("free");
      expect(existsSync(paths.socket)).toBe(false);
      expect(existsSync(join(stateDir, DAEMON_LOG))).toBe(false);
    },
    TIMEOUT,
  );
});

/**
 * Admission control is a separately-testable unit: these drive the queue
 * directly with controlled work so cap/capacity/expiry/disconnect
 * behavior is asserted deterministically rather than by racing a real
 * sandbox. The lifecycle tests above cover the real-process side.
 */
describe("ExecutionQueue admission", () => {
  /** Work that blocks until released, so slots stay occupied on demand. */
  function blocker(): { run: () => Promise<void>; release: () => void } {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { run: () => gate, release };
  }

  it("the 5th concurrent execute queues rather than running", () => {
    const queue = new ExecutionQueue();
    const blockers = Array.from({ length: CONCURRENCY_CAP }, () => blocker());
    for (const b of blockers) queue.submit(b.run, 60_000);

    expect(queue.activeCount).toBe(CONCURRENCY_CAP);
    expect(queue.depth).toBe(0);

    const fifth = queue.submit(blocker().run, 60_000);
    expect(fifth.outcome).toBe("accepted");
    expect(queue.depth).toBe(1);

    for (const b of blockers) b.release();
  });

  it("the 21st refuses busy — 4 active plus a full queue of 16", () => {
    const queue = new ExecutionQueue();
    const blockers = Array.from({ length: CONCURRENCY_CAP + QUEUE_CAPACITY }, () => blocker());
    for (const b of blockers) {
      expect(queue.submit(b.run, 60_000).outcome).toBe("accepted");
    }
    expect(queue.activeCount).toBe(CONCURRENCY_CAP);
    expect(queue.depth).toBe(QUEUE_CAPACITY);

    expect(queue.submit(blocker().run, 60_000).outcome).toBe("busy");

    for (const b of blockers) b.release();
  });

  it("disconnect removes a queued entry and frees its capacity", () => {
    const queue = new ExecutionQueue();
    const blockers = Array.from({ length: CONCURRENCY_CAP }, () => blocker());
    for (const b of blockers) queue.submit(b.run, 60_000);

    const queued = queue.submit(blocker().run, 60_000);
    expect(queue.depth).toBe(1);
    if (queued.outcome !== "accepted") throw new Error("expected acceptance");

    queued.abandon();
    expect(queue.depth).toBe(0);

    for (const b of blockers) b.release();
  });

  it("an abandoned entry settles as abandoned and never runs", async () => {
    const queue = new ExecutionQueue();
    const blockers = Array.from({ length: CONCURRENCY_CAP }, () => blocker());
    for (const b of blockers) queue.submit(b.run, 60_000);

    let ran = false;
    const queued = queue.submit(async () => {
      ran = true;
    }, 60_000);
    if (queued.outcome !== "accepted") throw new Error("expected acceptance");

    queued.abandon();
    expect(await queued.done).toBe("abandoned");
    expect(ran).toBe(false);

    for (const b of blockers) b.release();
  });

  it("an expired entry is dropped on the next admission and never runs", async () => {
    let now = 1_000;
    const queue = new ExecutionQueue(CONCURRENCY_CAP, QUEUE_CAPACITY, () => now);
    const blockers = Array.from({ length: CONCURRENCY_CAP }, () => blocker());
    for (const b of blockers) queue.submit(b.run, 60_000);

    let ran = false;
    const queued = queue.submit(async () => {
      ran = true;
    }, 5_000);
    if (queued.outcome !== "accepted") throw new Error("expected acceptance");
    expect(queue.depth).toBe(1);

    now += 5_001;
    // Any later admission sweeps expired entries first.
    queue.submit(blocker().run, 60_000);

    expect(await queued.done).toBe("expired");
    expect(ran).toBe(false);

    for (const b of blockers) b.release();
  });

  it("a STATIONARY queue expires an entry on its own clock, with nothing else submitted", async () => {
    // The regression: expiry used to be evaluated only as a side effect of
    // another submission or of work completing. With the cap full of
    // never-finishing work and no further arrivals, a queued entry whose
    // admission deadline had already passed was never settled — the client
    // hung to its own timeout and reported §5 `outcome unknown` for a
    // request the daemon could prove never ran. Real timers here on
    // purpose: the periodic sweep IS the behaviour under test.
    const queue = new ExecutionQueue();
    const blockers = Array.from({ length: CONCURRENCY_CAP }, () => blocker());
    for (const b of blockers) queue.submit(b.run, 60_000);

    let ran = false;
    const queued = queue.submit(async () => {
      ran = true;
    }, 50);
    if (queued.outcome !== "accepted") throw new Error("expected acceptance");
    expect(queue.depth).toBe(1);

    // Nothing else is submitted and nothing completes — the only thing
    // that can settle this is the queue's own expiry tick.
    expect(await queued.done).toBe("expired");
    expect(ran).toBe(false);
    expect(queue.depth).toBe(0);

    queue.stop();
    for (const b of blockers) b.release();
  }, 10_000);

  it("resume shares the SAME queue as execute — concurrent resumes queue rather than exceeding the cap", () => {
    // Resume re-enters sandbox execution (it drives a paused execution's
    // replay), so it is admitted through the same queue as execute.
    // Before the fix it bypassed admission entirely and N concurrent
    // resumes ran unbounded in the one process the cap protects.
    const queue = new ExecutionQueue();

    // Fill every slot with "execute" work...
    const executes = Array.from({ length: CONCURRENCY_CAP }, () => blocker());
    for (const b of executes) queue.submit(b.run, 60_000);
    expect(queue.activeCount).toBe(CONCURRENCY_CAP);

    // ...then submit resumes. They QUEUE behind the cap rather than
    // adding themselves to the active set.
    const resumes = Array.from({ length: 3 }, () => blocker());
    for (const b of resumes) {
      expect(queue.submit(b.run, RESUME_ADMISSION_DEADLINE_MS).outcome).toBe("accepted");
    }
    expect(queue.activeCount).toBe(CONCURRENCY_CAP);
    expect(queue.depth).toBe(3);

    for (const b of [...executes, ...resumes]) b.release();
  });

  it("an entry settles exactly once — the first verdict wins even when two paths reach it", async () => {
    // "expired" vs "ran" is a correctness claim, and before the one-shot
    // guard it rode entirely on the queue/active split keeping those
    // paths disjoint — a property of the control flow, not of the entry.
    // Here abandon and expiry both reach the same entry; whichever lands
    // first is the verdict, and the second call must not re-resolve it.
    let now = 1_000;
    const queue = new ExecutionQueue(CONCURRENCY_CAP, QUEUE_CAPACITY, () => now);
    const blockers = Array.from({ length: CONCURRENCY_CAP }, () => blocker());
    for (const b of blockers) queue.submit(b.run, 60_000);

    let ran = false;
    const queued = queue.submit(async () => {
      ran = true;
    }, 5_000);
    if (queued.outcome !== "accepted") throw new Error("expected acceptance");

    // First verdict: abandoned (removes it from the queue and settles).
    queued.abandon();
    // Now push past its deadline and force a sweep. The entry is already
    // gone, but a second settle on the same entry would be the bug —
    // and abandon() itself is called again for good measure.
    now += 5_001;
    queued.abandon();
    queue.submit(blocker().run, 60_000);

    expect(await queued.done).toBe("abandoned");
    expect(ran).toBe(false);

    for (const b of blockers) b.release();
  });

  it("sustained overload never exceeds the queue capacity", () => {
    const queue = new ExecutionQueue();
    const blockers = Array.from({ length: CONCURRENCY_CAP }, () => blocker());
    for (const b of blockers) queue.submit(b.run, 60_000);

    let refused = 0;
    for (let i = 0; i < 200; i++) {
      if (queue.submit(blocker().run, 60_000).outcome === "busy") refused++;
    }

    // The bound holds under arrival pressure: depth never passed
    // capacity, and everything beyond it was refused rather than buffered.
    expect(queue.maxObservedDepth).toBe(QUEUE_CAPACITY);
    expect(queue.depth).toBe(QUEUE_CAPACITY);
    expect(refused).toBe(200 - QUEUE_CAPACITY);

    for (const b of blockers) b.release();
  });
});
