import type { UpstreamAuth } from "../credentials.js";
import type { Source, Tool } from "../types.js";
import { assertEgressAllowed, type EgressOptions } from "./egress.js";
import { ConduitCallError, upstreamError } from "./errors.js";

/**
 * Upstream caller seam (spec §5.3 step 4): the pipeline hands over a fully
 * resolved request — tool, source, input, auth, time budget — and gets back
 * an outcome or a thrown ConduitCallError. Only this module knows about
 * fetch, JSON-RPC, or wire formats; per-source-type callers (decision A5:
 * MCP-only in v1) mount behind this interface.
 */
export interface UpstreamRequest {
  tool: Tool;
  source: Source;
  input: unknown;
  auth: UpstreamAuth;
  timeoutMs: number;
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
  return {
    async call(request: UpstreamRequest): Promise<UpstreamOutcome> {
      let target: URL;
      try {
        target = new URL(request.source.location);
        await assertEgressAllowed(target, options.egress ?? {});
      } catch (cause) {
        // Egress refusals cross as upstream errors, not opaque infra: the
        // guard's message is ref-free and tells the agent exactly which
        // §9.3 default fired.
        throw upstreamError(
          cause instanceof Error ? cause.message : "Upstream URL failed the egress check.",
        );
      }
      // Decision A5: upstream MCP name = tool name minus the namespace
      // prefix the normalizer added. Known limitation (documented in §18):
      // wrong for MCP names the normalizer had to transform.
      const upstreamName = request.tool.name.startsWith(`${request.tool.namespace}.`)
        ? request.tool.name.slice(request.tool.namespace.length + 1)
        : request.tool.name;
      const startedAt = Date.now();
      let response: Response;
      try {
        // The merged header object lives only in this fetch argument (spec
        // §9.2): auth material is never persisted beyond the call frame nor
        // interpolated into an error, trace row, or host log (it reaches
        // sanitizeUpstreamText only as the redaction key, never as output).
        response = await fetch(target, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...request.auth.headers,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method: "tools/call",
            params: { name: upstreamName, arguments: request.input ?? {} },
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (cause) {
        const reason =
          cause instanceof Error && cause.name === "TimeoutError"
            ? `timed out after ${request.timeoutMs}ms`
            : "request failed before a response arrived";
        throw upstreamError(
          `Upstream call failed: ${reason}. Context: { tool: ${request.tool.name} }`,
        );
      }
      const latencyMs = Date.now() - startedAt;
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {}); // release the socket; the body is refused
        throw upstreamError(
          `Upstream redirect refused (spec §9.3): redirects are not followed. Context: { status: ${response.status} }`,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        await response.body?.cancel().catch(() => {});
        throw upstreamError(
          `Upstream returned a non-JSON response. Context: { status: ${response.status}, contentType: ${sanitizeUpstreamText(contentType, request.auth) || "none"} }`,
        );
      }
      // A 4xx/5xx body is still read (capped) to drain the socket, but its
      // content never reaches the error — hostile upstreams echo secrets.
      // Read-phase failures (slow-loris body, mid-stream reset) classify as
      // upstream, same as their pre-response siblings above.
      let body: string;
      try {
        body = await readCapped(response, maxBytes);
      } catch (cause) {
        if (cause instanceof ConduitCallError) {
          throw cause; // the size cap, already classified
        }
        const reason =
          cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
            ? `timed out after ${request.timeoutMs}ms while reading the response`
            : "connection failed while reading the response";
        throw upstreamError(
          `Upstream call failed: ${reason}. Context: { tool: ${request.tool.name} }`,
        );
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw upstreamError(
            `Upstream rejected the connection's credentials (HTTP ${response.status}) — check the connection. Context: { tool: ${request.tool.name} }`,
          );
        }
        throw upstreamError(
          `Upstream returned HTTP ${response.status}. Context: { tool: ${request.tool.name} }`,
        );
      }
      // §9.2, success-path twin of the error sanitizer: a response that
      // contains the connection's own credential (full value OR a bare
      // token segment) is a hostile echo. The secret must never cross into
      // the sandbox, the journal, or Trace — so the call fails closed
      // instead of delivering a redacted result.
      if (credentialTokens(request.auth).some((token) => body.includes(token))) {
        throw upstreamError(
          `Upstream response echoed the connection's credential; refusing to deliver it. Context: { tool: ${request.tool.name} }`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw upstreamError(
          `Upstream response is not valid JSON. Context: { tool: ${request.tool.name} }`,
        );
      }
      // Validate the JSON-RPC envelope shape rather than trusting a cast: a
      // non-object body, or one bearing neither `result` nor `error`, is a
      // protocol violation — never a `{ result: null }` success (which would
      // memoize garbage for §5.5 replay) and never a raw property-access
      // TypeError laundered into an opaque infra error.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw upstreamError(
          `Upstream response is not a JSON-RPC object. Context: { tool: ${request.tool.name} }`,
        );
      }
      const envelope = parsed as { result?: unknown; error?: unknown };
      if (envelope.error !== undefined && envelope.error !== null) {
        // Upstream-controlled text headed for a guest-visible error: redact
        // + sanitize before interpolating.
        const rpcError = envelope.error as { code?: unknown; message?: unknown };
        throw upstreamError(
          `Upstream tool call failed: ${sanitizeUpstreamText(String(rpcError.message ?? "unknown error"), request.auth)}. Context: { code: ${typeof rpcError.code === "number" ? rpcError.code : "none"} }`,
        );
      }
      if (!("result" in envelope)) {
        throw upstreamError(
          `Upstream response carried neither a result nor an error (not JSON-RPC). Context: { tool: ${request.tool.name} }`,
        );
      }
      return { result: envelope.result ?? null, status: response.status, latencyMs };
    },
  };
}

/**
 * Every credential string worth scanning for in an upstream echo: each
 * auth-header value in full, plus its whitespace-separated segments long
 * enough to be a real secret (so a bare-token echo — the token without its
 * `Bearer `/`token ` scheme — is caught too). Scheme words like `Bearer`
 * fall below the length floor and are never redacted. Longest first, so a
 * full value is replaced before its own sub-token can match a fragment.
 */
function credentialTokens(auth: UpstreamAuth): string[] {
  const tokens = new Set<string>();
  for (const value of Object.values(auth.headers)) {
    if (value === "") {
      continue;
    }
    tokens.add(value);
    for (const segment of value.split(/\s+/)) {
      if (segment.length >= 8) {
        tokens.add(segment);
      }
    }
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}

/**
 * Upstream-controlled text that will cross into a guest-visible error:
 * redact every credential token (a hostile upstream echoes what we sent),
 * strip control characters, cap length — in that order, so truncation can
 * never bisect a redaction.
 */
function sanitizeUpstreamText(raw: string, auth: UpstreamAuth): string {
  let text = raw;
  for (const token of credentialTokens(auth)) {
    text = text.split(token).join("[redacted]");
  }
  const printable = [...text].filter((ch) => ch >= " " && ch !== "\u007f").join("");
  return printable.length > 200 ? `${printable.slice(0, 200)}…` : printable;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      // Swallow a cancel rejection so the cap error always wins — a cap
      // violation is a policy refusal, not the network flake the caller's
      // catch would otherwise report it as.
      await reader.cancel().catch(() => {});
      throw upstreamError(
        `Upstream response exceeded the size cap. Context: { maxBytes: ${maxBytes} }`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
