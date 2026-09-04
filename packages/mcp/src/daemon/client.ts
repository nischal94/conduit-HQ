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
import {
  isCheckPayloadShape,
  isDaemonStatusShape,
  isExecutePayloadShape,
  isResumePayloadShape,
  type RpcPayloadFor,
} from "../payloads.js";
import { type DaemonPaths, daemonPaths } from "./conduitd.js";
import { encodeFrame, FrameDecoder } from "./frames.js";
import {
  describeHolder,
  MAINTENANCE_PROBE_BUSY_TIMEOUT_MS,
  probeShared,
  probeSharedWithin,
  readLockHolder,
} from "./locks.js";
import type { CAPABILITIES, RpcRequest, RpcResponse } from "./rpc.js";
import { DAEMON_LOG, spawnDaemon } from "./spawn.js";
import {
  assertSafeAncestorChain,
  assertStateDir,
  type DirectoryIdentity,
  leafIdentity,
  StateDirError,
  sameLeaf,
} from "./state-dir.js";
import {
  canonicalOfMissing,
  isDefaultStateDir,
  resolveEffectiveStateDir,
} from "./state-dir-resolve.js";

// Re-exported so the historical import site (`./client.js`) keeps working
// for callers and tests written before these moved to their own module.
// The classification/resolution logic now lives in `state-dir-resolve.ts`
// so both the client and the daemon can reach it without an import cycle.
export {
  canonicalOfMissing,
  isDefaultStateDir,
  resolveEffectiveStateDir,
  sameDirectoryIdentity,
} from "./state-dir-resolve.js";

export interface DaemonRequestOptions<K extends RpcRequest["kind"] = RpcRequest["kind"]> {
  stateDir: string;
  role: keyof typeof CAPABILITIES;
  request: Extract<RpcRequest, { kind: K }>;
  /**
   * One bounded budget for the WHOLE attempt, waits and spawn included.
   *
   * **Must be at least `MIN_PASS_BUDGET_MS`.** The decision loop refuses to
   * enter a pass it has no room to act on, so a budget below that floor
   * would probe nothing, spawn nothing, and fall straight to the terminal
   * `unavailable` — a real daemon reported as absent because the caller's
   * arithmetic produced a number too small, with a message naming the
   * daemon log for a daemon that was never contacted. A sub-floor deadline
   * is therefore its own typed refusal naming the minimum, rather than a
   * silent no-probe "unavailable".
   */
  deadlineMs: number;
  /**
   * An explicit OFF switch for auto-start (Codex ARC F5).
   *
   * The auto-start boundary is now STRUCTURAL, not a value a caller must
   * remember to set: a production request (one with no injected `spawn`
   * seam) auto-starts a daemon ONLY when its `stateDir` is the canonical
   * default (`isDefaultStateDir`), because the production `spawnDaemon` is
   * zero-argument and derives that default — a spawn against any other
   * directory would start a default-dir daemon while this loop polls the
   * custom dir forever. A caller need do nothing to be safe: omitting this
   * on a custom directory refuses rather than misdirecting a spawn.
   *
   * This flag remains only as an EXPLICIT suppression even on the default
   * directory (a caller that wants a hard "never spawn, just report if
   * absent"). It cannot ENABLE a spawn the structural gate forbids —
   * `autoStart: true` against a custom production dir still refuses, because
   * the child would still derive the wrong directory. So it is honored in
   * one direction only: `false` always suppresses; unset/`true` permits a
   * spawn only where the gate already allows one.
   */
  autoStart?: boolean;
  /**
   * Injectable spawn seam for tests, which run daemons against throwaway
   * custom state directories. When present, this caller has taken explicit
   * ownership of WHERE the daemon starts, so the auto-start gate permits a
   * spawn against a non-default directory THROUGH THIS SEAM — the seam
   * receives the dir it must target. Production leaves this unset and
   * reaches the zero-argument `spawnDaemon`, which can only ever start the
   * default-dir daemon; the gate then permits it only for the default dir.
   */
  spawn?: (stateDir: string) => void;
  /**
   * Observes the daemon's `handshake.ok` when one is received.
   *
   * The handshake carries the daemon's effective, non-secret configuration
   * — §9 item 3: "the handshake reports protocol version, db path, and
   * effective non-secret security settings; clients print them on
   * mismatch". Every other caller only needs the RESPONSE, so the
   * handshake stays consumed inside `exchange`; `--doctor` is the one
   * caller whose entire job is reporting that configuration, and this
   * seam lets it read what arrived without changing the return type or
   * the ambiguity semantics for anyone else.
   *
   * Read-only by construction: the callback cannot alter the exchange,
   * and it fires at most once per attempt.
   *
   * `agentVersion` is the daemon's build version (§17), reported so a
   * client can diagnose version skew. It is `string | undefined`: a daemon
   * built BEFORE this field existed (pre-D-B1) sends a `handshake.ok`
   * without it, and that ABSENCE is itself the skew signal — a NEW client
   * observing `agentVersion: undefined` is talking to a stale daemon whose
   * capability vocabulary predates the request it is about to send. It is
   * NEVER used to authorize anything; it is a diagnostic.
   */
  onHandshake?: (info: {
    dbPath: string;
    allowPrivateEgress: boolean;
    agentVersion: string | undefined;
  }) => void;
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
 * The pacing for a pass that made NO PROGRESS.
 *
 * Every pass of the decision table opens lock-db clients — `probeShared`
 * takes a fresh one per probe by design (each hold/probe gets a dedicated
 * client; sharing one across passes is what the lock design forbids), so a
 * pass costs 2–3 client opens. At the 50ms poll interval a long deadline
 * spends that cost hundreds of times over: a 60s budget paced at 50ms
 * admits ~1,200 passes and roughly 2,400–3,600 client opens, nearly all of
 * them re-reading a state that has not changed.
 *
 * The distinction that makes this safe to slow down is PROGRESS. A pass
 * that observed a transition — the lock released, a socket appeared — is
 * chasing something moving and stays at the poll interval, because latency
 * there is the client's whole responsiveness. A pass that observed the SAME
 * state it observed last time is watching a daemon drain or fail to come
 * up, and neither finishes faster for being polled 20 times a second.
 *
 * At 4× the poll interval the two no-progress paths cost ~5 passes/second
 * instead of ~20. Worst case for a deadline D, all passes no-progress:
 * `floor((D − MIN_PASS_BUDGET_MS) / NO_PROGRESS_PACE_MS) + 1` passes, so at
 * most 3 probes each — for D = 60s that is ≤300 passes and ≤900 probes,
 * down from ~1,200 passes and ~3,600 probes. §3.5 semantics are untouched:
 * the same rows are read in the same order, the spawn is still rationed by
 * count, and no path that can make progress is slowed.
 */
const NO_PROGRESS_PACE_MS = LIFECYCLE_WAIT_POLL_MS * 4;

/**
 * How long a re-entry of the decision table must be able to make progress
 * in before the loop stops re-entering. Re-entry is bounded by TIME, not
 * by a fixed count of iterations.
 *
 * The count this replaced (`MAX_PASSES = 4`) conflated two different
 * things: OBSERVATION passes (a probe re-read, a wait that ended, a
 * connect that never reached READY) and the one SPEND action the design
 * actually rations (spawn — still exactly once, tracked by `spawned`
 * below). Every legitimate state transition burned a unit of the same
 * small budget, so a daemon that merely transitioned more often than the
 * budget allowed — a slow start under load, a drain followed by a
 * restart — produced a terminal `unavailable` with the deadline barely
 * touched. The failure was budget exhaustion reported as unavailability,
 * which sent operators to a daemon log describing a daemon that was
 * coming up fine.
 *
 * Time is the honest bound because it is the one the caller actually
 * expressed: `deadlineMs` is documented as "one bounded budget for the
 * WHOLE attempt, waits and spawn included", and it composes with the
 * deadline plumbing the request path already carries rather than adding
 * a second, invisible limit on top of it.
 *
 * The pathological case the count existed to stop — a flapping daemon
 * spun on forever — is still covered, and covered better: a pass that
 * observes no change and consumes no time cannot repeat, because each
 * re-entry must leave at least this much of the budget for the work it is
 * re-entering to do. A loop with less than this remaining stops and
 * reports, rather than issuing probes it has no time to act on.
 *
 * Normative-local, derived from the poll interval: one re-entry needs
 * room for at least a couple of `LIFECYCLE_WAIT_POLL_MS` polls plus the
 * probe round-trips between them, so the floor sits a small multiple
 * above that interval rather than at an independently-chosen number.
 */
export const MIN_PASS_BUDGET_MS = LIFECYCLE_WAIT_POLL_MS * 4;

/**
 * Exported ONLY so the floor's derivation can be pinned by a test — the
 * relationship to the poll interval is the invariant, not the number.
 * Nothing outside this module reads it to make a decision.
 */
export const LIFECYCLE_WAIT_POLL_MS_FOR_TEST = LIFECYCLE_WAIT_POLL_MS;

export class DaemonUnavailable extends Error {
  readonly code: "rotation-in-progress" | "unavailable";

  constructor(code: "rotation-in-progress" | "unavailable", message: string) {
    super(message);
    this.name = "DaemonUnavailable";
    this.code = code;
  }
}

/**
 * The response type for a given request kind: every non-`result` arm
 * unchanged, and `result.payload` narrowed to that kind's projection via
 * `RpcPayloadFor`.
 *
 * This is what retires the six blind `as` casts at the call sites. It is a
 * COMPILE-TIME claim about what the daemon is supposed to send, not
 * evidence about what arrived — `decodeResponse` still validates the
 * envelope, and the shapes whose misreading is dangerous are guarded at
 * the seam below. A caller reading `payload` on a kind whose answer is
 * genuinely open still gets `unknown` and must narrow it itself.
 */
export type RpcResponseFor<K extends RpcRequest["kind"]> =
  | Exclude<RpcResponse, { kind: "result" }>
  | { kind: "result"; requestId: string; payload: RpcPayloadFor<K> };

/**
 * Runs one request against the daemon, auto-starting it if absent.
 *
 * Returns an `RpcResponse` whose `result` payload is typed for the request
 * kind (see `RpcResponseFor`). A returned `outcome-unknown` is a real,
 * terminal answer — the caller must NOT retry it (§5). A thrown
 * `DaemonUnavailable` means nothing was ever written, so the caller may
 * retry as a first attempt.
 */
export async function daemonRequest<K extends RpcRequest["kind"]>(
  opts: DaemonRequestOptions<K>,
): Promise<RpcResponseFor<K>> {
  // The single canonical base (Codex ARC pass 4). EVERYTHING downstream —
  // `assertStateDir`'s validation, `daemonPaths`' socket/lock derivation, and
  // the dir the spawn seam is handed — is threaded through this one value, so
  // the directory that is validated and the directory the paths are derived
  // in are provably the same filesystem object. Deriving from the raw
  // `opts.stateDir` instead is the reverse-alias hole: a spelling that
  // resolves (through a symlink + `..`) to the default or to a legitimate
  // custom dir validates fine, while `daemonPaths`' lexical `join` lands the
  // socket under an attacker-controlled sibling. The classification gate
  // below still reads the RAW input — "is this the default?" is a question
  // about what the caller named, and `isDefaultStateDir` already answers it
  // by identity, not by string.
  const effectiveStateDir = resolveEffectiveStateDir(opts.stateDir);
  const paths = daemonPaths(effectiveStateDir);

  // Whether the caller named the canonical default. Read from the RAW input —
  // "is this the default?" is a question about what the caller named, and
  // `isDefaultStateDir` answers it by filesystem identity, not by string. It
  // decides the two base-kind-dependent behaviours below: the §5 NOT_FOUND
  // classification and (indirectly, via `spawnPermitted`) the auto-start gate.
  const isDefault = isDefaultStateDir(opts.stateDir);

  // The §17 §3.2 ancestor-chain rule (closes P1). A leaf that is itself a
  // self-owned 0700 directory is still unsafe if a DIFFERENT uid owns a
  // directory the path traverses to reach it — that uid can rename the
  // validated leaf out and drop a replacement before the client connects.
  // Checked against the KERNEL-FAITHFUL canonical form (the canonicalize half
  // of canonicalize-then-check, per §3.3), on the existing prefix of its walk,
  // and reported as a boundary break — never swallowed as "fresh install".
  //
  // `canonicalOfMissing` is applied even to the default branch's
  // `effectiveStateDir` (`DEFAULT_CONDUIT_DIR`, the passwd `~/.conduit`, which
  // the resolver returns un-realpath'd): on a standard install the passwd home
  // has no symlinked ancestors so it is already canonical and this is a no-op,
  // but on a symlinked-home install it makes the walk operate on the resolved
  // chain exactly as §3.3 specifies rather than on a spelling with an
  // unfollowed symlink. Idempotent on an already-canonical custom base.
  assertSafeAncestorChain(canonicalOfMissing(effectiveStateDir));

  // The auto-start gate, decided HERE rather than trusted from the caller
  // (Codex ARC F5 — the structural half). Two independent facts permit a
  // spawn against this `stateDir`:
  //
  //  - a TEST injected its own `spawn` seam, taking explicit ownership of
  //    where the daemon starts (the seam receives the dir); or
  //  - this is PRODUCTION (no injected seam) AND `stateDir` is the canonical
  //    default, the only directory the zero-argument `spawnDaemon` can
  //    start.
  //
  // A production request on a CUSTOM directory falls through to neither and
  // refuses at row 4 with the by-hand command — even if the caller passed
  // `autoStart: true`, because the child would still derive the DEFAULT dir
  // and answer nobody. `autoStart: false` suppresses in every case. This is
  // what makes the boundary a property of the code, not of caller
  // discipline: a new caller that forgets to reason about it is safe by
  // default.
  const spawnChild: (stateDir: string) => void =
    opts.spawn ??
    (() => {
      // The production seam is zero-argument by construction; it always
      // starts the default-dir daemon regardless of any argument, so the
      // gate below is the thing that guarantees it is only reached for the
      // default dir.
      spawnDaemon();
    });
  const spawnPermitted =
    opts.autoStart !== false && (opts.spawn !== undefined || isDefaultStateDir(opts.stateDir));

  // The floor, refused explicitly rather than discovered as a silent
  // no-probe. Below it the loop below is never entered even once, so the
  // client would report "no daemon could be reached or started" about a
  // daemon it never looked for — and point the operator at a daemon log
  // that has nothing to say, because no child was ever spawned. Naming the
  // minimum turns an unfalsifiable "unavailable" into a caller bug the
  // caller can fix.
  if (!Number.isFinite(opts.deadlineMs) || opts.deadlineMs < MIN_PASS_BUDGET_MS) {
    throw new DaemonUnavailable(
      "unavailable",
      `[conduit] Daemon unavailable: the request deadline is below the minimum one decision pass ` +
        `needs, so no daemon was probed or started. Context: {deadlineMs: ${opts.deadlineMs}, ` +
        `minimumMs: ${MIN_PASS_BUDGET_MS}} — this is a caller-side budget too small to act on, ` +
        `not evidence about any daemon.`,
    );
  }

  const expiry = Date.now() + opts.deadlineMs;

  // Encoded BEFORE anything connects, so an oversized request is refused
  // here — in the fully retryable zone, where the client can prove no
  // daemon saw it — rather than throwing from the write inside
  // `exchange`, where the same failure would be indistinguishable from a
  // request that had already gone out. A request too large to frame can
  // never succeed, and it should never reach the ambiguous zone to fail.
  const requestFrame = encodeFrame(opts.request);

  // The last connect errno that was NOT part of the decision table (see
  // `tryConnect`). Remembered rather than thrown so a transient fault
  // cannot abort a bounded wait, and surfaced in the terminal message so
  // the operator is not told "no daemon could be reached" when the real
  // answer was EACCES.
  let lastConnectError: string | undefined;
  const noteErrno = (code: string): void => {
    lastConnectError = code;
  };

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
  // The identity of the validated leaf, captured when it EXISTS so the
  // post-connect re-check (§17 §3.3) can prove the leaf the socket lives in
  // is the same object this validated. `undefined` when the leaf did not
  // exist at validation (a genuine fresh install — see the NOT_FOUND branch):
  // there is no object to pin, and the daemon's own `ensureStateDir` creates
  // and re-asserts the leaf under the same boundary before it binds.
  let validatedLeaf: DirectoryIdentity | undefined;

  try {
    // Validated against the SAME resolved base the socket/lock paths are
    // derived from (`effectiveStateDir`), never the raw spelling — that
    // equality is the whole point of the pass-4 fix: the dir this blesses is
    // exactly the dir the endpoint lives in.
    await assertStateDir(effectiveStateDir, "connect");
    // Existed and validated: pin its identity for the leaf-swap re-check.
    validatedLeaf = leafIdentity(effectiveStateDir);
  } catch (err) {
    if (!(err instanceof StateDirError) || err.code !== "NOT_FOUND") throw err;
    // NOT_FOUND is classified by BASE KIND (§17 §5), because the default and a
    // custom dir have OPPOSITE safe responses:
    //
    //  - CUSTOM dir, canonical form absent → REFUSE. Production auto-start is
    //    zero-argument and can only ever start the DEFAULT-dir daemon, so a
    //    custom dir that does not yet exist can never be SERVED by an
    //    auto-start; accepting it as "fresh install, proceed" would only open
    //    the P1 ancestor-swap window (the attacker creates the leaf in the
    //    gap). There is no legitimate auto-start outcome to protect, so the
    //    safe answer is the same refusal the auto-start gate gives — with the
    //    by-hand start command.
    //
    //  - DEFAULT dir absent → PROCEED. A genuine fresh install has not created
    //    `~/.conduit` yet; the base is the UID-anchored `DEFAULT_CONDUIT_DIR`
    //    (not attacker-chosen) and its existing ancestor prefix was just
    //    vouched for above, so both probes read "free", the loop lands on row
    //    4, and the daemon materializes the leaf 0700 and re-asserts under the
    //    same boundary. `validatedLeaf` stays `undefined` — nothing existed to
    //    pin — and the leaf-swap re-check is correctly skipped.
    //
    // An injected `spawn` seam is a TEST that has taken explicit ownership of
    // where the daemon starts (it can start one against this very custom dir),
    // so a not-yet-existent custom dir is a legitimate fresh install for it,
    // exactly as the default is for production — it proceeds, not refuses.
    if (!isDefault && opts.spawn === undefined) {
      throw new DaemonUnavailable(
        "unavailable",
        `[conduit] Daemon unavailable: the custom state directory ${opts.stateDir} does not exist, ` +
          `and auto-start cannot create one (a spawned daemon runs against the DEFAULT directory, ` +
          `not this one). Start it by hand: conduit-mcp --daemon --state-dir ${opts.stateDir}`,
      );
    }
  }

  let spawned = false;

  // Re-entry is bounded by TIME (see MIN_PASS_BUDGET_MS): the loop keeps
  // re-reading the table for as long as the caller's own deadline leaves
  // room to act on what it reads. The one rationed action inside remains
  // rationed by COUNT — `spawned` below still permits exactly one spawn,
  // because "how many daemons may this client start" is a question about
  // the action, not about how long the client is willing to wait.
  while (remaining(expiry) >= MIN_PASS_BUDGET_MS) {
    // Row 1 — rotation. Checked FIRST and every pass, including after a
    // wait: §3.5 step 5 is explicit that a client's view is stale the
    // moment it is taken, so the branch is revalidated rather than
    // remembered. Rotation is fail-fast with no spawn: a daemon started
    // now would only exit "rotation in progress" itself, and spinning
    // would starve the rotation this refusal exists to let finish.
    //
    // NOTE the converse race, which runs the other way: this probe takes
    // the maintenance lock SHARED for the instant it reads, so a `key
    // rotate` attempting its EXCLUSIVE acquisition inside that instant is
    // refused BUSY by a client that is merely looking. Each probe is one
    // SHARED acquisition wide (the re-probe window below holds nothing
    // between probes — plain timers), and it is self-healing — the
    // rotation's own refusal tells the operator to retry, and the probe is
    // gone by then. It is why the no-progress pacing above matters beyond
    // client cost: fewer probes per second is proportionally fewer instants
    // in which a rotation can be spuriously refused by a waiting client.
    //
    // The probe is re-issued for up to MAINTENANCE_PROBE_BUSY_TIMEOUT_MS
    // before a persistent BUSY is read as rotation: a daemon coming up
    // commits its holder stamp on this very lock db, and that commit is a
    // transient EXCLUSIVE a single fail-fast probe reads as "rotation" — a
    // terminal misread, because this row never retries. A real rotation is
    // still BUSY once the window elapses. The window is clamped so that
    // MIN_PASS_BUDGET_MS of the caller's budget REMAINS after it: a
    // transient that clears at the window's edge must leave this pass
    // enough time to probe lifecycle and connect — otherwise the pass
    // would spawn a daemon (rationed to once) and then report the deadline
    // spent, having started a daemon nobody waited for.
    if (
      (await probeSharedWithin(
        paths.maintenanceLockDb,
        Math.min(MAINTENANCE_PROBE_BUSY_TIMEOUT_MS, remaining(expiry) - MIN_PASS_BUDGET_MS),
      )) === "busy"
    ) {
      // The holder row read below names who LAST acquired; after a windowed
      // probe the EXCLUSIVE that answered BUSY is, by construction, one that
      // outlived the window — a rotation — so the daemon's own startup stamp
      // is the likelier stale row only when a transient cleared *exactly* at
      // the window's edge. `describeHolder`'s hedge already covers that.
      // Name the holder, exactly as `key rotate`'s own refusal does: the
      // operator gets told WHO to wait on rather than only that something
      // is in the way. Read only AFTER the kernel refused — the row is a
      // companion to that verdict, never a substitute — and hedged,
      // because a SIGKILLed holder leaves its row behind. An EXCLUSIVE
      // holder blocks the read, in which case `readLockHolder` answers
      // null and the clause is simply absent; it never fails the refusal.
      const holder = describeHolder(await readLockHolder(paths.maintenanceLockDb));
      throw new DaemonUnavailable(
        "rotation-in-progress",
        "[conduit] Daemon unavailable: key rotation is in progress. Context: {stateDir: " +
          `${opts.stateDir}}${holder} — retry once rotation finishes`,
      );
    }

    const lifecycle = await probeShared(paths.lifecycleLockDb);

    if (lifecycle === "busy") {
      // Row 2/3 — a daemon holds lifecycle: it is running, starting, or
      // draining. Try to connect; only a connect that reaches READY is a
      // healthy daemon.
      let socket = await tryConnect(paths.socket, remaining(expiry), noteErrno);
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
        socket = await waitForStartOrRelease(paths, expiry, noteErrno);
        // Still nothing — the lock released (drain finished, or the
        // daemon died) or time ran out. RE-PROBE FROM THE TOP rather
        // than assuming which: rotation may have taken maintenance in
        // the meantime, so the loop re-runs row 1 instead of falling
        // through to spawn.
        if (socket === null) continue;
      }

      const ready = await awaitReady(socket, remaining(expiry));
      if (ready.ready) {
        // The leaf-swap re-check (§17 §3.3), run AFTER connect+READY and
        // BEFORE the first byte, while still in the retryable zone. If the
        // leaf we validated existed, re-`lstat` it now and confirm its
        // `(dev, ino)` is unchanged: a parent-owner who renamed the validated
        // leaf out and dropped a replacement (holding this very socket) in the
        // window between validation and connect is caught here. A mismatch is
        // a boundary break — destroy the socket and abort with ZERO bytes
        // written, so the request (for `add-mcp`, the add secret) never
        // reaches the swapped-in endpoint. Nothing has been written, so this
        // throw is in the retryable zone; it is a refusal, not an ambiguity.
        if (
          validatedLeaf !== undefined &&
          !sameLeaf(leafIdentity(effectiveStateDir), validatedLeaf)
        ) {
          socket.destroy();
          throw new StateDirError(
            "UNSAFE_ANCESTOR",
            `state directory leaf changed identity between validation and connect (a parent-owner ` +
              `swap): ${effectiveStateDir} — refusing to send the request to a possibly-replaced ` +
              `endpoint. No bytes were written.`,
          );
        }
        // Past this point the request bytes go out and the retryable
        // zone ends. The READY gate's decoder and any frames it already
        // read past READY travel into the exchange — see `awaitReady`
        // for why starting a fresh decoder here would be a bug.
        return (await exchange(
          socket,
          opts.role,
          expiry,
          ready,
          requestFrame,
          opts.request.kind,
          opts.onHandshake,
        )) as RpcResponseFor<K>;
      }
      // Connected but no READY — accepted-or-queued during DRAINING.
      // Identical to a refused connect, and crucially NOTHING was
      // written, so the next attempt is still a first attempt.
      socket.destroy();
      // Paced before re-entering. This is the ONE re-entry path that can
      // complete without having waited on anything: a daemon that accepts
      // and immediately closes makes both `tryConnect` and `awaitReady`
      // return at once, so an unpaced `continue` would spin the table hot
      // until the deadline instead of waiting for the drain to finish.
      // Every other path either sleeps (`waitForStartOrRelease`,
      // `waitForLifecycleHeld`) or terminates. Under the old fixed pass
      // count this spin was capped by the count itself; with a
      // time-bounded loop the pacing has to be explicit.
      //
      // Paced at the NO-PROGRESS interval rather than the poll interval:
      // this pass observed a daemon that is draining, and a drain does not
      // finish faster for being watched. See `NO_PROGRESS_PACE_MS`.
      await sleep(Math.min(NO_PROGRESS_PACE_MS, remaining(expiry)));
      continue;
    }

    // Row 4 — neither lock held: no daemon and no rotation.
    //
    // Auto-start is gated STRUCTURALLY (F5): a production request may spawn
    // only for the canonical default directory, because the zero-argument
    // `spawnDaemon` can start nothing else — a spawn for a custom dir would
    // start a DEFAULT-dir daemon while this loop polls the custom dir, a
    // daemon that answers nobody. `spawnPermitted` folds that gate together
    // with the explicit `autoStart: false` off switch (see its computation
    // above). When a spawn is not permitted, refuse with the exact by-hand
    // start command instead of misdirecting one.
    if (!spawnPermitted) {
      throw new DaemonUnavailable(
        "unavailable",
        `[conduit] Daemon unavailable: no daemon is running for the custom state directory ` +
          `${opts.stateDir}, and auto-start is disabled for custom directories (a spawned daemon ` +
          `would run against the DEFAULT directory, not this one). Start it by hand: ` +
          `conduit-mcp --daemon --state-dir ${opts.stateDir}`,
      );
    }
    // Spawn, then probe again. Once only: a second spawn after a failed
    // re-probe would mean something is wrong that another process cannot
    // fix, and spawn loops are how fork bombs happen.
    if (spawned) {
      break;
    }
    // Handed the RESOLVED base, not the raw spelling: an injected test seam
    // starts its daemon under the same directory this loop derived its
    // socket/lock paths in, so client and daemon meet at one endpoint. The
    // production seam is zero-argument and ignores this — it always targets
    // `DEFAULT_CONDUIT_DIR`, which is exactly what `effectiveStateDir`
    // already is on the only path production reaches a spawn (the default).
    spawnChild(effectiveStateDir);
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
    `[conduit] Daemon unavailable: no daemon could be reached or started within the deadline. Context: {stateDir: ${opts.stateDir}, deadlineMs: ${opts.deadlineMs}${
      lastConnectError !== undefined ? `, last connect error: ${lastConnectError}` : ""
    }} — see ${join(effectiveStateDir, DAEMON_LOG)} for why the daemon exited`,
  );
}

function remaining(expiry: number): number {
  return Math.max(0, expiry - Date.now());
}

/**
 * Connects, or resolves null if the endpoint refuses/is absent. A refusal
 * is information, not an error, and it explicitly does NOT license
 * removing the socket (§3.2) — hence no unlink anywhere in this module.
 *
 * The errno is CLASSIFIED rather than discarded. `ECONNREFUSED`/`ENOENT`
 * are the decision table's own inputs — "nobody is listening at this
 * name" — and mean exactly what a null return means. Every other errno
 * (`EACCES` on a socket this uid may not open, `ENOTSOCK` on a path that
 * is not a socket, `EMFILE` when the CLIENT is out of descriptors) is a
 * different problem wearing the same clothes, and reading it as "starting
 * or draining" sends the client into a wait loop that will never resolve,
 * ending in a terminal message that names none of it.
 *
 * It is reported, never thrown: the wait path calls this repeatedly and a
 * transient `EMFILE` must not abort a bounded wait that would otherwise
 * succeed. The last such errno is remembered and surfaces in the terminal
 * `DaemonUnavailable` message.
 */
function tryConnect(
  socketPath: string,
  timeoutMs: number,
  onErrno?: (code: string) => void,
): Promise<Socket | null> {
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
    const onError = (err: NodeJS.ErrnoException): void => {
      const code = err.code;
      if (code !== undefined && code !== "ECONNREFUSED" && code !== "ENOENT") {
        onErrno?.(code);
      }
      finish(null);
    };
    socket.once("error", onError);
    socket.once("connect", () => finish(socket));
  });
}

/**
 * The outcome of the READY gate. On success it carries a live `Reader`
 * already bound to the connection's decoder state — the decoder itself
 * never escapes, so "recreate it for the next phase" is not an
 * expressible mistake.
 */
type ReadyResult = { ready: false } | { ready: true; reader: Reader };

/**
 * Waits for the daemon's READY preface. Resolves `{ready: false}` if the
 * connection closes or the deadline passes first — both meaning the
 * daemon never accepted this connection while RUNNING. No bytes are
 * written here; that is the entire point of the gate.
 *
 * **The decoder never leaves this function.** A UDS delivers arbitrary
 * chunk boundaries, so bytes following READY can arrive coalesced into
 * the same chunk — and a frame can also be split across chunks, leaving a
 * partial body buffered inside the decoder. Starting a fresh decoder for
 * the next phase would silently drop both: the already-decoded frames,
 * and the partial-frame bytes. That loss would surface as a response that
 * never arrives — a spurious `outcome-unknown` on a request the daemon
 * actually answered, which is the worst failure this module can produce
 * because it is indistinguishable from a genuine ambiguity.
 *
 * Rather than documenting that as a contract the caller must honor, the
 * `Reader` is constructed HERE, over that same decoder and the frames
 * that arrived after READY. The caller receives something it can only
 * read from; recreating the decoder is not an operation it has.
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
      } catch (err) {
        // Nothing has been written yet, so this stays a non-ready
        // outcome and the caller retries as a first attempt. But the
        // fault is REPORTED rather than swallowed: "the daemon sent
        // bytes we could not parse" and "the connection dropped" have
        // the same shape from here and completely different causes, and
        // only one of them means something is wrong with the daemon.
        process.stderr.write(
          `[conduit] Daemon sent an undecodable frame before READY; treating the connection as unusable. Context: {cause: ${
            err instanceof Error ? err.message : String(err)
          }}\n`,
        );
        finish({ ready: false });
        return;
      }
      const at = messages.findIndex((msg) => isKind(msg, "ready"));
      if (at !== -1) {
        // Everything after READY in this same chunk belongs to the next
        // phase and is handed to the reader rather than dropped.
        finish({
          ready: true,
          reader: createReader(socket, decoder, messages.slice(at + 1)),
        });
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
  expiry: number,
  ready: Extract<ReadyResult, { ready: true }>,
  requestFrame: Buffer,
  requestKind: RpcRequest["kind"],
  onHandshake?: DaemonRequestOptions["onHandshake"],
): Promise<RpcResponse> {
  // The reader was built by the READY gate over the decoder that consumed
  // READY, so no byte the daemon already sent is lost at this boundary.
  const { reader } = ready;
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
    if (handshake === null) return unknownOutcome(null, reader.decodeFault());
    if (isKind(handshake, "error")) return decodeResponseOrUnknown(handshake);
    if (!isKind(handshake, "handshake.ok")) return unknownOutcome(handshake, reader.decodeFault());

    // Surfaced through the validating decoder rather than the raw frame,
    // so an observer can never be handed a malformed handshake's fields.
    const validated = decodeResponse(handshake);
    if (validated !== null && validated.kind === "handshake.ok") {
      try {
        // `agentVersion` is read defensively rather than off the static type:
        // `decodeResponse` tolerates its ABSENCE (an old daemon omits it),
        // so the declared `string` can be `undefined` at runtime. That
        // undefined is not a defect to paper over — it is the skew signal the
        // observer is meant to receive. `typeof` narrows a present string and
        // maps everything else (including absence) to `undefined`.
        const agentVersion =
          typeof validated.agentVersion === "string" ? validated.agentVersion : undefined;
        onHandshake?.({
          dbPath: validated.dbPath,
          allowPrivateEgress: validated.allowPrivateEgress,
          agentVersion,
        });
      } catch {
        // "Cannot alter the exchange" is enforced, not merely intended.
        // This sits AFTER the handshake write, so an escaping observer
        // fault would unwind into §5's ambiguous zone and be reported as
        // `outcome-unknown` — telling the caller its request may have run
        // when the only thing that actually failed was a diagnostic
        // callback. A reporting seam must never be able to manufacture
        // ambiguity about the request it is merely watching.
      }
    }

    // Encoded BEFORE the connection was ever made (see `daemonRequest`),
    // so an oversized request has already been refused client-side and
    // cannot reach this write.
    socket.write(requestFrame);
    const response = await reader.next(remaining(expiry));
    if (response === null) return unknownOutcome(null, reader.decodeFault());
    // Envelope first, then the payload shapes the callers structurally
    // depend on — one seam, so no call site has to defend itself.
    return validatePayload(decodeResponseOrUnknown(response), requestKind);
  } finally {
    reader.dispose();
    socket.destroy();
  }
}

/**
 * Validates the PAYLOAD of a `result` for every kind whose payload a caller
 * structurally consumes, degrading to an `error` the caller already knows
 * how to report.
 *
 * `decodeResponse` validates the envelope and stops one field short: a
 * `result` with a `payload` key of any shape passes. That gap is where a
 * protocol fault turns into a WRONG ANSWER rather than a refusal —
 * `approvals.list` is the sharp case, because its caller maps over the
 * payload and a non-array produces either a raw `TypeError` out of an
 * operator command or, worse, an empty table that reads as "nothing awaits
 * you".
 *
 * The seam covers ALL the structurally-consumed kinds rather than that one.
 * Guarding a single kind was the more dangerous arrangement, not the
 * cheaper one: it made the OTHER call sites read as deliberately
 * unguarded, so each grew its own value-level hedge (a `typeof` on
 * `sourceCount`, a `?? []` on `warnings`) that silently substituted a
 * plausible default for an answer the daemon never gave. A per-kind
 * default is exactly the wrong-answer class this seam exists to convert
 * into a refusal.
 *
 * Deliberately still NOT a general payload schema check. The client is not
 * the authorization boundary (see `decodeResponse`), and validating every
 * field of every projection would be a second copy of the daemon's
 * senders, drifting from them. What is checked per kind is the STRUCTURAL
 * assumption its callers then rely on — the shape whose absence makes a
 * caller misbehave rather than merely read a missing optional field.
 *
 * Refusals are `error`/`internal` rather than `outcome-unknown`: these are
 * reads (and, for `source.provision`, a write whose response arrived — the
 * ambiguity §5 protects is about a response that never came, not about one
 * that came malformed). A malformed answer to a completed exchange has no
 * side effect to be ambiguous ABOUT. Reporting §5 ambiguity here would tell
 * an operator their query may have changed something, which is both false
 * and the opposite of actionable.
 *
 * Every message says what the operator must NOT assume, following the
 * `approvals.list` refusal's pattern: a protocol fault that reads as a
 * benign empty/absent answer is the failure mode, so each refusal names the
 * inference it is forbidding.
 */
function validatePayload(response: RpcResponse, kind: RpcRequest["kind"]): RpcResponse {
  if (response.kind !== "result") return response;

  const refuse = (message: string): RpcResponse => ({
    kind: "error",
    requestId: response.requestId,
    code: "internal",
    message,
  });

  switch (kind) {
    case "approvals.list": {
      const rows = response.payload;
      if (!Array.isArray(rows)) {
        return refuse(
          "the daemon's approvals.list answer was not a list of paused rows. " +
            "Nothing is being reported about the queue — do NOT assume it is empty. " +
            'Re-run "conduit approvals list"; if it persists, see the daemon log.',
        );
      }
      // Each row is rendered as a table cell and a date, so a row missing
      // the fields the renderer reads produces "Invalid Date" or a
      // RangeError at an operator rather than a refusal. Refuse the ROW SET
      // rather than dropping bad rows: a silently shorter queue is the same
      // wrong answer as an empty one.
      if (!rows.every(isPausedRowShape)) {
        return refuse(
          "the daemon's approvals.list answer contained a malformed paused row. " +
            "Nothing is being reported about the queue — do NOT assume it is empty. " +
            'Re-run "conduit approvals list"; if it persists, see the daemon log.',
        );
      }
      return response;
    }

    case "catalog.listing": {
      // `connections` is iterated to build `tools/list` and its length is
      // reported; `sourceCount` drives the "0 sources — onboard one" hint.
      // A missing/mistyped either one previously degraded to a plausible
      // default (an empty advertisement, a hint that fires anyway), which
      // tells the operator a fresh install has nothing on file when the
      // daemon may hold a full catalog.
      if (!isCatalogListingShape(response.payload)) {
        return refuse(
          "the daemon's catalog.listing answer was not a catalog projection. " +
            "Nothing is being reported about the catalog — do NOT assume it is empty or that " +
            "no sources are onboarded. Re-run; if it persists, see the daemon log.",
        );
      }
      return response;
    }

    case "source.provision":
    case "source.revalidate": {
      // `counts` is destructured into the success line and the --json
      // object, and `warnings` is iterated. A malformed `counts` printed
      // "undefined safe, undefined review" as a SUCCESS line after the
      // daemon had already committed the write — an onboarding the operator
      // would rationally re-run.
      if (!isProvisionPayloadShape(response.payload)) {
        return refuse(
          `the daemon's ${kind} answer was not a provisioning projection. ` +
            "The source's state on the daemon is NOT being reported here — do NOT assume " +
            "nothing was written. Check whether the source is registered before re-running.",
        );
      }
      return response;
    }

    case "approvals.resume": {
      // TWO axes, because `runDecide` branches on both and a break in
      // either produces the SAME false negative.
      //
      // `decisionApplied` carries the OPERATOR'S VERB truth (§17 D-T7-2):
      // whether the staged decision was consumed by the pending call. An
      // ABSENT field must never read as `false` — that reports a landed
      // deny as "never applied" (exit 1), sending the operator to re-issue
      // a decision the execution already consumed.
      //
      // `status` selects the command's ENTIRE output path, and it must be a
      // LEGAL member of the resume status set — not merely a string (F6). A
      // guard that accepted any string let `{status: "bogus",
      // decisionApplied: true}` through, and the deny arm would then print
      // "settled as bogus"; the never-applied arm reached the same false
      // answer for a payload missing `status` entirely. `isResumePayloadShape`
      // (payloads.ts, shared with the sender) checks BOTH: a legal status,
      // an `executionId`, and the boolean `decisionApplied`.
      if (!isResumePayloadShape(response.payload)) {
        return refuse(
          "the daemon's approvals.resume answer did not report the decision's fate " +
            "(whether it was applied, and what the execution then settled as). Do NOT assume " +
            "it was not applied — the decision may well have been consumed by the pending " +
            'call. Run "conduit approvals list" to see whether the execution is still ' +
            "awaiting a decision, and do not re-issue a decision blindly.",
        );
      }
      return response;
    }

    case "execute": {
      // Handed to the AGENT verbatim (`toTextResult` JSON-stringifies it), so
      // no client field access can throw — but the agent-facing contract
      // dispatches on `status`, and a payload whose `status` is absent OR an
      // illegal value (F6) is a frame the agent cannot act on. Validated to
      // the STRUCTURAL floor `isExecutePayloadShape` defines — a legal status
      // member plus the `executionId` `check_execution` needs — and no
      // deeper: field-by-field validation of `result`/`error`/`pending`
      // would be a second copy of the daemon's projection, the drift this
      // seam's docblock rules out.
      if (!isExecutePayloadShape(response.payload)) {
        return refuse(
          `the daemon's ${kind} answer carried no legal execution status. ` +
            "The execution's fate is NOT being reported here — do NOT assume it did not run. " +
            "Look it up with check_execution before re-issuing anything.",
        );
      }
      return response;
    }

    case "execution.get":
    case "execution.getByRequestKey": {
      // The check projection adds `running`/`not_found` to the execute set,
      // so it has its OWN legal-status predicate (`isCheckPayloadShape`): a
      // body status must be a legal member with an `executionId`, and the
      // bare `not_found` is accepted with no id (there is no execution to
      // name). Same membership-not-just-string floor as execute.
      if (!isCheckPayloadShape(response.payload)) {
        return refuse(
          `the daemon's ${kind} answer carried no legal execution status. ` +
            "The execution's fate is NOT being reported here — do NOT assume it did not run. " +
            "Look it up with check_execution before re-issuing anything.",
        );
      }
      return response;
    }

    case "daemon.status": {
      // Every field is interpolated into the operator's report, and
      // `startedAt` reaches `new Date(...).toISOString()` — where a
      // malformed value throws a RangeError at the operator as a stack
      // trace rather than as a refusal, the same failure the
      // `approvals.list` row guard exists to prevent.
      if (!isDaemonStatusShape(response.payload)) {
        return refuse(
          "the daemon's daemon.status answer was not a status projection. " +
            "Nothing is being reported about the daemon — do NOT assume it is unhealthy or " +
            'idle. Re-run "conduit daemon status"; if it persists, see the daemon log.',
        );
      }
      return response;
    }

    case "daemon.stop": {
      // DELIBERATELY EXEMPT, and named rather than left to fall through the
      // `default` — a silent omission reads as an oversight, and the next
      // reader adds a guard nobody needs.
      //
      // The exemption holds because NOTHING structurally consumes this
      // payload. `runStop` (cli `commands/daemon.ts`) checks the response
      // for its refusal arms and never reads `payload` at all: the ack means
      // "will stop", and the fact worth reporting is whether it DID, which
      // the lifecycle-lock poll answers. So there is no field whose
      // malformation could become a wrong answer here — the verification is
      // the lock, not the frame.
      //
      // THE CONDITION: this stops being true the moment a consumer reads
      // `stopping`. Such a consumer must add the guard here FIRST, before
      // reading it — the shape (`isDaemonStopShape`) does not exist yet
      // precisely because nothing needs it.
      return response;
    }

    default:
      return response;
  }
}

/**
 * The structural shape `runtime-stdio.ts` and `--doctor` depend on.
 *
 * `connections` must be a real array of listing views because it is
 * iterated into the advertised tool list; `sourceCount` must be a finite
 * number because it is compared against zero to decide whether to print the
 * onboarding hint.
 */
function isCatalogListingShape(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.sourceCount !== "number" || !Number.isFinite(p.sourceCount)) return false;
  if (!Array.isArray(p.connections)) return false;
  return p.connections.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return typeof e.prefix === "string" && typeof e.label === "string";
  });
}

/**
 * The structural shape `add-mcp` depends on.
 *
 * EVERY field the success output interpolates is checked, because they all
 * fail the same way: the daemon has already committed the atomic write, so
 * a missing field renders a landed provisioning as a nonsense summary —
 * "seeded undefined tools for connection undefined" — which an operator
 * would rationally re-run against a source that is already there.
 *
 * - `counts` — three FINITE numbers, each interpolated into the success
 *   line and spread into the `--json` object.
 * - `toolCount` — a finite number, the headline of the success line.
 * - `namespace`/`prefix` — strings, both named in the success line.
 * - `credential` — the two-valued PRESENCE flag, emitted in `--json`; any
 *   other value would answer the operator's "did my secret stick?" with
 *   something that is neither "present" nor "absent".
 * - `warnings` — absent-or-an-array-of-strings. Genuinely optional (the
 *   daemon omits it when there is nothing to say), so absence is fine and
 *   the caller's `?? []` handles it; a non-array PRESENT value would be
 *   iterated, and swallowing it hides the one thing the daemon was trying
 *   to say.
 */
function isProvisionPayloadShape(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;

  if (typeof p.namespace !== "string" || typeof p.prefix !== "string") return false;
  if (typeof p.toolCount !== "number" || !Number.isFinite(p.toolCount)) return false;
  if (p.credential !== "present" && p.credential !== "absent") return false;

  const counts = p.counts;
  if (typeof counts !== "object" || counts === null) return false;
  const c = counts as Record<string, unknown>;
  for (const field of ["safe", "review", "destructive"] as const) {
    if (typeof c[field] !== "number" || !Number.isFinite(c[field])) return false;
  }

  if (p.warnings !== undefined) {
    if (!Array.isArray(p.warnings)) return false;
    if (!p.warnings.every((w) => typeof w === "string")) return false;
  }
  return true;
}

/**
 * The structural shape `toPausedRow` and the table renderer depend on.
 *
 * `startedAt`/`expiresAt` are checked as FINITE numbers specifically: they
 * reach `new Date(...).toISOString()` and an arithmetic expiry comparison,
 * where `undefined` renders "Invalid Date" and a non-finite value throws
 * `RangeError` mid-table — both of which present a protocol fault as
 * either a malformed queue or a crash, instead of as a refusal.
 */
function isPausedRowShape(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.executionId === "string" &&
    typeof r.toolName === "string" &&
    typeof r.startedAt === "number" &&
    Number.isFinite(r.startedAt) &&
    typeof r.expiresAt === "number" &&
    Number.isFinite(r.expiresAt)
  );
}

/**
 * Validates a frame the daemon sent as an `RpcResponse`, degrading to
 * `outcome-unknown` when it is not one.
 *
 * A blind `as RpcResponse` admits ANY frame the daemon happens to send —
 * an unknown kind, a `result` with no `requestId` — and hands it to the
 * caller as a well-typed value it will then destructure. Post-write there
 * is no retryable answer available (§5), so a frame that fails validation
 * is a protocol fault reported as the ambiguity it genuinely is, with the
 * fault attached so an operator can tell it from a dropped connection.
 */
function decodeResponseOrUnknown(frame: unknown): RpcResponse {
  const decoded = decodeResponse(frame);
  if (decoded !== null) return decoded;
  return unknownOutcome(
    frame,
    `daemon sent a frame that is not a valid response: ${JSON.stringify(frame)?.slice(0, 200)}`,
  );
}

/**
 * Synthesizes the §5 `outcome unknown` verdict client-side. There is no
 * wire message for it — the daemon that would have sent one is gone —
 * so the id is taken from whatever partial response arrived, and falls
 * back to the sentinel when nothing did. See UNCORRELATED.
 *
 * `detail`, when present, records WHY the outcome is unknown: a decode
 * fault reads identically to a dropped connection from the caller's side,
 * and only one of the two means the daemon is misbehaving. The field is
 * client-local — it is never encoded onto the wire, so adding it does not
 * touch the §3.3 response vocabulary.
 */
function unknownOutcome(partial: unknown, detail?: string): RpcResponse {
  const requestId =
    typeof partial === "object" &&
    partial !== null &&
    typeof (partial as { requestId?: unknown }).requestId === "string"
      ? (partial as { requestId: string }).requestId
      : UNCORRELATED;
  return { kind: "outcome-unknown", requestId, ...(detail !== undefined ? { detail } : {}) };
}

/**
 * Validates a daemon frame as an `RpcResponse`, returning null when it is
 * not one. Hand-written like `decodeRequest` but lighter: this checks the
 * kind is one the protocol defines and that the fields the client
 * actually reads are present and correctly typed. The client is not the
 * authorization boundary the daemon's decoder is — it validates to avoid
 * handing the caller a lie, not to defend itself from its own daemon.
 */
function decodeResponse(frame: unknown): RpcResponse | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  const hasId = typeof f.requestId === "string";
  switch (f.kind) {
    case "ready":
      return frame as RpcResponse;
    case "handshake.ok":
      // `agentVersion` (§17) is validated as a string WHEN PRESENT but
      // TOLERATED as absent: an OLD daemon predating the field sends a
      // handshake.ok without it, and rejecting that would break the very
      // backward compatibility this diagnostic exists to preserve — a new
      // client MUST be able to complete the handshake with a stale daemon so
      // it can then observe the absence and name the skew. A present-but-
      // non-string value IS malformed and rejected.
      return f.protocol === 1 &&
        typeof f.dbPath === "string" &&
        typeof f.allowPrivateEgress === "boolean" &&
        (f.agentVersion === undefined || typeof f.agentVersion === "string")
        ? (frame as RpcResponse)
        : null;
    case "result":
      return hasId && "payload" in f ? (frame as RpcResponse) : null;
    case "error":
      return hasId && typeof f.code === "string" && typeof f.message === "string"
        ? (frame as RpcResponse)
        : null;
    case "outcome-unknown":
      return hasId ? (frame as RpcResponse) : null;
    default:
      return null;
  }
}

interface Reader {
  /** Next decoded frame, or null if the connection closed / time ran out. */
  next(timeoutMs: number): Promise<unknown | null>;
  /**
   * The decode fault that ended this stream, if one did. Distinguishes
   * "the daemon sent bytes we could not parse" from "the connection was
   * lost" — both surface as a null `next()`, and only the first indicates
   * something wrong with the daemon rather than with the transport.
   */
  decodeFault(): string | undefined;
  dispose(): void;
}

/**
 * `decoder` and `alreadyRead` come from the READY gate: the decoder may
 * hold a partially-received frame, and `alreadyRead` holds frames that
 * arrived coalesced with READY. Constructed only there, so neither can be
 * recreated at a phase boundary.
 */
function createReader(socket: Socket, decoder: FrameDecoder, alreadyRead: unknown[]): Reader {
  const buffered: unknown[] = [...alreadyRead];
  let waiter: ((msg: unknown | null) => void) | null = null;
  let closed = false;
  let fault: string | undefined;

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
    } catch (err) {
      // Captured, not swallowed. This is post-write, so the outcome is
      // ambiguous either way — but "the daemon sent unparseable bytes"
      // and "the connection was lost" have different causes and different
      // fixes, and the caller can only tell them apart if the fault
      // survives to the synthesized outcome.
      fault = `frame decode failed: ${err instanceof Error ? err.message : String(err)}`;
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
    decodeFault(): string | undefined {
      return fault;
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
 *
 * The FIRST iteration polls at `LIFECYCLE_WAIT_POLL_MS`, because a
 * daemon that is nearly finished binding resolves within one tick and
 * that latency is the client's cold-start responsiveness. Subsequent
 * iterations — each one having observed the same held-lock, no-socket
 * state again — pace at `NO_PROGRESS_PACE_MS`: past the first tick this is
 * a wait on something slow, and each iteration costs both a connect
 * attempt and a lock-db client.
 */
async function waitForStartOrRelease(
  paths: DaemonPaths,
  expiry: number,
  onErrno?: (code: string) => void,
): Promise<Socket | null> {
  let pace = LIFECYCLE_WAIT_POLL_MS;
  while (Date.now() < expiry) {
    await sleep(Math.min(pace, remaining(expiry)));
    pace = NO_PROGRESS_PACE_MS;

    const socket = await tryConnect(paths.socket, remaining(expiry), onErrno);
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
