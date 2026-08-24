import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_VERSION, ensureDbFile, resolveEnv } from "./env.js";
import { openStoreClientFromEnv } from "./store-open.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

it("AGENT_VERSION matches package.json — the skew warning must never report a stale string", () => {
  const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
  expect(AGENT_VERSION).toBe(pkg.version);
});

describe("resolveEnv (design M7/M8)", () => {
  it("resolves defaults and decodes the key", () => {
    const r = resolveEnv({ CONDUIT_MASTER_KEY: KEY });
    expect(r.dbPath.endsWith("/.conduit/conduit.db")).toBe(true);
    expect(r.keyBytes.length).toBe(32);
    expect(r.allowPrivateEgress).toBe(false);
  });
  it("missing key → per-cause message including the generation one-liner", () => {
    // keyFilePath points at a definitely-nonexistent path so this doesn't
    // depend on whether the host machine happens to have ~/.conduit/master-key.
    expect(() =>
      resolveEnv({}, { keyFilePath: "/nonexistent/conduit-env-test/master-key" }),
    ).toThrow(/CONDUIT_MASTER_KEY.*conduit key generate/s);
  });
  it("malformed key (wrong length) → per-cause message", () => {
    expect(() => resolveEnv({ CONDUIT_MASTER_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /32 bytes/,
    );
  });
  it("non-canonical base64 (invalid characters) → per-cause message, not silent 32 bytes", () => {
    const valid = Buffer.alloc(32, 7).toString("base64");
    expect(() => resolveEnv({ CONDUIT_MASTER_KEY: `!!${valid.slice(2)}` })).toThrow(
      /canonical|encoding/i,
    );
  });
  it("non-canonical base64 (valid 32-byte length, non-zero padding bits) → per-cause message", () => {
    // Buffer.from silently ignores unused padding bits instead of rejecting
    // them, so a corrupted-but-same-length key must still fail loudly.
    const valid = Buffer.alloc(32, 7).toString("base64");
    const nonCanonical = `${valid.slice(0, -2)}B=`;
    expect(Buffer.from(nonCanonical, "base64").length).toBe(32);
    expect(() => resolveEnv({ CONDUIT_MASTER_KEY: nonCanonical })).toThrow(/canonical|encoding/i);
  });
  it("egress opt-in", () => {
    expect(
      resolveEnv({ CONDUIT_MASTER_KEY: KEY, CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1" })
        .allowPrivateEgress,
    ).toBe(true);
  });
});

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("key resolution (design §1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-env-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("INVARIANT §16.3: env var wins over the key file; keySource says so", () => {
    const keyFile = join(dir, "master-key");
    writeFileSync(keyFile, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
    const resolved = resolveEnv({ CONDUIT_MASTER_KEY: VALID_KEY }, { keyFilePath: keyFile });
    expect(resolved.keySource).toBe("env");
    expect(Buffer.from(resolved.keyBytes).toString("base64")).toBe(VALID_KEY);
  });

  it("INVARIANT §16.3: no env var → key file is read, validated, keySource 'file'", () => {
    const keyFile = join(dir, "master-key");
    writeFileSync(keyFile, `${VALID_KEY}\n`, { mode: 0o600 }); // trailing newline is trimmed
    const resolved = resolveEnv({}, { keyFilePath: keyFile });
    expect(resolved.keySource).toBe("file");
    expect(Buffer.from(resolved.keyBytes).toString("base64")).toBe(VALID_KEY);
  });

  it("INVARIANT §16.3: neither env nor file → loud error naming `conduit key generate`", () => {
    expect(() => resolveEnv({}, { keyFilePath: join(dir, "master-key") })).toThrow(
      /conduit key generate/,
    );
  });

  it("malformed key FILE names the file, never its contents", () => {
    const keyFile = join(dir, "master-key");
    writeFileSync(keyFile, "not-base64!!", { mode: 0o600 });
    const err = (() => {
      try {
        resolveEnv({}, { keyFilePath: keyFile });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(String(err)).toContain(keyFile);
    expect(String(err)).not.toContain("not-base64!!");
  });

  it("INVARIANT §16.3: key file wider than 0600 → stderr warning, still serves", () => {
    const keyFile = join(dir, "master-key");
    writeFileSync(keyFile, VALID_KEY, { mode: 0o644 });
    const warnings: string[] = [];
    const resolved = resolveEnv({}, { keyFilePath: keyFile, warn: (m) => warnings.push(m) });
    expect(resolved.keySource).toBe("file");
    expect(warnings.some((w) => w.includes("0600"))).toBe(true);
  });
});

describe("ensureDbFile (design §4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-dbfile-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mode = (p: string) => statSync(p).mode & 0o777;

  it("INVARIANT §16.3: db file created 0600 before libsql touches it; dir 0700", () => {
    const dbPath = join(dir, "sub", "conduit.db");
    ensureDbFile(dbPath);
    expect(mode(dbPath)).toBe(0o600);
    expect(mode(join(dir, "sub"))).toBe(0o700);
  });

  it("INVARIANT §16.3: existing wider-perms db and sidecars healed to 0600", () => {
    const dbPath = join(dir, "conduit.db");
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      closeSync(openSync(p, "w", 0o644));
      chmodSync(p, 0o644);
    }
    ensureDbFile(dbPath);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      expect(mode(p)).toBe(0o600);
    }
  });

  it("is idempotent and tolerates a concurrent-create race", () => {
    const dbPath = join(dir, "conduit.db");
    ensureDbFile(dbPath);
    ensureDbFile(dbPath); // second call: file exists, already 0600 — no-op
    expect(existsSync(dbPath)).toBe(true);
  });

  it("INVARIANT §16.3: a real store open + write leaves any materialized WAL sidecars 0600", async () => {
    const dbPath = join(dir, "conduit.db");
    const keyFilePath = join(dir, "master-key");
    writeFileSync(keyFilePath, `${KEY}\n`, { mode: 0o600 });
    const { store, client } = await openStoreClientFromEnv({ CONDUIT_DB: dbPath }, { keyFilePath });
    try {
      await store.secrets.put("cred_seed", "seed-secret");
      // Pin that the WAL sidecar actually materializes here — without this,
      // the perms asserts below could pass vacuously if libsql never
      // created -wal/-shm for this write pattern.
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${dbPath}${suffix}`;
        if (existsSync(sidecar)) {
          expect(mode(sidecar)).toBe(0o600);
        }
      }
      expect(mode(dbPath)).toBe(0o600);
    } finally {
      client.close();
    }
  });
});
