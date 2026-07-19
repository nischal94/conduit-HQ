import {
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
