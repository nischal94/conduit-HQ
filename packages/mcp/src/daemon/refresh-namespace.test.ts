import { describe, expect, it } from "vitest";
import { type ConnectionDeps, refreshNamespace } from "./connection.js";

/**
 * `refreshNamespace` driven DIRECTLY, with a fake store and a recording
 * catalog.
 *
 * Why not through a real daemon: the two properties below are structurally
 * unreachable from a black-box test. The store read and the two catalog
 * mutations are one synchronous run, and the refresh happens after its
 * commit inside the held source lock — so no client and no stalled upstream
 * can interleave anything into the window where either property bites.
 * Driving the function is the only honest way to pin them.
 */

interface CatalogCall {
  op: "remove" | "upsert";
  /** For `remove`, the namespace; for `upsert`, the tool names written. */
  detail: string[];
}

interface Tool {
  name: string;
  namespace: string;
}

interface Harness {
  deps: ConnectionDeps;
  calls: CatalogCall[];
  logs: string[];
}

function makeDeps(options: {
  tools: Tool[];
  /** Throws on the Nth `removeNamespace` (1-based); 0 disables. */
  failRemoveOn?: number;
  /** Throws on the Nth `upsert` (1-based); 0 disables. */
  failUpsertOn?: number;
  /** Throws on EVERY `upsert`, so the ladder runs to rung 2. */
  failEveryUpsert?: boolean;
  /** Rejects the Nth `tools.list()` (1-based); 0 disables. */
  failListOn?: number;
}): Harness {
  const calls: CatalogCall[] = [];
  const logs: string[] = [];
  let removes = 0;
  let upserts = 0;
  let lists = 0;

  const deps = {
    store: {
      tools: {
        list: async (): Promise<Tool[]> => {
          lists += 1;
          if (lists === options.failListOn) throw new Error("injected store fault");
          return options.tools;
        },
      },
    },
    runtime: {
      catalog: {
        removeNamespace: (ns: string): void => {
          removes += 1;
          calls.push({ op: "remove", detail: [ns] });
          if (removes === options.failRemoveOn) throw new Error("injected remove fault");
        },
        upsert: (tools: Tool[]): void => {
          upserts += 1;
          calls.push({ op: "upsert", detail: tools.map((t) => t.name) });
          if (options.failEveryUpsert === true || upserts === options.failUpsertOn) {
            throw new Error("injected upsert fault");
          }
        },
      },
    },
    log: (line: string): void => {
      logs.push(line);
    },
    // The rest of ConnectionDeps is unreachable from this function; the cast
    // is the FAKE's, narrowing to exactly what refreshNamespace touches.
  } as unknown as ConnectionDeps;

  return { deps, calls, logs };
}

const TOOLS: Tool[] = [
  { name: "github.list_issues", namespace: "github" },
  { name: "jira.list_tickets", namespace: "jira" },
  { name: "github.list_releases", namespace: "github" },
];

describe("refreshNamespace", () => {
  it("INVARIANT §2.2: a namespace refresh writes only THIS namespace's rows", async () => {
    // `store.tools.list()` spans EVERY namespace, but the write scope must
    // match the LOCK scope — this namespace alone. An unfiltered upsert
    // writes another namespace's rows under a lock that never covered them,
    // which is how a concurrently-retired tool gets resurrected.
    //
    // MUTATION CHECK: drop the `.filter(...)` in `refreshNamespace` and the
    // upsert below carries `jira.list_tickets`, failing this test.
    const h = makeDeps({ tools: TOOLS });

    await refreshNamespace(h.deps, "github");

    expect(h.calls).toEqual([
      { op: "remove", detail: ["github"] },
      { op: "upsert", detail: ["github.list_issues", "github.list_releases"] },
    ]);
    // Stated separately, because THIS is the damaging half: no other
    // namespace's row is ever written.
    const written = h.calls.flatMap((c) => (c.op === "upsert" ? c.detail : []));
    expect(written).not.toContain("jira.list_tickets");
  });

  it("removes before it upserts, so a retired tool cannot linger", async () => {
    // `InMemoryCatalog.upsert` only ever `set`s. An upsert alone therefore
    // cannot retire a dropped tool — it would leave the retired one serving
    // beside the new ones, which is stale AND inconsistent.
    const h = makeDeps({ tools: TOOLS });

    await refreshNamespace(h.deps, "github");

    expect(h.calls.map((c) => c.op)).toEqual(["remove", "upsert"]);
  });

  it("retries the whole materialize-then-mutate body on rung 1", async () => {
    // The retry re-reads the store rather than reusing the failed attempt's
    // snapshot: a transient store fault is the case worth one retry.
    const h = makeDeps({ tools: TOOLS, failRemoveOn: 1 });

    await refreshNamespace(h.deps, "github");

    // Rung 1 ran the full body again — remove THEN upsert, not a bare
    // upsert onto a namespace the failed attempt may have half-cleared.
    expect(h.calls.map((c) => c.op)).toEqual(["remove", "remove", "upsert"]);
    expect(h.logs.join("\n")).toContain("retrying the namespace refresh");
    expect(h.logs.join("\n")).toContain("Catalog refreshed on retry");
  });

  it("reports MISSING OR PARTIAL — not merely stale — when both rungs fail", async () => {
    // The honesty property. An upsert failure lands AFTER the remove, so the
    // namespace is empty or partial; claiming it is "serving the previous
    // catalog" is simply false, and it is the claim an operator would act on.
    // BOTH rungs' upserts fail, so the ladder runs to the bottom.
    const h = makeDeps({ tools: TOOLS, failEveryUpsert: true });

    await refreshNamespace(h.deps, "github");

    // Non-vacuous: the remove really did run before each failed upsert, so
    // the namespace really is empty — the state the line describes.
    expect(h.calls.map((c) => c.op)).toEqual(["remove", "upsert", "remove", "upsert"]);

    const log = h.logs.join("\n");
    expect(log).toContain("MISSING OR PARTIAL");
    expect(log).toMatch(/provision\/revalidate/);
    expect(log).toContain("restart");
    // The retired claim is GONE, not merely joined by the new one.
    expect(log).not.toContain("serving the previous catalog");
  });

  it("never throws, whatever fails — a committed provisioning stays successful", async () => {
    // The contract the whole function exists to keep: a refresh failure
    // after a COMMITTED write must not turn the operator's successful
    // provisioning into an error answer.
    const h = makeDeps({ tools: TOOLS, failListOn: 1 });
    await expect(refreshNamespace(h.deps, "github")).resolves.toBeUndefined();

    // Including when the LOG itself throws — the last thing the catch
    // bodies can reach.
    const hostile = makeDeps({ tools: TOOLS, failListOn: 1 });
    (hostile.deps as { log: (line: string) => void }).log = () => {
      throw new Error("closed pipe");
    };
    await expect(refreshNamespace(hostile.deps, "github")).resolves.toBeUndefined();
  });
});
