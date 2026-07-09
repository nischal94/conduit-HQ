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
 * Mirrors the shape of the upstream credential-echo scan in
 * pipeline/upstream.ts (`containsCredential` / `sanitizeUpstreamText`), but
 * is simpler: this callsite already has exactly one candidate secret string
 * (not a set of auth-header-derived tokens), so there is no token-extraction
 * step to mirror — only the serialize → verbatim-replace → parse-back shape
 * and the best-effort labeling.
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
  const scrubbed = serialized.split(secret).join("[redacted]");
  return JSON.parse(scrubbed);
}
