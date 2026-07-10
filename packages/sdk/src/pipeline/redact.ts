/**
 * §11 semantic redaction — display hygiene for the audit Trace, NOT a
 * security boundary. The credential boundary is structural (§9.2:
 * request-scoped, never-persisted credentials); the §5.5 replay journal
 * is deliberately untouched (design D7 / spec R8). The claim here is
 * BOUNDED and convergent (adversarial-convergence.md): fields NAMED by
 * the builtin list or a tool's policy are masked — not "all sensitive
 * data". Scalar payloads are not scanned.
 *
 * STRICTLY NON-MUTATING (design R5, load-bearing): the execution manager
 * scrubs and journals the same `value` reference AFTER appendTrace runs,
 * and `pausedOn.input` is journaled after the refusal-path trace append.
 * An in-place mutation here would put semantically-redacted data into
 * the replay journal — replay divergence, exactly the D7 violation this
 * module must not commit.
 */

/** Same marker as pipeline/upstream.ts's credential scan. */
const REDACTED = "[redacted]";

/**
 * Fail-closed recursion cap: at or beyond it, the value is replaced with the
 * marker — passing it through unredacted would make deep nesting a
 * redaction bypass (design R5).
 */
const MAX_DEPTH = 64;

/**
 * Builtin sensitive key names, already normalized (see normalizeRedactKey).
 * Pinned by the INVARIANT §11 test; extend deliberately, not per finding.
 */
export const BUILTIN_REDACT_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "xapikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "clientsecret",
  "authorization",
  "auth",
  "bearer",
  "credential",
  "credentials",
  "cookie",
  "setcookie",
  "ssn",
];

/**
 * Lowercase + strip `-`, `_`, `.`, and spaces: `apiKey`, `api_key`, and
 * `API-KEY` all normalize to `apikey`. Matching is EXACT on the normalized
 * form (`author` never matches `auth`) — no substring heuristics, so the
 * claim stays bounded (design R2).
 */
export function normalizeRedactKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, "");
}

/**
 * Returns a redacted deep copy of `value`: every object entry whose
 * normalized key is in the builtin list or `extraKeys` has its value
 * (scalar or whole subtree) replaced with "[redacted]". Non-object roots
 * pass through unchanged. Never mutates `value`.
 */
export function redactSensitiveFields(value: unknown, extraKeys: readonly string[]): unknown {
  const keys = new Set(BUILTIN_REDACT_KEYS);
  for (const key of extraKeys) {
    keys.add(normalizeRedactKey(key));
  }
  return walk(value, keys, 0, new WeakSet());
}

function walk(
  value: unknown,
  keys: ReadonlySet<string>,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_DEPTH || ancestors.has(value)) {
    return REDACTED;
  }
  // `ancestors` tracks the CURRENT path only (delete after recursion), so a
  // shared non-cyclic subtree is copied normally and only a true
  // back-reference trips the fail-closed arm.
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => walk(item, keys, depth + 1, ancestors));
  } else {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = keys.has(normalizeRedactKey(key))
        ? REDACTED
        : walk(entry, keys, depth + 1, ancestors);
    }
    result = out;
  }
  ancestors.delete(value);
  return result;
}
