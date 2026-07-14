import {
  type ConduitStore,
  createCatalogToolHost,
  createExecutionManager,
  createMcpUpstreamCaller,
  createStoreCredentialResolver,
  createStorePolicyEngine,
  createToolInvoker,
  type ExecutionManager,
  InMemoryCatalog,
  QuickJSSandbox,
} from "@conduithq/sdk";

export interface ApprovalRuntime {
  manager: ExecutionManager;
}

async function hydrateCatalog(store: ConduitStore): Promise<InMemoryCatalog> {
  const catalog = new InMemoryCatalog();
  catalog.upsert(await store.tools.list());
  return catalog;
}

/**
 * Builds the SAME manager composition previously inlined in
 * `createConduitMcpServer`'s execute handler (server.ts) — one home for the
 * §9.3 egress boundary wiring and the manager graph, shared by the /mcp
 * server and the CLI's approvals command. Callers MUST invoke this fresh per
 * unit of work (M6): a freshly-hydrated catalog snapshot per call is the
 * recorded fix for stale-connection visibility.
 */
export async function createApprovalRuntime(opts: {
  store: ConduitStore;
  allowPrivateEgress: boolean;
  log?: (line: string) => void;
}): Promise<ApprovalRuntime> {
  const { store } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const sandbox = new QuickJSSandbox();
  const policy = createStorePolicyEngine(store.policies);
  const credentials = createStoreCredentialResolver(store.secrets);
  // §9.3 EGRESS BOUNDARY — verbatim from server.ts:122-124. Default `{}` is
  // fail-closed; only an explicit `true` opts into private-address egress.
  const upstream = createMcpUpstreamCaller(
    opts.allowPrivateEgress === true ? { egress: { allowPrivate: true } } : {},
  );

  const catalog = await hydrateCatalog(store);
  const manager = createExecutionManager({
    store,
    sandbox,
    makeInvoker: ({ executionId, decisions, deadline }) =>
      createToolInvoker(
        {
          store,
          policy,
          credentials,
          upstream,
          ...(decisions !== undefined ? { decisions } : {}),
        },
        { executionId, log, ...(deadline !== undefined ? { deadline } : {}) },
      ),
    makeToolHost: (invoke) => createCatalogToolHost(catalog, invoke),
  });

  return { manager };
}
