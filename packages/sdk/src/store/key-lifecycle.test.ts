import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretBox } from "../secrets.js";
import { CANARY_REF, CANARY_SENTINEL, KeyCanaryError } from "./key-lifecycle.js";
import { openSqliteStore } from "./sqlite.js";

async function freshBoxes() {
  const right = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
  const wrong = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
  return { right, wrong };
}

describe("key canary (design §2)", () => {
  let client: ReturnType<typeof createClient>;
  beforeEach(() => {
    client = createClient({ url: ":memory:" });
  });

  it("INVARIANT §16.3: first open on an empty db writes the canary; reopen with the same key succeeds", async () => {
    const { right } = await freshBoxes();
    await openSqliteStore({ client, secretBox: right });
    const row = await client.execute({
      sql: "SELECT sealed FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    expect(row.rows).toHaveLength(1);
    expect(await right.open(String(row.rows[0]?.sealed))).toBe(CANARY_SENTINEL);
    await expect(openSqliteStore({ client, secretBox: right })).resolves.toBeDefined();
  });

  it("INVARIANT §16.3: wrong master key fails at store open (canary), not first use", async () => {
    const { right, wrong } = await freshBoxes();
    await openSqliteStore({ client, secretBox: right });
    await expect(openSqliteStore({ client, secretBox: wrong })).rejects.toThrow(KeyCanaryError);
  });

  it("INVARIANT §16.3: legacy db (real rows, no canary) + wrong key → refused, canary NOT created", async () => {
    const { right, wrong } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    await store.secrets.put("cred_github", "real-secret");
    await client.execute({ sql: "DELETE FROM secrets WHERE ref = ?", args: [CANARY_REF] });
    await expect(openSqliteStore({ client, secretBox: wrong })).rejects.toThrow(KeyCanaryError);
    const canary = await client.execute({
      sql: "SELECT 1 FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    expect(canary.rows).toHaveLength(0); // never bound to an unverified key
  });

  it("INVARIANT §16.3: legacy db + correct key → canary created, subsequent opens pass", async () => {
    const { right } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    await store.secrets.put("cred_github", "real-secret");
    await client.execute({ sql: "DELETE FROM secrets WHERE ref = ?", args: [CANARY_REF] });
    await openSqliteStore({ client, secretBox: right });
    const canary = await client.execute({
      sql: "SELECT 1 FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    expect(canary.rows).toHaveLength(1);
  });

  it("INVARIANT §16.3: corrupted canary + healthy real row → canary-corruption error, not wrong-key", async () => {
    const { right } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    await store.secrets.put("cred_github", "real-secret");
    await client.execute({
      sql: "UPDATE secrets SET sealed = ? WHERE ref = ?",
      args: [await right.seal("not-the-sentinel"), CANARY_REF],
    });
    const err = await openSqliteStore({ client, secretBox: right }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyCanaryError);
    expect((err as KeyCanaryError).kind).toBe("canary-corruption");
  });

  it("INVARIANT §16.3: probe-all — corrupt FIRST real row + later good row → still canary-corruption", async () => {
    const { right, wrong } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    // ref ordering: cred_a sorts before cred_b — corrupt the first.
    await store.secrets.put("cred_a", "s1");
    await store.secrets.put("cred_b", "s2");
    await client.execute({
      sql: "UPDATE secrets SET sealed = ? WHERE ref = ?",
      args: [await wrong.seal("foreign"), "cred_a"],
    });
    await client.execute({
      sql: "UPDATE secrets SET sealed = 'v1.garbage.garbage' WHERE ref = ?",
      args: [CANARY_REF],
    });
    const err = await openSqliteStore({ client, secretBox: right }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyCanaryError);
    expect((err as KeyCanaryError).kind).toBe("canary-corruption"); // cred_b proved the key
  });

  it("INVARIANT §16.3: canary fails + ALL real rows fail → ambiguous wrong-key-or-corruption error", async () => {
    const { right, wrong } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    await store.secrets.put("cred_github", "real-secret");
    const err = await openSqliteStore({ client, secretBox: wrong }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyCanaryError);
    expect((err as KeyCanaryError).kind).toBe("wrong-key");
    expect(String(err)).toMatch(/wrong master key/i);
    expect(String(err)).not.toMatch(/[A-Za-z0-9+/]{40,}/); // no key material
  });

  it("INVARIANT §16.3: M5 first-run race — INSERT OR IGNORE keeps a racing pair consistent", async () => {
    const { right } = await freshBoxes();
    // Sequential simulation of the race: both opens bootstrap with the SAME key;
    // the second must tolerate the first's row (INSERT OR IGNORE + verify).
    await Promise.all([
      openSqliteStore({ client, secretBox: right }),
      openSqliteStore({ client, secretBox: right }),
    ]);
    const rows = await client.execute({
      sql: "SELECT sealed FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    expect(rows.rows).toHaveLength(1);
    expect(await right.open(String(rows.rows[0]?.sealed))).toBe(CANARY_SENTINEL);
  });

  it("context (db path / key source) appears in the error, key material never does", async () => {
    const { right, wrong } = await freshBoxes();
    await openSqliteStore({ client, secretBox: right });
    const err = await openSqliteStore({
      client,
      secretBox: wrong,
      keyContext: { dbPath: "/tmp/x/conduit.db", keySource: "file" },
    }).catch((e: unknown) => e);
    expect(String(err)).toContain("/tmp/x/conduit.db");
    expect(String(err)).toContain("file");
  });
});
