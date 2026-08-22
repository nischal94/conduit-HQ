/**
 * Transport-agnostic control handlers (spec §7).
 *
 * Nothing here knows about sockets, frames, or HTTP. The handlers take a
 * PRINCIPAL and a dependency record and return a payload; the transport
 * owns everything else. That split is what lets step 4 mount these same
 * two functions over HTTP behind the §16 floor without a second
 * implementation of the projections, and it is why `daemonStop` returns
 * an intent rather than performing the stop: only the transport knows
 * when its answer is actually on the wire.
 *
 * The principal is constructed by the TRANSPORT, server-side, and is
 * NEVER decoded from the request. The UDS transport constructs
 * `anonymous-local` unconditionally — the §3.2 directory boundary is what
 * authenticates a caller there, so a principal field on the wire would be
 * a client-supplied authorization input, which is precisely the thing a
 * credential boundary must not accept.
 *
 * `_principal` is therefore unused today: `anonymous-local` is the only
 * variant, and authorization is decided by the connection's capability
 * row before dispatch ever reaches here. The parameter stays in the
 * signature because it is the seam a second transport would need, and
 * because a handler that never sees its principal cannot later be given
 * one without changing every call site.
 */
import type { DaemonStatusPayload, DaemonStopPayload } from "../payloads.js";

export type Principal = { kind: "anonymous-local" };

export interface ControlDeps {
  pid: () => number;
  agentVersion: string;
  startedAt: number;
  dbPath: string;
  connectionCount: () => number;
  queueStats: () => { depth: number; activeCount: number };
  logInfo: () => { path: string; sizeBytes: number } | null;
}

export function daemonStatus(_principal: Principal, deps: ControlDeps): DaemonStatusPayload {
  const queue = deps.queueStats();
  const log = deps.logInfo();
  return {
    pid: deps.pid(),
    agentVersion: deps.agentVersion,
    startedAt: deps.startedAt,
    dbPath: deps.dbPath,
    connections: deps.connectionCount(),
    executionsInFlight: queue.activeCount,
    queueDepth: queue.depth,
    logPath: log === null ? null : log.path,
    logSizeBytes: log === null ? null : log.sizeBytes,
  };
}

/**
 * Returns the stopping intent only. The TRANSPORT flushes the response
 * frame and THEN triggers the stop (spec §3.1): signaling shutdown before
 * the ack is on the wire could close the connection under the reply.
 */
export function daemonStop(_principal: Principal): DaemonStopPayload {
  return { stopping: true };
}
