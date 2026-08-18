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
import { createServer } from "node:net";
import { join } from "node:path";
import { type ConduitStore, logSandboxDiagnosticsTo } from "@conduithq/sdk";
import { createApprovalRuntime } from "../runtime.js";
import { openStoreFromEnv } from "../store-open.js";
import {
  type Admission,
  type ConnectionContext,
  type ConnectionDeps,
  handleConnection,
  type QueueOutcome,
} from "./connection.js";
import {
  acquireExclusive,
  acquireShared,
  EXCLUSIVE_ACQUIRE_BUSY_TIMEOUT_MS,
  type HeldLock,
} from "./locks.js";
import { createSourceLock } from "./source-lock.js";
import { ensureStateDir } from "./state-dir.js";

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
 * Re-exported from the connection module, where the admission deadline
 * for `approvals.resume` now lives alongside the request that uses it.
 * `conduitd.ts` remains the public import site for the daemon's
 * normative constants.
 */
export { RESUME_ADMISSION_DEADLINE_MS } from "./connection.js";

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

/**
 * The `role` strings stamped into the maintenance lock's diagnostic holder
 * row (§3.4). They appear verbatim inside refusal messages a human reads
 * ("Last acquired by daemon (pid 4711) at … (may be stale)"), so they are
 * named here rather than written as literals at each acquisition site —
 * the daemon and the two CLI acquirers must agree on the vocabulary for
 * those messages to read consistently.
 */
export const MAINTENANCE_ROLE_DAEMON = "daemon";
export const MAINTENANCE_ROLE_ROTATE = "conduit key rotate";
export const MAINTENANCE_ROLE_GENERATE = "conduit key generate";
export const MAINTENANCE_ROLE_DOCTOR = "conduit-mcp --doctor --offline";

/**
 * How often a NON-EMPTY queue re-checks its entries for deadline expiry.
 *
 * Without it, expiry is only ever evaluated as a side effect of another
 * submission or of work completing — so a queue that goes stationary
 * (cap full of long-running work, no new arrivals) never expires anything.
 * A client whose admission deadline has already passed would then hang to
 * its own client-side timeout and report §5 `outcome unknown` for a
 * request the daemon can prove never ran. The daemon owes it the truthful
 * terminal answer — "expired" — and can only give it on its own clock.
 *
 * 250ms is granularity, not a bound: admission deadlines are seconds-scale
 * (§3.3 `deadlineMs`, RESUME_ADMISSION_DEADLINE_MS is 60s), so this costs
 * a no-op tick per quarter second only while entries are actually waiting.
 */
export const QUEUE_EXPIRY_TICK_MS = 250;

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

export type { Admission, QueueOutcome } from "./connection.js";

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
  private expiryTimer: NodeJS.Timeout | null = null;

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

    let resolveDone: (outcome: QueueOutcome) => void = () => {};
    const done = new Promise<QueueOutcome>((resolve) => {
      resolveDone = resolve;
    });
    // One-shot at CONSTRUCTION, so the first verdict wins no matter which
    // path settles the entry. An entry can plausibly be reached twice —
    // expiry sweeping a queued entry that dispatch is concurrently
    // draining, or abandon racing either — and today "expired" vs "ran"
    // stays correct only because the queue/active split happens to make
    // those paths disjoint. That is a property of the current control
    // flow, not of the type, and a later refactor could silently flip a
    // settled verdict. Guarding here makes the one-shot a property of the
    // entry itself; a second call is a no-op rather than a re-resolve.
    let settled = false;
    const settle = (outcome: QueueOutcome): void => {
      if (settled) return;
      settled = true;
      resolveDone(outcome);
    };
    const entry: QueueEntry = { run, expiresAt: this.now() + deadlineMs, settle };

    if (this.active < this.cap) {
      void this.dispatch(entry);
    } else {
      this.queue.push(entry);
      this.highWaterMark = Math.max(this.highWaterMark, this.queue.length);
      this.startExpiryTimer();
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

  /**
   * Runs only while entries are actually waiting, and is `unref`'d so it
   * is never itself a reason for the process to stay alive. Both matter:
   * a timer that outlived the queue would hold Node's event loop open past
   * the point the daemon released its locks, which is precisely the
   * lingering-process hazard `bin.ts`'s hard exit exists to close.
   */
  private startExpiryTimer(): void {
    if (this.expiryTimer !== null) return;
    const timer = setInterval(() => {
      this.dropExpired();
    }, QUEUE_EXPIRY_TICK_MS);
    timer.unref?.();
    this.expiryTimer = timer;
  }

  private stopExpiryTimer(): void {
    if (this.expiryTimer === null) return;
    clearInterval(this.expiryTimer);
    this.expiryTimer = null;
  }

  /** Releases the expiry timer; call once the queue is done being used. */
  stop(): void {
    this.stopExpiryTimer();
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
    // Nothing left to expire — the timer would just be a no-op tick.
    if (this.queue.length === 0) this.stopExpiryTimer();
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

/**
 * Runs the daemon, resolving only once it has fully stopped — both locks
 * released, endpoint removed. It never terminates the process itself: the
 * two refusal paths throw `DaemonExit` rather than calling `process.exit`,
 * so the exit code stays a property of the protocol and the CALLER owns
 * process termination.
 *
 * That ownership carries an obligation, not just a choice. Resolving here
 * does not cancel work the drain deadline abandoned, so a caller that
 * keeps running after this resolves is a process holding live in-flight
 * store work with the locks already released — a second writer against a
 * successor's database. Every caller must exit promptly once this settles;
 * `bin.ts`'s `--daemon` path does so explicitly, and the test fixture
 * `helpers/run-daemon.ts` mirrors it.
 */
export async function runDaemon(opts: RunDaemonOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const paths = daemonPaths(opts.stateDir);

  // Route sandbox module-recovery diagnostics (gate-two DoS fix) to the
  // daemon's log — ONCE, at startup. The sink is process-global (the
  // shared QuickJS module is too), and since D-B1 the daemon is the only
  // process that RUNS a sandbox: `createConduitMcpServer` registered this
  // while it owned the execution runtime, but a serve process that
  // executes nothing would never fire it. Registering here keeps §16
  // recovery observable instead of silently losing it in the move.
  logSandboxDiagnosticsTo(log);

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
  //    The daemon CREATES the directory when absent (0700) and then runs
  //    the full validation over it either way — on a fresh install
  //    nothing has made `~/.conduit` yet, and refusing to start there
  //    would make first run a dead end. Creation is not a shortcut past
  //    the boundary: mkdir-then-assert proves the same properties for a
  //    directory it just created as for one it found.
  await ensureStateDir(paths.stateDir);

  // 2. Lifecycle EXCLUSIVE — singleton enforcement among daemons. The
  //    collision backoff makes a symmetric auto-start race end with one
  //    winner rather than mutual BUSY refusals; lifecycle is the only
  //    acquisition that opts in (see the constant's doc in locks.ts).
  const lifecycle = await acquireExclusive(paths.lifecycleLockDb, {
    busyTimeoutMs: EXCLUSIVE_ACQUIRE_BUSY_TIMEOUT_MS,
  });
  if (lifecycle === null) {
    log("already running");
    throw new DaemonExit(EXIT_ALREADY_RUNNING, "already running");
  }

  let maintenance: HeldLock | null = null;
  try {
    // 3. Maintenance SHARED — mutual exclusion against offline rotation.
    //    Lifecycle-first ordering means rotation can never wedge itself
    //    between the two acquisitions.
    //
    //    The role stamp is diagnostics only (§3.4): a `key rotate` refused
    //    by this very hold reads it back and names WHICH process is in the
    //    way, instead of telling the operator to go hunt for it. A SHARED
    //    holder does not block that read.
    maintenance = await acquireShared(paths.maintenanceLockDb, { role: MAINTENANCE_ROLE_DAEMON });
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
      //
      // Abandoning it does NOT cancel it — the sweep's own store writes
      // may still be in flight after this race resolves. That straggler
      // is tolerable only because losing this race means a stop was
      // requested, so the process is about to exit through `finally`
      // (both locks released, no endpoint ever bound) and no client can
      // observe the partially-swept state. If this race is ever reused
      // somewhere the process KEEPS RUNNING afterwards, the straggler
      // becomes a concurrent writer against a store the daemon has
      // resumed serving, and it would need real cancellation.
      await Promise.race([opts.sweep(store), stopSignal.wait()]);
      // Which side won is invisible from the outside — both leave the
      // process exiting through `finally` — so the abandoned case is
      // named explicitly. Otherwise an operator seeing rows still
      // `running` after a start has no way to tell "the sweep ran and
      // these are new" from "the sweep never finished".
      if (stopSignal.isRequested) {
        log("sweep abandoned mid-flight; rows remain for next startup");
      }
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
    //
    // Nested rather than sequential: the maintenance release is a real
    // store call and can throw (a ROLLBACK against an already-closing
    // client, say). Left in sequence, that throw would skip the lifecycle
    // release entirely and propagate — leaving the exclusive lock held by
    // a process that is on its way out, so every successor exits "already
    // running" until the OS drops it. The lifecycle release is the one
    // step that must happen on every path, so it owns the `finally`.
    //
    // Kernel lock-drop at process death is the backstop underneath this
    // (advisory locks die with the process, and `bin.ts` exits hard right
    // after), but a backstop is not a reason to skip the ordered release:
    // it is what makes the release visible PROMPTLY and in the §3.5 order,
    // rather than whenever the kernel gets around to it.
    try {
      if (maintenance !== null) await maintenance.release();
    } catch (err) {
      log(
        `[conduitd] Maintenance lock release failed: releasing lifecycle anyway. Context: {cause: ${err instanceof Error ? err.message : String(err)}}`,
      );
    } finally {
      await lifecycle.release();
    }
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

  // The bind-phase `error` listener above is removed once listen
  // succeeds, which would leave the server with NO error listener for the
  // rest of its life. A post-listen fault (accept-time EMFILE/ENFILE, or
  // any listener-level error) would then be an uncaught 'error' event:
  // the process dies where it stands, bypassing the entire drain path —
  // no unlink under the device+inode check, no maintenance-then-lifecycle
  // release ordering, no "draining"/"stopped" lines. Routing it into the
  // stop signal makes a server fault exit through exactly the same path
  // as SIGTERM, which is the only exit this daemon is designed to have.
  server.on("error", (err: NodeJS.ErrnoException) => {
    log(
      `[conduitd] Listener error after bind — draining. Context: {code: ${err.code ?? "unknown"}, cause: ${err.message}}`,
    );
    stopSignal.request();
  });

  // The endpoint we bound, by identity rather than by name — shutdown
  // compares against this so it can never unlink a successor's socket.
  const bound = statSync(paths.socket);

  // Everything the connection protocol needs, handed over explicitly.
  // `isDraining` is a getter, not a snapshot: the drain block below flips
  // `draining` long after these deps are built, and the READY gate must
  // observe the live value.
  // Daemon-scoped per-namespace source lock (F2): built once, shared by
  // every connection, so provision/revalidate against one namespace
  // serialize even across connections.
  const sourceLock = createSourceLock();

  const connectionDeps: ConnectionDeps = {
    store,
    allowPrivateEgress,
    dbPath,
    log,
    createRuntime,
    submit: (run, deadlineMs): Admission => queue.submit(run, deadlineMs),
    isDraining: () => draining,
    connections,
    queueStats: () => ({
      depth: queue.depth,
      maxObservedDepth: queue.maxObservedDepth,
      activeCount: queue.activeCount,
    }),
    busyMessage: `daemon busy: ${QUEUE_CAPACITY} requests queued behind ${CONCURRENCY_CAP} active`,
    withSourceLock: (namespace, fn) => sourceLock.run(namespace, fn),
  };

  server.on("connection", (socket) => {
    handleConnection(socket, connectionDeps);
  });

  // Distinct one-word prefixes: "already running" contains "ready" as a
  // substring, so a line-oriented reader keying on it would treat the
  // singleton loser's refusal as a successful start.
  log(`listening socket=${paths.socket} db=${dbPath}`);

  // DRAINING (§3.5): close the listener, finish everything already
  // accepted, then remove the endpoint under the device+inode check.
  // Draining is not cancellable — a daemon that has begun draining
  // completes its exit.
  await stopSignal.wait();
  draining = true;
  log("draining");

  // Stop accepting new connections. `server.close` does NOT resolve
  // until every already-open connection is gone, so idle connections
  // must eventually be ended — otherwise a client that connected and sat
  // there would hold the daemon in DRAINING forever.
  //
  // But "eventually" is the drain deadline, not drain start. §3.5 is
  // explicit that a connection which has received READY counts as active
  // work: the client was told the daemon was serving, and it may be
  // mid-decision about a request it is entitled to still issue. Cutting
  // it at drain start breaks that promise for a connection that did
  // nothing wrong. So a READY-granted connection — idle or not — is left
  // open through the grace window below and ended only when the deadline
  // expires. That cut is the deliberate residual: the grace window was
  // ruled bounded rather than unbounded because holding the lifecycle
  // lock forever is a worse failure than ending one idle connection, so
  // a still-open READY connection at the deadline is severed on purpose.
  //
  // A connection that never received READY was never promised anything
  // and is ended immediately.
  const closed = new Promise<void>((done) => server.close(() => done()));
  for (const ctx of connections) {
    if (!ctx.readyGranted) ctx.socket.end();
  }

  // Finishing accepted work is best-effort under a deadline, not an
  // unbounded wait. §16's budgets bound the sandbox, but a request
  // blocked in the store or an upstream layer is outside them — and an
  // unbounded drain holds the lifecycle lock forever, which is strictly
  // worse than abandoning one response: every restart would exit
  // "already running" and rotation could never acquire maintenance.
  // Exiting releases both locks and lets the next daemon serve.
  // The grace window. It runs to the deadline whenever a READY-granted
  // connection is still open, rather than exiting the moment the queue
  // first reads idle: an idle queue does NOT mean the connection is
  // finished, only that it has not issued its next request yet, and that
  // request is one §3.5 entitles it to make. Exiting early would end the
  // connection between two requests it was promised it could send.
  //
  // Once every READY connection has closed on its own, there is nothing
  // left to wait for and the loop stops immediately — the common case
  // (well-behaved clients disconnecting on SIGTERM) still exits fast.
  const deadline = Date.now() + DRAIN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const liveReady = [...connections].some((ctx) => ctx.readyGranted && !ctx.socket.destroyed);
    if (queue.isIdle && !liveReady) break;
    await new Promise((tick) => setTimeout(tick, 5));
  }

  // Deadline reached (or nothing left): finish whatever responses are
  // still writable, then end every remaining connection. This is where
  // the surviving idle READY connections are finally cut — the residual
  // the bounded grace window accepts in exchange for a guaranteed exit.
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
  queue.stop();
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
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // Logged rather than rethrown. This runs at the very END of `serve`,
    // after the drain completed and immediately before the locks release
    // — so a throw here converts a clean shutdown into a crash exit that
    // `bin.ts` reports as an unexpected failure (it special-cases only
    // `DaemonExit`). The leftover entry is not dangerous: the next
    // daemon's `clearStaleEndpoint` validates and removes it under the
    // lifecycle lock before binding, which is exactly the path that
    // exists for an endpoint a predecessor failed to clean up.
    log(
      `[conduitd] Endpoint unlink failed — leaving it for the successor to clear. Context: {path: ${socketPath}, code: ${code ?? "unknown"}}`,
    );
  }
}
