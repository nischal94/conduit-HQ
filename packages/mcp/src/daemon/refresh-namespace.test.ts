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
  /** Every `tools.list` argument, in call order. Counts the store reads. */
  listArgs: (string | undefined)[];
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
  const listArgs: (string | undefined)[] = [];
  let removes = 0;
  let upserts = 0;
  let lists = 0;

  const deps = {
    store: {
      tools: {
        // Honors the namespace argument, exactly as the real
        // `store.tools.list(namespace)` does (`sqlite.ts`, indexed with the
        // same ORDER BY). A fake that ignored it would keep passing after a
        // regression that dropped the scoping and reinstated a filter — or
        // dropped both — so the scoping assertion has to bite HERE.
        list: async (namespace?: string): Promise<Tool[]> => {
          lists += 1;
          listArgs.push(namespace);
          if (lists === options.failListOn) throw new Error("injected store fault");
          return namespace === undefined
            ? options.tools
            : options.tools.filter((tool) => tool.namespace === namespace);
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

  return { deps, calls, logs, listArgs };
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
    // MUTATION CHECK: widen the read to `store.tools.list()` and the upsert
    // below carries `jira.list_tickets`, failing this test.
    const h = makeDeps({ tools: TOOLS });

    await refreshNamespace(h.deps, "github");

    expect(h.calls).toEqual([
      { op: "remove", detail: ["github"] },
      { op: "upsert", detail: ["github.list_issues", "github.list_releases"] },
    ]);
    // Scoped at the QUERY, not by a filter over every namespace's rows: the
    // store is asked for this namespace alone, which is what makes the
    // scoping hold at the read rather than depending on a later step.
    expect(h.listArgs).toEqual(["github"]);
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

  it("retries a failed MUTATE without a second store read", async () => {
    // The observable-empty window, closed. A mutate can fail AFTER the
    // remove has already run, leaving the namespace empty. If the retry
    // re-read the store it would `await` in exactly that state, handing
    // control to the event loop with the namespace observably empty — any
    // concurrent request landing in that window sees a namespace with no
    // tools, on a provisioning that COMMITTED successfully.
    //
    // The retry therefore reuses the array it already holds. `mutate` has no
    // `await`, so the removed-but-not-upserted state never survives a tick.
    //
    // MUTATION CHECK: make the rung-1 retry re-read (`mutate(await read())`
    // unconditionally) and the read count below goes to 2, failing here.
    const h = makeDeps({ tools: TOOLS, failUpsertOn: 1 });

    await refreshNamespace(h.deps, "github");

    // The remove ran, the upsert failed, and the retry re-ran BOTH halves of
    // the mutation — a bare upsert would leave a retired tool serving.
    expect(h.calls.map((c) => c.op)).toEqual(["remove", "upsert", "remove", "upsert"]);
    // ONE store read across the whole ladder. This is the assertion the
    // window depends on: a second read means a second suspension point.
    expect(h.listArgs).toEqual(["github"]);
    expect(h.logs.join("\n")).toContain("retrying the namespace refresh");
    expect(h.logs.join("\n")).toContain("Catalog refreshed on retry");
    // Recovered to the right contents, not merely to "no error".
    expect(h.calls.at(-1)).toEqual({
      op: "upsert",
      detail: ["github.list_issues", "github.list_releases"],
    });
  });

  it("retries the whole read-then-mutate when the READ is what failed", async () => {
    // The other rung-1 shape. A failed read removed nothing, so no window
    // was ever opened and repeating the read is both safe and necessary —
    // the read is the half that failed, and a transient store fault is the
    // case worth one retry.
    const h = makeDeps({ tools: TOOLS, failListOn: 1 });

    await refreshNamespace(h.deps, "github");

    // No catalog call at all before the retry: nothing was mutated.
    expect(h.calls.map((c) => c.op)).toEqual(["remove", "upsert"]);
    expect(h.listArgs).toEqual(["github", "github"]);
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
