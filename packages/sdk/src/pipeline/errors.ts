import { inspect } from "node:util";

/**
 * Pipeline error boundary (spec §5.3, §9.2): the ONLY error shapes allowed
 * to cross into the sandbox. Infra causes ([SqliteStore]/[CredentialResolver]
 * messages carry refs and internals) stay host-side behind a correlation id.
 */
export type CallErrorKind = "policy" | "upstream" | "infra";

export const GUEST_ERROR_NAMES = {
  policyDenied: "ConduitPolicyDenied",
  policyBlocked: "ConduitPolicyBlocked",
  upstream: "ConduitUpstreamError",
  infra: "ConduitInternalError",
} as const;

/** The closed vocabulary: the only error names that may cross the boundary. */
export type GuestErrorName = (typeof GUEST_ERROR_NAMES)[keyof typeof GUEST_ERROR_NAMES];

/** §5.5 contract: journal entries bearing these names are never memoized on replay. */
export const NON_MEMOIZABLE_ERROR_NAMES: readonly string[] = [
  GUEST_ERROR_NAMES.policyDenied,
  GUEST_ERROR_NAMES.policyBlocked,
] satisfies readonly GuestErrorName[];

export class ConduitCallError extends Error {
  readonly kind: CallErrorKind;
  readonly correlationId: string | undefined;
  // `name` is typed to the closed vocabulary: an UpstreamCaller implementer
  // (the A5 extension point) cannot mint an arbitrary name that would cross
  // into the sandbox and mis-drive §5.5 replay stripping. Prefer the
  // factories below; they also pair kind and name correctly.
  constructor(kind: CallErrorKind, name: GuestErrorName, message: string, correlationId?: string) {
    super(message);
    this.name = name;
    this.kind = kind;
    this.correlationId = correlationId;
  }
}

export function policyError(
  action: "require_approval" | "block",
  reason: string,
): ConduitCallError {
  const name =
    action === "block" ? GUEST_ERROR_NAMES.policyBlocked : GUEST_ERROR_NAMES.policyDenied;
  return new ConduitCallError("policy", name, reason);
}

export function upstreamError(message: string): ConduitCallError {
  return new ConduitCallError("upstream", GUEST_ERROR_NAMES.upstream, message);
}

export function infraError(cause: unknown, log: (message: string) => void): ConduitCallError {
  const correlationId = crypto.randomUUID();
  // inspect() keeps the stack and the walked `cause` chain (egress and
  // [SqliteStore] read errors attach `{ cause }`): the correlation id is
  // the ONLY host-side pointer to the real fault, so it must not degrade
  // to "[object Object]".
  const detail = inspect(cause, { depth: 5 });
  log(`[ToolInvoker] Infra failure ${correlationId}: ${detail}`);
  return new ConduitCallError(
    "infra",
    GUEST_ERROR_NAMES.infra,
    `Internal error on this call. Reference: ${correlationId}`,
    correlationId,
  );
}
