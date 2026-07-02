import type { Catalog } from "./catalog.js";
import type { ToolHost } from "./sandbox/sandbox.js";
import type { JsonSchema } from "./types.js";

/**
 * The `execute` tool (spec §6): the only tool any client ever sees.
 * Progressive disclosure (spec §4.2) lives or dies on this surface
 * staying small — the whole catalog hides behind it, schemas load only
 * on demand, and the serialized definition must fit the ~1,044-token
 * budget the spec promises ("thousands of tools, no bloat").
 */
export interface ExecuteToolDefinition {
  name: "execute";
  description: string;
  inputSchema: JsonSchema;
}

/** One line of the §6 connection listing surfaced in the description. */
export interface ConnectionListing {
  /** Addressing prefix, e.g. `github.org.main`. */
  prefix: string;
  /** Human label, e.g. `Production GitHub`. */
  label: string;
}

export interface BuildExecuteToolOptions {
  /** Configured connections to advertise; may be empty before onboarding. */
  connections: readonly ConnectionListing[];
}

/**
 * Build the `execute` tool definition. The description carries the §6
 * 4-step workflow, the §8 search guidance (concrete nouns/verbs, retry
 * with synonyms), and the available connection prefixes — everything the
 * model gets up front; all else is discovered from inside the sandbox.
 */
export function buildExecuteTool(options: BuildExecuteToolOptions): ExecuteToolDefinition {
  const connectionLines =
    options.connections.length > 0
      ? options.connections.map((c) => `- ${c.prefix} : ${c.label}`).join("\n")
      : "- (none configured yet)";

  const description = `Execute TypeScript in a sandboxed runtime with access to configured API tools.

Workflow:
1. const { items } = await tools.search({ query })  // discover tools by intent
2. const path = items[0]?.path                      // pick a tool
3. const details = await tools.describe.tool({ path, includeSchemas: true })  // load its schemas (lazy)
4. const result = await tools[path](input)          // call it

Typed direct calls work once a path is known, e.g. await tools.github.issues.list({ owner, repo }).
Search with concrete nouns and verbs ("create issue", "refund charge"); if results are empty, retry with synonyms.
Your code runs as an async function body; its return value is the execution result.

Available connections:
${connectionLines}`;

  return {
    name: "execute",
    description,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "TypeScript source, run as an async function body in the sandbox. Use the tools.* API; return the result.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  };
}

/**
 * Rough token count for budget checks (spec §4.2): the ~4-chars-per-token
 * heuristic, biased upward by ceiling. Good enough to catch description
 * bloat in CI without shipping a tokenizer.
 */
export function estimateTokens(definition: ExecuteToolDefinition): number {
  return Math.ceil(JSON.stringify(definition).length / 4);
}

/**
 * What the §5.3 pipeline will be: resolve connection, enforce policy,
 * attach credentials host-side, call upstream, record Trace. Phase 0
 * injects it as a callback so the sandbox and catalog land without
 * policy/credentials growing into the sandbox's vocabulary (spec §9.2).
 */
export type ToolInvoker = (path: string, input: unknown) => Promise<unknown>;

/**
 * The catalog-backed ToolHost: search/describe answered locally from the
 * Catalog (reads, no policy), invocation delegated to the pipeline.
 */
export function createCatalogToolHost(catalog: Catalog, invoke: ToolInvoker): ToolHost {
  return {
    search: async (options) => catalog.search(options),
    describe: async (path, options) => catalog.describe(path, options),
    call: (path, input) => invoke(path, input),
  };
}
