import type { CredentialResolver } from "../credentials.js";
import type { ToolInvoker } from "../execute.js";
import type { ApprovalDecisions } from "../execution/decisions.js";
import {
  type PolicyEngine,
  type PolicyVerdict,
  printableName,
  unknownToolReason,
} from "../policy.js";
import type { EffectiveScope } from "../scope.js";
import type { ConduitStore } from "../store/store.js";
import type { Connection, Projection, TraceEvent } from "../types.js";
import { createDispatchCell, type DispatchCell } from "./dispatch.js";
import {
  ConduitCallError,
  ConduitOutcomeAmbiguous,
  ConduitReplayDivergence,
  GUEST_ERROR_NAMES,
  infraError,
  policyError,
  upstreamError,
} from "./errors.js";
import { redactSensitiveFields } from "./redact.js";
import type { UpstreamCaller, UpstreamOutcome } from "./upstream.js";
import type { UpstreamSessionScope } from "./upstream-session.js";

/**
 * The §5.3 per-call pipeline: resolve tool → check scope → enforce policy →
 * resolve connection → read the source → gate on the deadline → attach
 * credentials host-side → call upstream → append Trace → return. Mounts at
 * the ToolInvoker seam the sandbox's ToolHost calls through; everything here
 * runs host-side, outside the sandbox (spec §9.2).
 *
 * The ORDER is the security property. Scope and policy are evaluated BEFORE
 * connection resolution (spec §5.3 lists them in the other order) so a denied,
 * unknown, or out-of-scope tool never engages the connection or credential
 * machinery. The deadline gate sits after the last unbounded store read and
 * before credentials, so a continuation stalled on a read never holds live
 * credential material; a final gate inside the caller's
 * `beforeSend` covers the awaits that follow.
 *
 * Every failure is classified at this boundary (pipeline/errors.ts): only
 * the four guest-safe names cross into the sandbox. An outermost catch
 * makes that structural — any throw not already a ConduitCallError (e.g. a
 * non-serializable result from a custom UpstreamCaller) becomes an opaque
 * infra error rather than crossing raw — so quickjs.ts's error pass-through
 * is safe by construction.
 */
export interface ToolInvokerDeps {
  store: ConduitStore;
  policy: PolicyEngine;
  credentials: CredentialResolver;
  upstream: UpstreamCaller;
  /**
   * §5.5 design D6: request-bound operator decisions staged for a resume.
   * OPTIONAL — when absent (the common case) runCall behaves exactly as it
   * does with no decision. When present, a decision staged for THIS call's
   * exact identity forces allow (approve) or block (deny), checked BEFORE
   * policy; a decision staged for a DIFFERENT identity fails the call closed
   * (confused-deputy defense: an approval for one call never authorizes
   * another). See execution/decisions.ts.
   */
  decisions?: ApprovalDecisions;
}

export interface CreateToolInvokerOptions {
  executionId: string;
  /** Per-call upstream ceiling; the effective timeout is min(ceiling, deadline()). */
  upstreamTimeoutMs?: number;
  /** Remaining §16 wall-clock budget in ms, supplied by the execution layer. */
  deadline?: () => number;
  /** Host-side sink for infra-failure detail; NEVER guest-visible. */
  log?: (message: string) => void;
  /**
   * §18-C4: the per-drive upstream session scope, owned and disposed by the
   * execution manager. Forwarded onto every `UpstreamRequest` this invoker
   * builds so repeat calls within the same drive reuse one initialized MCP
   * session. Optional — absent (legacy callers, tests) each call falls back
   * to `upstream.ts`'s own ephemeral per-call scope.
   */
  upstreamSession?: UpstreamSessionScope;
  /** §4.3: recorded on every Trace row this invoker appends. */
  projection: Projection;
  clientId: string | null;
  /**
   * §5.2/§5.5: the scope resolver already bound to this drive's client id,
   * awaited per call so a revocation lands on the very next call. OPTIONAL —
   * absent (the shipped Code Mode path) NO scope is consulted and the call
   * behaves exactly as it does today; never a default scope built per call.
   */
  scope?: () => Promise<EffectiveScope>;
  /** §5.5: a direct drive's one dispatch cell. Absent → one fresh cell per call. */
  dispatch?: DispatchCell;
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export function createToolInvoker(
  deps: ToolInvokerDeps,
  options: CreateToolInvokerOptions,
): ToolInvoker {
  const log = options.log ?? ((message: string) => console.error(message));
  const ceiling = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  return async (path: string, input: unknown): Promise<unknown> => {
    // One cell per call (D-A4). A direct drive supplies its own; every other
    // caller gets a fresh one here — a cell shared across calls would let an
    // earlier call's dispatch misclassify a later one.
    const dispatch = options.dispatch ?? createDispatchCell();
    try {
      return await runCall(deps, options, log, ceiling, path, input, dispatch);
    } catch (cause) {
      // §7: whatever error reaches here, the CELL decides — not an error
      // field, which any wrapping or replacement would drop. Once the body
      // write was attempted the upstream effect is unknowable, so classify
      // ambiguous BEFORE any pass-through below can hide it.
      if (dispatch.state === "dispatched") {
        throw new ConduitOutcomeAmbiguous(
          `[ToolInvoker] Upstream call failed after dispatch: the upstream may have performed the call. Context: { tool: ${path} }`,
          { cause },
        );
      }
      // Outermost classification: anything a step already threw as a
      // ConduitCallError passes through; anything else (a bug, a custom
      // caller's non-serializable result, a throwing deadline()) becomes an
      // opaque infra error. Nothing raw crosses into the sandbox.
      //
      // A ConduitReplayDivergence (§5.5/F2) also passes through UNCHANGED — it
      // must NOT be laundered into a guest-catchable ConduitInternalError. The
      // journaling wrapper recognizes it by name and turns it into a host-side
      // terminal signal (the manager finalizes `failed`); the guest never gets
      // to catch it, exactly like the sandbox's own nondeterminism interrupt.
      if (cause instanceof ConduitReplayDivergence || cause instanceof ConduitCallError) {
        throw cause;
      }
      throw infraError(cause, log);
    }
  };
}

async function runCall(
  deps: ToolInvokerDeps,
  options: CreateToolInvokerOptions,
  log: (message: string) => void,
  ceiling: number,
  path: string,
  input: unknown,
  dispatch: DispatchCell,
): Promise<unknown> {
  // 1. Look up the tool (catalog-of-record: the store, not the in-memory catalog).
  let tool = await deps.store.tools.get(path).catch((cause) => {
    throw infraError(cause, log);
  });
  // §5.5: scope is authority recomputed per call. Out of scope ≡ unknown —
  // the same block, the same audit row, and no upstream contact, so the
  // refusal cannot be used to probe what the profile grants.
  //
  // The resolver runs on the scoped path whether or not the catalog holds the
  // name, and BEFORE the outcome depends on catalog presence. Gating it on
  // `tool !== undefined` made the SCHEDULE itself an existence oracle even
  // though the refusal text was identical: an unknown name returned without
  // ever awaiting the resolver, so a guest read existence off the latency, off
  // a resolver rejection that surfaced as `infraError` for existing names
  // only, and off a resolver that hung for one case and not the other. The
  // number and order of awaited resolver and store calls must not depend on
  // catalog membership. The UNSCOPED path is untouched — no resolver exists
  // there, so it keeps its one `tools.get` per call.
  let outOfScope = false;
  if (options.scope !== undefined) {
    const scope = await options.scope().catch((cause) => {
      throw infraError(cause, log);
    });
    // An absent tool is already refused below; recording `outOfScope` only
    // when the catalog HELD it keeps the host log's operator distinction
    // truthful, and it never reaches the guest.
    if (tool !== undefined && !scope.permits(options.projection, path)) {
      tool = undefined;
      outOfScope = true;
    }
  }

  // 1b. §5.5 design D6 — request-bound operator decision, checked BEFORE
  //     policy (a human approval/denial on the paused call overrides the
  //     policy verdict for exactly this call). This is the confused-deputy
  //     defense at the resume boundary: the staged decision is bound to the
  //     pending call's identity, and only the identical call may consume it.
  //     Absent the decisions dep (the common case) this is a no-op and the
  //     policy path below is byte-for-byte unchanged.
  const decisionVerdict = resolveDecisionVerdict(deps, options.executionId, path, input);

  // 2. Policy. Allow-list discipline (policy.ts contract): proceed ONLY on
  //    "allow"; a store rejection is a failed call, never a verdict. Skipped
  //    entirely when an operator decision already resolved this call.
  let verdict =
    decisionVerdict ??
    (await deps.policy
      .evaluate({
        target: tool !== undefined ? { kind: "known", tool } : { kind: "unknown", toolName: path },
        input,
      })
      .catch((cause) => {
        throw infraError(cause, log);
      }));
  if (decisionVerdict !== undefined) {
    // §11 (design R4): the D6 decision branch skips the policy engine, so
    // the synthetic verdict carries no per-tool redactFields. Fetch them
    // here — one extra row read on the rare resume path only — so the
    // approved call's audit row is redacted identically to the policy path.
    // Deliberately fail-closed: a store failure here aborts the call as
    // infra rather than silently degrading to builtin-only redaction.
    const row = await deps.store.policies.get(path).catch((cause) => {
      throw infraError(cause, log);
    });
    verdict = { ...decisionVerdict, redactFields: row?.redactFields ?? [] };
  }
  // Unknown tool: fail closed as blocked regardless of the verdict. The
  // built-in engine returns block/unknown_tool here; a custom engine that
  // returns "allow" for a tool absent from the catalog still cannot proceed
  // (there is nothing to call), and must not surface an allow reason under a
  // denial name — which would also mis-drive §5.5 replay stripping.
  if (tool === undefined) {
    // The GUEST-VISIBLE refusal for an out-of-scope tool is byte-identical to
    // the unknown-tool refusal (controller ruling). Search and describe
    // already make the two indistinguishable; a CALL that said "outside this
    // client's scope" was an EXISTENCE ORACLE — a probing client learned the
    // tool exists and only its grant is missing. Both now produce the same
    // error class and the same message for the same path.
    // Deliberately NOT special-cased on `outOfScope`: setting `tool =
    // undefined` above already routed this through the engine's own
    // unknown-tool evaluation, so `verdict.reason` IS the unknown-tool text
    // for this path. Re-deriving it here would reintroduce the oracle the
    // moment the engine's wording and this fallback drift apart — which they
    // already had. The fallback remains only for a CUSTOM engine that answers
    // `allow` for a tool the catalog does not hold, and it is built from the
    // SAME `unknownToolReason` helper the engine uses, so the two texts are
    // byte-identical by construction rather than by matching literals.
    const guestReason = verdict.action === "allow" ? unknownToolReason(path) : verdict.reason;
    const blocked: PolicyVerdict = {
      action: "block",
      reason: guestReason,
      source: verdict.source,
      redactFields: verdict.redactFields,
    };
    await appendTrace(deps, options, log, { path, input, verdict: blocked });
    if (options.scope !== undefined) {
      // ONE logging path, taken for BOTH refusals on the scoped path. The
      // guest-visible text was already identical; the SCHEDULE was not. Only
      // the out-of-scope case logged, so a synchronous sink's latency, or a
      // sink that threw or stalled for one case and not the other, told a
      // probing client which of the two had happened — the existence oracle
      // the identical text exists to close. Same call count, same position,
      // either way; the operator's distinction is a FIELD on the line.
      //
      // The tool path only: no tool input, no credential material, and
      // nothing that crosses back to the guest. The path is GUEST-SUPPLIED,
      // so it is sanitized before interpolation: a raw newline in it would
      // forge a host log line, and an unbounded one would flood the daemon
      // log.
      //
      // The sink is CALLED and never AWAITED, and its faults are swallowed: a
      // throwing sink must not change the error the guest sees, and a sink
      // returning a promise that never settles must not hold the call open.
      // A host log line is a diagnostic, never part of the refusal.
      try {
        const logged: unknown = log(
          `[ToolInvoker] Call refused: reported to the guest as an unknown tool. Context: { tool: ${printableName(path)}, clientId: ${JSON.stringify(options.clientId)}, inCatalog: ${outOfScope} }`,
        );
        // Duck-typed, not `instanceof`: a sink may return a thenable from
        // another realm. An unobserved rejection would surface as an
        // unhandled rejection and take the process down.
        if (typeof logged === "object" && logged !== null && "then" in logged) {
          void Promise.resolve(logged).catch(() => {});
        }
      } catch {
        // Deliberately empty: see above.
      }
    }
    throw policyError("block", guestReason);
  }
  if (verdict.action !== "allow") {
    // Audit the refusal too. Chosen semantic: unauditable is ALWAYS infra —
    // if this append fails, the guest sees ConduitInternalError rather than
    // the policy name, because a refusal we cannot record is a fault, not
    // a verdict.
    await appendTrace(deps, options, log, { path, input, verdict });
    throw policyError(verdict.action === "block" ? "block" : "require_approval", verdict.reason);
  }

  // 3. Resolve connection (decision A1: single connection per namespace;
  //    the prefix parameter is reserved on the seam for per-call addressing).
  const connection = await resolveConnection(deps, tool.namespace, undefined).catch((cause) => {
    throw cause instanceof ConduitCallError ? cause : infraError(cause, log);
  });

  // 4. Source read — the LAST unbounded store read before the wire
  //    F2). It comes before the deadline gate so a continuation that stalls
  //    here has its budget re-read afterwards, not before.
  const source = await deps.store.sources.getByNamespace(tool.namespace).catch((cause) => {
    throw infraError(cause, log);
  });
  if (source === undefined) {
    throw infraError(new Error(`source missing for namespace ${tool.namespace}`), log);
  }
  if (tool.sourceSemantics.kind !== "mcp") {
    throw upstreamError(
      `Source type "${tool.sourceSemantics.kind}" is not yet callable; MCP only in v1. Context: { tool: ${tool.name} }`,
    );
  }

  // 5. Deadline gate — re-read AFTER every unbounded read has returned, and
  //    BEFORE credentials. A burnt §16 budget refuses while no credential
  //    material has been resolved at all, so a stalled continuation never
  //    holds live credentials and never dispatches after the row was settled.
  //    Traced per decision A3 (an allowed call that produced no result).
  const remaining = options.deadline?.() ?? Number.POSITIVE_INFINITY;
  if (remaining <= 0) {
    await appendTrace(deps, options, log, { path, input, verdict, connection });
    throw upstreamError(
      `Upstream call refused: the execution's wall-clock budget is exhausted (spec §16). Context: { tool: ${tool.name} }`,
    );
  }

  // 6. Credentials — host-side, fresh per call (spec §9.2). Resolver
  //    failures carry the prefix and credentialRef in their message;
  //    they cross the boundary only as opaque infra errors.
  const auth = await deps.credentials.resolve(connection).catch((cause) => {
    throw infraError(cause, log);
  });

  // 7. Upstream, time-bounded by the post-read remaining §16 budget.
  const timeoutMs = Math.max(1, Math.min(ceiling, remaining));
  let outcome: UpstreamOutcome;
  try {
    outcome = await deps.upstream.call({
      tool,
      source,
      input,
      auth,
      timeoutMs,
      dispatch,
      // The pre-write gate: the checks above still precede egress
      // pre-flight and the session handshake, both of which await. The caller
      // re-reads this immediately before the body write.
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      ...(options.upstreamSession !== undefined ? { session: options.upstreamSession } : {}),
    });
  } catch (cause) {
    const error = cause instanceof ConduitCallError ? cause : infraError(cause, log);
    if (error.kind === "upstream") {
      // Decision A3: an allowed call that reached the upstream caller and
      // failed is an auditable outcome — the row carries the allow verdict
      // and no output. Infra faults are deliberately NOT traced; they live
      // in the host log under their correlation id. If the audit write
      // itself fails, log the superseded upstream error so it is not lost.
      try {
        await appendTrace(deps, options, log, { path, input, verdict, connection });
      } catch (auditCause) {
        log(`[ToolInvoker] Upstream failure not audited: ${error.message}`);
        throw auditCause instanceof ConduitCallError ? auditCause : infraError(auditCause, log);
      }
    }
    throw error;
  }

  // 8. Trace, then return. Fail closed if the audit row can't be written
  //    (decision A3): an unauditable call must not silently succeed.
  await appendTrace(deps, options, log, { path, input, verdict, connection, outcome });
  return outcome.result;
}

/**
 * §5.5 design D6/F2 — resolve the operator decision for this call into a
 * synthetic PolicyVerdict, or `undefined` to fall through to policy.
 *
 * The identity is `{ op: "call", toolName: path, request }`, where `request`
 * is `JSON.stringify(input)` — the canonical serialization of the call's
 * INPUT. The path is carried separately as `toolName`, so it is NOT folded
 * into `request` (that would double-encode it and desync from how a decision
 * is staged). Whoever stages a decision MUST use the identical serialization.
 *
 * Outcomes, all fail-closed by construction:
 *  - no decisions dep, or nothing staged for this execution → undefined
 *    (the policy path runs unchanged — the common resume case).
 *  - a decision staged for THIS exact identity → consume it (one-shot):
 *    approve → synthetic allow (skips policy); deny → synthetic block.
 *  - a decision staged but its identity DIVERGES from this call → THROW a
 *    ConduitReplayDivergence (NOT a block verdict). `take` returned undefined
 *    (no match) yet `peek` shows one is staged: the first live call on resume
 *    is not the call the human approved. A guest-catchable `block` would let
 *    the guest catch it and continue past the divergence to later invoke the
 *    originally-approved tool. Instead we terminate the execution: the
 *    divergence is uncatchable (the wrapper turns it into a host-side terminal
 *    signal), and the staged decision is DISCARDED so it can never be reused.
 *    This both preserves the confused-deputy property (approval for A never
 *    authorizes B) AND makes the divergence terminal.
 */
function resolveDecisionVerdict(
  deps: ToolInvokerDeps,
  executionId: string,
  path: string,
  input: unknown,
): PolicyVerdict | undefined {
  const decisions = deps.decisions;
  if (decisions === undefined) {
    return undefined;
  }
  const identity = { op: "call", toolName: path, request: JSON.stringify(input) } as const;
  const decision = decisions.take(executionId, identity);
  if (decision === undefined) {
    // Nothing staged → normal policy path. Something staged but non-matching
    // → resume divergence: terminate the execution, uncatchable by the guest.
    if (decisions.peek(executionId)) {
      // Discard the mismatched decision so it can never authorize a later call
      // (belt-and-suspenders: the sandbox is interrupted after this throw, but
      // a consumed decision cannot be reused under any control flow).
      decisions.discard(executionId);
      throw new ConduitReplayDivergence(
        "resume divergence: the first live call does not match the approved pending call; execution terminated",
      );
    }
    return undefined;
  }
  if (decision.kind === "approve") {
    return {
      action: "allow",
      reason: "operator approved this call on resume",
      source: "override",
      redactFields: [],
    };
  }
  return {
    action: "block",
    reason: "operator denied this call on resume",
    source: "override",
    redactFields: [],
  };
}

/**
 * Decision A1: a namespace resolves to its one configured connection.
 * `_prefix` is the reserved per-call addressing parameter — accepted from
 * day one so real addressing arrives without an interface change; unused
 * in v1.
 */
async function resolveConnection(
  deps: ToolInvokerDeps,
  namespace: string,
  _prefix: string | undefined,
): Promise<Connection> {
  const integration = await deps.store.integrations.getByNamespace(namespace);
  if (integration === undefined) {
    throw new Error(`integration missing for namespace ${namespace}`);
  }
  const connections = (await deps.store.connections.list()).filter(
    (connection) => connection.integrationId === integration.id,
  );
  const [first] = connections;
  if (first === undefined) {
    // Guest-actionable and ref-free: the agent can relay this to a human.
    throw upstreamError(
      `No connection is configured for this integration — add one in the console. Context: { namespace: ${namespace} }`,
    );
  }
  if (connections.length > 1) {
    // Deliberately a fixed, ref-free message (decision A1) rather than an
    // opaque correlation id: the failure is a product limitation, not a fault.
    throw new ConduitCallError(
      "infra",
      GUEST_ERROR_NAMES.infra,
      `Multiple connections are configured for this integration; per-call addressing is not yet supported. Context: { namespace: ${namespace} }`,
    );
  }
  return first;
}

async function appendTrace(
  deps: ToolInvokerDeps,
  options: CreateToolInvokerOptions,
  log: (message: string) => void,
  details: {
    path: string;
    input: unknown;
    verdict: PolicyVerdict;
    connection?: Connection;
    outcome?: UpstreamOutcome;
  },
): Promise<void> {
  const event: TraceEvent = {
    callId: crypto.randomUUID(),
    executionId: options.executionId,
    toolName: details.path,
    // Refusals are traced before any connection is engaged: empty prefix
    // records exactly that.
    connectionPrefix: details.connection?.prefix ?? "",
    // §4.3: which projection raised the call, and for which client.
    projection: options.projection,
    clientId: options.clientId,
    // §11: the audit row is redacted at append time (builtins + the
    // verdict's per-tool additions). Non-mutating by contract (redact.ts)
    // — the caller's `input` reference is journaled for replay later.
    input: redactSensitiveFields(details.input, details.verdict.redactFields),
    policyVerdict: details.verdict.action,
    at: Date.now(),
  };
  if (details.outcome !== undefined) {
    const output = details.outcome.result ?? null;
    // §11 R7: redact BEFORE slicing, so a sensitive value's head cannot
    // leak through the 160-char display cap.
    event.outputSummary = JSON.stringify(
      redactSensitiveFields(output, details.verdict.redactFields),
    ).slice(0, 160);
    event.upstreamStatus = details.outcome.status;
    event.latencyMs = details.outcome.latencyMs;
  }
  try {
    await deps.store.trace.append(event);
  } catch (cause) {
    throw infraError(cause, log);
  }
}
