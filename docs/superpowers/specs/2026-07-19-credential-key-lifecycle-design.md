# Credential key lifecycle — design (spec §17 v1 step 1)

**Date:** 2026-07-19 · **Status:** revised after cross-model review · **Scope:**
the §17 v1 surface-product prerequisite — "confirm the master-key generation,
file permissions, and a defined recovery/rotation story (§16.3, Phase 0)" —
plus the tracked 0644-at-creation `conduit.db` permissions finding.

**Review trail:** draft v1 (commit `8aaf37b`) → codex cross-model design review
(gpt-5.6, high reasoning, 13 findings: 6 P1 / 5 P2 / 2 P3) → revision
(commit `0defa52`) resolving all 13 → codex convergence re-pass (6 new-class
findings: 2 P1 / 3 P2 / 1 P3 — generate clobber window, hygiene
mis-classification, BUSY-strands-`.next`, probe overclaim, env-migration
contradiction, filename grammar) → revision (commit `fa633cb`) resolving
those 6 → codex pass 3 (4 findings: 1 P1 / 2 P2 / 1 P3 — generate
durability/visibility window → link-publication; a stale env-refusal line;
probe-all not pinned in the ledger; the `.next` cleanup claim overbroad) →
this revision resolves those 4. The P1 cluster (#2/#3/#4/#6/#8) shared one root cause — the
draft's `master-key.new` two-phase roll-forward manufactured the very lockout
states it meant to prevent — so per the adversarial-convergence rule the fix is
a SHAPE change (stop-first in-place rotation, manual documented recovery), not
per-state patches. Load-bearing behavioral claims were then verified
empirically against the repo's exact stack (libsql 0.14 + built SecretBox):
empty-0600-file-as-fresh-db with 0600 `-wal`/`-shm` inheritance; `SQLITE_BUSY`
writer refusal under a held `transaction("write")`; async re-seal inside one
interactive write tx; wrong-key/tampered-canary distinguishability.

## Decisions (made with the user, 2026-07-18/19)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Scope | Build `conduit key generate` + `conduit key rotate` CLI tooling, plus perms hardening and a documented recovery story — not verify-and-document only. |
| D2 | Key source of truth | Key file first: runtime reads `~/.conduit/master-key` (0600) by default; `CONDUIT_MASTER_KEY` env var overrides when set. |
| D3 | Rotation model | Stop-first, in-place, default-paths-only; crash recovery is a documented manual procedure (restore `master-key.bak`), NOT an automatic roll-forward state machine. (Revised from draft v1 per review findings #2/#4/#8.) |
| D4 | Wrong-key failure | Key-check canary verified at store open — wrong key fails loud at startup, replacing the documented fails-at-first-decrypt behavior. |

## Current state (verified 2026-07-18/19)

- Key loading: `CONDUIT_MASTER_KEY` env var only, canonical-base64/32-byte
  validation in `packages/mcp/src/env.ts` (`resolveEnv`). `~/.conduit/master-key`
  exists on the dev machine but no code reads it.
- Wrong key fails at first secret decrypt (spec §14 documents this as-is).
- Db directory created 0700 (`ensureDbDir`); the db FILE is created by
  `@libsql/client` at umask default → 0644 (the tracked finding). `-wal`/`-shm`
  sidecars inherit the db file's permissions at their creation (verified).
- No rotation story: the 2026-07-16 rotation was delete-everything-and-mint-fresh.
- Secret refs are `cred_<namespace>` (validated identifier namespace,
  `add-mcp.ts`), so a reserved dotted ref cannot collide.
- The dev machine's db is a LEGACY db for this design: it holds real sealed
  rows and no canary — the §2 legacy bootstrap path is exercised by the very
  first run after this ships.

## 1. Key resolution (env → file → error)

`resolveEnv` in `packages/mcp/src/env.ts` (already the single env→config home
shared by `conduit serve`, `conduit-mcp --doctor`, and every CLI command that
opens the store via `openStoreFromEnv`) gains a file fallback:

1. `CONDUIT_MASTER_KEY` set → existing behavior, unchanged validation. This
   remains the container/CI/non-default-home escape hatch.
2. Otherwise read `~/.conduit/master-key` (fixed path, sibling of the default
   db): trim, then the SAME canonical-base64/32-byte validation, with the file
   named in any error (never its contents). If the file's permissions are wider
   than 0600, print a stderr warning (warn-and-serve; the fix is one `chmod`).
3. Neither present → loud error naming both options, with
   `conduit key generate` as the suggested fix.

`ResolvedEnv` gains `keySource: "env" | "file"` — provenance that §3's rotate
refusals and diagnostics depend on (review #4/#11). Error/diagnostic messages
may name the source and paths; NEVER key material.

Consequences: MCP client-config snippets no longer need to embed the key for
default-path setups; the "chmod 600 your client config" footgun disappears
(spec §14 walkthrough updates). The env var keeps working everywhere it is
used today. Precedence when both exist: env wins silently (standard
convention), documented in READMEs; `key generate`/`key rotate` REFUSE rather
than warn in mixed states (§3, review #5).

## 2. Startup canary (wrong key fails loud at open)

A reserved row in the EXISTING `secrets` table — ref `__conduit.key-canary.v1__`
(dots make it unconstructible as a real `cred_<namespace>` ref) — handled
inside `openSqliteStore` (`packages/sdk/src/store/sqlite.ts`) after schema
setup. Sentinel plaintext: the fixed string `conduit-key-canary`.

**Open-time check (canary present):** `secretBox.open()` the row and compare
the decrypted value to the sentinel. Diagnosis is honest about what AES-GCM
can and cannot prove (review #9):

- Opens AND matches sentinel → key is correct; proceed.
- Fails to open (or opens to a wrong value): probe the real secret rows —
  ALL of them, until one opens (re-pass #4: one arbitrary row may itself be
  corrupt; certainty must not outrun the probe). ANY real row opens → the
  KEY IS FINE, the canary itself is damaged/overwritten → a DISTINCT
  canary-corruption error. Recovery is documented, not tooled (no
  `repair-canary` command — YAGNI): the README's procedure is a SQL
  one-liner deleting the canary row, then reopen (bootstrap recreates it
  under the verified-good key). NO row opens (or none exists) → an honestly
  AMBIGUOUS error: "wrong master key — or, if this key is known-correct,
  the stored rows are corrupted/foreign" — naming db path + key source.

**Bootstrap (canary absent) — verify BEFORE binding (review #1, the draft's
worst defect):**

- Secrets table has real rows (legacy db): decrypt existing rows with the
  candidate key FIRST — until one succeeds (re-pass #4: a single corrupt row
  must not refuse a correct key). Any success → create the canary. ALL fail
  → refuse with the ambiguous wrong-key-or-corruption error; the db is never
  bound to an unverified key.
- Secrets table empty: create the canary freely (nothing to strand).
- Creation uses `INSERT OR IGNORE` inside a write transaction, then re-reads
  and verifies — idempotent under the M5 multi-process first-run race (both
  racers hold the same key; either's row verifies for both). The M5
  schema-race tolerance (`duplicate column name` / `no such column`) never
  matches a canary INSERT conflict, so the two mechanisms cannot interact.

Because every product bin opens the store through `openSqliteStore`, serve /
approvals / add-mcp all get startup fail-fast with zero per-command code.
Spec §14's "a wrong master key fails at first secret decrypt, not startup"
line is updated to "fails at startup (key canary)".

The canary row is invisible to product surfaces: `secrets.reveal` is only
called with connection-derived `cred_*` refs, and nothing enumerates the
secrets table today. Re-encryption (§3) re-seals it like any other row.
`openSqliteStore` gains optional sanitized context (db path, key source) for
error messages (review #11) — passed by `openStoreFromEnv`, defaulted
elsewhere.

## 3. `conduit key` command family (`packages/cli`)

New `key` command registered in `dispatch.ts` with subcommands `generate` and
`rotate`. Grammar decided now (review #13): bare `conduit key`, unknown
subcommand, and `key --help` / `key generate --help` / `key rotate --help` all
print the family usage text (exit 0 for help, exit 1 for missing/unknown
subcommand — matching the existing dispatch convention); errors exit 1,
refusals exit 1 with the reason on stderr. The `--help` interception is added
for `key` the same way `add-mcp` does it today.

### `conduit key generate`

Refusals first (each names its reason and the way forward, review #5):

- `~/.conduit/master-key` already exists → refuse, point at `conduit key
  rotate`. NO overwrite flag — overwriting the live key orphans every sealed
  secret; that footgun stays unbuildable.
- `CONDUIT_MASTER_KEY` is set → refuse: the env var would override the file,
  and a file differing from the env key is a delayed lockout (env removal
  later strands the db). Message states the v1 position consistently
  (re-pass #5): a FRESH install can unset the env var and generate; an
  env-key install with a POPULATED db cannot migrate to file keys in v1 —
  keep the env key, or delete-and-re-onboard. (A `conduit key import` that
  persists the verified env key to file is the deferred fix — see out of
  scope.)
- The default db exists AND holds sealed rows → refuse: those rows are under
  some other key; generating a fresh one cannot decrypt them. Recovery story:
  locate the original key, or delete the db and re-onboard.

Happy path: mint via `SecretBox.generateKeyBytes()`; create `~/.conduit`
0700 if absent; then durable-staging publication (pass-3 #1): write
`master-key.tmp-<pid>` (`wx`, 0600), fsync the FILE, `link()` it to the
final `master-key` name, fsync the DIRECTORY, unlink the temp. `link()`
never replaces an existing name, so it is simultaneously the no-clobber
guarantee and the serialization point (a concurrent `generate` loses with
EEXIST) — and because the content is fsynced BEFORE the name exists, the
final name is only ever complete-and-durable: no reader can observe a
partial key, and a host crash leaves at worst an inert `master-key.tmp-*`
(never read by `resolveEnv`; the next `generate` reports leftovers and asks
the operator to remove them — never silently reused). A handled failure
unlinks this run's temp on the way out. Print next steps (snippet without
embedded key). NEVER print the key.

### `conduit key rotate`

**Model (D3, revised):** stop-first, in-place, default-paths-only. Rotation
is only DEFINED for the default pair (`~/.conduit/master-key` +
`~/.conduit/conduit.db`). It refuses when:

- `keySource === "env"` → the operator manages the key; the tool cannot
  update every client config. Message (consistent with `generate`'s v1
  position — pass-3 #2): rotation is unsupported for env-managed keys in
  v1; keep using the env key, or delete-and-re-onboard (`conduit key
  import` is the deferred migration path). (Review #4 — no env-sourced
  state ever enters the key-file machinery.)
- `CONDUIT_DB` is set (custom db path) → refuse: one global key file cannot
  serve N dbs (review #6). Custom-path installs are env-key installs by
  definition; their rotation story is delete-and-re-onboard (documented).
- Another writer holds the db write lock → `SQLITE_BUSY` within
  `busy_timeout` → refuse: "stop running conduit processes first." (Verified:
  a held `transaction("write")` = `BEGIN IMMEDIATE` refuses a second writer
  with SQLITE_BUSY after its busy_timeout. This is writer exclusion DURING
  the transaction — best-effort detection, not process detection; review #7.)

Sequence (the invariant: BOTH candidate keys are on disk before the db
changes, so every crash state recovers by "try the other file"):

1. **Preflight:** resolve the key (must be `file`-sourced, above); refuse if
   a leftover `master-key.next` exists (a prior rotate crashed — resolve it
   per the README procedure first; leftovers are never silently reused or
   deleted); open the store — the §2 canary proves the old key correct
   before anything is touched.
2. **Backup the old key:** copy `master-key` → `master-key.bak` (0600,
   temp+rename+fsync). Overwritten on each rotation — it exists to survive
   a crash of THIS run, not as key history.
3. **Persist the new key BEFORE the db changes:** mint, write to
   `master-key.next` (`wx`, 0600, fsync file + directory).
4. **Re-seal in ONE interactive write transaction** (`transaction("write")`,
   with `finally { tx.close() }` — review #7): read every `secrets` row
   (canary included), `open()` with the old box, `seal()` with the new box,
   UPDATE. (Verified: async seal/open work inside the interactive tx —
   `batch` would not allow awaiting.) Any failure → rollback; the db is
   untouched — AND rotate deletes the `master-key.next` it created in step 3
   (re-pass #3: the routine `SQLITE_BUSY` refusal must not strand a `.next`
   that poisons the operator's retry; pre-commit, this run's `.next` is
   provably meaningless). Scope of that cleanup (pass-3 #4): it applies to
   handled PRE-COMMIT failures only, and if the deletion itself fails the
   refusal message names the leftover file. A handled POST-COMMIT promote
   failure (step 5) deliberately LEAVES `.next` — the crash-table row-2
   recovery depends on it — and prints that row's procedure. So preflight's
   leftover-`.next` refusal covers crashes and post-commit promote failures,
   both resolved by the same documented table.
5. **Promote:** rename `master-key.next` → `master-key`, fsync the
   directory.
6. **Hygiene (best-effort defense-in-depth, NOT a boundary — re-pass #2):**
   `PRAGMA wal_checkpoint(TRUNCATE)` then `VACUUM` — old-key ciphertext
   otherwise lingers in WAL frames and freelist pages. On failure (busy
   checkpoint, full disk, crash before this step) rotation is still
   SUCCESSFUL but the completion message is replaced by a LOUD warning
   naming the manual procedure (README: run checkpoint+VACUUM via the
   documented one-liner once processes are stopped). This layer is labeled
   best-effort because completeness is impossible from userspace anyway:
   filesystem-level remnants (backups, snapshots, unlinked blocks) are
   untouchable regardless — the real guarantee against a leaked old key
   remains the re-seal itself plus the paired-backup discipline.
7. Print completion (or the hygiene warning) + "restart your MCP clients" +
   the backup note. Never print either key.

**Crash recovery — a documented manual procedure, not code** (review
#2/#8/#10): the on-disk states and their two-line recoveries:

| Crash point | db sealed under | `master-key` | on disk besides it | Recovery |
|---|---|---|---|---|
| before step 4 commits | old | old | `.bak`=old, maybe `.next`=new | delete `master-key.next`; re-run rotate |
| after 4 commits, before 5 | NEW | old (stale) | `.bak`=old, `.next`=NEW | `mv master-key.next master-key` |
| after 5 | new | new | `.bak`=old | done; nothing to do |

The one loud state (row 2) is startup failing with the §2 wrong-key error,
whose text adds: "if this db was mid-rotation, see the rotation-recovery
procedure (`master-key.next` / `master-key.bak`)." No automatic roll-forward
logic exists to get any of this wrong — the procedure is a human choosing
between two named files, both of which are always present.

**Honest limits (documented, review #3/#10):** the write-lock check cannot
see an IDLE process holding the old key in memory; such a process can write
an old-key-sealed secret AFTER rotation commits. Stop-first is therefore a
documented operator obligation, not an enforced invariant. The failure is
DETECTABLE, not silent: the stray row fails loudly at its next use while the
canary (re-sealed) passes — which is exactly the §2 "canary passes, real row
fails" diagnosis, whose README entry names "a process was running during
rotation" as the likely cause and re-entering that credential
(`add-mcp --replace`) as the fix. The all-or-nothing claim is scoped
honestly: the TRANSACTION is atomic; the system-wide single-key state
additionally requires the stop-first precondition. Pre-rotation db backups
pair with `master-key.bak`-era keys — the README's backup guidance says:
back up db + key file TOGETHER, always.

### SDK seam

Re-sealing lives in the sdk: `reencryptSecrets(client, oldBox, newBox)` — a
standalone store-level function in `store/sqlite.ts` beside the schema it
touches, NOT a `ConduitStore` interface method (review #11: it is a
maintenance operation on the SQLite backend, not cross-backend contract; a
D1 backend would need its own). It owns the transaction and returns the row
count re-sealed. The CLI opens the store once for preflight (canary check),
then calls `reencryptSecrets` on the same client; after commit the
pre-rotate store handle is DEAD (its captured `SecretBox` is the old key —
review #11) and the CLI never touches it again — rotate exits rather than
reopening. `SecretBox` itself is UNCHANGED — same v1 sealed format; rotation
is re-encryption, not a format migration.

## 4. Db file permissions (the 0644 finding)

`ensureDbDir` (packages/mcp/src/env.ts) grows into `ensureDbFile`-scope:

- Directory: unchanged 0700 creation.
- File absent → create it empty, `wx`, mode 0600, BEFORE `@libsql/client`
  touches the path. (Verified: libsql accepts a zero-length file as a fresh
  db, and creates `-wal`/`-shm` with the db file's 0600.)
- File present with perms wider than 0600 → `chmod` 0600 (self-healing; the
  2026-07-16 hand-fix becomes code). Same for existing `-wal`/`-shm`/
  `-journal` sidecars if present.

**Scope (review #12):** this guarantee holds for everything that opens the
db via `openStoreFromEnv` — i.e. every product bin (serve, conduit-mcp,
add-mcp, approvals, key). Direct SDK consumers and tests that call
`createClient` themselves bypass it by design; the SDK's README notes the
operator owns file perms on custom paths. POSIX/local filesystems only
(the only supported deployment for the local db).

## 5. Error handling

- Every new error follows the project format
  (`[Module] Operation failed: reason. Context: {…}`), names the way forward,
  and never contains key material — paths and provenance only.
- `rotate`'s transaction is atomic (rollback on any failure); system-wide
  atomicity is conditioned on stop-first, stated honestly (§3).
- `generate`/`rotate` are offline maintenance commands: no timeout machinery
  beyond SQLite's `busy_timeout`; they run to completion or fail loud.

## 6. Testing (INVARIANTS, all RED-first)

| Invariant | Pin |
|---|---|
| Wrong master key fails at store open (canary), not first use | sdk store test |
| Legacy db (real rows, no canary) + wrong key → refused, canary NOT created | sdk store test |
| Legacy db + correct key → canary created, subsequent opens pass | sdk store test |
| Corrupted canary + healthy real row → canary-corruption error, not wrong-key | sdk store test |
| Probe-all: corrupt FIRST real row + later good row → still canary-corruption (open path) / still bootstraps (legacy path) | sdk store test |
| Canary fails + ALL real rows fail → ambiguous wrong-key-or-corruption error | sdk store test |
| First open on empty db writes the canary; reopen with same key succeeds; M5 race idempotent | sdk store test |
| `reencryptSecrets` atomic: injected mid-rotate failure leaves every row openable under the OLD key | sdk store test |
| After re-seal, every row (canary incl.) opens under the NEW key, none under the old | sdk store test |
| Db file + sidecars 0600 at creation via the env path; wider existing perms healed | mcp env test |
| Key resolution: env > file; `keySource` reported; neither → error naming `conduit key generate` | mcp env test |
| Key file wider than 0600 → stderr warning, still serves | mcp env test |
| `key generate` refusals: file exists / env set / db has sealed rows | cli test |
| `key generate` publishes via fsynced-temp + `link()` (0600; EEXIST loses; temp unlinked on handled failure), never prints key material | cli test |
| `key rotate` refusals: env-sourced key / custom CONDUIT_DB / held write lock / leftover `master-key.next` | cli test |
| `key rotate` BUSY refusal removes its own `master-key.next` (retry not poisoned) | cli test |
| `key rotate` hygiene failure → rotation still succeeds with loud warning | cli test |
| `key rotate` end-state: db + key file both new; `master-key.bak` = old; wal checkpointed | cli test |
| Neither command ever writes key material to stdout/stderr | cli test |

Ledger: each row lands in `INVARIANTS.md` with its test in the same commit
(project rule).

## 7. Documentation updates (same PR)

- Spec (`conduitspec.html` + regenerated `.md`): §14 key onboarding
  (file-based default via `conduit key generate`; env override), the
  wrong-key-at-startup change, env-var table (`CONDUIT_MASTER_KEY` "optional
  when `~/.conduit/master-key` exists"), and the §16.3/§17 recovery+rotation
  story — including the stop-first obligation, the crash-recovery procedure,
  and the paired db+key backup rule.
- `packages/cli/README.md`: `conduit key` reference; rotation walkthrough
  (stop clients → rotate → restart clients); crash-recovery procedure
  (try `master-key.bak` / promote `master-key.next`); canary-corruption
  recovery; custom-path/env-key rotation story (delete-and-re-onboard).
- `packages/mcp/README.md`: onboarding starts with `conduit key generate`;
  snippet drops the embedded key for default-path setups.

## Out of scope (documented, deliberate)

- Concurrent-safe rotation (dual-key read windows, key epochs) and enforced
  process exclusivity — daemon ownership (§17 step 2) is the structural fix;
  this design's write-lock probe + honest stop-first documentation is the v1
  floor. (Review #3 accepted as a documented limit, not closed.)
- Rotation for env-key or custom-`CONDUIT_DB` installs (documented
  delete-and-re-onboard story instead — review #6). Likewise `conduit key
  import` (persist a verified env key to file, unlocking env→file migration
  for populated dbs — re-pass #5); trigger: the first real user asking to
  migrate an env-key install.
- Key derivation from passphrases, OS keychain integration, multi-key/tenant.
- Trace/`replay_journal` re-encryption: not sealed with the master key
  (redaction, not encryption, per §11) — nothing to rotate.
- Scrubbing filesystem-level old-key ciphertext remnants beyond
  checkpoint+VACUUM (stated caveat in §3).
