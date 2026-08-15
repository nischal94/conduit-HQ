/**
 * Typed RPC vocabulary for the daemon UDS protocol (design §3.3). Every
 * request and response is schema-validated by hand — CLAUDE.md's
 * zero-new-dependencies rule for `packages/mcp` rules out zod/ajv, so
 * `decodeRequest` is an explicit, field-by-field decoder rather than a
 * generic schema runtime.
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

export type RpcRequest =
  | { kind: "handshake"; protocol: 1 }
  | { kind: "execute"; code: string; deadlineMs: number }
  | { kind: "search"; query: string }
  | { kind: "describe"; toolName: string }
  | { kind: "approvals.list" }
  | { kind: "approvals.resume"; executionId: string; decision: "approve" | "deny" }
  | { kind: "source.provision"; namespace: string; url: string; secret?: string }
  | { kind: "source.revalidate"; namespace: string };

export type RpcResponse =
  | { kind: "ready" }
  | { kind: "handshake.ok"; protocol: 1; dbPath: string; allowPrivateEgress: boolean }
  | { kind: "result"; requestId: string; payload: unknown }
  | {
      kind: "error";
      requestId: string;
      code: "busy" | "rotation-in-progress" | "refused-custom-db" | "invalid" | "internal";
      message: string;
    }
  | { kind: "outcome-unknown"; requestId: string };

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
      assertNoExtraKeys(v, ["kind", "protocol"]);
      if (v.protocol !== 1) {
        throw new InvalidRpcRequest("handshake.protocol must be 1");
      }
      return { kind: "handshake", protocol: 1 };
    }
    case "execute": {
      assertNoExtraKeys(v, ["kind", "code", "deadlineMs"]);
      if (!isString(v.code)) {
        throw new InvalidRpcRequest("execute.code must be a string");
      }
      if (typeof v.deadlineMs !== "number") {
        throw new InvalidRpcRequest("execute.deadlineMs must be a number");
      }
      return { kind: "execute", code: v.code, deadlineMs: v.deadlineMs };
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
      assertNoExtraKeys(v, ["kind", "namespace", "url", "secret"]);
      if (!isString(v.namespace)) {
        throw new InvalidRpcRequest("source.provision.namespace must be a string");
      }
      if (!isString(v.url)) {
        throw new InvalidRpcRequest("source.provision.url must be a string");
      }
      if (v.secret !== undefined && !isString(v.secret)) {
        throw new InvalidRpcRequest("source.provision.secret must be a string when present");
      }
      const result: RpcRequest = { kind: "source.provision", namespace: v.namespace, url: v.url };
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
    default:
      throw new InvalidRpcRequest(`unknown request kind "${kind}"`);
  }
}

export const CAPABILITIES: Record<
  "serve" | "approvals" | "add-mcp",
  ReadonlySet<RpcRequest["kind"]>
> = {
  serve: new Set(["execute", "search", "describe", "handshake"]),
  approvals: new Set(["approvals.list", "approvals.resume", "handshake"]),
  "add-mcp": new Set(["source.provision", "source.revalidate", "handshake"]),
};
