import {
  type ConduitStore,
  createCatalogToolHost,
  createExecutionManager,
  createMcpUpstreamCaller,
  createScopedCatalogToolHost,
  createStoreCredentialResolver,
  createStorePolicyEngine,
  createToolInvoker,
  type ExecutionManager,
  InMemoryCatalog,
  QuickJSSandbox,
} from "@conduithq/sdk";

export interface ApprovalRuntime {
  manager: ExecutionManager;
  /**
   * The one cached piece of state in the composition (spec §2.1): policy
   * and credentials read the store live per decision, the manager is
   * store-backed, the sandbox module is process-shared with its own
   * poison/rebuild recovery. The daemon refreshes this catalog at the
   * provisioning tail; nothing else mutates it.
   */
  catalog: InMemoryCatalog;
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
 * server and the CLI's approvals command. Built ONCE per daemon process
 * (spec §2.1). The M6 per-call rehydration was the no-owner workaround;
 * the daemon's catalog is authoritative because the daemon is the only
 * writer.
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
    makeInvoker: ({
      executionId,
      decisions,
      deadline,
      upstreamSession,
      projection,
      clientId,
      scope,
      dispatch,
    }) =>
      createToolInvoker(
        {
          store,
          policy,
          credentials,
          upstream,
          ...(decisions !== undefined ? { decisions } : {}),
        },
        {
          executionId,
          log,
          // §4.3: the drive's real attribution and authority, as the manager
          // resolved them. Production rows carry `clientId: null` until Lane B
          // introduces named clients.
          projection,
          clientId,
          ...(deadline !== undefined ? { deadline } : {}),
          ...(upstreamSession !== undefined ? { upstreamSession } : {}),
          ...(scope !== undefined ? { scope } : {}),
          ...(dispatch !== undefined ? { dispatch } : {}),
        },
      ),
    // §5.4: a drive running under a resolver gets the SCOPED catalog view, so
    // in-sandbox search/describe match the per-call authority. The scoped host
    // logs resolver faults through the daemon's real logger, never console.
    makeToolHost: (invoke, scoped) =>
      scoped
        ? createScopedCatalogToolHost(catalog, invoke, scoped.scope, scoped.projection, log)
        : createCatalogToolHost(catalog, invoke),
  });

  return { manager, catalog };
}
