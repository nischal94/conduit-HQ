import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  acquireExclusiveIfPresent,
  DEFAULT_CONDUIT_DIR,
  daemonPaths,
  describeHolder,
  type ExclusiveAcquisition,
  ensureDbFile,
  ensureStateDir,
  MAINTENANCE_ROLE_GENERATE,
  MAINTENANCE_ROLE_ROTATE,
  openStoreClientFromEnv,
  readLockHolder,
  resolveEffectiveStateDir,
} from "@conduithq/mcp";
import { ReencryptError, reencryptSecrets, SecretBox } from "@conduithq/sdk";
import { writeAllAndFsync } from "./key-fs.js";

export const KEY_USAGE = `conduit key — manage the Conduit master key

Usage: conduit key <subcommand>

Subcommands:
  generate   Mint a new master key at ~/.conduit/master-key (0600).
             Refuses if a key file exists, CONDUIT_MASTER_KEY is set,
             or the default db already holds sealed secrets.
  rotate     Re-seal every stored secret under a fresh key (stop-first:
             run \`conduit daemon stop\` and quit every MCP client before
             running — any process started before rotation holds the old key).
             Refuses for env-managed keys and custom CONDUIT_DB paths.

Run with --help for this text. See packages/cli/README.md for the
rotation walkthrough and crash-recovery procedures.`;

export interface KeyDeps {
  env: NodeJS.ProcessEnv;
  conduitDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  openStoreClient: typeof openStoreClientFromEnv;
  /**
   * Creates + validates the state directory under the §3.2 boundary. Used by
   * `generate` to create-then-lock (F4) before taking the maintenance lock.
   * Injectable so a test can point generate at a temp dir.
   */
  ensureStateDir: typeof ensureStateDir;
}

const PROD_DEPS: KeyDeps = {
  env: process.env,
  conduitDir: DEFAULT_CONDUIT_DIR,
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
  openStoreClient: openStoreClientFromEnv,
  ensureStateDir,
};

export interface KeyResult {
  exitCode: number;
}

export async function runKey(args: string[], overrides?: Partial<KeyDeps>): Promise<KeyResult> {
  const merged: KeyDeps = { ...PROD_DEPS, ...overrides };
  // Derive `key`'s base through the SAME single resolver every other consumer
  // runs (§17 §2, consumer 4). `key` has no custom `--state-dir` surface, so
  // no attacker-supplied spelling reaches it and the classifier is not needed;
  // what it needs is to never DRIFT from the daemon it shares a directory
  // with. On the production `DEFAULT_CONDUIT_DIR` constant this is an
  // idempotent no-op; the guarantee is that it is the identical no-op the
  // daemon and client perform, so a poisoned-HOME default (now closed at the
  // source in `env.ts`) could never again put `key`'s files under one dir
  // while the auto-started daemon serves another. Tests that inject a temp
  // `conduitDir` get its own canonical form, keeping every `key` path
  // consistent with what a daemon in that temp dir would bind.
  const deps: KeyDeps = { ...merged, conduitDir: resolveEffectiveStateDir(merged.conduitDir) };
  const [sub] = args;
  if (sub === "generate") {
    return generateUnderMaintenance(deps);
  }
  if (sub === "rotate") {
    return rotateUnderMaintenance(deps);
  }
  deps.stderr(`${KEY_USAGE}\n`);
  return { exitCode: 1 };
}

/**
 * `key generate` while holding the §3.4 maintenance lock — CREATES the state
 * directory FIRST, then locks (Codex ARC F4).
 *
 * The order is a TOCTOU fix. The previous shape acquired the lock first, and
 * on a fresh install the acquisition returned `no-state-dir` — the directory
 * did not exist yet — so `generate` ran UNLOCKED for its whole duration and
 * created the directory itself moments later. That left a window: between
 * "observe no state dir" and "create it", an env-key daemon (which needs no
 * key file to start) could create the directory, take the maintenance lock
 * SHARED, and open the db — and `generate`'s unlocked `countSealedRows`
 * inspection would then race the daemon's writes, its refusal-on-sealed-rows
 * guarantee reading a db under concurrent mutation.
 *
 * Observation-of-absence is not a held lock. So `generate` now CREATES and
 * validates the state directory under the §3.2 boundary (`ensureStateDir`:
 * mkdir 0700 then assert ownership/mode/ACL), and only THEN acquires the
 * maintenance lock — which, the directory now existing, resolves to a real
 * EXCLUSIVE hold rather than `no-state-dir`. A daemon racing to start is now
 * excluded by the kernel lock for `generate`'s whole run, exactly as §3.4
 * requires.
 *
 * The hold still spans the ENTIRE subcommand (the `countSealedRows`
 * inspection and the key publication both run under it), released in
 * `finally` on every path.
 */
async function generateUnderMaintenance(deps: KeyDeps): Promise<KeyResult> {
  // Create + validate the state directory BEFORE the lock. A create failure
  // (an unsafe pre-existing directory, an un-strippable ACL) is generate's
  // own refusal, not a lock error.
  try {
    await deps.ensureStateDir(deps.conduitDir);
  } catch (cause) {
    deps.stderr(
      `[ConduitKey] generate refused: the state directory ${deps.conduitDir} could not be ` +
        `created or validated (§3.2 ownership/mode/ACL boundary). Fix its ownership and ` +
        `permissions, then re-run. Context: { cause: ${String(cause)} }\n`,
    );
    return { exitCode: 1 };
  }

  const acquisition = await acquireMaintenance(deps, MAINTENANCE_ROLE_GENERATE, "generate");
  // `no-state-dir` is now unreachable — `ensureStateDir` above created it.
  // Treated as a refusal rather than an unlocked proceed if it ever occurs
  // (a directory removed in the microsecond between create and acquire),
  // because proceeding unlocked is exactly the window this fix closes.
  if (acquisition.outcome !== "acquired") return { exitCode: 1 };

  try {
    return await runKeyGenerate(deps);
  } finally {
    await acquisition.lock.release();
  }
}

/**
 * `key rotate` while holding the §3.4 maintenance lock — refuses OUTRIGHT on
 * a keyless / dir-less install (Codex ARC F4).
 *
 * The previous shape let `no-state-dir` PROCEED UNLOCKED, on the reasoning
 * that rotate would then fail "on its own terms". But proceeding unlocked at
 * all is the hole: a daemon could create the directory and take the
 * maintenance lock in the window, and rotate would re-encrypt the live
 * daemon's db with no EXCLUSIVE hold — breaking stop-first and the
 * two-openers guarantee. A keyless / dir-less install genuinely has nothing
 * to rotate, so refusing immediately is both safe and the more correct
 * diagnosis; there is no legitimate case in which rotate should run without
 * the lock.
 *
 * `busy` and `no-state-dir` both refuse; only a real EXCLUSIVE hold proceeds.
 */
async function rotateUnderMaintenance(deps: KeyDeps): Promise<KeyResult> {
  const acquisition = await acquireMaintenance(deps, MAINTENANCE_ROLE_ROTATE, "rotate");
  if (acquisition.outcome === "busy") return { exitCode: 1 };
  if (acquisition.outcome === "no-state-dir") {
    deps.stderr(
      `[ConduitKey] rotate refused: no Conduit state directory at ${deps.conduitDir} — there is ` +
        "nothing to rotate. Run `conduit key generate` to create a key first. (Rotation never " +
        "proceeds without the maintenance lock, and a dir-less install has no lock to take.)\n",
    );
    return { exitCode: 1 };
  }

  try {
    return await runKeyRotate(deps);
  } finally {
    await acquisition.lock.release();
  }
}

/**
 * Takes the §3.4 maintenance lock EXCLUSIVE, or explains who has it.
 *
 * This is the whole of §3.4's exclusion, and it REPLACES the old
 * write-lock probe. That probe asked SQLite "is the db busy right now?",
 * which is a liveness QUERY, and §3.4 rejects liveness queries outright:
 * an unrelated client can auto-start a daemon in the window between the
 * check and the rotation — including after rotate has loaded the old key
 * but before the re-seal transaction commits. The kernel lock closes that
 * window by construction, because the daemon takes the SAME lock SHARED
 * before it resolves its key or opens the db, and holds it for its whole
 * lifetime. Stop-first stops being a request the operator is trusted to
 * honor and becomes something the kernel enforces.
 *
 * Non-blocking on purpose (`acquireExclusive`'s default `busyTimeoutMs`
 * of 0): a busy maintenance lock is this command's DECISION INPUT — "a
 * daemon is up, so refuse and tell the operator" — and waiting for it
 * would silently convert a refusal into a takeover of a daemon that
 * happened to stop mid-wait.
 *
 * The refusal names the holder when it can. That clause is diagnostics
 * only (§3.4: metadata for a good error message, the lock for the
 * exclusion) and is simply omitted when unreadable.
 */
async function acquireMaintenance(
  deps: KeyDeps,
  role: string,
  verb: string,
): Promise<ExclusiveAcquisition> {
  const lockDb = daemonPaths(deps.conduitDir).maintenanceLockDb;
  const acquisition = await acquireExclusiveIfPresent(lockDb, { role });
  if (acquisition.outcome !== "busy") return acquisition;
  // Read the holder only AFTER the kernel has already refused us — the
  // row is a companion to that verdict, never a substitute for it, and it
  // is rendered hedged because it can name a departed process.
  const holder = describeHolder(await readLockHolder(lockDb));
  deps.stderr(
    `[ConduitKey] ${verb} refused: another process owns ~/.conduit — the maintenance lock is held.` +
      `${holder} ${verb} is stop-first: stop running conduit processes first — run \`conduit daemon stop\`, ` +
      "quit every MCP client (any process started before rotation holds the old key), then re-run. " +
      "Nothing was read or written.\n",
  );
  return acquisition;
}

/** fsync a directory so a just-created/renamed entry survives a host crash. THROWS on failure — each caller decides whether to degrade (generate/post-promote: warn) or abort (pre-tx staging: refuse). */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

class CountSealedRowsError extends Error {}

/**
 * Raw count — no key needed, and MUST NOT create the db as a side effect.
 * Returns 0 ONLY when the cause chain looks like "no such table" (a fresh or
 * legacy db with no secrets table = nothing sealed, by construction). Any
 * OTHER failure (SQLITE_BUSY, a corrupt/non-db file, EACCES) throws
 * CountSealedRowsError instead of silently reading as "nothing sealed" —
 * generate's refusal is a documented guarantee and must not be downgraded
 * by an inspection failure that has nothing to do with the db's contents.
 */
async function countSealedRows(dbPath: string): Promise<number> {
  if (!existsSync(dbPath)) return 0;
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const rs = await client.execute("SELECT COUNT(*) AS n FROM secrets");
    return Number(rs.rows[0]?.n ?? 0);
  } catch (cause) {
    if (/no such table/i.test(cause instanceof Error ? cause.message : String(cause))) {
      return 0; // no secrets table = nothing sealed
    }
    throw new CountSealedRowsError(`could not inspect ${dbPath}: ${String(cause)}`, { cause });
  } finally {
    client.close();
  }
}

async function runKeyGenerate(deps: KeyDeps): Promise<KeyResult> {
  const keyPath = join(deps.conduitDir, "master-key");

  if (deps.env.CONDUIT_MASTER_KEY !== undefined && deps.env.CONDUIT_MASTER_KEY.trim() !== "") {
    deps.stderr(
      "[ConduitKey] generate refused: CONDUIT_MASTER_KEY is set (env overrides any key file, so a " +
        "differing file is a delayed lockout). A fresh install can unset the env var and re-run; an " +
        "env-key install with a populated db cannot migrate to file keys in v1 — keep the env key, " +
        "or delete the db and re-onboard.\n",
    );
    return { exitCode: 1 };
  }
  if (existsSync(keyPath)) {
    deps.stderr(
      `[ConduitKey] generate refused: ${keyPath} already exists. To change keys, run: conduit key rotate\n`,
    );
    return { exitCode: 1 };
  }
  const dbPath = join(deps.conduitDir, "conduit.db");
  let sealedCount: number;
  try {
    sealedCount = await countSealedRows(dbPath);
  } catch (cause) {
    deps.stderr(
      `[ConduitKey] generate refused: could not inspect ${dbPath}: ${String(cause)}. If a conduit ` +
        "process is running, stop it and re-run; if the file is not a conduit db, move it aside.\n",
    );
    return { exitCode: 1 };
  }
  if (sealedCount > 0) {
    deps.stderr(
      `[ConduitKey] generate refused: ${dbPath} already holds sealed rows under some other key ` +
        "(possibly only the key canary from a previous run) — a fresh key cannot open them. Locate " +
        "the original key, or delete the db and re-onboard.\n",
    );
    return { exitCode: 1 };
  }
  // A successful count against an EXISTING db only reads it — the WAL read
  // may have materialized -wal/-shm sidecars at default (not 0600) perms;
  // heal them now. No-op on a fresh/nonexistent db (nothing to heal yet).
  if (existsSync(dbPath)) ensureDbFile(dbPath);

  // The state directory already exists and was validated 0700 by
  // `generateUnderMaintenance`'s `ensureStateDir` (F4: create-then-lock), so
  // there is no directory to create here — this function runs only under the
  // held maintenance lock.
  const stale = readdirSync(deps.conduitDir).filter((f) => f.startsWith("master-key.tmp-"));
  if (stale.length > 0) {
    deps.stderr(
      `[ConduitKey] note: leftover temp key files from a crashed run: ${stale.map((f) => join(deps.conduitDir, f)).join(", ")} — inert ` +
        "(never read); remove them at leisure.\n",
    );
  }

  const keyBase64 = Buffer.from(SecretBox.generateKeyBytes()).toString("base64");
  const tmpPath = join(deps.conduitDir, `master-key.tmp-${process.pid}`);
  // Durable-staging publication (design pass-3 #1): content is fsynced
  // BEFORE the final name exists; link() never replaces, so EEXIST is the
  // concurrent-generate loser. Same inode — unlinking the temp after link
  // leaves the published key untouched.
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeAllAndFsync(fd, `${keyBase64}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmpPath, keyPath);
  } catch (cause) {
    const isConcurrentWinner = (cause as NodeJS.ErrnoException).code === "EEXIST";
    // Cleanup the temp BEFORE classifying the cause — a throw here must not
    // mask whether the ORIGINAL link failure was the benign EEXIST race.
    try {
      unlinkSync(tmpPath);
    } catch {
      deps.stderr(
        `[ConduitKey] note: leftover temp key file ${tmpPath} — inert (never read); remove it at leisure.\n`,
      );
    }
    if (isConcurrentWinner) {
      deps.stderr(
        `[ConduitKey] generate refused: ${keyPath} appeared concurrently — another generate won. ` +
          "Re-run to inspect state; nothing was overwritten.\n",
      );
      return { exitCode: 1 };
    }
    throw cause;
  }
  let durabilityWarning = "";
  try {
    fsyncDir(deps.conduitDir);
  } catch (cause) {
    durabilityWarning =
      "[ConduitKey] WARNING: directory fsync failed — the key file is live and correct, but until " +
      "the entry is durable a host crash could lose it. Verify the disk, then re-run any command to " +
      `confirm. Context: { cause: ${String(cause)} }\n`;
  }
  // The key is already published (link succeeded) — a failure to unlink the
  // now-redundant temp is inert leftover, never a reason to report generate
  // as failed.
  try {
    unlinkSync(tmpPath);
  } catch {
    deps.stderr(
      `[ConduitKey] note: leftover temp key file ${tmpPath} — inert (never read); remove it at leisure.\n`,
    );
  }

  if (durabilityWarning) deps.stderr(durabilityWarning);
  deps.stdout(
    `[ConduitKey] master key generated at ${keyPath} (0600).\n` +
      "Next steps:\n" +
      "  1. Your MCP client config no longer needs CONDUIT_MASTER_KEY for default-path setups.\n" +
      "  2. Onboard an upstream: conduit add-mcp --url <url> --namespace <ns> --prefix <prefix>\n" +
      "  3. Stop-first rule: run this BEFORE wiring clients; see packages/cli/README.md.\n",
  );
  return { exitCode: 0 };
}

const RECOVERY_HINT =
  "Recovery: whichever of master-key / master-key.next opens the db is live — " +
  "promote it (mv) or restore master-key.bak; see packages/cli/README.md.";

// Shared by BOTH `.next`-exists refusal arms (the pre-check below and the
// wx-EEXIST claim further down): `.next` existing means either another
// rotation is CURRENTLY in flight, or one crashed mid-write — this process
// cannot tell which. A concurrent winner may be mid-re-seal with `.next`
// holding the ONLY persisted copy of its new key; deleting it out from under
// that winner permanently seals the db under a lost key. The recovery
// procedure (whichever key opens the db is live) is only safe to follow
// once no rotation is running anywhere — never as a first response.
const NEXT_EXISTS_REFUSAL =
  "another rotation may be IN FLIGHT right now, or a prior one crashed mid-write — this process " +
  "cannot tell which from here. First make ABSOLUTELY SURE no `conduit key rotate` is currently " +
  "running anywhere (check processes on this host and any others sharing ~/.conduit). Only once " +
  `that is confirmed does recovery apply: ${RECOVERY_HINT}`;

/** True iff the failure's cause chain looks like a busy/locked SQLite database. */
function isBusyCause(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current = cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      // Structured code first — @libsql/client's LibsqlError carries `code`
      // (string, e.g. "SQLITE_BUSY") and `rawCode` (numeric); check those
      // BEFORE the message regex so a differently-worded but same-coded
      // error still classifies correctly.
      const code = (current as { code?: unknown }).code;
      const rawCode = (current as { rawCode?: unknown }).rawCode;
      if (typeof code === "string" && /^SQLITE_(BUSY|LOCKED)$/.test(code)) return true;
      if (rawCode === 5 || rawCode === 6) return true; // SQLITE_BUSY / SQLITE_LOCKED
    }
    const message = current instanceof Error ? current.message : String(current);
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function runKeyRotate(deps: KeyDeps): Promise<KeyResult> {
  const keyPath = join(deps.conduitDir, "master-key");
  const bakPath = join(deps.conduitDir, "master-key.bak");
  const nextPath = join(deps.conduitDir, "master-key.next");

  // Refusals (design §3) — each names the way forward.
  if (deps.env.CONDUIT_MASTER_KEY !== undefined && deps.env.CONDUIT_MASTER_KEY.trim() !== "") {
    deps.stderr(
      "[ConduitKey] rotate refused: the key is env-managed (CONDUIT_MASTER_KEY). Rotation is " +
        "unsupported for env-managed keys in v1 — keep using the env key, or delete the db and " +
        "re-onboard (conduit key import is the deferred migration path).\n",
    );
    return { exitCode: 1 };
  }
  if (deps.env.CONDUIT_DB !== undefined && deps.env.CONDUIT_DB.trim() !== "") {
    deps.stderr(
      "[ConduitKey] rotate refused: CONDUIT_DB is set. Rotation is defined only for the default " +
        "db + key-file pair (one global key file cannot serve N dbs). Custom-path installs: manage " +
        "the key via env; rotation story is delete-and-re-onboard.\n",
    );
    return { exitCode: 1 };
  }
  if (existsSync(nextPath)) {
    deps.stderr(`[ConduitKey] rotate refused: ${nextPath} exists — ${NEXT_EXISTS_REFUSAL}\n`);
    return { exitCode: 1 };
  }

  // 1. Preflight: open the store — the canary proves the old key (design §2).
  //    deps.env deliberately lacks CONDUIT_MASTER_KEY here (checked above), so
  //    resolution is file-sourced — and resolveEnv's own refusal check uses
  //    the SAME trim-predicate as the guard above, so an empty/whitespace
  //    CONDUIT_MASTER_KEY is consistently treated as absent by both. CONDUIT_DB
  //    and the key-file path are pinned to deps.conduitDir (controller
  //    deviation D1) — in production deps.conduitDir === DEFAULT_CONDUIT_DIR so
  //    this is a no-op; in tests it keeps rotation inside the temp dir instead
  //    of touching ~/.conduit.
  let opened: Awaited<ReturnType<typeof deps.openStoreClient>>;
  try {
    opened = await deps.openStoreClient(
      { ...deps.env, CONDUIT_DB: join(deps.conduitDir, "conduit.db") },
      { keyFilePath: keyPath },
    );
  } catch (cause) {
    if (isBusyCause(cause)) {
      // The maintenance lock is already held by this process, so no
      // daemon can be the writer here — this is a NON-daemon opener
      // (another rotate on a shared ~/.conduit, a stray sqlite client),
      // which the kernel lock does not and cannot cover.
      deps.stderr(
        "[ConduitKey] rotate preflight failed: the database is locked by a process that is not a " +
          "conduit daemon (the maintenance lock is held by this rotation, so no daemon can be the " +
          `writer). Find and stop that process, then re-run. Context: { cause: ${String(cause)} }\n`,
      );
      return { exitCode: 1 };
    }
    deps.stderr(`[ConduitKey] rotate preflight failed: ${String(cause)}\n`);
    return { exitCode: 1 };
  }
  const { client } = opened;

  try {
    // 2-3. Stage the new key BEFORE the db is touched, THEN back up the old
    // one. Creating `.next` (wx) FIRST is the mutual-exclusion point: an
    // EEXIST here means another rotation already claimed it, and this run
    // must not touch `.bak` at all — a concurrent loser that copied `.bak`
    // BEFORE staging would have already overwritten it ahead of the winner
    // claiming ownership. Any raw fs failure here is provably pre-transaction:
    // the db is still under the OLD key and nothing has been re-sealed yet
    // (unlike step 4+, these steps have no reencrypt-side classification to
    // fall back on, so they get their own catch naming that fact explicitly).
    let newKeyBytes: ReturnType<typeof SecretBox.generateKeyBytes>;
    let nextClaimed = false;
    try {
      // 2. Persist the NEW key BEFORE anything else (wx: a racing rotate
      // loses here — this IS the claim on the rotation).
      newKeyBytes = SecretBox.generateKeyBytes();
      const newKeyBase64 = Buffer.from(newKeyBytes).toString("base64");
      const nextFd = openSync(nextPath, "wx", 0o600);
      // Ownership is claimed the INSTANT the exclusive create succeeds — not
      // after write+fsync+close. If writeAllAndFsync or closeSync throws
      // below, `.next` already exists on disk as THIS run's file; claiming
      // ownership late would skip the self-clean unlink in the catch below,
      // leaving a partial `.next` that poisons the next attempt while the
      // failure message wrongly claims "nothing was left behind".
      nextClaimed = true;
      try {
        writeAllAndFsync(nextFd, `${newKeyBase64}\n`);
      } finally {
        closeSync(nextFd);
      }

      // 3. Backup the old key (overwritten each rotation — crash insurance,
      // not history). Only reached once THIS run provably owns `.next`.
      copyFileSync(keyPath, bakPath);
      const bakFd = openSync(bakPath, "r");
      try {
        fsyncSync(bakFd);
      } finally {
        closeSync(bakFd);
      }

      fsyncDir(deps.conduitDir);
    } catch (cause) {
      const isConcurrentNext = !nextClaimed && (cause as NodeJS.ErrnoException).code === "EEXIST";
      if (isConcurrentNext) {
        // Another rotation is in flight or crashed mid-write. `.next` may be
        // the WINNER's live, uncommitted key — deleting it here (even
        // conditionally) risks destroying the only copy of a new key whose
        // db has already been re-sealed under it. NEVER advise deletion.
        deps.stderr(`[ConduitKey] rotation refused: ${nextPath} exists — ${NEXT_EXISTS_REFUSAL}\n`);
        return { exitCode: 1 };
      }
      // `.next` (if present) provably belongs to THIS run — clean it up
      // ourselves rather than leaving it for the next invocation to trip on.
      let cleanupNote = "nothing was left behind";
      if (nextClaimed) {
        try {
          unlinkSync(nextPath);
        } catch (unlinkCause) {
          if ((unlinkCause as NodeJS.ErrnoException).code !== "ENOENT") {
            cleanupNote = `${nextPath} could not be removed — delete it before retrying (cause: ${String(unlinkCause)})`;
          }
        }
      }
      deps.stderr(
        `[ConduitKey] rotation failed before the db was touched: ${String(cause)}. The live key file ` +
          `and db are unchanged; ${cleanupNote}.\n`,
      );
      return { exitCode: 1 };
    }

    // 4. Re-seal in ONE write transaction (reencryptSecrets owns atomicity + classification).
    const oldBox = await SecretBox.fromKeyBytes(opened.env.keyBytes);
    const newBox = await SecretBox.fromKeyBytes(newKeyBytes);
    let count: number;
    try {
      count = await reencryptSecrets(client, oldBox, newBox);
    } catch (cause) {
      if (cause instanceof ReencryptError && cause.dbState === "unchanged") {
        // Confirmed still-old → this run's .next is provably meaningless.
        try {
          unlinkSync(nextPath);
        } catch (unlinkCause) {
          if ((unlinkCause as NodeJS.ErrnoException).code !== "ENOENT") {
            deps.stderr(
              `[ConduitKey] note: could not remove ${nextPath} — delete it before retrying.\n`,
            );
          }
          // ENOENT: already gone — nothing to note.
        }
        if (isBusyCause(cause)) {
          // As in preflight: a daemon is excluded by the maintenance lock
          // this rotation holds, so a BUSY here is a non-daemon opener.
          deps.stderr(
            "[ConduitKey] rotation failed: the database is locked by a process that is not a conduit " +
              "daemon (the maintenance lock is held by this rotation). Find and stop that process, " +
              `then re-run. Context: { cause: ${cause.message} }\n`,
          );
        } else {
          deps.stderr(`[ConduitKey] rotation failed (db unchanged): ${cause.message}\n`);
        }
        return { exitCode: 1 };
      }
      // Uncertain outcome → NEVER delete .next (design pass-4 #2).
      deps.stderr(
        `[ConduitKey] rotation failed with UNCERTAIN db state: ${String(cause)}\n${RECOVERY_HINT}\n`,
      );
      return { exitCode: 1 };
    }

    // 5. Promote (two failure states — design pass-4 #3).
    try {
      renameSync(nextPath, keyPath);
    } catch (cause) {
      deps.stderr(
        `[ConduitKey] rotation committed but promotion failed: ${String(cause)}\n` +
          `The db is under the NEW key at ${nextPath}. Recovery: mv ${nextPath} ${keyPath}\n`,
      );
      return { exitCode: 1 };
    }
    let promoteWarning = "";
    try {
      fsyncDir(deps.conduitDir);
    } catch (cause) {
      promoteWarning =
        "[ConduitKey] WARNING: directory fsync failed after promotion — the new key is live and " +
        "correct, but until the entry is durable a host crash could revert it; master-key.bak " +
        `still holds the old key. Context: { cause: ${String(cause)} }\n`;
    }

    // 6. Hygiene — best-effort defense-in-depth (design pass-2 #2), never a failure.
    let hygieneWarning = "";
    try {
      await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      await client.execute("VACUUM");
    } catch (cause) {
      hygieneWarning =
        `[ConduitKey] WARNING: post-rotation cleanup (checkpoint/VACUUM) failed: ${String(cause)} — ` +
        "old-key ciphertext may linger in WAL/free pages. Once all conduit processes are stopped, " +
        "re-run it via the one-liner in packages/cli/README.md.\n";
    }

    if (promoteWarning) deps.stderr(promoteWarning);
    if (hygieneWarning) deps.stderr(hygieneWarning);
    deps.stdout(
      `[ConduitKey] rotation complete: ${count} secrets re-sealed under the new key.\n` +
        "Restart your MCP clients now (any process started before rotation holds the old key).\n" +
        "Back up the db and key file TOGETHER — old db backups pair only with master-key.bak-era keys.\n",
    );
    return { exitCode: 0 };
  } finally {
    client.close();
  }
}
