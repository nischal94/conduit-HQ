import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireExclusive,
  daemonPaths,
  EXIT_ROTATION_IN_PROGRESS,
  MAINTENANCE_ROLE_ROTATE,
  openStoreClientFromEnv,
} from "@conduithq/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runKey } from "./commands/key.js";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };
}

describe("conduit key generate (design §3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-key-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("INVARIANT §16.3: happy path — 0600 key file, no key material on stdout/stderr", async () => {
    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(0);
    const keyPath = join(dir, "master-key");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const key = readFileSync(keyPath, "utf8").trim();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    const all = [...io.out, ...io.err].join("\n");
    expect(all).not.toContain(key); // NEVER prints the key
    expect(existsSync(join(dir, `master-key.tmp-${process.pid}`))).toBe(false); // temp unlinked
    expect(existsSync(join(dir, "conduit.db"))).toBe(false); // generate must not create the db
  });

  it("INVARIANT §16.3: refuses when the key file exists (points at rotate)", async () => {
    writeFileSync(join(dir, "master-key"), VALID_KEY, { mode: 0o600 });
    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/conduit key rotate/);
    expect(readFileSync(join(dir, "master-key"), "utf8")).toBe(VALID_KEY); // untouched
  });

  it("INVARIANT §16.3: refuses when CONDUIT_MASTER_KEY is set", async () => {
    const io = makeIo();
    const result = await runKey(["generate"], {
      env: { CONDUIT_MASTER_KEY: VALID_KEY },
      conduitDir: dir,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/env/i);
    expect(existsSync(join(dir, "master-key"))).toBe(false);
  });

  it("INVARIANT §16.3: refuses when the default db already holds sealed rows", async () => {
    // A db file with a secrets row (any bytes count — the check is COUNT, not decrypt).
    // Build it through the real path: put a row via a scratch store.
    const { createDbWithOneSecret } = await import("./key-test-helpers.js");
    await createDbWithOneSecret(join(dir, "conduit.db"));
    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/sealed/i);
    expect(existsSync(join(dir, "master-key"))).toBe(false);
  });

  it("INVARIANT §16.3: db path is a directory (unreadable as a db) → generate refuses loudly, not the fresh-key happy path", async () => {
    const dbPath = join(dir, "conduit.db");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dbPath); // a directory at the db path — SELECT against it fails, not "no such table"
    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/could not inspect/i);
    expect(existsSync(join(dir, "master-key"))).toBe(false); // refused, not the happy path
  });

  it("bare `conduit key` / unknown subcommand → usage on stderr, exit 1", async () => {
    for (const args of [[], ["frobnicate"]]) {
      const io = makeIo();
      const result = await runKey(args, { env: {}, conduitDir: dir, ...io });
      expect(result.exitCode).toBe(1);
      expect(io.err.join("\n")).toMatch(/generate/);
    }
  });
});

/** Sets up a rotatable install: file-sourced key + db with one real secret. */
async function rotatableInstall(dir: string) {
  const keyPath = join(dir, "master-key");
  const dbPath = join(dir, "conduit.db");
  const key = await (await import("./key-test-helpers.js")).createDbWithOneSecret(dbPath);
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  return { keyPath, dbPath, key };
}

describe("conduit key rotate (design §3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-rotate-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("INVARIANT §16.3: end state — db + key file both new, .bak = old, secret still opens; keys never printed", async () => {
    const { keyPath, dbPath, key: oldKey } = await rotatableInstall(dir);
    const io = makeIo();
    const result = await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(0);

    const newKey = readFileSync(keyPath, "utf8").trim();
    expect(newKey).not.toBe(oldKey);
    expect(readFileSync(join(dir, "master-key.bak"), "utf8").trim()).toBe(oldKey);
    expect(existsSync(join(dir, "master-key.next"))).toBe(false);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // db opens under the NEW key; the real secret round-trips
    const { store, client } = await openStoreClientFromEnv({
      CONDUIT_DB: dbPath,
      CONDUIT_MASTER_KEY: newKey,
    });
    expect(await store.secrets.reveal("cred_seed")).toBe("seed-secret");
    client.close();

    const all = [...io.out, ...io.err].join("\n");
    expect(all).not.toContain(oldKey);
    expect(all).not.toContain(newKey);
    expect(all).toMatch(/restart/i); // "restart your MCP clients"
  });

  it("INVARIANT §16.3: refuses an env-sourced key", async () => {
    const { key } = await rotatableInstall(dir);
    const io = makeIo();
    const result = await runKey(["rotate"], {
      env: { CONDUIT_MASTER_KEY: key },
      conduitDir: dir,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/env/i);
  });

  it("INVARIANT §16.3: refuses a custom CONDUIT_DB path", async () => {
    await rotatableInstall(dir);
    const io = makeIo();
    const result = await runKey(["rotate"], {
      env: { CONDUIT_DB: join(dir, "elsewhere.db") },
      conduitDir: dir,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/CONDUIT_DB/);
  });

  it("INVARIANT §16.3: refuses a leftover master-key.next (never silently reused or deleted)", async () => {
    await rotatableInstall(dir);
    writeFileSync(join(dir, "master-key.next"), "leftover", { mode: 0o600 });
    const io = makeIo();
    const result = await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/master-key\.next/);
    expect(io.err.join("\n")).toMatch(/in flight.*or a prior one crashed/i);
    expect(io.err.join("\n")).toMatch(
      /make ABSOLUTELY SURE no .conduit key rotate. is currently running/i,
    );
    expect(readFileSync(join(dir, "master-key.next"), "utf8")).toBe("leftover");
  });

  it("INVARIANT §16.3: EEXIST on the .next claim (concurrent/crashed rotation) refuses without ever advising deletion, and never touches .bak", async () => {
    const { keyPath, key } = await rotatableInstall(dir);
    const io = makeIo();
    // The plain leftover-`.next` pre-check only fires BEFORE preflight. To
    // exercise the wx-claim's OWN EEXIST arm, the file must appear AFTER
    // that pre-check passes but BEFORE the wx open — i.e. from inside the
    // DI-wrapped openStoreClient, once preflight has already succeeded.
    const result = await runKey(["rotate"], {
      env: {},
      conduitDir: dir,
      ...io,
      openStoreClient: async (env, opts) => {
        const opened = await openStoreClientFromEnv(env, opts);
        writeFileSync(join(dir, "master-key.next"), "winner-in-flight", { mode: 0o600 });
        return opened;
      },
    });
    expect(result.exitCode).toBe(1);
    // Must warn about an in-flight/crashed rotation, and must NEVER say to
    // unconditionally delete `.next` — that advice is what would let an
    // EEXIST loser destroy a concurrent winner's only copy of the new key.
    expect(io.err.join("\n")).toMatch(/in flight.*or a prior one crashed/i);
    expect(io.err.join("\n")).toMatch(
      /make ABSOLUTELY SURE no .conduit key rotate. is currently running/i,
    );
    expect(io.err.join("\n")).not.toMatch(/delete it and re-run/i);
    // The pre-created `.next` is untouched — neither deleted nor overwritten.
    expect(readFileSync(join(dir, "master-key.next"), "utf8")).toBe("winner-in-flight");
    // .bak must never be touched: the wx claim is the FIRST step now, so a
    // loser that fails there must not have copied `.bak` either.
    expect(existsSync(join(dir, "master-key.bak"))).toBe(false);
    expect(readFileSync(keyPath, "utf8").trim()).toBe(key); // live key untouched
  });

  it("INVARIANT §16.3: BUSY refusal removes its own .next — retry is not poisoned", async () => {
    const { dbPath, key } = await rotatableInstall(dir);
    // Hold the write lock from a second connection.
    const holder = await openStoreClientFromEnv({ CONDUIT_DB: dbPath, CONDUIT_MASTER_KEY: key });
    const tx = await holder.client.transaction("write");
    await tx.execute("SELECT 1"); // materialize BEGIN IMMEDIATE
    try {
      const io = makeIo();
      const result = await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
      expect(result.exitCode).toBe(1);
      // Task 9: the holder here is a second in-process libsql connection —
      // a genuinely NON-daemon opener, which is the only kind of writer the
      // §3.4 maintenance lock (held by this rotation) cannot exclude. The
      // message says exactly that rather than the pre-Task-9 "stop running
      // conduit processes", which would now be misleading advice: stopping
      // conduit processes cannot clear a stray sqlite client.
      expect(io.err.join("\n")).toMatch(/not a conduit daemon/i);
      expect(io.err.join("\n")).toMatch(/Find and stop that process/i);
      expect(existsSync(join(dir, "master-key.next"))).toBe(false); // cleaned up
      expect(readFileSync(join(dir, "master-key"), "utf8").trim()).toBe(key); // untouched
    } finally {
      await tx.rollback();
      tx.close();
      holder.client.close();
    }
  }, 10_000); // the 5000ms busy_timeout means this refusal alone takes ~5-6s

  it("INVARIANT §16.3: reencrypt-acquire BUSY removes the already-written .next — retry not poisoned", async () => {
    const { keyPath, key } = await rotatableInstall(dir);
    let holder: Awaited<ReturnType<typeof openStoreClientFromEnv>> | undefined;
    let tx:
      | Awaited<
          ReturnType<Awaited<ReturnType<typeof openStoreClientFromEnv>>["client"]["transaction"]>
        >
      | undefined;
    try {
      const io = makeIo();
      const result = await runKey(["rotate"], {
        env: {},
        conduitDir: dir,
        ...io,
        // Let preflight resolve normally against the real dir/key, then —
        // AFTER preflight succeeds — grab the write lock from a second
        // connection, so the BUSY hits reencryptSecrets' OWN
        // client.transaction("write") acquire instead of preflight's.
        openStoreClient: async (env, opts) => {
          const opened = await openStoreClientFromEnv(env, opts);
          holder = await openStoreClientFromEnv(env, opts);
          tx = await holder.client.transaction("write");
          await tx.execute("SELECT 1"); // materialize BEGIN IMMEDIATE
          return opened;
        },
      });
      expect(result.exitCode).toBe(1);
      // Same reclassification as the preflight case above (Task 9).
      expect(io.err.join("\n")).toMatch(/not a conduit daemon/i);
      expect(io.err.join("\n")).toMatch(/Find and stop that process/i);
      expect(existsSync(join(dir, "master-key.next"))).toBe(false); // written in step 3, removed by cleanup
      expect(readFileSync(keyPath, "utf8").trim()).toBe(key); // untouched
    } finally {
      if (tx) {
        await tx.rollback();
        tx.close();
      }
      holder?.client.close();
    }
  }, 10_000); // the 5000ms busy_timeout means this refusal alone takes ~5-6s

  it("INVARIANT §16.3: a pre-transaction fs failure (backup/stage) names the way forward, db untouched, .next self-cleaned", async () => {
    const { keyPath, key } = await rotatableInstall(dir);
    const io = makeIo();
    try {
      const result = await runKey(["rotate"], {
        env: {},
        conduitDir: dir,
        ...io,
        // Let preflight resolve normally, then — AFTER it succeeds — strip
        // read access from the CURRENT key file so `.next` is created and
        // claimed successfully (step 2), then step 3's copyFileSync(bak)
        // fails EACCES reading the source, before reencryptSecrets is ever
        // called. Since `.next` provably belongs to THIS run, rotate must
        // clean it up itself rather than leave it for the next invocation.
        openStoreClient: async (env, opts) => {
          const opened = await openStoreClientFromEnv(env, opts);
          chmodSync(keyPath, 0o000);
          return opened;
        },
      });
      expect(result.exitCode).toBe(1);
      expect(io.err.join("\n")).toMatch(/unchanged/);
      expect(io.err.join("\n")).toMatch(/nothing was left behind/);
      expect(existsSync(join(dir, "master-key.next"))).toBe(false); // self-cleaned — belonged to this run
    } finally {
      chmodSync(keyPath, 0o600); // restore so afterEach's rmSync can clean up
      expect(readFileSync(keyPath, "utf8").trim()).toBe(key); // untouched
    }
  });

  it("INVARIANT §16.3: an UNCERTAIN reencrypt outcome (commit throws) exits 1, PRESERVES master-key.next, and names UNCERTAIN + recovery", async () => {
    const { keyPath, key } = await rotatableInstall(dir);
    const io = makeIo();
    const result = await runKey(["rotate"], {
      env: {},
      conduitDir: dir,
      ...io,
      // Preflight resolves normally against the real dir/key; the returned
      // client's transaction("write") is wrapped so its tx.commit() throws
      // — driving reencryptSecrets to a dbState "unknown" ReencryptError.
      openStoreClient: async (env, opts) => {
        const opened = await openStoreClientFromEnv(env, opts);
        const realClient = opened.client;
        // Bind methods to `realClient` explicitly rather than proxying the
        // whole client — @libsql/client's methods (e.g. close()) read private
        // class fields via `this`, which breaks if `this` resolves to a Proxy
        // instead of the real instance.
        const proxyClient = {
          ...realClient,
          close: realClient.close.bind(realClient),
          transaction: async (...args: Parameters<typeof realClient.transaction>) => {
            const realTx = await realClient.transaction(...args);
            return {
              ...realTx,
              commit: async () => {
                throw new Error("simulated commit failure");
              },
              rollback: realTx.rollback.bind(realTx),
              execute: realTx.execute.bind(realTx),
              close: realTx.close.bind(realTx),
            };
          },
        } as typeof realClient;
        return { ...opened, client: proxyClient };
      },
    });
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(dir, "master-key.next"))).toBe(true); // preserved — uncertain outcome
    expect(io.err.join("\n")).toMatch(/UNCERTAIN/i);
    expect(io.err.join("\n")).toMatch(/master-key\.bak|whichever/i);
    expect(readFileSync(keyPath, "utf8").trim()).toBe(key); // master-key itself untouched (promote never ran)
  });

  it("INVARIANT §16.3: crash-table row 2 — .next promotes manually and the db opens", async () => {
    // Simulate "crash after commit, before promote": run a real rotate, then
    // reconstruct row-2 state from its outputs (bak=old, next=new via rename back).
    const { keyPath, dbPath, key: oldKey } = await rotatableInstall(dir);
    const io = makeIo();
    await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
    const newKey = readFileSync(keyPath, "utf8").trim();
    renameSync(keyPath, join(dir, "master-key.next")); // db=new, master-key absent→restore old
    writeFileSync(keyPath, `${oldKey}\n`, { mode: 0o600 });
    // startup with the stale (old) key fails loud and names the recovery files
    // (resolveEnv's default key-file path is HOME-based, so pass the old key explicitly)
    const err = await openStoreClientFromEnv({
      CONDUIT_DB: dbPath,
      CONDUIT_MASTER_KEY: oldKey,
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/master-key\.next|rotation-recovery/);
    // the documented manual recovery works: mv .next → master-key
    renameSync(join(dir, "master-key.next"), keyPath);
    const opened = await openStoreClientFromEnv({
      CONDUIT_DB: dbPath,
      CONDUIT_MASTER_KEY: newKey,
    });
    expect(await opened.store.secrets.reveal("cred_seed")).toBe("seed-secret");
    opened.client.close();
  });
});

/**
 * Task 9: the §3.4 maintenance lock — rotation's exclusion against the
 * daemon, with REAL spawned daemon processes on both sides of the race.
 *
 * The old guard was a write-lock probe, which §3.4 rejects outright: a
 * liveness query cannot close the window in which an unrelated client
 * auto-starts a daemon between the check and the re-seal. What is pinned
 * here is that the kernel lock closes it in BOTH orders.
 */
describe("conduit key rotate under the maintenance lock (design §3.4)", () => {
  let dir: string;
  const spawned: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-rotate-lock-"));
    // The §3.2 state-directory boundary the daemon asserts before binding.
    chmodSync(dir, 0o700);
  });

  afterEach(async () => {
    await Promise.all(
      spawned.map((child) => {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        if (!child.killed) child.kill("SIGKILL");
        return new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }),
    );
    spawned.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  /** The compiled mcp bin — `--daemon --state-dir` is the by-hand start path. */
  const mcpBinPath = join(process.cwd(), "..", "mcp", "dist", "bin.js");

  /**
   * Starts a real daemon against `stateDir`, resolving with its exit code
   * if it exits early (the refusal cases) or with `null` once it reports
   * "listening". Keyed on the daemon's own lifecycle lines, exactly as the
   * integration suite's `startDaemonAt` is.
   */
  function startDaemon(stateDir: string, key: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        CONDUIT_MASTER_KEY: key,
      };
      delete env.CONDUIT_DB;
      const child = spawn(process.execPath, [mcpBinPath, "--daemon", "--state-dir", stateDir], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      spawned.push(child);
      const timer = setTimeout(
        () => reject(new Error(`daemon timed out. Output: ${seen}`)),
        30_000,
      );
      let seen = "";
      const watch = (chunk: Buffer): void => {
        seen += chunk.toString("utf8");
        if (seen.includes("listening")) {
          clearTimeout(timer);
          resolve(null);
        }
      };
      child.stdout?.on("data", watch);
      child.stderr?.on("data", watch);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  it("INVARIANT §17 / §3.4: order A — a LIVE daemon makes rotate refuse non-blocking, naming the holder", async () => {
    const { key } = await rotatableInstall(dir);
    // A real daemon, holding maintenance SHARED for its whole lifetime.
    expect(await startDaemon(dir, key)).toBeNull();

    const io = makeIo();
    const started = Date.now();
    const result = await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
    const elapsed = Date.now() - started;

    expect(result.exitCode).toBe(1);
    const err = io.err.join("\n");
    expect(err).toMatch(/maintenance lock is held/i);
    // The §3.4 diagnostic metadata: the refusal names WHO holds it, so the
    // operator is not sent hunting. A SHARED holder does not block the read.
    // Hedged rather than asserted: the row survives a SIGKILLed holder, so
    // it is offered as a lead ("may be stale"), never as a verdict that
    // would send the operator after an already-departed pid.
    expect(err).toMatch(/Last acquired by daemon \(pid \d+\) at .* \(may be stale\)/);
    // Non-blocking: a fail-fast refusal, never a wait-then-take. Well under
    // EXCLUSIVE_ACQUIRE_BUSY_TIMEOUT_MS (1000), which only lifecycle uses.
    expect(elapsed).toBeLessThan(2000);

    // Nothing was read or written — the whole rotation sequence is behind
    // the lock, so a refused rotate leaves no `.next` and no `.bak`.
    expect(existsSync(join(dir, "master-key.next"))).toBe(false);
    expect(existsSync(join(dir, "master-key.bak"))).toBe(false);
    expect(readFileSync(join(dir, "master-key"), "utf8").trim()).toBe(key);
  }, 60_000);

  it("INVARIANT §17 / §3.4: order B — a HELD rotation makes a starting daemon exit `rotation in progress`", async () => {
    const { key } = await rotatableInstall(dir);
    // Hold maintenance EXCLUSIVE exactly as rotate does, then start a
    // daemon into it. The daemon takes maintenance SHARED after lifecycle
    // EXCLUSIVE, reads BUSY, and exits with the §3.5 contract code.
    const held = await acquireExclusive(daemonPaths(dir).maintenanceLockDb, {
      role: MAINTENANCE_ROLE_ROTATE,
    });
    expect(held).not.toBeNull();
    try {
      expect(await startDaemon(dir, key)).toBe(EXIT_ROTATION_IN_PROGRESS);
    } finally {
      await held?.release();
    }

    // And once the rotation releases, a daemon starts normally — the
    // refusal was the lock, not a poisoned state directory.
    expect(await startDaemon(dir, key)).toBeNull();
  }, 60_000);

  it("INVARIANT §17 / §3.4: `key generate` is behind the same lock — its db inspection cannot race a daemon", async () => {
    // §3.4's closing note: key.ts's second direct `createClient` (the
    // sealed-row count) sits inside the boundary too. A daemon holding
    // maintenance must therefore refuse generate as well as rotate.
    const { key } = await rotatableInstall(dir);
    rmSync(join(dir, "master-key")); // generate needs the key file absent
    expect(await startDaemon(dir, key)).toBeNull();

    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });

    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/maintenance lock is held/i);
    expect(io.err.join("\n")).toMatch(/Last acquired by daemon \(pid \d+\)/);
    expect(existsSync(join(dir, "master-key"))).toBe(false); // no key minted
  }, 60_000);

  it("INVARIANT §17 / §3.4: fresh install — generate works when the state directory does not exist yet", async () => {
    // THE REGRESSION THIS PINS: the maintenance acquisition runs BEFORE
    // generate's own mkdir, and `acquireExclusive` throws raw libsql
    // SQLITE_CANTOPEN (`ConnectionFailed(… : 14)`) on a directory that is
    // not there. That broke the DOCUMENTED FIRST ONBOARDING STEP — the one
    // command guaranteed to run before `~/.conduit` exists. Every other
    // fixture in this file uses mkdtempSync, which always creates the
    // directory, which is exactly why nothing caught it.
    //
    // Nothing can hold a lock inside a directory that does not exist, so
    // the absence is proof of exclusivity and generate proceeds.
    const fresh = join(dir, "not-created-yet");
    expect(existsSync(fresh)).toBe(false);

    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: fresh, ...io });

    expect(result.exitCode).toBe(0);
    const all = [...io.out, ...io.err].join("\n");
    expect(all).not.toMatch(/ConnectionFailed|SQLITE_CANTOPEN/);

    // The key was really minted, and the directory created 0700.
    const keyPath = join(fresh, "master-key");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64")).toHaveLength(32);
    expect(all).not.toContain(readFileSync(keyPath, "utf8").trim()); // key never printed
  });

  it("INVARIANT §17 / §3.4: fresh install — rotate refuses IMMEDIATELY on a dir-less install, with NO unlocked-proceed window (F4)", async () => {
    // The F4 TOCTOU fix. Rotate previously PROCEEDED UNLOCKED on
    // `no-state-dir` (falling through to its preflight, which then failed
    // "Missing master key"). But proceeding unlocked at all is the hole: a
    // daemon could create the directory and take the maintenance lock in the
    // window, and rotate would re-encrypt the live daemon's db with no
    // EXCLUSIVE hold. A dir-less install genuinely has nothing to rotate, so
    // rotate now refuses OUTRIGHT — before any preflight, before any lock
    // acquisition proceeds unlocked — with the keyless diagnosis.
    const fresh = join(dir, "also-not-created");
    expect(existsSync(fresh)).toBe(false);

    const io = makeIo();
    const result = await runKey(["rotate"], { env: {}, conduitDir: fresh, ...io });

    expect(result.exitCode).toBe(1);
    const err = io.err.join("\n");
    expect(err).not.toMatch(/ConnectionFailed|SQLITE_CANTOPEN/);
    // The new refusal: nothing to rotate, run generate first. NOT the old
    // "preflight failed / Missing master key" — rotate never reaches
    // preflight on a dir-less install now.
    expect(err).toMatch(/rotate refused: no Conduit state directory/);
    expect(err).toMatch(/nothing to rotate/);
    expect(err).toMatch(/conduit key generate/);
    expect(err).not.toMatch(/preflight/);
    // And it created nothing on the way to refusing — no unlocked proceed.
    expect(existsSync(fresh)).toBe(false);
  });

  it("rotate succeeds normally once no daemon holds the lock, and releases it afterwards", async () => {
    // The lock must not be a one-way door: a plain rotate on a quiet
    // install still works, and leaves maintenance free for the next one.
    const { keyPath, key: oldKey } = await rotatableInstall(dir);
    const io = makeIo();
    expect((await runKey(["rotate"], { env: {}, conduitDir: dir, ...io })).exitCode).toBe(0);
    expect(readFileSync(keyPath, "utf8").trim()).not.toBe(oldKey);

    // Released promptly, not merely at process death: a second rotate in
    // the same process acquires without waiting.
    const after = await acquireExclusive(daemonPaths(dir).maintenanceLockDb);
    expect(after).not.toBeNull();
    await after?.release();
  }, 30_000);

  it("INVARIANT §17 / §3.4: generate CREATES the dir under the §3.2 boundary BEFORE acquiring, and holds a REAL releasable EXCLUSIVE (F4)", async () => {
    // The F4 TOCTOU fix's positive half. Generate used to acquire the lock
    // FIRST, get `no-state-dir` on a fresh install, and then run UNLOCKED
    // while it created the directory and inspected the db — a window an
    // env-key daemon could start inside. Now generate creates + validates the
    // directory (0700) via ensureStateDir and only THEN takes the maintenance
    // lock EXCLUSIVE, so the acquire is against a directory that now exists
    // (never `no-state-dir`) and the db inspection + key publication run under
    // a real hold.
    //
    // Proven three ways: ensureStateDir is called with generate's dir (create
    // BEFORE lock); the dir is 0700 and the key minted (the acquire succeeded
    // because the dir existed); and the maintenance lock is FREE and
    // re-acquirable afterwards (a real releasable EXCLUSIVE, not a no-op skip).
    const fresh = join(dir, "gen-creates-then-locks");
    expect(existsSync(fresh)).toBe(false);

    const { ensureStateDir } = await import("@conduithq/mcp");
    const ensureCalls: string[] = [];

    const io = makeIo();
    const result = await runKey(["generate"], {
      env: {},
      conduitDir: fresh,
      ...io,
      ensureStateDir: async (d: string) => {
        ensureCalls.push(d);
        await ensureStateDir(d);
      },
    });
    expect(result.exitCode).toBe(0);
    // ensureStateDir ran for generate's own dir — the create-then-lock order.
    expect(ensureCalls).toEqual([fresh]);

    // The lock is a real, releasable EXCLUSIVE: free and re-acquirable now
    // that generate finished (not a no-op that never held anything).
    const afterRun = await acquireExclusive(daemonPaths(fresh).maintenanceLockDb);
    expect(afterRun).not.toBeNull();
    await afterRun?.release();

    // The key was minted and the dir is 0700 — the acquire succeeded because
    // generate created the dir BEFORE acquiring (never `no-state-dir`).
    expect(statSync(join(fresh, "master-key")).mode & 0o777).toBe(0o600);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
  }, 30_000);

  it("INVARIANT §17 / §3.4: generate does NOT proceed unlocked — a held maintenance lock blocks it even mid-onboarding (F4)", async () => {
    // The decisive proof that generate acquires-then-works rather than
    // proceeding unlocked: hold maintenance EXCLUSIVE externally, then run
    // generate against the SAME (existing, empty-of-key) directory. Generate
    // creates/validates the dir (idempotent), tries to acquire, reads BUSY,
    // and refuses — it never runs its db inspection or mints a key against a
    // directory another holder owns. Before F4, a fresh-dir generate skipped
    // the lock entirely; this pins that it no longer can.
    const held = await acquireExclusive(daemonPaths(dir).maintenanceLockDb, {
      role: MAINTENANCE_ROLE_ROTATE,
    });
    expect(held).not.toBeNull();
    try {
      const io = makeIo();
      const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });
      expect(result.exitCode).toBe(1);
      // Refused for the lock, and minted no key while another holder owned it.
      expect(existsSync(join(dir, "master-key"))).toBe(false);
    } finally {
      await held?.release();
    }

    // Once the lock frees, generate works — the refusal was the lock, not a
    // poisoned directory.
    const io2 = makeIo();
    expect((await runKey(["generate"], { env: {}, conduitDir: dir, ...io2 })).exitCode).toBe(0);
    expect(statSync(join(dir, "master-key")).mode & 0o777).toBe(0o600);
  }, 30_000);
});
