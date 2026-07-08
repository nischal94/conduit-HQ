import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { UpstreamAuth } from "../credentials.js";
import type { Source, Tool } from "../types.js";
import {
  assertEgressAllowed,
  createPinnedLookup,
  type EgressOptions,
  isEgressBlockedError,
} from "./egress.js";
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
      // Decision A5: upstream MCP name = tool name minus the namespace
      // prefix the normalizer added. Known limitation (documented in §18):
      // wrong for MCP names the normalizer had to transform.
      const upstreamName = request.tool.name.startsWith(`${request.tool.namespace}.`)
        ? request.tool.name.slice(request.tool.namespace.length + 1)
        : request.tool.name;
      const startedAt = Date.now();
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: upstreamName, arguments: request.input ?? {} },
      });
      let res: IncomingMessage;
      try {
        // The merged header object lives only in this request (spec §9.2):
        // auth material is never persisted beyond the call frame nor
        // interpolated into an error, trace row, or host log (it reaches
        // sanitizeUpstreamText only as the redaction key, never as output).
        // The pinned lookup forces the socket to a §9.3-vetted IP.
        res = await sendPinnedRequest({
          target,
          payload,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...request.auth.headers,
          },
          timeoutMs: request.timeoutMs,
          lookup: pinnedLookup,
        });
      } catch (cause) {
        if (cause instanceof ConduitCallError) {
          throw cause;
        }
        // A §9.3 refusal from the pinned lookup (every resolved address private
        // at connect time — the DNS-rebinding case) is detected structurally,
        // not by string-matching: the tagged error's message is ref-free and
        // crosses to the agent verbatim.
        if (isEgressBlockedError(cause)) {
          throw upstreamError((cause as Error).message);
        }
        const reason =
          cause instanceof Error && cause.name === "TimeoutError"
            ? `timed out after ${request.timeoutMs}ms`
            : "request failed before a response arrived";
        throw upstreamError(
          `Upstream call failed: ${reason}. Context: { tool: ${request.tool.name} }`,
        );
      }
      const latencyMs = Date.now() - startedAt;
      const status = res.statusCode ?? 0;
      if (status === 0) {
        // No parsed status line (malformed response). Refuse with a clear
        // reason rather than the confusing "HTTP 0".
        res.destroy();
        throw upstreamError(
          `Upstream response had no valid status line. Context: { tool: ${request.tool.name} }`,
        );
      }
      if (status >= 300 && status < 400) {
        res.destroy(); // release the socket; the redirect is refused, never followed
        throw upstreamError(
          `Upstream redirect refused (spec §9.3): redirects are not followed. Context: { status: ${status} }`,
        );
      }
      const contentType = res.headers["content-type"] ?? "";
      if (!contentType.includes("application/json")) {
        res.destroy();
        throw upstreamError(
          `Upstream returned a non-JSON response. Context: { status: ${status}, contentType: ${sanitizeUpstreamText(contentType, request.auth) || "none"} }`,
        );
      }
      // A 4xx/5xx body is still read (capped) to drain the socket, but its
      // content never reaches the error — hostile upstreams echo secrets.
      // Read-phase failures (slow-loris body, mid-stream reset) classify as
      // upstream, same as their pre-response siblings above.
      let body: string;
      try {
        body = await readCapped(res, maxBytes, request.timeoutMs, startedAt);
      } catch (cause) {
        if (cause instanceof ConduitCallError) {
          throw cause; // the size cap, already classified
        }
        const reason =
          cause instanceof Error && cause.name === "TimeoutError"
            ? `timed out after ${request.timeoutMs}ms while reading the response`
            : "connection failed while reading the response";
        throw upstreamError(
          `Upstream call failed: ${reason}. Context: { tool: ${request.tool.name} }`,
        );
      }
      if (status < 200 || status >= 300) {
        if (status === 401 || status === 403) {
          throw upstreamError(
            `Upstream rejected the connection's credentials (HTTP ${status}) — check the connection. Context: { tool: ${request.tool.name} }`,
          );
        }
        throw upstreamError(
          `Upstream returned HTTP ${status}. Context: { tool: ${request.tool.name} }`,
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
      // §9.2 BEST-EFFORT tripwire (NOT a boundary — see containsCredential):
      // if the response obviously contains the connection's own credential,
      // fail closed rather than deliver it. Runs on the re-serialized parsed
      // structure so a JSON-escaped echo is caught after decode. This scan
      // cannot be complete (an adversary can encode the secret in unbounded
      // ways), so it is not the guarantee — it is a cheap catch for the common
      // case. The real guarantee is structural: the credential lives only in
      // this request scope and is never persisted (§9.2); at-rest redaction is
      // §11. Per ~/.claude/rules/adversarial-convergence.md, a finding against
      // this scan is category (b), not a boundary break.
      if (containsCredential(JSON.stringify(parsed) ?? "", request.auth)) {
        throw upstreamError(
          `Upstream response echoed the connection's credential; refusing to deliver it. Context: { tool: ${request.tool.name} }`,
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
      return { result: envelope.result ?? null, status, latencyMs };
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
// Auth-scheme words are not secrets; scanning for them would false-positive
// on ordinary response text. Everything else in a header value is treated as
// credential material down to a short floor (real tokens run 6+ chars; a
// hostile server can echo just the bare token, so the floor must be low
// enough to catch short ones without matching common English words).
const AUTH_SCHEME_WORDS = new Set(["bearer", "basic", "token", "digest", "negotiate", "apikey"]);
const MIN_TOKEN_LEN = 5;

function credentialTokens(auth: UpstreamAuth): string[] {
  const tokens = new Set<string>();
  for (const value of Object.values(auth.headers)) {
    if (value === "") {
      continue;
    }
    tokens.add(value);
    for (const segment of value.split(/\s+/)) {
      if (segment.length >= MIN_TOKEN_LEN && !AUTH_SCHEME_WORDS.has(segment.toLowerCase())) {
        tokens.add(segment);
      }
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
  let text = raw;
  for (const token of credentialTokens(auth)) {
    text = text.split(token).join("[redacted]");
  }
  const printable = [...text].filter((ch) => ch >= " " && ch !== "\u007f").join("");
  return printable.length > 200 ? `${printable.slice(0, 200)}…` : printable;
}

/**
 * Sends the POST over node:http(s) with the pinned lookup and resolves with
 * the response stream (headers arrived; body not yet read). The Agent's
 * `lookup` forces the socket to a §9.3-vetted IP; the whole-request deadline
 * fires here for the pre-body phase, and again in readCapped for the body.
 *
 * A `lookup` rejection (all addresses private / NXDOMAIN) surfaces as the
 * socket's `error` — mapped by the caller. A pre-response deadline rejects
 * with a TimeoutError-named error so the caller's classifier matches fetch's.
 */
function sendPinnedRequest(args: {
  target: URL;
  payload: string;
  headers: Record<string, string>;
  timeoutMs: number;
  lookup: ReturnType<typeof createPinnedLookup>;
}): Promise<IncomingMessage> {
  const { target, payload, headers, timeoutMs, lookup } = args;
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = send(
      target,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) },
        lookup,
      },
      (res) => {
        // Headers arrived: the PRE-RESPONSE deadline is done. Disarm it so it
        // cannot fire during the body-read phase — readCapped owns that
        // deadline exclusively. Leaving it armed would race readCapped's timer
        // and, if it won, destroy the socket with a plain "aborted" error that
        // the caller mis-classifies as a connection failure, not a timeout.
        req.setTimeout(0);
        resolve(res);
      },
    );
    // The pre-response deadline: fires only until headers arrive. Destroy with
    // a TimeoutError so the caller's name check (mirrored from
    // AbortSignal.timeout) classifies it as a timeout.
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("Upstream request timed out"), { name: "TimeoutError" }));
    });
    req.on("error", (err) => reject(err));
    req.end(payload);
  });
}

/**
 * Reads the response stream into a UTF-8 string, capping at maxBytes off the
 * wire (never trusting content-length) and aborting if the body trickles past
 * the whole-request deadline. A cap breach throws a pre-classified upstream
 * error (a policy refusal, not a network flake); a deadline breach throws a
 * TimeoutError-named error the caller maps to "timed out while reading".
 */
function readCapped(
  res: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
  startedAt: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
    const timer = setTimeout(() => {
      res.destroy(
        Object.assign(new Error("Upstream body read timed out"), { name: "TimeoutError" }),
      );
    }, remaining);
    const settleReject = (err: unknown): void => {
      clearTimeout(timer);
      reject(err);
    };
    res.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        // The cap wins over any subsequent 'error' from destroy(): a cap
        // breach is a policy refusal, pre-classified so the caller passes it
        // through rather than re-labeling it a network failure.
        res.destroy();
        settleReject(
          upstreamError(
            `Upstream response exceeded the size cap. Context: { maxBytes: ${maxBytes} }`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    res.on("error", (err) => settleReject(err));
  });
}
