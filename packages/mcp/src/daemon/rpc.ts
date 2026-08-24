/**
 * Typed RPC vocabulary for the daemon UDS protocol (design §3.3). Every
 * request and response is schema-validated by hand — "zero new
 * dependencies" is this plan's Global Constraint, which rules out
 * zod/ajv, so `decodeRequest` is an explicit, field-by-field decoder
 * rather than a generic schema runtime.
 *
 * The capability table (§3.3) is the daemon's authorization boundary:
 * each connected client is scoped to exactly one of `serve`, `approvals`,
 * `add-mcp`, and the daemon must reject any request whose kind isn't in
 * that client's capability set before doing any other work.
 *
 * Hard invariant (§3.3.1, the anti-oracle shape): `source.revalidate`
 * re-authenticates a *stored* identity, so it must carry only a
 * namespace — never a url. The daemon derives the url and credential
 * itself from what it already has on file. Making the field
 * unrepresentable in the type (not just unused) is what stops a client
 * from ever supplying an attacker-chosen url and using daemon-held
 * credentials as a same-origin fetch oracle against it. `decodeRequest`
 * enforces this by rejecting any `source.revalidate` object carrying a
 * `url` key at all, decoded or not.
 *
 * No RPC response shape may carry a master key, a plaintext credential,
 * a credential-bearing header, or a pre-authenticated upstream request
 * (§3.3, §9.2). `source.provision.secret` is the sole exception: it is
 * client→daemon only (operator-supplied at provisioning time) and is
 * never echoed back in any response.
 */

export type Capability = keyof typeof CAPABILITIES;

export type RpcRequest =
  | {
      kind: "handshake";
      protocol: 1;
      capability: Capability;
      /**
       * Present only when the client's own environment sets `CONDUIT_DB`.
       * The daemon refuses any handshake carrying it (§9.3 item 3): v1
       * serves exactly the default database, and a client pointing at a
       * custom path must be told so rather than silently served against
       * a different store than it asked for.
       */
      dbPath?: string;
    }
  | {
      kind: "execute";
      code: string;
      deadlineMs: number;
      /**
       * The §M1 correlation key, persisted BEFORE the sandbox runs so a
       * lost response can be recovered via `execution.getByRequestKey`
       * rather than re-executed. Optional because it is
       * agent-supplied — but load-bearing when present: it is what makes
       * a reissued `execute` return `conflict` instead of starting a
       * second run against the same upstream side effects.
       */
      requestKey?: string;
    }
  | { kind: "search"; query: string }
  | { kind: "describe"; toolName: string }
  /**
   * D-B1 (controller-ruled, 2026-08-18): three read-only kinds the
   * agent-facing `serve` process genuinely performs today and could not
   * perform through the original §3.3 row.
   *
   * Design §3.3's `serve` row ("execute, search, describe") was written
   * against the §6 four-step vocabulary the AGENT uses inside the
   * sandbox, not against the store reads the serve PROCESS performs
   * outside it — and design line 383 already mandated that the startup
   * reads "become daemon calls at process start" without ever defining
   * the calls. These three close that gap.
   *
   * All three are reads, and each answers with a PROJECTION computed
   * daemon-side, never a repository row: `catalog.listing` returns the
   * advertisement view (`{connections, sourceCount}`), and the two
   * execution lookups return the §M1 `CheckPayload`. That keeps §3.3's
   * "the socket carries service operations, never database access" — a
   * proxied `connections.list()` would hand a client `credentialRef`,
   * which is exactly the shape §3.3.1 exists to forbid.
   *
   * §8's "no widening beyond the §3.3 row" is not crossed in spirit:
   * its own rationale names administrative verbs, and nothing here
   * mutates anything or returns credential-adjacent material.
   */
  | { kind: "execution.get"; executionId: string }
  | { kind: "execution.getByRequestKey"; requestKey: string }
  /**
   * Nullary on purpose: the client supplies NO parameters, so it cannot
   * narrow, filter, or steer what comes back. The daemon returns exactly
   * the advertisement projection it chooses, which makes "a client asked
   * for a row it should not see" unrepresentable rather than merely
   * unimplemented.
   */
  | { kind: "catalog.listing" }
  | { kind: "approvals.list" }
  | { kind: "approvals.resume"; executionId: string; decision: "approve" | "deny" }
  /**
   * The onboarding write. `url` and `secret` are BOTH the operator's own
   * data, supplied together in one request — that is the one case §3.3.1
   * permits a client to name a destination alongside a credential, because
   * nothing stored is being redirected outward. The daemon still applies
   * §9.3 and never echoes the secret back.
   *
   * `prefix`, `replace` and `clearCredential` (Task 8) are the remaining
   * operator decisions `add-mcp` has always taken, and they are NOT
   * derivable from the other fields. They are safe to accept because
   * neither carries a destination nor a credential: `replace` selects
   * whether the daemon may retarget a namespace it already holds, and
   * `clearCredential` selects whether the stored secret is dropped rather
   * than preserved. Both resolve against the daemon's OWN stored row, and
   * the credential-leak refusal in `provision.ts` sits downstream of both.
   */
  | {
      kind: "source.provision";
      namespace: string;
      url: string;
      prefix: string;
      secret?: string;
      replace: boolean;
      clearCredential: boolean;
    }
  | { kind: "source.revalidate"; namespace: string }
  /**
   * Nullary on purpose (§3.1): the client supplies no parameters, so it
   * cannot narrow what the daemon reports or which daemon it stops.
   * Answered outside the execution queue — a busy or unreachable queue
   * must never delay a status read or a shutdown request. Scoped to the
   * `control` capability alone: no other row gains either verb.
   */
  | { kind: "daemon.status" }
  | { kind: "daemon.stop" };

export type RpcResponse =
  | { kind: "ready" }
  | {
      kind: "handshake.ok";
      protocol: 1;
      dbPath: string;
      allowPrivateEgress: boolean;
      /**
       * The daemon's OWN build version (env.ts `AGENT_VERSION`), reported so
       * a client can DIAGNOSE version skew (§17). `protocol` stays 1 across a
       * vocabulary-only change like D-B1 — a matched upgraded client+daemon
       * pair speak it fine — so the protocol number cannot signal "this
       * daemon predates the capability I am about to use". This string can:
       * a NEW client that sees a `handshake.ok` whose `agentVersion` is
       * ABSENT is talking to a daemon built before this field existed, i.e.
       * before the D-B1 vocabulary, and can say so.
       *
       * It is a plain diagnostic, NOT a capability gate and NOT
       * security-sensitive: no authorization decision is made on it. The
       * capability set (§3.3) remains the sole boundary.
       */
      agentVersion: string;
    }
  | { kind: "result"; requestId: string; payload: unknown }
  | {
      kind: "error";
      requestId: string;
      /**
       * Every code here has a live emitter. `unimplemented` was added for
       * the two Lane-B placeholder refusals (D5) and outlived them —
       * Task 8 implemented both, and nothing has emitted it since. A code
       * a daemon can never send is worse than absent: a client branching
       * on it writes a handler that can only ever be dead, and its
       * documentation describes a distinction the protocol no longer makes.
       */
      code: "busy" | "rotation-in-progress" | "refused-custom-db" | "invalid" | "internal";
      message: string;
    }
  | {
      kind: "outcome-unknown";
      requestId: string;
      /**
       * Why the outcome is unknown, when the client can say.
       *
       * CLIENT-LOCAL AND NEVER ON THE WIRE. No daemon sends
       * `outcome-unknown` — it is synthesized by `client.ts` precisely
       * when the daemon that would have answered is gone — so this field
       * does not widen the §3.3 response vocabulary and the daemon's
       * decoder never sees it.
       *
       * It exists because "the daemon sent bytes we could not parse" and
       * "the connection dropped" are indistinguishable from the caller's
       * side and have different causes: only the first means the daemon
       * is misbehaving. The diagnostic was already being collected
       * (`Reader.decodeFault`) and then discarded for want of a
       * declaration; operator-facing surfaces append it, and the
       * agent-facing ones deliberately do not.
       */
      detail?: string;
    };

/**
 * The leading text of the handshake's capability refusal, exported because a
 * CLIENT keys on it.
 *
 * `conduit daemon status|stop` detects a PRE-CONTROL daemon by this exact
 * refusal: a daemon whose vocabulary predates the `control` row answers the
 * handshake rather than the request, and the CLI turns that into a
 * "stop it by signal" remediation instead of an opaque error. That makes the
 * wording a cross-package contract rather than prose — so it lives here, at
 * the one site that emits it, and the CLI imports it. Before this, the same
 * sentence was spelled out independently in both places, where a reword on
 * either side silently broke the detection.
 */
export const CAPABILITY_REJECTION_PREFIX = "handshake.capability must be one of";

export class InvalidRpcRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRpcRequest";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Narrows to a capability name by consulting CAPABILITIES itself, so the
 * decoder can never drift from the §3.3 table: adding a role there makes
 * it decodable here with no second list to keep in sync.
 */
function isCapability(v: unknown): v is Capability {
  return isString(v) && Object.hasOwn(CAPABILITIES, v);
}

/** Rejects any object carrying keys outside the given allowed set. */
function assertNoExtraKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new InvalidRpcRequest(`unexpected field "${key}"`);
    }
  }
}

export function decodeRequest(v: unknown): RpcRequest {
  if (!isRecord(v)) {
    throw new InvalidRpcRequest("request must be a JSON object");
  }
  const kind = v.kind;
  if (!isString(kind)) {
    throw new InvalidRpcRequest('request must have a string "kind" field');
  }

  switch (kind) {
    case "handshake": {
      assertNoExtraKeys(v, ["kind", "protocol", "capability", "dbPath"]);
      if (v.protocol !== 1) {
        throw new InvalidRpcRequest("handshake.protocol must be 1");
      }
      if (!isCapability(v.capability)) {
        throw new InvalidRpcRequest(
          `${CAPABILITY_REJECTION_PREFIX} ${Object.keys(CAPABILITIES).join(" | ")}`,
        );
      }
      if (v.dbPath !== undefined && !isString(v.dbPath)) {
        throw new InvalidRpcRequest("handshake.dbPath must be a string when present");
      }
      const handshake: RpcRequest = { kind: "handshake", protocol: 1, capability: v.capability };
      if (v.dbPath !== undefined) {
        (handshake as { dbPath?: string }).dbPath = v.dbPath;
      }
      return handshake;
    }
    case "execute": {
      assertNoExtraKeys(v, ["kind", "code", "deadlineMs", "requestKey"]);
      if (!isString(v.code)) {
        throw new InvalidRpcRequest("execute.code must be a string");
      }
      if (v.requestKey !== undefined && !isString(v.requestKey)) {
        throw new InvalidRpcRequest("execute.requestKey must be a string when present");
      }
      // Finite and non-negative, not merely "a number". `NaN`, `-1` and
      // `Infinity` are all typeof "number" and each corrupts the
      // admission bound differently: NaN makes every expiry comparison
      // false so the entry NEVER expires, a negative deadline expires it
      // before it is ever dispatched, and Infinity is an unbounded queue
      // entry — the exact thing the capacity cap exists to prevent.
      if (typeof v.deadlineMs !== "number" || !Number.isFinite(v.deadlineMs) || v.deadlineMs < 0) {
        throw new InvalidRpcRequest(
          "execute.deadlineMs must be a finite, non-negative number of milliseconds",
        );
      }
      // Built conditionally, like handshake.dbPath: an absent key must
      // stay ABSENT rather than become `requestKey: undefined`, which
      // would make `"requestKey" in request` true for a request that
      // carries none and hand `manager.start` an explicit undefined.
      const execute: RpcRequest = { kind: "execute", code: v.code, deadlineMs: v.deadlineMs };
      if (v.requestKey !== undefined) {
        (execute as { requestKey?: string }).requestKey = v.requestKey;
      }
      return execute;
    }
    case "execution.get": {
      assertNoExtraKeys(v, ["kind", "executionId"]);
      if (!isString(v.executionId)) {
        throw new InvalidRpcRequest("execution.get.executionId must be a string");
      }
      return { kind: "execution.get", executionId: v.executionId };
    }
    case "execution.getByRequestKey": {
      assertNoExtraKeys(v, ["kind", "requestKey"]);
      if (!isString(v.requestKey)) {
        throw new InvalidRpcRequest("execution.getByRequestKey.requestKey must be a string");
      }
      return { kind: "execution.getByRequestKey", requestKey: v.requestKey };
    }
    case "catalog.listing": {
      // Nullary: any field at all is a client trying to steer a
      // projection it does not get to shape.
      assertNoExtraKeys(v, ["kind"]);
      return { kind: "catalog.listing" };
    }
    case "search": {
      assertNoExtraKeys(v, ["kind", "query"]);
      if (!isString(v.query)) {
        throw new InvalidRpcRequest("search.query must be a string");
      }
      return { kind: "search", query: v.query };
    }
    case "describe": {
      assertNoExtraKeys(v, ["kind", "toolName"]);
      if (!isString(v.toolName)) {
        throw new InvalidRpcRequest("describe.toolName must be a string");
      }
      return { kind: "describe", toolName: v.toolName };
    }
    case "approvals.list": {
      assertNoExtraKeys(v, ["kind"]);
      return { kind: "approvals.list" };
    }
    case "approvals.resume": {
      assertNoExtraKeys(v, ["kind", "executionId", "decision"]);
      if (!isString(v.executionId)) {
        throw new InvalidRpcRequest("approvals.resume.executionId must be a string");
      }
      if (v.decision !== "approve" && v.decision !== "deny") {
        throw new InvalidRpcRequest('approvals.resume.decision must be "approve" or "deny"');
      }
      return { kind: "approvals.resume", executionId: v.executionId, decision: v.decision };
    }
    case "source.provision": {
      assertNoExtraKeys(v, [
        "kind",
        "namespace",
        "url",
        "prefix",
        "secret",
        "replace",
        "clearCredential",
      ]);
      if (!isString(v.namespace)) {
        throw new InvalidRpcRequest("source.provision.namespace must be a string");
      }
      if (!isString(v.url)) {
        throw new InvalidRpcRequest("source.provision.url must be a string");
      }
      if (!isString(v.prefix)) {
        throw new InvalidRpcRequest("source.provision.prefix must be a string");
      }
      if (v.secret !== undefined && !isString(v.secret)) {
        throw new InvalidRpcRequest("source.provision.secret must be a string when present");
      }
      // Required booleans rather than optional ones: an omitted flag would
      // decode as `undefined` and read as false anyway, but making them
      // explicit means a client that forgets one is TOLD so rather than
      // silently getting the conservative branch of a decision the
      // operator meant to take.
      if (typeof v.replace !== "boolean") {
        throw new InvalidRpcRequest("source.provision.replace must be a boolean");
      }
      if (typeof v.clearCredential !== "boolean") {
        throw new InvalidRpcRequest("source.provision.clearCredential must be a boolean");
      }
      const result: RpcRequest = {
        kind: "source.provision",
        namespace: v.namespace,
        url: v.url,
        prefix: v.prefix,
        replace: v.replace,
        clearCredential: v.clearCredential,
      };
      if (v.secret !== undefined) {
        (result as { secret?: string }).secret = v.secret;
      }
      return result;
    }
    case "source.revalidate": {
      // Anti-oracle shape (§3.3.1): url must be structurally absent, not
      // merely unused — reject the object outright if it carries one.
      assertNoExtraKeys(v, ["kind", "namespace"]);
      if (!isString(v.namespace)) {
        throw new InvalidRpcRequest("source.revalidate.namespace must be a string");
      }
      return { kind: "source.revalidate", namespace: v.namespace };
    }
    case "daemon.status": {
      assertNoExtraKeys(v, ["kind"]);
      return { kind: "daemon.status" };
    }
    case "daemon.stop": {
      assertNoExtraKeys(v, ["kind"]);
      return { kind: "daemon.stop" };
    }
    default:
      throw new InvalidRpcRequest(`unknown request kind "${kind}"`);
  }
}

export const CAPABILITIES: Readonly<
  Record<"serve" | "approvals" | "add-mcp" | "control", ReadonlySet<RpcRequest["kind"]>>
> = {
  // D-B1 added the three read-only kinds; the row stays free of every
  // administrative verb, which is what §8's prohibition actually guards.
  serve: new Set([
    "execute",
    "search",
    "describe",
    "handshake",
    "execution.get",
    "execution.getByRequestKey",
    "catalog.listing",
  ]),
  approvals: new Set(["approvals.list", "approvals.resume", "handshake"]),
  "add-mcp": new Set(["source.provision", "source.revalidate", "handshake"]),
  // The capability set scopes an HONEST client — it is not a privilege
  // boundary against a hostile same-UID process, which can already read
  // and write the UDS socket file directly. That is the parent design's
  // accepted v1 limit (§3.1); the boundary this row enforces is "a
  // well-behaved client only ever asks for what its role needs."
  control: new Set(["handshake", "daemon.status", "daemon.stop"]),
};
