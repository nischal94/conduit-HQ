import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
