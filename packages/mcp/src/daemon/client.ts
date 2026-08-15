/**
 * The daemon client (design §3.5's decision table + §5's retry rule).
 *
 * The whole module is organized around one asymmetry: **before the first
 * request byte is written, every failure is retryable; after it, none
 * are.** A client that has written nothing can wait, re-probe, spawn, and
 * try again, and its eventual attempt is a FIRST attempt — nothing
 * reached a daemon, so nothing can have been half-done. Once a byte is on
 * the wire that reasoning collapses: a lost connection no longer
 * distinguishes "the daemon never saw it" from "the daemon executed it
 * and died before replying", and those have opposite correct responses.
 * §5 resolves the ambiguity by refusing to guess — the client reports
 * `outcome-unknown` and never retries, because a retried execution can
 * duplicate upstream side effects that already landed.
 *
 * This is why the READY gate exists and why it is load-bearing rather
 * than decorative. A `connect()` can succeed at the kernel level, sitting
 * in the listen backlog, moments before the daemon closes its listener;
 * that connection is discarded without ever being accepted. Writing
 * immediately on connect would put such a request into the ambiguous zone
 * for a daemon that provably never saw it. Waiting for READY keeps it in
 * the retryable zone instead.
 *
 * Clients NEVER unlink the socket (§3.2). A failed connect does not prove
 * the daemon is dead — it may be starting, its backlog may be transiently
 * full, or shutdown may be racing — and unlinking a live UDS does not
 * close the listener: it only frees the name, letting a second daemon
 * bind and produce two owners of one database.
 */

import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { type DaemonPaths, daemonPaths } from "./conduitd.js";
import { encodeFrame, FrameDecoder } from "./frames.js";
import { probeShared } from "./locks.js";
import type { CAPABILITIES, RpcRequest, RpcResponse } from "./rpc.js";
import { DAEMON_LOG, spawnDaemon } from "./spawn.js";
import { assertStateDir, StateDirError } from "./state-dir.js";

export interface DaemonRequestOptions {
  stateDir: string;
  role: keyof typeof CAPABILITIES;
  request: RpcRequest;
  /** One bounded budget for the WHOLE attempt, waits and spawn included. */
  deadlineMs: number;
  /** Injectable for tests; production spawns the real daemon. */
  spawn?: (stateDir: string) => void;
}

/**
 * The correlation id on a client-synthesized `outcome-unknown`.
 *
 * Correlation ids are DAEMON-assigned (`conduitd.ts`: no request variant
 * carries one, and the decoder's extra-key rejection refuses one a client
 * sends). So when the connection dies before any response arrives, there
 * is genuinely no id to echo — the daemon never told us one. Rather than
 * invent a plausible-looking id that no daemon log will ever contain,
 * this sentinel says so explicitly: a reader correlating against the
 * daemon log needs to know the lookup is impossible, not to search for a
 * number that was never assigned.
 *
 * If a partial response DID deliver an id before the connection dropped,
 * that real id is used instead — it is correlatable, and strictly more
 * useful than the sentinel.
 */
export const UNCORRELATED = "uncorrelated";

/** How long to wait for the lifecycle lock to release before re-probing. */
const LIFECYCLE_WAIT_POLL_MS = 50;

/**
 * How many times the top of the decision table may be re-entered. Each
 * pass corresponds to a state transition the design names (rotation
 * clears, a starting daemon finishes, a spawn lands), and every pass is
 * additionally bounded by `deadlineMs`. The count exists so a pathological
 * flapping daemon produces a typed refusal rather than spinning until the
 * deadline: §3.5 says spawn-then-re-probe happens ONCE, and the wait path
 * re-probes from the top, so a small fixed bound covers every legitimate
 * sequence.
 */
const MAX_PASSES = 4;

export class DaemonUnavailable extends Error {
  readonly code: "rotation-in-progress" | "unavailable";

  constructor(code: "rotation-in-progress" | "unavailable", message: string) {
    super(message);
    this.name = "DaemonUnavailable";
    this.code = code;
  }
}

/**
 * Runs one request against the daemon, auto-starting it if absent.
 *
 * Returns an `RpcResponse`. A returned `outcome-unknown` is a real,
 * terminal answer — the caller must NOT retry it (§5). A thrown
 * `DaemonUnavailable` means nothing was ever written, so the caller may
 * retry as a first attempt.
 */
export async function daemonRequest(opts: DaemonRequestOptions): Promise<RpcResponse> {
  const paths = daemonPaths(opts.stateDir);
  const spawnChild = opts.spawn ?? spawnDaemon;
  const expiry = Date.now() + opts.deadlineMs;

  // The client-side half of the §3.2 boundary. `connect` mode verifies
  // only — a client never mutates the state directory (that is the
  // daemon's prerogative), but it must refuse to hand a request to a
  // socket sitting in a directory whose ownership or mode would let
  // another uid reach it.
  //
  // A directory that does not exist yet is the one case that is NOT a
  // boundary violation: on a fresh install nothing has created
  // `~/.conduit`, and "absent" IS decision-table row 4 — a lock nobody
  // can open is a lock nobody holds, so there is no daemon and no
  // rotation. Any OTHER code still refuses: a directory that exists and
  // is unsafe is a boundary break, not a fresh install.
  //
  // The client never creates the directory itself — that stays the
  // daemon's prerogative. It simply proceeds into the loop, where both
  // probes read "free" against a missing directory (a lock nobody can
  // open is a lock nobody holds), lands on row 4, and spawns; the
  // daemon's own `ensureStateDir` then creates it under the same
  // mkdir-then-assert boundary that governs every other start.
  try {
    await assertStateDir(opts.stateDir, "connect");
  } catch (err) {
    if (!(err instanceof StateDirError) || err.code !== "NOT_FOUND") throw err;
  }

  let spawned = false;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (Date.now() >= expiry) break;

    // Row 1 — rotation. Checked FIRST and every pass, including after a
    // wait: §3.5 step 5 is explicit that a client's view is stale the
    // moment it is taken, so the branch is revalidated rather than
    // remembered. Rotation is fail-fast with no spawn: a daemon started
    // now would only exit "rotation in progress" itself, and spinning
    // would starve the rotation this refusal exists to let finish.
    if ((await probeShared(paths.maintenanceLockDb)) === "busy") {
      throw new DaemonUnavailable(
        "rotation-in-progress",
        "[conduit] Daemon unavailable: key rotation is in progress. Context: {stateDir: " +
          `${opts.stateDir}} — retry once rotation finishes`,
      );
    }

    const lifecycle = await probeShared(paths.lifecycleLockDb);

    if (lifecycle === "busy") {
      // Row 2/3 — a daemon holds lifecycle: it is running, starting, or
      // draining. Try to connect; only a connect that reaches READY is a
      // healthy daemon.
      let socket = await tryConnect(paths.socket, remaining(expiry));
      if (socket === null) {
        // Row 3 — starting or draining, and the two are indistinguishable
        // from out here. So the wait watches for EITHER outcome rather
        // than only one: a DRAINING daemon ends by releasing the
        // lifecycle lock, but a STARTING one holds it the whole time and
        // resolves by BINDING — the lock is taken before the store opens
        // and the sweep runs, so a perfectly healthy daemon sits in that
        // window with the socket not yet there. Waiting only for release
        // would burn the entire deadline against a daemon that came up
        // fine seconds earlier.
        socket = await waitForStartOrRelease(paths, expiry);
        // Still nothing — the lock released (drain finished, or the
        // daemon died) or time ran out. RE-PROBE FROM THE TOP rather
        // than assuming which: rotation may have taken maintenance in
        // the meantime, so the loop re-runs row 1 instead of falling
        // through to spawn.
        if (socket === null) continue;
      }

      const ready = await awaitReady(socket, remaining(expiry));
      if (ready.ready) {
        // Past this point the request bytes go out and the retryable
        // zone ends. The READY gate's decoder and any frames it already
        // read past READY travel into the exchange — see `awaitReady`
        // for why starting a fresh decoder here would be a bug.
        return await exchange(socket, opts.role, opts.request, expiry, ready);
      }
      // Connected but no READY — accepted-or-queued during DRAINING.
      // Identical to a refused connect, and crucially NOTHING was
      // written, so the next attempt is still a first attempt.
      socket.destroy();
      continue;
    }

    // Row 4 — neither lock held: no daemon and no rotation. Spawn, then
    // probe again. Once only: a second spawn after a failed re-probe
    // would mean something is wrong that another process cannot fix, and
    // spawn loops are how fork bombs happen.
    if (spawned) {
      break;
    }
    spawnChild(opts.stateDir);
    spawned = true;
    // The child must acquire its locks and bind before the next pass can
    // see it. Waiting for the lifecycle lock to be TAKEN is the earliest
    // observable evidence the child is alive, and it is strictly better
    // than a fixed sleep.
    await waitForLifecycleHeld(paths.lifecycleLockDb, expiry);
  }

  // Names the daemon's own log: this is the terminal failure, and the
  // cause is never on the wire (the daemon that would have reported it
  // is the thing that could not be reached). Without the path, "no
  // daemon could be started" is a dead end — with it, the next step is
  // to read why the child exited.
  throw new DaemonUnavailable(
    "unavailable",
    `[conduit] Daemon unavailable: no daemon could be reached or started within the deadline. Context: {stateDir: ${opts.stateDir}, deadlineMs: ${opts.deadlineMs}} — see ${join(opts.stateDir, DAEMON_LOG)} for why the daemon exited`,
  );
}

function remaining(expiry: number): number {
  return Math.max(0, expiry - Date.now());
}

/**
 * Connects, or resolves null if the endpoint refuses/is absent. A refusal
 * is information, not an error, and it explicitly does NOT license
 * removing the socket (§3.2) — hence no unlink anywhere in this module.
 */
function tryConnect(socketPath: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (result: Socket | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("error", onError);
      if (result === null) socket.destroy();
      resolve(result);
    };
    // A connect that neither succeeds nor errors is possible: a full
    // listen backlog leaves the SYN unanswered, so without this the
    // attempt outlives the caller's whole budget waiting on a socket
    // that will never report either way.
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onError = (): void => finish(null);
    socket.once("error", onError);
    socket.once("connect", () => finish(socket));
  });
}

/**
 * The outcome of the READY gate. On success it carries the decoder state
 * forward — see `awaitReady` for why that is mandatory rather than tidy.
 */
type ReadyResult =
  | { ready: false }
  | {
      ready: true;
      /** The SAME decoder that consumed the READY frame. */
      decoder: FrameDecoder;
      /** Frames that arrived in the READY chunk, after the READY frame. */
      pending: unknown[];
    };

/**
 * Waits for the daemon's READY preface. Resolves `{ready: false}` if the
 * connection closes or the deadline passes first — both meaning the
 * daemon never accepted this connection while RUNNING. No bytes are
 * written here; that is the entire point of the gate.
 *
 * **The decoder is handed to the caller, never discarded.** A UDS
 * delivers arbitrary chunk boundaries, so bytes following READY can
 * arrive coalesced into the same chunk — and a frame can also be split
 * across chunks, leaving a partial body buffered inside this decoder.
 * Constructing a fresh decoder for the next phase would silently drop
 * both: the already-decoded frames, and the partial-frame bytes this one
 * still holds. That loss would surface as a response that never arrives,
 * i.e. a spurious `outcome-unknown` on a request the daemon actually
 * answered — the single worst failure this module can produce, since it
 * is indistinguishable from a genuine ambiguity.
 *
 * Today the daemon writes nothing between READY and the handshake
 * response, so neither case can fire in practice. That is a property of
 * the current daemon, not of the protocol, and this seam must not depend
 * on it.
 */
function awaitReady(socket: Socket, timeoutMs: number): Promise<ReadyResult> {
  return new Promise((resolve) => {
    const decoder = new FrameDecoder();
    let settled = false;
    const finish = (result: ReadyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ready: false }), timeoutMs);
    const onData = (chunk: Buffer): void => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        finish({ ready: false });
        return;
      }
      const at = messages.findIndex((msg) => isKind(msg, "ready"));
      if (at !== -1) {
        // Everything after READY in this same chunk belongs to the next
        // phase and travels with the decoder rather than being dropped.
        finish({ ready: true, decoder, pending: messages.slice(at + 1) });
      }
    };
    socket.on("data", onData);
    socket.once("close", () => finish({ ready: false }));
    socket.once("error", () => finish({ ready: false }));
  });
}

/**
 * Handshake, then the request — the only place this module writes bytes.
 *
 * Everything after the first write is in §5's ambiguous zone, so every
 * failure path below resolves `outcome-unknown` rather than throwing a
 * retryable error or retrying internally. The handshake write counts:
 * once ANY byte has gone out, the client can no longer prove the daemon
 * did nothing, and a caller that treated a handshake-phase drop as
 * retryable would eventually replay a request that had in fact been
 * delivered on a later connection.
 */
async function exchange(
  socket: Socket,
  role: keyof typeof CAPABILITIES,
  request: RpcRequest,
  expiry: number,
  ready: Extract<ReadyResult, { ready: true }>,
): Promise<RpcResponse> {
  // Continues the READY gate's decoder rather than starting a new one, so
  // no byte the daemon has already sent can be lost at the phase boundary.
  const reader = createReader(socket, ready.decoder, ready.pending);
  try {
    // The client's own CONDUIT_DB, when set, is declared rather than
    // hidden: the daemon refuses it with `refused-custom-db` (§9.3 item
    // 3). Concealing it would serve the client against a database it did
    // not ask for, which is the failure this field exists to prevent.
    const dbPath = process.env.CONDUIT_DB?.trim();
    socket.write(
      encodeFrame({
        kind: "handshake",
        protocol: 1,
        capability: role,
        ...(dbPath ? { dbPath } : {}),
      }),
    );

    const handshake = await reader.next(remaining(expiry));
    if (handshake === null) return unknownOutcome(null);
    if (isKind(handshake, "error")) return handshake as RpcResponse;
    if (!isKind(handshake, "handshake.ok")) return unknownOutcome(handshake);

    socket.write(encodeFrame(request));
    const response = await reader.next(remaining(expiry));
    if (response === null) return unknownOutcome(null);
    return response as RpcResponse;
  } finally {
    reader.dispose();
    socket.destroy();
  }
}

/**
 * Synthesizes the §5 `outcome unknown` verdict client-side. There is no
 * wire message for it — the daemon that would have sent one is gone —
 * so the id is taken from whatever partial response arrived, and falls
 * back to the sentinel when nothing did. See UNCORRELATED.
 */
function unknownOutcome(partial: unknown): RpcResponse {
  const requestId =
    typeof partial === "object" &&
    partial !== null &&
    typeof (partial as { requestId?: unknown }).requestId === "string"
      ? (partial as { requestId: string }).requestId
      : UNCORRELATED;
  return { kind: "outcome-unknown", requestId };
}

interface Reader {
  /** Next decoded frame, or null if the connection closed / time ran out. */
  next(timeoutMs: number): Promise<unknown | null>;
  dispose(): void;
}

/**
 * `decoder` and `alreadyRead` come from the READY gate: the decoder may
 * hold a partially-received frame, and `alreadyRead` holds frames that
 * arrived coalesced with READY. Both must be adopted, never recreated.
 */
function createReader(socket: Socket, decoder: FrameDecoder, alreadyRead: unknown[]): Reader {
  const buffered: unknown[] = [...alreadyRead];
  let waiter: ((msg: unknown | null) => void) | null = null;
  let closed = false;

  const deliver = (msg: unknown | null): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(msg);
    } else if (msg !== null) {
      buffered.push(msg);
    }
  };

  const onData = (chunk: Buffer): void => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      closed = true;
      deliver(null);
      return;
    }
    for (const msg of messages) deliver(msg);
  };
  const onEnd = (): void => {
    closed = true;
    deliver(null);
  };

  socket.on("data", onData);
  socket.once("close", onEnd);
  socket.once("error", onEnd);

  return {
    next(timeoutMs: number): Promise<unknown | null> {
      const ready = buffered.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiter = null;
          resolve(null);
        }, timeoutMs);
        waiter = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
      });
    },
    dispose(): void {
      socket.removeListener("data", onData);
      socket.removeListener("close", onEnd);
      socket.removeListener("error", onEnd);
    },
  };
}

/**
 * Waits out a daemon that holds the lifecycle lock, resolving on
 * whichever of the two possible outcomes happens first:
 *
 * - a **connected socket**, meaning a STARTING daemon finished binding.
 *   The caller carries it straight into the READY gate; reconnecting
 *   would only race the same window again.
 * - **null**, meaning the lock went free (a DRAINING daemon exited, or
 *   the holder died) or the deadline passed. The caller re-probes from
 *   the top of the decision table.
 *
 * Both are polled on the same tick because the client cannot tell
 * STARTING from DRAINING from outside: they present identically (lock
 * held, no socket), and they resolve in opposite directions. Watching
 * only for release would make a healthy start cost the full deadline;
 * watching only for the socket would hang on a daemon that is leaving.
 */
async function waitForStartOrRelease(paths: DaemonPaths, expiry: number): Promise<Socket | null> {
  while (Date.now() < expiry) {
    await sleep(Math.min(LIFECYCLE_WAIT_POLL_MS, remaining(expiry)));

    const socket = await tryConnect(paths.socket, remaining(expiry));
    if (socket !== null) return socket;

    if ((await probeShared(paths.lifecycleLockDb)) === "free") return null;
  }
  return null;
}

/** Polls until a spawned daemon has TAKEN the lifecycle lock. */
async function waitForLifecycleHeld(lockDb: string, expiry: number): Promise<void> {
  while (Date.now() < expiry) {
    if ((await probeShared(lockDb)) === "busy") return;
    await sleep(Math.min(LIFECYCLE_WAIT_POLL_MS, remaining(expiry)));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isKind(msg: unknown, kind: string): boolean {
  return typeof msg === "object" && msg !== null && (msg as { kind?: unknown }).kind === kind;
}
