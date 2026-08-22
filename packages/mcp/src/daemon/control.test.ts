import { describe, expect, it } from "vitest";
import { daemonStatus, daemonStop, type Principal } from "./control.js";

const anon: Principal = { kind: "anonymous-local" };

const deps = {
  pid: () => 4242,
  agentVersion: "0.1.0",
  startedAt: 1_000,
  dbPath: "/tmp/x/conduit.db",
  connectionCount: () => 3,
  queueStats: () => ({ depth: 2, activeCount: 1 }),
  logInfo: () => ({ path: "/tmp/x/conduitd.log", sizeBytes: 512 }),
};

describe("daemonStatus", () => {
  it("projects exactly the defined status fields", () => {
    expect(daemonStatus(anon, deps)).toEqual({
      pid: 4242,
      agentVersion: "0.1.0",
      startedAt: 1_000,
      dbPath: "/tmp/x/conduit.db",
      connections: 3,
      executionsInFlight: 1,
      queueDepth: 2,
      logPath: "/tmp/x/conduitd.log",
      logSizeBytes: 512,
    });
  });

  it("reports null log fields when the daemon logs to a TTY", () => {
    const status = daemonStatus(anon, { ...deps, logInfo: () => null });
    expect(status.logPath).toBeNull();
    expect(status.logSizeBytes).toBeNull();
  });
});

describe("daemonStop", () => {
  it("returns the stopping intent — the transport performs the flush-then-stop", () => {
    expect(daemonStop(anon)).toEqual({ stopping: true });
  });
});
