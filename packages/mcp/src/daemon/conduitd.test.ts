import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONCURRENCY_CAP,
  DRAIN_DEADLINE_MS,
  daemonPaths,
  EXIT_ALREADY_RUNNING,
  EXIT_ROTATION_IN_PROGRESS,
  ExecutionQueue,
  QUEUE_CAPACITY,
  RESUME_ADMISSION_DEADLINE_MS,
} from "./conduitd.js";
import { encodeFrame, FrameDecoder } from "./frames.js";
import { bundleDaemonHelper, type HelperBundle } from "./helpers/bundle.js";
import { acquireExclusive, acquireShared, type HeldLock } from "./locks.js";

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
      client.send({ kind: "approvals.resume", executionId: "e1", decision: "approve" });
      expect(await client.next()).toMatchObject({ kind: "error", code: "invalid" });
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
      client.send({ kind: "approvals.resume", executionId: "e1", decision: "approve" });
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
      client.send({ kind: "approvals.resume", executionId: "e1", decision: "approve" });
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
      expect(reply.message).not.toContain(stateDir);
      expect(reply.message).not.toContain(".db");
    },
    TIMEOUT,
  );

  it(
    "refuses unimplemented source RPCs distinguishably from malformed ones",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      const client = await connectClient(paths.socket);
      await handshake(client, "add-mcp");

      // Well-formed and permitted for this capability, but not built:
      // "unimplemented", never "invalid".
      client.send({ kind: "source.revalidate", namespace: "ns" });
      expect(await client.next()).toMatchObject({ kind: "error", code: "unimplemented" });

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
    const daemon = spawnDaemon(stateDir, ["--stall-sandbox"]);
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
    approver.send({ kind: "approvals.resume", executionId: "exec_x", decision: "approve" });

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
