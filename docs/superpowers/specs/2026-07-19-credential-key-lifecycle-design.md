# Credential key lifecycle — design (spec §17 v1 step 1)

**Date:** 2026-07-19 · **Status:** draft for review · **Scope:** the §17 v1
surface-product prerequisite — "confirm the master-key generation, file
permissions, and a defined recovery/rotation story (§16.3, Phase 0)" — plus the
tracked 0644-at-creation `conduit.db` permissions finding.

## Decisions (made with the user, 2026-07-18/19)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Scope | Build `conduit key generate` + `conduit key rotate` CLI tooling, plus perms hardening and documented recovery story — not verify-and-document only. |
| D2 | Key source of truth | Key file first: runtime reads `~/.conduit/master-key` (0600) by default; `CONDUIT_MASTER_KEY` env var overrides when set. |
| D3 | Rotation concurrency | Stop-first, documented, with best-effort detection (exclusive write transaction); NOT a fully concurrent-safe dual-key design. |
| D4 | Wrong-key failure | Add a key-check canary so a wrong key fails loud at store-open (startup), replacing the documented fails-at-first-decrypt behavior. |

## Current state (verified 2026-07-18)

- Key loading: `CONDUIT_MASTER_KEY` env var only, canonical-base64/32-byte
  validation in `packages/mcp/src/env.ts` (`resolveEnv`). `~/.conduit/master-key`
  exists on the dev machine but no code reads it.
- Wrong key fails at first secret decrypt (spec §14 documents this as-is).
- Db directory created 0700 (`ensureDbDir`); the db FILE is created by
  `@libsql/client` at umask default → 0644 (the tracked finding). `-wal`/`-shm`
  sidecars inherit the db file's perms at their creation.
- No rotation story: the 2026-07-16 rotation was delete-everything-and-mint-fresh,
  viable only because the db held nothing worth keeping.
- Secret refs are `cred_<namespace>` (namespace is a validated identifier), so a
  reserved dotted ref cannot collide.

## 1. Key resolution (env → file → error)

`resolveEnv` in `packages/mcp/src/env.ts` (already the single env→config home
shared by `conduit serve`, `conduit-mcp --doctor`, and every CLI command that
opens the store via `openStoreFromEnv`) gains a file fallback:

1. `CONDUIT_MASTER_KEY` set → existing behavior, unchanged validation. This
   remains the container/CI/non-default-home escape hatch.
2. Otherwise read `~/.conduit/master-key` (fixed path, sibling of the default
   db): trim, then the SAME canonical-base64/32-byte validation, with the file
   named in any error. If the file's permissions are wider than 0600, print a
   stderr warning (do not fail — warn-and-serve, self-healing is `chmod` away).
3. Neither present → loud error naming both options, with
   `conduit key generate` as the suggested fix (replaces the current
   env-only error text).

Consequences: MCP client-config snippets no longer need to embed the key for
default-path setups; the "chmod 600 your client config" footgun disappears
(spec §14 walkthrough updates). The env var keeps working everywhere it is used
today.

Precedence note (documented in READMEs): if BOTH are present they must be the
same key in practice; the env var silently winning is the standard env-override
convention. `conduit key generate` warns when `CONDUIT_MASTER_KEY` is set in
its environment, since a file it writes would then not be what serve uses.

## 2. Startup canary (wrong key fails loud at open)

A reserved row in the EXISTING `secrets` table — ref `__conduit.key-canary.v1__`
(dots make it unconstructible as a real `cred_<namespace>` ref) — handled inside
`openSqliteStore` (`packages/sdk/src/store/sqlite.ts`), after schema setup:

- Row absent → seal a fixed sentinel plaintext (e.g. `conduit-key-canary`) with
  the store's `SecretBox`, INSERT. First-run initialization; idempotent under
  the M5 multi-process race (INSERT OR IGNORE — two racing first-runs both hold
  the same key, either's canary verifies).
- Row present → `secretBox.open()` it. Decrypt failure → loud
  `[SqliteStore] Failed to open store: wrong master key for this database.
  Context: { db, keySource }`-class error at open time.

Because every bin opens the store through `openSqliteStore`, serve / approvals /
add-mcp all get startup fail-fast with zero per-command code. AES-GCM is
authenticated encryption, so a failed decrypt IS proof of key mismatch (or
tampering) — no false positives. No schema change. Spec §14's
"a wrong master key fails at first secret decrypt, not startup" line is
updated to "fails at startup (key canary)".

The canary row is invisible to product surfaces: `secrets.getByRef` is only
ever called with connection-derived `cred_*` refs, and nothing enumerates the
secrets table today. Rotation (below) re-seals it like any other row.

## 3. `conduit key` command family (`packages/cli`)

New `key` command registered in `dispatch.ts` (usage text, `--help`
interception per the D5 convention).

### `conduit key generate`

- Refuses if `~/.conduit/master-key` already exists — the error points at
  `conduit key rotate`. NO overwrite flag: overwriting the live key orphans
  every sealed secret; that footgun stays unbuildable.
- Warns (stderr) if `CONDUIT_MASTER_KEY` is set — the env var would override
  the file being written.
- Mints via `SecretBox.generateKeyBytes()`, writes atomically (temp file in the
  same directory, 0600 at creation, `rename()` into place; directory created
  0700 first if absent).
- Prints next steps (client snippet no longer embeds the key). NEVER prints the
  key itself — transcript safety.

### `conduit key rotate`

Sequence (each step names its failure mode):

1. **Load old key** via the same resolution as serve (env override honored; if
   the env var supplied the old key, the closing message says every client
   config carrying it must be updated by hand).
2. **Preflight:** open the store with the old key — the §2 canary proves the
   old key is correct before anything is touched. Leftover
   `master-key.new` from a crashed prior rotate → roll-forward path (below)
   instead.
3. **Mint the new key**; write it to `~/.conduit/master-key.new` (0600,
   temp+rename) BEFORE any db write.
4. **Re-seal in ONE exclusive write transaction:** read every `secrets` row
   (canary included), `open()` with old box, `seal()` with new box, UPDATE.
   The exclusive transaction is also the best-effort concurrency detection
   (D3): a concurrent writer holding the lock → refuse with
   "stop running conduit processes first" (bounded by the existing
   busy_timeout; no partial state). Stop-first remains the DOCUMENTED
   requirement — a lock cannot see an idle serve holding the old key in
   memory; the closing message says "restart your MCP clients".
5. **Promote:** `rename("master-key.new", "master-key")` (atomic on POSIX).
6. Print completion + restart reminder. Never print either key.

**Crash-safety invariant:** at every crash point at least one on-disk key opens
the db, and `master-key.new`'s presence marks an in-flight rotation:

| Crash point | db sealed under | `master-key` | `master-key.new` | Recovery |
|---|---|---|---|---|
| before step 3 | old | old | absent | nothing happened; re-run |
| after 3, before 4 commits | old | old | new (stale) | re-run: canary opens with `master-key` → discard stale `.new`, mint fresh |
| after 4 commits, before 5 | new | old (stale) | new | serve fails loud naming `.new`; `conduit key rotate` rolls FORWARD: canary opens with `.new` → rename, done |

Roll-forward rule: when `.new` exists, rotate tries the canary under BOTH
files; whichever opens the db is the live key — `.new` wins → promote it (the
crashed rotate's commit stands); `master-key` wins → the commit never happened,
discard `.new` and start over. `resolveEnv` itself never auto-promotes (serve
stays read-only on key files); its wrong-key error mentions the `.new` file
when present and points at `conduit key rotate` to complete recovery.

### SDK seam

Re-sealing lives in the sdk as a store-level operation —
`reencryptSecrets(newBox)` exposed on/alongside the store opened with the old
key — so the transaction sits next to the schema it touches and the CLI stays a
thin adapter (the established `serve`/`approvals` pattern). The sdk's
`SecretBox` itself is UNCHANGED (same v1 sealed format; rotation is
re-encryption, not a format migration).

## 4. Db file permissions (the 0644 finding)

`ensureDbDir` (packages/mcp/src/env.ts) grows into `ensureDbFile`-scope:

- Directory: unchanged 0700 creation.
- File absent → create it empty with mode 0600 (`open` with `O_CREAT`,
  mode 0600) before `@libsql/client` ever touches the path. SQLite treats an
  empty file as a fresh database, and creates `-wal`/`-shm` with the db file's
  permissions — 0600 at creation covers the sidecars.
- File present with perms wider than 0600 → `chmod` 0600 (self-healing for
  existing installs; the 2026-07-16 hand-fix becomes code). Same for existing
  wider-perms sidecars if present.

Applies wherever the daemon/CLI creates the db; test dbs under scratch dirs are
unaffected (they go through the same path and simply get tighter perms).

## 5. Error handling

- Every new error follows the project format:
  `[Module] Operation failed: specific reason. Context: {…}` — and never
  contains key material.
- `rotate` is all-or-nothing: any failure inside step 4 rolls the transaction
  back; the observable state is always "all secrets under old key" or "all
  under new key".
- `generate`/`rotate` are offline maintenance commands: no timeout machinery
  beyond SQLite's busy_timeout; they run to completion or fail loud.

## 6. Testing (INVARIANTS, all RED-first)

| Invariant | Pin |
|---|---|
| Wrong master key fails at store open (canary), not first use | sdk store test |
| First open writes the canary; reopen with same key succeeds | sdk store test |
| `reencryptSecrets` is atomic: injected mid-rotate failure leaves every secret openable under the OLD key | sdk store test |
| After successful re-seal, every secret (canary incl.) opens under the NEW key and none under the old | sdk store test |
| Db file (and sidecars) created 0600; wider existing perms healed to 0600 | mcp env test |
| Key resolution precedence: env > file; neither → loud error naming `conduit key generate` | mcp env test |
| Key file with wider-than-0600 perms → stderr warning, still serves | mcp env test |
| `key generate` refuses when the key file exists; writes 0600 atomically otherwise | cli test |
| `key rotate` roll-forward: each crash-table row recovers as specified | cli test |
| `key rotate` refuses when another writer holds the db write lock | cli test |
| Neither command ever writes key material to stdout/stderr | cli test |

Ledger: each row lands in `INVARIANTS.md` with its test in the same commit
(project rule).

## 7. Documentation updates (same PR)

- Spec (`conduitspec.html` + regenerated `.md`): §14 key onboarding steps
  (file-based default; env override), the wrong-key-at-startup change, env-var
  table row for `CONDUIT_MASTER_KEY` ("optional when `~/.conduit/master-key`
  exists"), and the §16.3/§17 recovery+rotation story (the "defined
  recovery/rotation story" the milestone requires).
- `packages/cli/README.md`: `conduit key` reference, rotation walkthrough
  (stop clients → rotate → restart clients), recovery-from-crash note.
- `packages/mcp/README.md`: onboarding now starts with `conduit key generate`;
  snippet drops the embedded key for default-path setups.

## Out of scope (documented, deliberate)

- Concurrent-safe rotation (dual-key read windows, key epochs) — D3; daemon
  ownership (§17 step 2) is the structural fix.
- Key derivation from passphrases, OS keychain integration, multi-key/tenant —
  all post-v1.
- Trace/`replay_journal` re-encryption: those tables are not sealed with the
  master key (redaction, not encryption, per §11) — nothing to rotate.
- Deleting the historical exposed key's artifacts: already done 2026-07-16.
