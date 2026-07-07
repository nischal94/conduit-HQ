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

/** Aligns with §16's output cap: a response the sandbox could never return is refused. */
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
        // Auth headers exist ONLY in this argument scope (spec §9.2) —
        // never on an object that outlives the call or reaches an error.
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
        throw upstreamError(
          `Upstream redirect refused (spec §9.3): redirects are not followed. Context: { status: ${response.status} }`,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
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
      let parsed: { result?: unknown; error?: { code?: number; message?: string } };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        throw upstreamError(
          `Upstream response is not valid JSON. Context: { tool: ${request.tool.name} }`,
        );
      }
      if (parsed.error !== undefined) {
        // The JSON-RPC error message is upstream-controlled text headed for
        // a guest-visible error: redact + sanitize before interpolating.
        throw upstreamError(
          `Upstream tool call failed: ${sanitizeUpstreamText(String(parsed.error.message ?? "unknown error"), request.auth)}. Context: { code: ${parsed.error.code ?? "none"} }`,
        );
      }
      return { result: parsed.result ?? null, status: response.status, latencyMs };
    },
  };
}

/**
 * Upstream-controlled text that will cross into a guest-visible error:
 * redact every auth-header value (a hostile upstream echoes what we sent),
 * strip control characters, cap length — in that order, so truncation can
 * never bisect a redaction.
 */
function sanitizeUpstreamText(raw: string, auth: UpstreamAuth): string {
  let text = raw;
  for (const value of Object.values(auth.headers)) {
    if (value !== "") {
      text = text.split(value).join("[redacted]");
    }
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
      await reader.cancel();
      throw upstreamError(
        `Upstream response exceeded the size cap. Context: { maxBytes: ${maxBytes} }`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
