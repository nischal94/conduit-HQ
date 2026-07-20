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
import { openStoreClientFromEnv } from "@conduithq/mcp";
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
    expect(io.err.join("\n")).toMatch(/in flight or crashed mid-write/i);
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
      expect(io.err.join("\n")).toMatch(/stop running conduit processes/i);
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
      expect(io.err.join("\n")).toMatch(/stop running conduit processes/i);
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
