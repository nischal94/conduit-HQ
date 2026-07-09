import { redactionTokens, redactTokens } from "../pipeline/upstream.js";

/**
 * §5.5 design D7 — best-effort credential scrub for a persisted/replayed
 * call result.
 *
 * BEST-EFFORT DEFENSE-IN-DEPTH — deliberately NOT a security boundary.
 *
 * Serializes `result`, replaces every verbatim occurrence of `secret` with
 * a redaction marker, and parses back. This is a substring scan over
 * untrusted upstream data, and that input space is unbounded: a hostile or
 * careless upstream can echo the credential in endless ways this scan
 * cannot catch (base64, split across fields, homoglyphs, chunked, re-cased).
 * Extending it per newly-discovered encoding is the denylist whack-a-mole
 * that ~/.claude/rules/adversarial-convergence.md exists to stop — so we do
 * NOT. It is a cheap tripwire for the OBVIOUS echo, not a promise that a
 * secret can never appear in a result that gets persisted or replayed.
 *
 * The REAL, structural guarantee is elsewhere and does not depend on this
 * scan: per design D7, request-scoped credentials are never themselves
 * persisted — only the (possibly still-imperfect) scrubbed result is. Under
 * the convergence criterion, an adversarial finding that gets an encoded
 * secret past this scan is category (b) (a known limit of a best-effort
 * layer), not a boundary break.
 *
 * SHARES upstream.ts's token primitive so the two cannot diverge: it derives
 * the same sub-token list (full value + whitespace-segmented segments >=5
 * chars, scheme words excluded) via `redactionTokens` and redacts through the
 * same `redactTokens` loop that `sanitizeUpstreamText` uses. This means a
 * bare-token echo (the secret's token without its `Bearer `/`token ` scheme)
 * is scrubbed here exactly as the upstream scan catches it — closing the gap
 * where a mirror-instead-of-reuse implementation only matched the full string.
 */
export function scrubCredential(result: unknown, secret: string | undefined): unknown {
  if (secret === undefined || secret === "") {
    return result;
  }
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    // `result` is `undefined` itself (or a bare function/symbol) —
    // JSON.stringify returns undefined for those; nothing to scrub.
    return result;
  }
  const scrubbed = redactTokens(serialized, redactionTokens(secret));
  return JSON.parse(scrubbed);
}
