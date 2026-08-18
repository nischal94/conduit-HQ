import {
  DaemonUnavailable,
  type RpcPayloadFor,
  type RpcRequest,
  type RpcResponse,
  type RpcResponseFor,
} from "@conduithq/mcp";

/**
 * The one daemon-answer reduction both operator-facing CLI commands use.
 *
 * `approvals` and `add-mcp` each grew their own copy of this trio
 * (`Answer`, `describeResponse`, `ask`) during their conversions, and the
 * copies had already diverged: only `approvals` appended the
 * `outcome-unknown` cause detail, so the same protocol fault told one
 * operator WHICH failure they were looking at and told the other nothing.
 * That asymmetry is resolved here in the detail-appending copy's favor —
 * the cause is the difference between "read the daemon log" and "retry
 * later", and it is as actionable for a provisioning as for a resume.
 *
 * **Not shared with `server.ts`'s `unwrap`.** That seam lives in the mcp
 * package, answers an AGENT rather than an operator, and converts refusals
 * into `McpError` — a different error model whose redaction posture is
 * deliberately stricter (an agent gets less than an operator does). Folding
 * the two together would drag one of those postures onto the other's
 * surface.
 *
 * Per-command WORDING stays per-command: every line each command prints is
 * passed in as context rather than unified, because the prose differs for
 * real reasons (`approvals` names the operator's verb and points at
 * `conduit approvals list`; `add-mcp` names the provisioning and points at
 * checking registration). Only the SHAPE of the reduction is shared.
 */

/**
 * One daemon round trip, reduced to either a payload or an operator-facing
 * refusal. Every non-`result` answer is a REFUSAL rather than an empty
 * success — rendering "nothing here" for a queue or a provisioning the
 * daemon never reported is the one wrong answer these commands must never
 * give.
 */
export type Answer<P> = { ok: true; payload: P } | { ok: false; line: string; exitCode: number };

/** The injectable daemon seam both commands drive their tests through. */
export type DaemonCall = (request: RpcRequest) => Promise<RpcResponse>;

/**
 * The per-command prose. Each field is a line (or line-builder) the owning
 * command supplies verbatim, so the shared reduction decides the STRUCTURE
 * of the answer and the command decides what the operator reads.
 */
export interface AnswerContext {
  /**
   * The §5 ambiguity line: the connection died after the request bytes went
   * out, so the operation may or may not have landed. The command supplies
   * the whole sentence because what the operator should do next is
   * command-specific (check the approval queue vs. check whether the source
   * is registered). MUST NOT end in a newline — the shared reduction
   * appends the cause clause and the newline.
   */
  outcomeUnknown: (requestId: string) => string;
  /** The daemon's own typed refusal, rendered for this command's surface. */
  refused: (code: string, message: string) => string;
  /** A frame the client already consumed arriving where a result belongs. */
  desync: (kind: string) => string;
  /** A non-`DaemonUnavailable` throw on the way to the daemon. */
  unreachable: (detail: string) => string;
}

/**
 * Reduces one response frame to an `Answer`.
 *
 * The `outcome-unknown` arm appends the client's cause detail when there is
 * one. The §5 VERDICT is unchanged by the cause — the outcome is ambiguous
 * either way and must not be retried — but the cause tells the operator
 * which failure they are looking at: a misbehaving daemon (unparseable
 * bytes) versus a dropped connection, which is the difference between
 * reading the daemon log and simply retrying later.
 */
export function describeResponse<K extends RpcRequest["kind"]>(
  response: RpcResponseFor<K>,
  context: AnswerContext,
): Answer<RpcPayloadFor<K>> {
  if (response.kind === "result") return { ok: true, payload: response.payload };
  if (response.kind === "outcome-unknown") {
    return {
      ok: false,
      exitCode: 1,
      line: `${context.outcomeUnknown(response.requestId)}${
        response.detail !== undefined ? ` Cause: ${response.detail}.` : ""
      }\n`,
    };
  }
  if (response.kind === "error") {
    return {
      ok: false,
      exitCode: 1,
      line: `${context.refused(response.code, response.message)}\n`,
    };
  }
  // `ready`/`handshake.ok` are prefaces the client already consumed.
  return { ok: false, exitCode: 1, line: `${context.desync(response.kind)}\n` };
}

/**
 * Calls the daemon, folding a thrown `DaemonUnavailable` into the same
 * Answer shape. That error is NOT dressed up: it already carries the state
 * directory, the deadline, and the daemon log path that explains why a
 * child exited — everything the operator needs to act. These are
 * operator-facing commands, so unlike the agent-facing `serve` seam there
 * is nothing here to redact it from.
 */
export async function ask<K extends RpcRequest["kind"]>(
  daemon: DaemonCall,
  request: Extract<RpcRequest, { kind: K }>,
  context: AnswerContext,
): Promise<Answer<RpcPayloadFor<K>>> {
  try {
    return describeResponse<K>((await daemon(request)) as RpcResponseFor<K>, context);
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      line:
        error instanceof DaemonUnavailable
          ? `${error.message}\n`
          : `${context.unreachable(error instanceof Error ? error.message : String(error))}\n`,
    };
  }
}
