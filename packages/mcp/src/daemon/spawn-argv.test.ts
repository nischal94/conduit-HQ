import { describe, expect, it } from "vitest";
import { daemonArgv } from "./spawn.js";

/**
 * The env→argv translation across the spawn boundary (spec §5, §3.1).
 *
 * The child's constructed environment is exactly `{PATH}`, so the §5 volume
 * gate can only reach it as an ARGUMENT. That translation was previously
 * unpinned: nothing failed if `--debug` stopped being appended, and the
 * symptom would be a daemon silently logging at the wrong volume — visible
 * only to whoever went looking for lines that were never written.
 */
describe("daemonArgv", () => {
  it("passes --debug when the SPAWNER's env opts in", () => {
    expect(daemonArgv({ CONDUIT_DAEMON_DEBUG: "1" })).toContain("--debug");
  });

  it("omits --debug by default, so the §5 gate is shut unless asked", () => {
    expect(daemonArgv({})).not.toContain("--debug");
  });

  it('requires exactly "1" — a fuzzy predicate would make `=0` enable debug', () => {
    for (const value of ["0", "", "true", "yes", "01"]) {
      expect(daemonArgv({ CONDUIT_DAEMON_DEBUG: value }), value).not.toContain("--debug");
    }
  });

  it("always starts the daemon: the entry point and --daemon lead the argv", () => {
    // Order matters — `bin.ts` reads `process.argv[2]` to select the daemon
    // branch, so `--daemon` must be the FIRST argument after the script.
    const argv = daemonArgv({ CONDUIT_DAEMON_DEBUG: "1" });
    expect(argv[1]).toBe("--daemon");
    expect(argv).toEqual([argv[0], "--daemon", "--debug"]);
  });
});
