/**
 * The per-connection protocol (design §3.3, §3.5). One connected client
 * is one `ConnectionContext` plus the state machine that drives it:
 * READY preface, handshake-once capability binding, frame decode,
 * capability check, dispatch, error-frame writing, and the
 * disconnect/queue-entry cleanup hooks.
 *
 * The split from `conduitd.ts` is by lifetime, not by layer. That file
 * owns things whose lifetime is the DAEMON's — kernel locks, startup
 * order, bind, the drain, signals, the ExecutionQueue. This one owns
 * everything whose lifetime is a single CONNECTION's, and reaches the
 * daemon only through the explicit `ConnectionDeps` it is handed: the
 * queue's `submit`, the runtime handles (`store`, `createRuntime`), and
 * the drain state. Nothing here reads daemon-scope mutable state
 * directly, which is why `isDraining` is a getter rather than a boolean
 * snapshot — the drain flips it after these handlers are already
 * installed.
 */
import type { Socket } from "node:net";
import { type ConduitStore, InMemoryCatalog } from "@conduithq/sdk";
import type { createApprovalRuntime } from "../runtime.js";
import {
  DepthExceeded,
  encodeFrame,
  FRAME_CAP,
  FrameDecoder,
  FrameTooLarge,
  MalformedFrame,
} from "./frames.js";
import {
  CAPABILITIES,
  type Capability,
  decodeRequest,
  InvalidRpcRequest,
  type RpcRequest,
  type RpcResponse,
} from "./rpc.js";

/**
 * Admission deadline for `approvals.resume`, which — unlike `execute` —
 * carries no client-supplied `deadlineMs` in its §3.3 request shape.
 *
 * Resume goes through the same queue as execute (it re-enters sandbox
 * execution), so it needs an admission bound like every other entry: an
 * entry that never expires is precisely the unbounded queue growth the
 * capacity cap exists to prevent. Normative-local, chosen here.
 */
export const RESUME_ADMISSION_DEADLINE_MS = 60_000;

export interface ConnectionContext {
  socket: Socket;
  capability: Capability | null;
  /**
   * Whether this connection was sent READY. §3.5 counts a READY-granted
   * connection as active work, so drain leaves it open through the grace
   * window rather than cutting it at drain start — see the drain block.
   */
  readyGranted: boolean;
  /** In-flight request promises; drain waits on all of them. */
  inFlight: Set<Promise<unknown>>;
  /** Abandon hooks for this connection's still-queued entries. */
  queued: Set<() => void>;
  /** Source of this connection's daemon-assigned correlation ids. */
  requestCounter: { n: number };
}

/**
 * Everything the connection protocol needs from the daemon runtime,
 * passed explicitly rather than closed over. `submit` is the queue's
 * admission call and `isDraining` the live drain state; the rest are the
 * handles one unit of work runs against.
 */
export interface ConnectionDeps {
  store: ConduitStore;
  allowPrivateEgress: boolean;
  dbPath: string;
  log: (line: string) => void;
  createRuntime: typeof createApprovalRuntime;
  /** The daemon's admission queue, reached only through submit. */
  submit: (run: () => Promise<void>, deadlineMs: number) => Admission;
  /** Live drain state — read per connection, never snapshotted. */
  isDraining: () => boolean;
  /** Registry of live connections; the drain iterates it. */
  connections: Set<ConnectionContext>;
  /** Queue observability for the admission log lines. */
  queueStats: () => { depth: number; maxObservedDepth: number; activeCount: number };
  /** Refusal message for a full queue — carries the normative caps. */
  busyMessage: string;
}

export type QueueOutcome = "ran" | "expired" | "abandoned";

export type Admission =
  | { outcome: "busy" }
  | { outcome: "accepted"; done: Promise<QueueOutcome>; abandon(): void };

/**
 * Writes one response frame, dropping it if the peer is already gone.
 *
 * A drop is logged rather than silent: the client sees only a closed
 * connection (§5's `outcome unknown`), so the daemon log is the ONLY
 * place the distinction between "we never produced a reply" and "we
 * produced one the client was no longer there to receive" can be
 * recovered. The correlation id is what makes that line joinable to the
 * request that produced it.
 */
export function send(socket: Socket, msg: RpcResponse, log?: (line: string) => void): void {
  if (socket.destroyed) {
    const requestId = "requestId" in msg ? msg.requestId : "n/a";
    log?.(
      `[conduitd] Response dropped: client socket already destroyed. Context: {requestId: ${requestId}, kind: ${msg.kind}}`,
    );
    return;
  }
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
  "internal daemon error; see the daemon log for the cause, correlated by this error's requestId";

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

/**
 * Accepts one connection: installs its handlers and writes the READY
 * preface. The whole per-connection state machine hangs off this call.
 */
export function handleConnection(socket: Socket, deps: ConnectionDeps): void {
  const { log, connections } = deps;

  // The READY gate (§3.5): a connect can succeed at the kernel level —
  // queued in the listen backlog — moments before the listener closes.
  // READY is sent only for connections accepted while RUNNING, so a
  // client that never sees one knows nothing was served and may retry
  // as a first attempt rather than a replay.
  if (deps.isDraining()) {
    socket.destroy();
    return;
  }

  const ctx: ConnectionContext = {
    socket,
    capability: null,
    readyGranted: false,
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
      send(
        socket,
        {
          kind: "error",
          requestId: "",
          code: "invalid",
          message: protocolFault ? (err as Error).message : INTERNAL_ERROR_MESSAGE,
        },
        log,
      );
      socket.destroy();
      return;
    }
    for (const msg of messages) {
      const promise = dispatch(ctx, msg, deps);
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
  socket.on("error", (err: NodeJS.ErrnoException) => {
    // Logged, not swallowed: a mid-response EPIPE/ECONNRESET is the
    // daemon-side evidence that a reply did not land, and without a
    // line here it is invisible from inside the daemon — the client
    // just sees a closed connection and the operator has nothing to
    // join against. Destroying remains the right disposition; only
    // the silence was wrong.
    log(
      `[conduitd] Connection error. Context: {code: ${err.code ?? "unknown"}, cause: ${err.message}}`,
    );
    socket.destroy();
  });

  // READY is the ONLY frame written before the client's first request:
  // the daemon is purely reactive from here, replying only to frames it
  // receives. Clients need not depend on that — `client.ts` carries its
  // READY-gate decoder into the next phase, so a frame coalesced with
  // READY (or split across chunks) survives regardless. Anything added
  // here that writes unprompted must keep that decoder-handoff intact.
  send(socket, { kind: "ready" }, log);
  ctx.readyGranted = true;
}

async function dispatch(ctx: ConnectionContext, msg: unknown, deps: ConnectionDeps): Promise<void> {
  const { log } = deps;
  const requestId = nextRequestId(ctx.requestCounter);
  let request: RpcRequest;
  try {
    request = decodeRequest(msg);
  } catch (err) {
    // Mirrors the frame-decode split above. `InvalidRpcRequest` is a
    // verdict about the CLIENT'S OWN bytes, so echoing it tells the
    // client how to fix its request and reveals nothing about daemon
    // state. Anything else reaching here is an unexpected fault inside
    // the decoder — its message could carry internal detail, so it is
    // logged daemon-side and the client gets the fixed string.
    const invalidRequest = err instanceof InvalidRpcRequest;
    if (!invalidRequest) {
      log(
        `[conduitd] Request decode failed: unexpected fault. Context: {requestId: ${requestId}, cause: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }}`,
      );
    }
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "invalid",
        message: invalidRequest ? (err as Error).message : INTERNAL_ERROR_MESSAGE,
      },
      log,
    );
    return;
  }

  if (request.kind === "handshake") {
    handleHandshake(ctx, request, requestId, deps);
    return;
  }

  if (ctx.capability === null) {
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "invalid",
        message: "handshake required before any other request",
      },
      log,
    );
    return;
  }
  // The capability set is the authorization boundary (§3.3): a request
  // outside the client's declared set is refused before any other work.
  if (!CAPABILITIES[ctx.capability].has(request.kind)) {
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "invalid",
        message: `capability "${ctx.capability}" does not permit "${request.kind}"`,
      },
      log,
    );
    return;
  }

  try {
    await handleRequest(ctx, request, requestId, deps);
  } catch (err) {
    // Detail daemon-side, generic message to the client — the cause is
    // correlated by requestId rather than copied onto the wire.
    log(
      `[conduitd] Request failed: ${request.kind}. Context: {requestId: ${requestId}, cause: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }}`,
    );
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "internal",
        message: INTERNAL_ERROR_MESSAGE,
      },
      log,
    );
  }
}

function handleHandshake(
  ctx: ConnectionContext,
  request: Extract<RpcRequest, { kind: "handshake" }>,
  requestId: string,
  deps: ConnectionDeps,
): void {
  const { log, dbPath, allowPrivateEgress } = deps;
  // A connection's capability is assigned EXACTLY ONCE. `handshake` is a
  // member of every capability set (§3.3), so without this guard a
  // client refused an out-of-set request could simply re-handshake as a
  // wider role and retry it — the authorization check below would then
  // pass. Capability is a property of the connection, not a mutable
  // per-request field; a client wanting a different one opens a new
  // connection.
  if (ctx.capability !== null) {
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "invalid",
        message: "capability already negotiated on this connection",
      },
      log,
    );
    return;
  }
  // A client carrying its own CONDUIT_DB is refused rather than served
  // against a database it did not choose. Silently ignoring the value
  // would hide the mismatch at exactly the moment it matters (§9.3
  // item 3: custom-path installs keep direct access and forgo daemon
  // features in v1).
  if (request.dbPath !== undefined) {
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "refused-custom-db",
        message: "custom db paths bypass the daemon in v1; unset CONDUIT_DB to use it",
      },
      log,
    );
    ctx.socket.end();
    return;
  }
  ctx.capability = request.capability;
  send(ctx.socket, { kind: "handshake.ok", protocol: 1, dbPath, allowPrivateEgress }, log);
}

/** Fresh catalog snapshot per call (M6) — never cached across requests. */
async function snapshotCatalog(store: ConduitStore): Promise<InMemoryCatalog> {
  const catalog = new InMemoryCatalog();
  catalog.upsert(await store.tools.list());
  return catalog;
}

/**
 * Runs one unit of sandbox work and writes its reply, converting EVERY
 * failure into a typed error frame rather than a rejected promise.
 *
 * This exists because the queue's run closure is invoked as
 * `void this.dispatch(entry)` and `dispatch` awaits `entry.run()` with
 * only a `finally` — nothing catches. A rejection there is an unhandled
 * rejection, which under Node's default disposition terminates the
 * whole daemon: one client's failing execution would take down every
 * other client's long-lived process. Mirroring `dispatch`'s own outer
 * handler (log with the correlation id, send the fixed internal
 * message) keeps the failure scoped to the request that caused it.
 *
 * The oversize case is handled separately and honestly. The sandbox's
 * default `maxOutputBytes` (§16) EQUALS `FRAME_CAP`, so an ordinary,
 * entirely legal result envelope — the payload plus its `kind`,
 * `requestId` and JSON overhead — can exceed the frame cap. That is not
 * an internal fault and must not read as one: the client is told its
 * result did not fit the IPC frame, which is actionable (return less),
 * where "internal daemon error" would not be.
 */
async function runGuarded(
  ctx: ConnectionContext,
  requestId: string,
  kind: RpcRequest["kind"],
  work: () => Promise<unknown>,
  deps: ConnectionDeps,
): Promise<void> {
  const { log } = deps;
  let payload: unknown;
  try {
    payload = await work();
  } catch (err) {
    log(
      `[conduitd] Queued request failed: ${kind}. Context: {requestId: ${requestId}, cause: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }}`,
    );
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "internal",
        message: INTERNAL_ERROR_MESSAGE,
      },
      log,
    );
    return;
  }
  sendResult(ctx, requestId, payload, log);
}

/**
 * Writes a `result`, degrading to a typed error when the encoded frame
 * would exceed `FRAME_CAP`. Encoding happens inside `send`, so without
 * this the throw escapes into whatever called it — on the queue path,
 * into an unhandled rejection.
 */
function sendResult(
  ctx: ConnectionContext,
  requestId: string,
  payload: unknown,
  log: (line: string) => void,
): void {
  try {
    send(ctx.socket, { kind: "result", requestId, payload }, log);
  } catch (err) {
    if (!(err instanceof FrameTooLarge)) throw err;
    log(
      `[conduitd] Result too large for one IPC frame. Context: {requestId: ${requestId}, cap: ${FRAME_CAP}}`,
    );
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "invalid",
        message: `the result was too large for the IPC frame (cap ${FRAME_CAP} bytes); return less data`,
      },
      log,
    );
  }
}

/**
 * Submits one unit of sandbox work to the admission queue and owns the
 * whole §3.1 admission contract around it: the `busy` refusal, the
 * per-connection abandon bookkeeping, and the expiry reply.
 *
 * Both `execute` and `approvals.resume` go through here. A resume
 * re-enters sandbox execution exactly as `execute` does — it drives a
 * paused execution's replay — so admitting it outside the queue would
 * let N concurrent resumes run unbounded past the cap the queue exists
 * to enforce, in the same process, against the same store.
 */
async function submitSandboxWork(
  ctx: ConnectionContext,
  requestId: string,
  kind: RpcRequest["kind"],
  deadlineMs: number,
  work: () => Promise<unknown>,
  deps: ConnectionDeps,
): Promise<void> {
  const { log } = deps;
  const admission = deps.submit(async () => {
    await runGuarded(ctx, requestId, kind, work, deps);
  }, deadlineMs);

  if (admission.outcome === "busy") {
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "busy",
        message: deps.busyMessage,
      },
      log,
    );
    const stats = deps.queueStats();
    log(`queue depth=${stats.depth} max=${stats.maxObservedDepth} refused=busy`);
    return;
  }

  ctx.queued.add(admission.abandon);
  const stats = deps.queueStats();
  log(`queue depth=${stats.depth} max=${stats.maxObservedDepth} active=${stats.activeCount}`);
  const settled = await admission.done;
  ctx.queued.delete(admission.abandon);
  if (settled === "expired") {
    // Nothing ran, so this is not an ambiguous outcome — the request
    // was never admitted and may be retried as a first attempt.
    send(
      ctx.socket,
      {
        kind: "error",
        requestId,
        code: "busy",
        message: "queue deadline expired before a slot became available",
      },
      log,
    );
  }
}

async function handleRequest(
  ctx: ConnectionContext,
  request: RpcRequest,
  requestId: string,
  deps: ConnectionDeps,
): Promise<void> {
  const { store, allowPrivateEgress, log, createRuntime } = deps;
  switch (request.kind) {
    case "execute": {
      // deadlineMs bounds ADMISSION, not execution: §16's wall-clock
      // budget stays with the manager's own limits.
      await submitSandboxWork(
        ctx,
        requestId,
        request.kind,
        request.deadlineMs,
        async () => {
          // M6: a fresh runtime per unit of work — never cached.
          const { manager } = await createRuntime({ store, allowPrivateEgress, log });
          return await manager.start(request.code);
        },
        deps,
      );
      return;
    }
    case "search": {
      const catalog = await snapshotCatalog(store);
      send(
        ctx.socket,
        {
          kind: "result",
          requestId,
          payload: catalog.search({ query: request.query }),
        },
        log,
      );
      return;
    }
    case "describe": {
      const catalog = await snapshotCatalog(store);
      send(
        ctx.socket,
        {
          kind: "result",
          requestId,
          payload: catalog.describe(request.toolName) ?? null,
        },
        log,
      );
      return;
    }
    case "approvals.list": {
      const paused = await store.executions.listPaused();
      send(
        ctx.socket,
        {
          kind: "result",
          requestId,
          payload: paused.map((execution) => ({
            executionId: execution.id,
            startedAt: execution.startedAt,
            pausedOn: execution.pausedOn ?? null,
          })),
        },
        log,
      );
      return;
    }
    case "approvals.resume": {
      // Through the SAME queue as execute: a resume drives a paused
      // execution's replay, which is sandbox execution by another name.
      // Admitting it outside the queue would let N concurrent resumes
      // run past the cap in the one process the cap exists to protect.
      //
      // `approvals.resume` carries no client-supplied deadline (§3.3's
      // request shape), so the admission bound is the daemon's own
      // constant rather than a client-chosen one — deliberately NOT
      // unbounded, since an entry that never expires is exactly the
      // unbounded queue growth §3.1 rejects.
      await submitSandboxWork(
        ctx,
        requestId,
        request.kind,
        RESUME_ADMISSION_DEADLINE_MS,
        async () => {
          const { manager } = await createRuntime({ store, allowPrivateEgress, log });
          return await manager.resume(request.executionId, { kind: request.decision });
        },
        deps,
      );
      return;
    }
    case "source.provision":
    case "source.revalidate": {
      // Well-formed and permitted for `add-mcp`, but §3.3.1's
      // credential-handling design is not built here. `unimplemented`
      // rather than `invalid` so a client can tell "not yet" from
      // "you sent something wrong" and does not retry or reformat.
      send(
        ctx.socket,
        {
          kind: "error",
          requestId,
          code: "unimplemented",
          message: `"${request.kind}" arrives with the client-conversion work; use direct store access until then`,
        },
        log,
      );
      return;
    }
    case "handshake":
      return;
  }
}
