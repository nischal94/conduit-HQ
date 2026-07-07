import type { CredentialResolver } from "../credentials.js";
import type { ToolInvoker } from "../execute.js";
import type { PolicyEngine, PolicyVerdict } from "../policy.js";
import type { ConduitStore } from "../store/store.js";
import type { Connection, TraceEvent } from "../types.js";
import {
  ConduitCallError,
  GUEST_ERROR_NAMES,
  infraError,
  policyError,
  upstreamError,
} from "./errors.js";
import type { UpstreamCaller, UpstreamOutcome } from "./upstream.js";

/**
 * The §5.3 per-call pipeline: resolve tool → enforce policy → resolve
 * connection → attach credentials host-side → call upstream → append Trace
 * → return. Mounts at the ToolInvoker seam the sandbox's ToolHost calls
 * through; everything here runs host-side, outside the sandbox (spec §9.2).
 *
 * Every failure is classified at this boundary (pipeline/errors.ts): only
 * the four guest-safe names cross into the sandbox, so quickjs.ts's
 * error pass-through is safe by construction.
 */
export interface ToolInvokerDeps {
  store: ConduitStore;
  policy: PolicyEngine;
  credentials: CredentialResolver;
  upstream: UpstreamCaller;
}

export interface CreateToolInvokerOptions {
  executionId: string;
  /** Per-call upstream ceiling; the effective timeout is min(ceiling, deadline()). */
  upstreamTimeoutMs?: number;
  /** Remaining §16 wall-clock budget in ms, supplied by the execution layer. */
  deadline?: () => number;
  /** Host-side sink for infra-failure detail; NEVER guest-visible. */
  log?: (message: string) => void;
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export function createToolInvoker(
  deps: ToolInvokerDeps,
  options: CreateToolInvokerOptions,
): ToolInvoker {
  const log = options.log ?? ((message: string) => console.error(message));
  const ceiling = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  return async (path: string, input: unknown): Promise<unknown> => {
    // 1. Look up the tool (catalog-of-record: the store, not the in-memory catalog).
    const tool = await deps.store.tools.get(path).catch((cause) => {
      throw infraError(cause, log);
    });

    // 2. Policy. Allow-list discipline (policy.ts contract): proceed ONLY on
    //    "allow"; a store rejection is a failed call, never a verdict.
    const verdict = await deps.policy
      .evaluate({
        target: tool !== undefined ? { kind: "known", tool } : { kind: "unknown", toolName: path },
        input,
      })
      .catch((cause) => {
        throw infraError(cause, log);
      });
    if (verdict.action !== "allow" || tool === undefined) {
      await appendTrace(deps, options, log, { path, input, verdict }); // audit the refusal too
      throw policyError(verdict.action === "block" ? "block" : "require_approval", verdict.reason);
    }

    // 3. Resolve connection (decision A1: single connection per namespace;
    //    the prefix parameter is reserved on the seam for per-call addressing).
    const connection = await resolveConnection(deps, tool.namespace, undefined).catch((cause) => {
      throw cause instanceof ConduitCallError ? cause : infraError(cause, log);
    });

    // 4. Credentials — host-side, fresh per call (spec §9.2). Resolver
    //    failures carry the prefix and credentialRef in their message;
    //    they cross the boundary only as opaque infra errors.
    const auth = await deps.credentials.resolve(connection).catch((cause) => {
      throw infraError(cause, log);
    });

    // 5. Upstream, time-bounded by the remaining §16 budget.
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
    const remaining = options.deadline?.() ?? Number.POSITIVE_INFINITY;
    const timeoutMs = Math.max(1, Math.min(ceiling, remaining));
    let outcome: UpstreamOutcome;
    try {
      outcome = await deps.upstream.call({ tool, source, input, auth, timeoutMs });
    } catch (cause) {
      const error = cause instanceof ConduitCallError ? cause : infraError(cause, log);
      if (error.kind === "upstream") {
        // Decision A3: allowed + upstream-failure is an auditable outcome —
        // the row carries the allow verdict and no output. Infra faults are
        // deliberately NOT traced; they live in the host log under their
        // correlation id.
        await appendTrace(deps, options, log, { path, input, verdict, connection });
      }
      throw error;
    }

    // 6. Trace, then return. Fail closed if the audit row can't be written
    //    (decision A3): an unauditable call must not silently succeed.
    await appendTrace(deps, options, log, { path, input, verdict, connection, outcome });
    return outcome.result;
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
    input: details.input,
    policyVerdict: details.verdict.action,
    at: Date.now(),
  };
  if (details.outcome !== undefined) {
    const output = details.outcome.result ?? null;
    event.output = output;
    event.outputSummary = JSON.stringify(output).slice(0, 160);
    event.upstreamStatus = details.outcome.status;
    event.latencyMs = details.outcome.latencyMs;
  }
  try {
    await deps.store.trace.append(event);
  } catch (cause) {
    throw infraError(cause, log);
  }
}
