import type { UpstreamAuth } from "../credentials.js";
import type { Source, Tool } from "../types.js";
import {
  assertEgressAllowed,
  createPinnedLookup,
  type EgressOptions,
  isEgressBlockedError,
} from "./egress.js";
import { ConduitCallError, upstreamError } from "./errors.js";
import { createMcpClient, McpClientError } from "./mcp-client.js";
import { createUpstreamSessionScope, type UpstreamSessionScope } from "./upstream-session.js";

/**
 * Upstream caller seam (spec §5.3 step 4): the pipeline hands over a fully
 * resolved request — tool, source, input, auth, time budget — and gets back
 * an outcome or a thrown ConduitCallError. Only this module knows about the
 * MCP client, JSON-RPC, or wire formats; per-source-type callers (decision A5:
 * MCP-only in v1) mount behind this interface.
 *
 * The wire transport itself lives in `mcp-client.ts` (streamable HTTP,
 * design D2/§18-C4): this module OWNS the §9.3 egress boundary (pre-flight +
 * pinned lookup), the §9.2 credential redaction of guest-visible text, and
 * the mapping of the client's typed error kinds back onto the guest-facing
 * upstream-error taxonomy. The transport mechanics that used to live here
 * (the bare JSON-RPC POST + capped body read) now belong to the client.
 */
export interface UpstreamRequest {
  tool: Tool;
  source: Source;
  input: unknown;
  auth: UpstreamAuth;
  timeoutMs: number;
  /**
   * Per-drive session scope (§18-C4): reuses one initialized MCP session
   * across calls to the same (url, auth). Optional — when absent (legacy
   * callers, tests) an EPHEMERAL scope is used for this one call, so the
   * handshake still happens but nothing is cached.
   */
  session?: UpstreamSessionScope;
}

export interface UpstreamOutcome {
  /** The JSON-RPC `result` as the server sent it (MCP CallToolResult shape). */
  result: unknown;
  status: number;
  latencyMs: number;
}

export interface UpstreamCaller {
  call(request: UpstreamRequest): Promise<UpstreamOutcome>;
}

/** Host-side memory bound on upstream bodies; shares §16's 1 MB default. */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export function createMcpUpstreamCaller(
  options: { maxResponseBytes?: number; egress?: EgressOptions } = {},
): UpstreamCaller {
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // The §9.3 authoritative check: a lookup that resolves once and forces the
  // socket to a vetted IP (spec §18 Phase-1). Passed into every request so
  // the address the guard vetted IS the address connected to — no second,
  // independent resolution to rebind (see egress.ts / createPinnedLookup).
  const pinnedLookup = createPinnedLookup(options.egress ?? {});
  return {
    async call(request: UpstreamRequest): Promise<UpstreamOutcome> {
      let target: URL;
      try {
        target = new URL(request.source.location);
        // Pre-flight: rejects a bad protocol (the lookup only governs DNS/IP)
        // and fast-fails an obviously-private literal before a socket opens.
        await assertEgressAllowed(target, options.egress ?? {});
      } catch (cause) {
        // Egress refusals cross as upstream errors, not opaque infra: the
        // guard's message is ref-free and tells the agent exactly which
        // §9.3 default fired.
        throw upstreamError(
          cause instanceof Error ? cause.message : "Upstream URL failed the egress check.",
        );
      }
      // Decision A5 (amended by C5 design D4): the upstream MCP name is the
      // raw wire name recorded at normalize time (`sourceSemantics.upstreamName`)
      // so hyphenated names round-trip exactly. On a LEGACY row that predates
      // C5 (no `upstreamName` in the stored source_semantics), fall back to
      // today's prefix-strip — documented-lossy: wrong for MCP names the
      // normalizer had to transform (e.g. `resolve-library-id`).
      const upstreamName =
        request.tool.sourceSemantics.kind === "mcp" &&
        request.tool.sourceSemantics.upstreamName !== undefined
          ? request.tool.sourceSemantics.upstreamName
          : stripNamespacePrefix(request.tool);
      const startedAt = Date.now();
      // The WHOLE logical operation — handshake + call + one 404-retry — shares
      // this single deadline (preserving F1's per-call budget semantics). The
      // client decrements against `deadline()` at every phase; the byte cap is
      // cumulative across every response in the operation.
      const budget = {
        deadline: () => Math.max(0, request.timeoutMs - (Date.now() - startedAt)),
        maxBytes,
      };
      // The merged header object lives only in this call frame (spec §9.2):
      // auth material is never persisted beyond the call, nor interpolated
      // into an error/trace/host-log (the client never echoes headers, and
      // guest-visible text is redacted below). The pinned lookup forces the
      // socket to a §9.3-vetted IP.
      const scope = request.session ?? createUpstreamSessionScope();
      try {
        const { client, session } = await scope.acquire({
          url: request.source.location,
          authHeaders: request.auth.headers,
          make: async () => {
            const client = createMcpClient(
              { target, headers: { ...request.auth.headers }, lookup: pinnedLookup },
              budget,
            );
            const session = await client.initialize();
            return { client, session };
          },
        });
        const { result, status } = await client.callTool(
          session,
          upstreamName,
          request.input ?? {},
        );
        assertNoCredentialEcho(result, request);
        return { result: result ?? null, status, latencyMs: Date.now() - startedAt };
      } catch (cause) {
        throw mapUpstreamError(cause, request, maxBytes);
      } finally {
        // An ephemeral scope is torn down after the call (best-effort, never
        // throws); a caller-supplied scope is owned by the caller and left
        // alone for reuse across calls.
        if (request.session === undefined) {
          await scope.dispose();
        }
      }
    },
  };
}

/**
 * Decision A5 prefix-strip: the upstream MCP name is the qualified tool name
 * minus the namespace prefix the normalizer added. The C5 fallback path only.
 */
function stripNamespacePrefix(tool: Tool): string {
  return tool.name.startsWith(`${tool.namespace}.`)
    ? tool.name.slice(tool.namespace.length + 1)
    : tool.name;
}

/**
 * §9.2 BEST-EFFORT tripwire (NOT a boundary — see containsCredential): if the
 * result obviously contains the connection's own credential, fail closed
 * rather than deliver it. Runs on the re-serialized parsed structure so a
 * JSON-escaped echo is caught after decode. This scan cannot be complete (an
 * adversary can encode the secret in unbounded ways), so it is not the
 * guarantee — it is a cheap catch for the common case. The real guarantee is
 * structural: the credential lives only in this request scope and is never
 * persisted (§9.2); at-rest redaction is §11. Per
 * ~/.claude/rules/adversarial-convergence.md, a finding against this scan is
 * category (b), not a boundary break.
 */
function assertNoCredentialEcho(result: unknown, request: UpstreamRequest): void {
  if (containsCredential(JSON.stringify(result) ?? "", request.auth)) {
    throw upstreamError(
      `Upstream response echoed the connection's credential; refusing to deliver it. Context: { tool: ${request.tool.name} }`,
    );
  }
}

/**
 * Maps a thrown error from the MCP client back onto the guest-visible upstream
 * taxonomy, preserving today's classification and message MEANING exactly:
 *
 * - a ConduitCallError (an egress pre-flight refusal, or the §9.2 echo refusal)
 *   passes through unchanged — it is already classified;
 * - a §9.3 pinned-lookup refusal (all resolved addresses private at connect
 *   time — DNS rebinding) is detected structurally via `isEgressBlockedError`
 *   and crosses as its ref-free message verbatim;
 * - `McpClientError` kinds map:
 *   - `timeout` → "timed out after {timeoutMs}ms" (the existing text);
 *   - `cap` → the existing response-size-cap refusal text;
 *   - `http_status` 3xx → the existing redirect-refused text;
 *   - other `http_status` → the existing HTTP-status text (401/403 credential
 *     variant preserved);
 *   - `protocol` → an upstream error carrying the sanitized detail
 *     (`sanitizeUpstreamText` redacts any echoed credential + strips/caps);
 *   - `network` → the existing connection-failure text.
 *
 * §9.2: no auth material ever reaches the message — the client never echoes
 * headers, and any upstream-controlled `protocol` detail is sanitized.
 */
function mapUpstreamError(
  cause: unknown,
  request: UpstreamRequest,
  maxBytes: number,
): ConduitCallError {
  if (cause instanceof ConduitCallError) {
    return cause;
  }
  // A §9.3 pinned-lookup refusal (every resolved address private at connect
  // time — the DNS-rebinding case) is detected STRUCTURALLY, not by string
  // match: its tagged error travels as the `cause` of the client's `network`
  // McpClientError (postOnce wraps the socket error), so unwrap one level.
  // The tagged message is ref-free and crosses to the agent verbatim.
  const egressBlocked = isEgressBlockedError(cause)
    ? (cause as Error)
    : cause instanceof McpClientError && isEgressBlockedError(cause.cause)
      ? (cause.cause as Error)
      : undefined;
  if (egressBlocked !== undefined) {
    return upstreamError(egressBlocked.message);
  }
  if (cause instanceof McpClientError) {
    switch (cause.kind) {
      case "timeout":
        return upstreamError(
          `Upstream call failed: timed out after ${request.timeoutMs}ms. Context: { tool: ${request.tool.name} }`,
        );
      case "cap":
        return upstreamError(
          `Upstream response exceeded the size cap. Context: { maxBytes: ${maxBytes} }`,
        );
      case "http_status": {
        const status = cause.status ?? 0;
        if (status >= 300 && status < 400) {
          return upstreamError(
            `Upstream redirect refused (spec §9.3): redirects are not followed. Context: { status: ${status} }`,
          );
        }
        if (status === 401 || status === 403) {
          return upstreamError(
            `Upstream rejected the connection's credentials (HTTP ${status}) — check the connection. Context: { tool: ${request.tool.name} }`,
          );
        }
        return upstreamError(
          `Upstream returned HTTP ${status}. Context: { tool: ${request.tool.name} }`,
        );
      }
      case "protocol":
        // Upstream-controlled protocol text headed for a guest-visible error:
        // redact + sanitize before interpolating.
        return upstreamError(
          `Upstream protocol error: ${sanitizeUpstreamText(cause.message, request.auth)}. Context: { tool: ${request.tool.name} }`,
        );
      case "network":
        return upstreamError(
          `Upstream call failed: request failed before a response arrived. Context: { tool: ${request.tool.name} }`,
        );
    }
  }
  // Any other thrown value (should not happen — the client throws only
  // McpClientError / ConduitCallError) crosses as a generic upstream failure
  // rather than an opaque infra error, and never carries its raw text.
  return upstreamError(
    `Upstream call failed: request failed before a response arrived. Context: { tool: ${request.tool.name} }`,
  );
}

/**
 * Every credential string worth scanning for in an upstream echo: each
 * auth-header value in full, plus its whitespace-separated segments long
 * enough to be a real secret (so a bare-token echo — the token without its
 * `Bearer `/`token ` scheme — is caught too). Scheme words like `Bearer`
 * fall below the length floor and are never redacted. Longest first, so a
 * full value is replaced before its own sub-token can match a fragment.
 */
// Auth-scheme words are not secrets; scanning for them would false-positive
// on ordinary response text. Everything else in a header value is treated as
// credential material down to a short floor (real tokens run 6+ chars; a
// hostile server can echo just the bare token, so the floor must be low
// enough to catch short ones without matching common English words).
const AUTH_SCHEME_WORDS = new Set(["bearer", "basic", "token", "digest", "negotiate", "apikey"]);
const MIN_TOKEN_LEN = 5;

/**
 * The SHARED redaction primitive (exported so `execution/scrub.ts` matches
 * this exact behavior instead of re-inventing it — spec D7 "reuse, not
 * re-invent"). From a SINGLE secret string, derive every token worth scanning
 * for: the full value, plus each whitespace-separated segment long enough to
 * be a real secret (so a bare-token echo — the token without its
 * `Bearer `/`token ` scheme — is caught too). Scheme words fall below the
 * length floor or are excluded outright and are never redacted. Empty input
 * yields no tokens (redacting on "" would destroy the whole text).
 */
export function redactionTokens(secret: string): string[] {
  if (secret === "") {
    return [];
  }
  const tokens = new Set<string>([secret]);
  for (const segment of secret.split(/\s+/)) {
    if (segment.length >= MIN_TOKEN_LEN && !AUTH_SCHEME_WORDS.has(segment.toLowerCase())) {
      tokens.add(segment);
    }
  }
  return [...tokens];
}

/**
 * The SHARED redaction loop (exported for `execution/scrub.ts`). Replaces
 * every token verbatim, longest first so a full value is replaced before its
 * own sub-token can match a fragment. Callers that build a token list from
 * multiple sources pass the merged list; the sort here makes order irrelevant
 * to the caller.
 */
export function redactTokens(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
    out = out.split(token).join("[redacted]");
  }
  return out;
}

function credentialTokens(auth: UpstreamAuth): string[] {
  const tokens = new Set<string>();
  for (const value of Object.values(auth.headers)) {
    for (const token of redactionTokens(value)) {
      tokens.add(token);
    }
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}

/**
 * BEST-EFFORT DEFENSE-IN-DEPTH — deliberately NOT a security boundary.
 *
 * True if any credential token appears verbatim in `text`. This is a
 * substring scan over untrusted response data, and that input space is
 * unbounded: a hostile upstream can encode the secret in endless ways
 * (base64, split across fields, homoglyphs, chunked). Extending it per newly-
 * discovered encoding is the denylist whack-a-mole that
 * ~/.claude/rules/adversarial-convergence.md exists to stop — so we do NOT.
 * It is a cheap tripwire for the OBVIOUS echo (the common misconfigured or
 * header-reflecting server), not a promise that a secret can never appear in
 * a delivered result.
 *
 * The REAL, structural guarantee is elsewhere and does not depend on this
 * scan: the credential exists only in this call's request scope (§9.2) — it
 * is never persisted, never interpolated into an error/trace/log — and
 * at-rest redaction of anything stored is §11. Under the convergence
 * criterion, an adversarial finding that gets an encoded secret past this
 * scan is category (b) (a known limit of a best-effort layer), not a boundary
 * break: the fix is never "add the encoding here", it is to rely on the
 * structural guarantee. Callers pass the re-serialized parsed structure so a
 * JSON-escaped echo — the one common encoding cheap enough to canonicalize —
 * is still caught after decode.
 */
function containsCredential(text: string, auth: UpstreamAuth): boolean {
  return credentialTokens(auth).some((token) => text.includes(token));
}

/**
 * Upstream-controlled text that will cross into a guest-visible error:
 * redact every credential token (a hostile upstream echoes what we sent),
 * strip control characters, cap length — in that order, so truncation can
 * never bisect a redaction.
 */
function sanitizeUpstreamText(raw: string, auth: UpstreamAuth): string {
  const text = redactTokens(raw, credentialTokens(auth));
  const printable = [...text].filter((ch) => ch >= " " && ch !== "\u007f").join("");
  return printable.length > 200 ? `${printable.slice(0, 200)}…` : printable;
}
