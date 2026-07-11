import { type ConduitStore, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createApprovalRuntime } from "./runtime.js";

/**
 * Proves the composition wired by `createApprovalRuntime` is reachable:
 * sandbox executes, manager reaches a terminal outcome. Mirrors
 * server.test.ts's store fixture (in-memory libsql + SecretBox).
 */

async function seedStore(): Promise<ConduitStore> {
  const client = createClient({ url: ":memory:" });
  return openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
  });
}

describe("createApprovalRuntime", () => {
  it("returns { manager } and the manager runs trivial code to a terminal outcome", async () => {
    const store = await seedStore();
    const runtime = await createApprovalRuntime({ store, allowPrivateEgress: false });
    expect(runtime.manager).toBeDefined();

    const outcome = await runtime.manager.start("return 42;");
    expect(outcome.status).toBe("completed");
    expect((outcome as { value: unknown }).value).toBe(42);
  });
});
