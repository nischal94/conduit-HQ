/**
 * The daemon runtime (design §3.1, §3.5). One process owns
 * `~/.conduit/conduit.db`; clients are capability-scoped RPC clients over
 * a Unix domain socket in the same 0700 state directory.
 *
 * The startup order in `runDaemon` is normative and security-load-bearing
 * (§3.5's "total acquisition protocol"): two separate kernel locks cannot
 * be observed atomically, so coherence comes from the ORDER of
 * acquisition, not from a snapshot. Lifecycle EXCLUSIVE is taken first so
 * "maintenance shared + lifecycle free" is never a reachable daemon
 * state; a client observing the lifecycle lock held therefore knows a
 * daemon is starting, running, or draining — never that rotation slipped
 * in between the two acquisitions.
 *
 * Endpoint ownership (§3.2): the daemon binds while holding the lifecycle
 * lock, and a lifecycle-lock holder is the ONLY process permitted to
 * remove an endpoint. Clients never unlink — a failed connect does not
 * prove the daemon is dead (it may be starting, its backlog may be
 * transiently full, or shutdown may be racing), and unlinking a live UDS
 * does not close the listener: it only frees the name, letting a second
 * daemon bind and produce two owners of one database. On shutdown the
 * daemon unlinks only if the pathname still resolves to the device+inode
 * it bound, so it can never remove a successor's socket.
 */
import { type Stats, statSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { type ConduitStore, InMemoryCatalog } from "@conduithq/sdk";
import { createApprovalRuntime } from "../runtime.js";
import { openStoreFromEnv } from "../store-open.js";
import {
  DepthExceeded,
  encodeFrame,
  FrameDecoder,
  FrameTooLarge,
  MalformedFrame,
} from "./frames.js";
import { acquireExclusive, acquireShared, type HeldLock } from "./locks.js";
import {
  CAPABILITIES,
  type Capability,
  decodeRequest,
  type RpcRequest,
  type RpcResponse,
} from "./rpc.js";
import { assertStateDir } from "./state-dir.js";

/**
 * Normative constants (§3.1), not configuration. N clients now drive
 * executions in ONE process sharing ONE QuickJS module, and §16's budgets
 * are per-execution — nothing else bounds the daemon. The queue is
 * bounded in BOTH dimensions on purpose: a deadline alone is not a size
 * bound, because at a high enough arrival rate requests accumulate faster
 * than deadlines expire and queued frames grow without limit.
 */
export const CONCURRENCY_CAP = 4;
export const QUEUE_CAPACITY = 16;

/**
 * How long DRAINING waits for accepted work before abandoning it.
 *
 * Normative-local (chosen here, not by the design): the design says
 * draining "finishes everything", which is correct as intent but
 * unbounded in practice — §16's budgets bound the sandbox, yet a request
 * blocked in the store or an upstream layer is outside them. Since the
 * daemon holds the lifecycle lock until it exits, an unbounded drain is
 * an unbounded outage: every restart exits "already running" and rotation
 * can never take maintenance. Bounding it trades one abandoned response
 * (which §5 already models as `outcome unknown`) for a guaranteed exit.
 */
export const DRAIN_DEADLINE_MS = 30_000;

export interface DaemonPaths {
  stateDir: string;
  socket: string;
  lifecycleLockDb: string;
  maintenanceLockDb: string;
  db: string;
}

export function daemonPaths(stateDir: string): DaemonPaths {
  return {
    stateDir,
    socket: join(stateDir, "conduitd.sock"),
    lifecycleLockDb: join(stateDir, "conduitd-lifecycle.lock.db"),
    maintenanceLockDb: join(stateDir, "conduitd-maintenance.lock.db"),
    // The database is a property of the state directory, not of the
    // ambient environment (§3.1: the daemon derives its state directory
    // itself and resolves config from it). Everything the daemon owns —
    // socket, both lock dbs, the store — lives together under one
    // directory whose ownership and mode were validated before bind.
    db: join(stateDir, "conduit.db"),
  };
}

/**
 * Gives a defined terminal transition to executions left durably
 * `running` by a daemon that died mid-request (§3.5 "durable execution
 * state after a crash" — never automatic replay). Invoked once at its
 * fixed point in the startup order: after both locks are held, so no
 * other daemon can be operating on the same rows, and before the endpoint
 * is bound, so no client can observe a half-swept database.
 */
export type CrashTerminalSweep = (store: ConduitStore) => Promise<void>;

export interface RunDaemonOptions {
  stateDir: string;
  /** Absent = no sweep runs; the seam fixes WHERE it runs, not whether. */
  sweep?: CrashTerminalSweep;
  /** Structured lifecycle lines; default stderr. */
  log?: (line: string) => void;
  /**
   * Builds the execution runtime per unit of work (M6). Defaults to
   * `createApprovalRuntime`; overridable so a test can substitute a
   * collaborator that stalls in a layer §16's budgets do not bound,
   * without the daemon under test being anything other than the real one.
   */
  createRuntime?: typeof createApprovalRuntime;
}

/** Exit codes are part of the client contract (§3.5 decision table). */
export const EXIT_ALREADY_RUNNING = 3;
export const EXIT_ROTATION_IN_PROGRESS = 4;

export class DaemonExit extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "DaemonExit";
    this.code = code;
  }
}

/**
 * Validates and removes a pre-existing socket entry. Only ever called
 * while holding the lifecycle lock — the one sanctioned remover (§3.2).
 * An entry that is not a socket, or is owned by another uid, is NOT
 * removed: unlinking it would make this process a deletion primitive
 * against a file it does not own.
 */
function clearStaleEndpoint(socketPath: string): void {
  let stat: Stats;
  try {
    stat = statSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!stat.isSocket()) {
    throw new Error(
      `[conduitd] Bind refused: existing entry is not a socket. Context: {path: ${socketPath}} — remove it by hand after confirming what it is`,
    );
  }
  if (stat.uid !== process.getuid?.()) {
    throw new Error(
      `[conduitd] Bind refused: socket owned by another uid. Context: {path: ${socketPath}, ownerUid: ${stat.uid}, ourUid: ${process.getuid?.()}}`,
    );
  }
  unlinkSync(socketPath);
}

interface QueueEntry {
  run: () => Promise<void>;
  /** Admission deadline (epoch ms) — §3.1's per-entry bound. */
  expiresAt: number;
  settle: (outcome: QueueOutcome) => void;
}

export type QueueOutcome = "ran" | "expired" | "abandoned";

export type Admission =
  | { outcome: "busy" }
  | { outcome: "accepted"; done: Promise<QueueOutcome>; abandon(): void };

/**
 * Admission control for executions (§3.1). Four active slots; everything
 * else queues, and the queue is bounded in both dimensions.
 *
 * `deadlineMs` bounds ADMISSION only — how long an entry may wait for a
 * slot. It is deliberately not threaded into the sandbox's wall-clock
 * budget: §16 execution limits stay owned by the runtime/manager config,
 * so the daemon's bound is "how long you may queue", never "how long your
 * code may run".
 *
 * Entries leave the queue on dispatch, on deadline expiry, AND on client
 * disconnect. Disconnect removal is not an optimization: a gone client's
 * queued work would otherwise hold bounded capacity against clients that
 * are still present.
 */
export class ExecutionQueue {
  private active = 0;
  private readonly queue: QueueEntry[] = [];
  private highWaterMark = 0;

  private readonly cap: number;
  private readonly capacity: number;
  private readonly now: () => number;

  // Explicit field assignment rather than TypeScript parameter
  // properties: this module is loaded by `helpers/run-daemon.ts` under
  // Node's strip-only TypeScript mode, which rejects parameter
  // properties outright (they emit code rather than erasing to nothing).
  constructor(
    cap: number = CONCURRENCY_CAP,
    capacity: number = QUEUE_CAPACITY,
    now: () => number = Date.now,
  ) {
    this.cap = cap;
    this.capacity = capacity;
    this.now = now;
  }

  get depth(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.active;
  }

  /** Largest depth ever observed — the sustained-overload assertion. */
  get maxObservedDepth(): number {
    return this.highWaterMark;
  }

  submit(run: () => Promise<void>, deadlineMs: number): Admission {
    this.dropExpired();
    if (this.active >= this.cap && this.queue.length >= this.capacity) {
      return { outcome: "busy" };
    }

    let settle: (outcome: QueueOutcome) => void = () => {};
    const done = new Promise<QueueOutcome>((resolve) => {
      settle = resolve;
    });
    const entry: QueueEntry = { run, expiresAt: this.now() + deadlineMs, settle };

    if (this.active < this.cap) {
      void this.dispatch(entry);
    } else {
      this.queue.push(entry);
      this.highWaterMark = Math.max(this.highWaterMark, this.queue.length);
    }

    return {
      outcome: "accepted",
      done,
      abandon: () => {
        // Only a still-queued entry can be abandoned; one already
        // dispatched is in-flight work that drain must wait for.
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          entry.settle("abandoned");
        }
      },
    };
  }

  private dropExpired(): void {
    const now = this.now();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      if (entry !== undefined && entry.expiresAt <= now) {
        this.queue.splice(i, 1);
        entry.settle("expired");
      }
    }
  }

  private async dispatch(entry: QueueEntry): Promise<void> {
    this.active++;
    try {
      await entry.run();
    } finally {
      this.active--;
      entry.settle("ran");
      this.pump();
    }
  }

  private pump(): void {
    this.dropExpired();
    while (this.active < this.cap) {
      const next = this.queue.shift();
      if (next === undefined) return;
      void this.dispatch(next);
    }
  }

  /** True once nothing is active or queued — the drain condition. */
  get isIdle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }
}

interface ConnectionContext {
  socket: Socket;
  capability: Capability | null;
  /** In-flight request promises; drain waits on all of them. */
  inFlight: Set<Promise<unknown>>;
  /** Abandon hooks for this connection's still-queued entries. */
  queued: Set<() => void>;
  /** Source of this connection's daemon-assigned correlation ids. */
  requestCounter: { n: number };
}

function send(socket: Socket, msg: RpcResponse): void {
  if (socket.destroyed) return;
  socket.write(encodeFrame(msg));
}

/**
 * What an `internal` error tells the client. Store and sandbox failures
 * carry absolute filesystem paths, key-source context, and upstream
 * detail (§5: "stable error codes, redacted cause"; §11 forbids secret
 * material in any daemon-visible line). The client gets a fixed string
 * plus its correlation id; the operator gets the real cause in the
 * daemon's own log, where the §3.2 directory boundary already restricts
 * who can read it.
 */
const INTERNAL_ERROR_MESSAGE =
  "internal daemon error; see the daemon log for the cause (correlation id below)";

/**
 * Runs the daemon, resolving only once it has fully stopped. The two
 * refusal paths throw `DaemonExit` rather than calling `process.exit`
 * directly, so the exit code stays a property of the protocol and the
 * caller owns process termination.
 */
export async function runDaemon(opts: RunDaemonOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const paths = daemonPaths(opts.stateDir);

  // Signals are armed BEFORE the first blocking startup step. Registering
  // them only once serving begins leaves a window — lock acquisition,
  // store open, sweep, bind — where SIGTERM takes Node's default
  // disposition: the process dies without unwinding, `finally` never
  // runs, and a freshly-bound socket is left behind. Arming here means an
  // interrupted startup exits through the same release path as a running
  // daemon, with the drain simply having nothing to do.
  const stopSignal = new StopSignal();
  process.once("SIGTERM", stopSignal.request);
  process.once("SIGINT", stopSignal.request);

  // A registered signal handler does NOT keep Node's event loop alive.
  // Before the listener binds, startup can be waiting only on promises
  // (a lock acquire, a store open, the sweep) — and if one of those never
  // settles, Node sees no pending work, exits at "unsettled top-level
  // await", and the handler never runs: locks abandoned, `finally`
  // skipped. This handle holds the loop open across the whole startup
  // window so a signal is always delivered to the code above rather than
  // to Node's default disposition. The listener keeps it alive afterwards.
  const keepAlive = setInterval(() => {}, 1 << 30);

  try {
    return await startDaemon(opts, paths, log, stopSignal);
  } finally {
    clearInterval(keepAlive);
    process.removeListener("SIGTERM", stopSignal.request);
    process.removeListener("SIGINT", stopSignal.request);
  }
}

/**
 * A stop request that can arrive before anything is listening for it.
 * A signal during startup must not be lost — it is recorded and observed
 * at the next checkpoint — and must not be delivered twice.
 */
class StopSignal {
  private requested = false;
  // Every pending waiter, not just the latest: startup races the signal
  // at more than one checkpoint, and a single-slot field would silently
  // strand whichever waiter registered first.
  private readonly waiters = new Set<() => void>();

  /** Bound so it can be registered and removed as a listener directly. */
  readonly request = (): void => {
    if (this.requested) return;
    this.requested = true;
    for (const notify of this.waiters) notify();
    this.waiters.clear();
  };

  get isRequested(): boolean {
    return this.requested;
  }

  /** Resolves immediately if a stop was already requested. */
  wait(): Promise<void> {
    if (this.requested) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.add(resolve);
    });
  }
}

async function startDaemon(
  opts: RunDaemonOptions,
  paths: DaemonPaths,
  log: (line: string) => void,
  stopSignal: StopSignal,
): Promise<void> {
  // 1. State-directory boundary (§3.2). The different-UID boundary is
  //    enforced here, one level above the socket: a different-uid process
  //    cannot traverse a 0700 directory, so it never reaches the pathname.
  await assertStateDir(paths.stateDir, "bind");

  // 2. Lifecycle EXCLUSIVE — singleton enforcement among daemons.
  const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
  if (lifecycle === null) {
    log("already running");
    throw new DaemonExit(EXIT_ALREADY_RUNNING, "already running");
  }

  let maintenance: HeldLock | null = null;
  try {
    // 3. Maintenance SHARED — mutual exclusion against offline rotation.
    //    Lifecycle-first ordering means rotation can never wedge itself
    //    between the two acquisitions.
    maintenance = await acquireShared(paths.maintenanceLockDb);
    if (maintenance === null) {
      log("rotation in progress");
      throw new DaemonExit(EXIT_ROTATION_IN_PROGRESS, "rotation in progress");
    }

    // 4. Config resolved by the daemon ITSELF from default paths (§3.1
    //    spawn boundary / §9.3 item 3): the daemon's environment is
    //    constructed, never inherited, so a client can never smuggle a
    //    database path into the long-lived process. A client whose own
    //    env sets CONDUIT_DB is refused at handshake instead.
    const { env, store } = await openStoreFromEnv(daemonEnv(paths.db));

    // 5. Crash-terminal sweep: executions left durably `running` by a
    //    dead daemon reach their terminal state before anything is
    //    served. Both locks are held, so no other daemon can be touching
    //    the same rows, and the endpoint is not yet bound.
    if (opts.sweep !== undefined) {
      // Raced against the stop signal: a sweep that blocks (a wedged
      // store call) would otherwise make the whole startup
      // uninterruptible, and SIGTERM would fall through to Node's default
      // disposition — killing the process without releasing either lock.
      // Losing the race abandons the sweep, which is safe: it is
      // idempotent by construction (it only moves dead-daemon rows to a
      // terminal state) and the next startup runs it again.
      await Promise.race([opts.sweep(store), stopSignal.wait()]);
    }

    // A stop that arrived during startup is honored here, before the
    // endpoint exists — so an interrupted start never leaves a bound
    // socket behind, and the locks still release through `finally`.
    if (stopSignal.isRequested) {
      log("stopped before bind");
      return;
    }

    // 6. Validate and remove any pre-existing endpoint (we hold the
    //    lifecycle lock — the one sanctioned remover), then bind.
    clearStaleEndpoint(paths.socket);

    await serve({
      paths,
      store,
      allowPrivateEgress: env.allowPrivateEgress,
      dbPath: env.dbPath,
      log,
      stopSignal,
      createRuntime: opts.createRuntime ?? createApprovalRuntime,
    });
  } finally {
    // §3.5 step 4: maintenance first, lifecycle last. Lifecycle release
    // is the very last act — a client that sees it free may start.
    if (maintenance !== null) await maintenance.release();
    await lifecycle.release();
  }
}

/**
 * The daemon's own environment. Any inherited `CONDUIT_DB` is discarded
 * and replaced with the path derived from the validated state directory:
 * a client can never smuggle a database path into the long-lived process
 * (§3.1 spawn boundary), and a client whose own env sets one is refused
 * at handshake instead (§9.3 item 3).
 *
 * `CONDUIT_MASTER_KEY` is deliberately left intact — it remains supported
 * for a daemon an operator starts BY HAND; auto-start constructs a clean
 * environment upstream, so nothing transfers through that path.
 */
function daemonEnv(dbPath: string): NodeJS.ProcessEnv {
  return { ...process.env, CONDUIT_DB: dbPath };
}

interface ServeOptions {
  paths: DaemonPaths;
  store: ConduitStore;
  allowPrivateEgress: boolean;
  dbPath: string;
  log: (line: string) => void;
  stopSignal: StopSignal;
  createRuntime: typeof createApprovalRuntime;
}

async function serve(opts: ServeOptions): Promise<void> {
  const { paths, store, allowPrivateEgress, dbPath, log, stopSignal, createRuntime } = opts;
  let draining = false;
  const queue = new ExecutionQueue();
  const connections = new Set<ConnectionContext>();

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  // The endpoint we bound, by identity rather than by name — shutdown
  // compares against this so it can never unlink a successor's socket.
  const bound = statSync(paths.socket);

  server.on("connection", (socket) => {
    handleConnection(socket);
  });

  // Distinct one-word prefixes: "already running" contains "ready" as a
  // substring, so a line-oriented reader keying on it would treat the
  // singleton loser's refusal as a successful start.
  log(`listening socket=${paths.socket} db=${dbPath}`);

  function handleConnection(socket: Socket): void {
    // The READY gate (§3.5): a connect can succeed at the kernel level —
    // queued in the listen backlog — moments before the listener closes.
    // READY is sent only for connections accepted while RUNNING, so a
    // client that never sees one knows nothing was served and may retry
    // as a first attempt rather than a replay.
    if (draining) {
      socket.destroy();
      return;
    }

    const ctx: ConnectionContext = {
      socket,
      capability: null,
      inFlight: new Set(),
      queued: new Set(),
      requestCounter: { n: 0 },
    };
    connections.add(ctx);
    const decoder = new FrameDecoder();

    socket.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        // Framing failures are protocol-level and describe only the
        // client's own bytes (size cap, nesting cap, malformed JSON), so
        // echoing those specific messages tells the client how to fix
        // its request without revealing daemon state. Anything else is
        // unexpected and gets the generic message.
        const protocolFault =
          err instanceof FrameTooLarge ||
          err instanceof DepthExceeded ||
          err instanceof MalformedFrame;
        if (!protocolFault) {
          log(
            `[conduitd] Frame decode failed: unexpected fault. Context: {cause: ${
              err instanceof Error ? (err.stack ?? err.message) : String(err)
            }}`,
          );
        }
        send(socket, {
          kind: "error",
          requestId: "",
          code: "invalid",
          message: protocolFault ? (err as Error).message : INTERNAL_ERROR_MESSAGE,
        });
        socket.destroy();
        return;
      }
      for (const msg of messages) {
        const promise = dispatch(ctx, msg);
        ctx.inFlight.add(promise);
        void promise.finally(() => ctx.inFlight.delete(promise));
      }
    });

    socket.on("close", () => {
      // Queued entries belonging to a gone client are removed here rather
      // than left to expire — they would otherwise hold bounded capacity
      // against clients that are still connected.
      for (const abandon of ctx.queued) abandon();
      ctx.queued.clear();
      connections.delete(ctx);
    });
    socket.on("error", () => {
      socket.destroy();
    });

    // READY is the ONLY frame written before the client's first request:
    // the daemon is purely reactive from here, replying only to frames it
    // receives. Clients need not depend on that — `client.ts` carries its
    // READY-gate decoder into the next phase, so a frame coalesced with
    // READY (or split across chunks) survives regardless. Anything added
    // here that writes unprompted must keep that decoder-handoff intact.
    send(socket, { kind: "ready" });
  }

  async function dispatch(ctx: ConnectionContext, msg: unknown): Promise<void> {
    const requestId = nextRequestId(ctx.requestCounter);
    let request: RpcRequest;
    try {
      request = decodeRequest(msg);
    } catch (err) {
      send(ctx.socket, {
        kind: "error",
        requestId,
        code: "invalid",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (request.kind === "handshake") {
      handleHandshake(ctx, request, requestId);
      return;
    }

    if (ctx.capability === null) {
      send(ctx.socket, {
        kind: "error",
        requestId,
        code: "invalid",
        message: "handshake required before any other request",
      });
      return;
    }
    // The capability set is the authorization boundary (§3.3): a request
    // outside the client's declared set is refused before any other work.
    if (!CAPABILITIES[ctx.capability].has(request.kind)) {
      send(ctx.socket, {
        kind: "error",
        requestId,
        code: "invalid",
        message: `capability "${ctx.capability}" does not permit "${request.kind}"`,
      });
      return;
    }

    try {
      await handleRequest(ctx, request, requestId);
    } catch (err) {
      // Detail daemon-side, generic message to the client — the cause is
      // correlated by requestId rather than copied onto the wire.
      log(
        `[conduitd] Request failed: ${request.kind}. Context: {requestId: ${requestId}, cause: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }}`,
      );
      send(ctx.socket, {
        kind: "error",
        requestId,
        code: "internal",
        message: INTERNAL_ERROR_MESSAGE,
      });
    }
  }

  function handleHandshake(
    ctx: ConnectionContext,
    request: Extract<RpcRequest, { kind: "handshake" }>,
    requestId: string,
  ): void {
    // A connection's capability is assigned EXACTLY ONCE. `handshake` is a
    // member of every capability set (§3.3), so without this guard a
    // client refused an out-of-set request could simply re-handshake as a
    // wider role and retry it — the authorization check below would then
    // pass. Capability is a property of the connection, not a mutable
    // per-request field; a client wanting a different one opens a new
    // connection.
    if (ctx.capability !== null) {
      send(ctx.socket, {
        kind: "error",
        requestId,
        code: "invalid",
        message: "capability already negotiated on this connection",
      });
      return;
    }
    // A client carrying its own CONDUIT_DB is refused rather than served
    // against a database it did not choose. Silently ignoring the value
    // would hide the mismatch at exactly the moment it matters (§9.3
    // item 3: custom-path installs keep direct access and forgo daemon
    // features in v1).
    if (request.dbPath !== undefined) {
      send(ctx.socket, {
        kind: "error",
        requestId,
        code: "refused-custom-db",
        message: "custom db paths bypass the daemon in v1; unset CONDUIT_DB to use it",
      });
      ctx.socket.end();
      return;
    }
    ctx.capability = request.capability;
    send(ctx.socket, { kind: "handshake.ok", protocol: 1, dbPath, allowPrivateEgress });
  }

  /** Fresh catalog snapshot per call (M6) — never cached across requests. */
  async function snapshotCatalog(): Promise<InMemoryCatalog> {
    const catalog = new InMemoryCatalog();
    catalog.upsert(await store.tools.list());
    return catalog;
  }

  async function handleRequest(
    ctx: ConnectionContext,
    request: RpcRequest,
    requestId: string,
  ): Promise<void> {
    switch (request.kind) {
      case "execute": {
        const admission = queue.submit(async () => {
          // M6: a fresh runtime per unit of work — never cached.
          const { manager } = await createRuntime({ store, allowPrivateEgress, log });
          // deadlineMs bounded ADMISSION, not execution: §16's wall-clock
          // budget stays with the manager's own limits.
          const outcome = await manager.start(request.code);
          send(ctx.socket, { kind: "result", requestId, payload: outcome });
        }, request.deadlineMs);

        if (admission.outcome === "busy") {
          send(ctx.socket, {
            kind: "error",
            requestId,
            code: "busy",
            message: `daemon busy: ${QUEUE_CAPACITY} requests queued behind ${CONCURRENCY_CAP} active`,
          });
          log(`queue depth=${queue.depth} max=${queue.maxObservedDepth} refused=busy`);
          return;
        }

        ctx.queued.add(admission.abandon);
        log(`queue depth=${queue.depth} max=${queue.maxObservedDepth} active=${queue.activeCount}`);
        const settled = await admission.done;
        ctx.queued.delete(admission.abandon);
        if (settled === "expired") {
          // Nothing ran, so this is not an ambiguous outcome — the
          // request was never admitted and may be retried as a first
          // attempt.
          send(ctx.socket, {
            kind: "error",
            requestId,
            code: "busy",
            message: "queue deadline expired before a slot became available",
          });
        }
        return;
      }
      case "search": {
        const catalog = await snapshotCatalog();
        send(ctx.socket, {
          kind: "result",
          requestId,
          payload: catalog.search({ query: request.query }),
        });
        return;
      }
      case "describe": {
        const catalog = await snapshotCatalog();
        send(ctx.socket, {
          kind: "result",
          requestId,
          payload: catalog.describe(request.toolName) ?? null,
        });
        return;
      }
      case "approvals.list": {
        const paused = await store.executions.listPaused();
        send(ctx.socket, {
          kind: "result",
          requestId,
          payload: paused.map((execution) => ({
            executionId: execution.id,
            startedAt: execution.startedAt,
            pausedOn: execution.pausedOn ?? null,
          })),
        });
        return;
      }
      case "approvals.resume": {
        const { manager } = await createRuntime({ store, allowPrivateEgress, log });
        const outcome = await manager.resume(request.executionId, { kind: request.decision });
        send(ctx.socket, { kind: "result", requestId, payload: outcome });
        return;
      }
      case "source.provision":
      case "source.revalidate": {
        // Well-formed and permitted for `add-mcp`, but §3.3.1's
        // credential-handling design is not built here. `unimplemented`
        // rather than `invalid` so a client can tell "not yet" from
        // "you sent something wrong" and does not retry or reformat.
        send(ctx.socket, {
          kind: "error",
          requestId,
          code: "unimplemented",
          message: `"${request.kind}" arrives with the client-conversion work; use direct store access until then`,
        });
        return;
      }
      case "handshake":
        return;
    }
  }

  // DRAINING (§3.5): close the listener, finish everything already
  // accepted, then remove the endpoint under the device+inode check.
  // Draining is not cancellable — a daemon that has begun draining
  // completes its exit.
  await stopSignal.wait();
  draining = true;
  log("draining");

  // Stop accepting new connections. `server.close` does NOT resolve until
  // every already-open connection is gone, so the idle ones are ended
  // first — otherwise a client that connected and simply sat there would
  // hold the daemon in DRAINING forever. Sockets with work in flight are
  // left alone here and ended below, once their responses are written.
  const closed = new Promise<void>((done) => server.close(() => done()));
  for (const ctx of connections) {
    if (ctx.inFlight.size === 0) ctx.socket.end();
  }

  // Finishing accepted work is best-effort under a deadline, not an
  // unbounded wait. §16's budgets bound the sandbox, but a request
  // blocked in the store or an upstream layer is outside them — and an
  // unbounded drain holds the lifecycle lock forever, which is strictly
  // worse than abandoning one response: every restart would exit
  // "already running" and rotation could never acquire maintenance.
  // Exiting releases both locks and lets the next daemon serve.
  const deadline = Date.now() + DRAIN_DEADLINE_MS;
  while (!queue.isIdle && Date.now() < deadline) {
    await new Promise((tick) => setTimeout(tick, 5));
  }
  for (const ctx of connections) {
    const remaining = deadline - Date.now();
    if (remaining > 0 && ctx.inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...ctx.inFlight]),
        new Promise((expire) => setTimeout(expire, remaining)),
      ]);
    }
    ctx.socket.end();
  }

  const abandonedActive = queue.activeCount;
  const abandonedQueued = queue.depth;
  if (abandonedActive > 0 || abandonedQueued > 0) {
    // Named explicitly: a client whose request was abandoned sees a
    // closed connection, which §5 already defines as `outcome unknown`
    // — never a silent success.
    log(
      `[conduitd] Drain deadline reached: abandoning work. Context: {deadlineMs: ${DRAIN_DEADLINE_MS}, active: ${abandonedActive}, queued: ${abandonedQueued}}`,
    );
  }

  // Destroy anything still open so the listener close can complete —
  // otherwise the wait below reintroduces the unbounded hang this
  // deadline exists to prevent.
  for (const ctx of connections) ctx.socket.destroy();
  await closed;

  unlinkIfStillOurs(paths.socket, bound, log);
  log("stopped");
}

/**
 * Unlinks the socket only if the pathname still resolves to the object
 * this daemon bound. If a successor already bound its own socket at the
 * same path, the inode differs and this daemon leaves it alone —
 * removing it would silently orphan a live listener.
 */
function unlinkIfStillOurs(socketPath: string, bound: Stats, log: (line: string) => void): void {
  try {
    const current = statSync(socketPath);
    if (current.dev !== bound.dev || current.ino !== bound.ino) {
      log("endpoint replaced since bind — leaving it in place");
      return;
    }
    unlinkSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Correlation ids are assigned by the DAEMON, not carried by the client:
 * no `RpcRequest` variant has a `requestId` field, and `decodeRequest`'s
 * extra-key rejection means one sent by a client is refused outright. A
 * per-connection monotonic counter is therefore the only source, and it
 * is enough for the one property responses need — matching a reply to a
 * request on a single ordered connection.
 */
function nextRequestId(counter: { n: number }): string {
  counter.n += 1;
  return `r${counter.n}`;
}
