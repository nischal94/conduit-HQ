import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEnv } from "./env.js";
import { openStoreClientFromEnv, openStoreFromEnv } from "./store-open.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("openStoreFromEnv", () => {
  it("valid env opens a store whose sources.list() returns [] on a fresh temp db", async () => {
    dir = mkdtempSync(join(tmpdir(), "conduit-store-open-"));
    const dbPath = join(dir, "conduit.db");
    const { env, store } = await openStoreFromEnv({
      CONDUIT_MASTER_KEY: KEY,
      CONDUIT_DB: dbPath,
    });
    expect(env.dbPath).toBe(dbPath);
    expect(await store.sources.list()).toEqual([]);
  });

  it("missing key rejects with the resolveEnv message", () => {
    // openStoreFromEnv intentionally has no opts seam (back-compat shape),
    // so it always resolves DEFAULT_KEY_FILE — which makes "missing key"
    // behavior undeterministic across host machines that do/don't have a
    // real ~/.conduit/master-key. resolveEnv (which openStoreFromEnv calls
    // first, before ever touching the filesystem for the db) is exercised
    // directly here with an explicit nonexistent keyFilePath instead.
    expect(() =>
      resolveEnv({}, { keyFilePath: "/nonexistent/conduit-store-open-test/master-key" }),
    ).toThrow(/CONDUIT_MASTER_KEY/);
  });
});

describe("openStoreClientFromEnv (opts threading — controller-logged deviation D1)", () => {
  it("threads ResolveEnvOptions.keyFilePath: resolves via key file, keySource 'file', db created 0600", async () => {
    dir = mkdtempSync(join(tmpdir(), "conduit-store-open-opts-"));
    const dbPath = join(dir, "conduit.db");
    const keyFilePath = join(dir, "master-key");
    writeFileSync(keyFilePath, KEY, { mode: 0o600 });

    const { env, store, client } = await openStoreClientFromEnv(
      { CONDUIT_DB: dbPath },
      { keyFilePath },
    );

    expect(env.keySource).toBe("file");
    expect(env.dbPath).toBe(dbPath);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(await store.sources.list()).toEqual([]);
    client.close();
  });
});
