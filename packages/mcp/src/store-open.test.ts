import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStoreFromEnv } from "./store-open.js";

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

  it("missing key rejects with the resolveEnv message", async () => {
    await expect(openStoreFromEnv({})).rejects.toThrow(/CONDUIT_MASTER_KEY/);
  });
});
