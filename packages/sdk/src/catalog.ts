import type { JsonSchema, RiskClass, Tool } from "./types.js";

/**
 * Catalog (spec §8): the searchable index behind progressive disclosure.
 * `search` returns ranked paths with minimal metadata — never schemas; a
 * schema costs prompt tokens only when `describe` is asked for it.
 *
 * The interface is the seam (spec §20 watch-item): callers may not assume
 * any engine. InMemoryCatalog serves Phase 0; a SQLite-FTS5- or D1-backed
 * implementation must be able to replace it without touching call sites.
 */
export interface Catalog {
  /** Add or replace tools, keyed by tool name (source refresh, spec §7). */
  upsert(tools: readonly Tool[]): void;
  /** Drop every tool a namespace contributed (source removal). */
  removeNamespace(namespace: string): void;
  /** Intent search over the full catalog: ranked, minimal, schema-free. */
  search(options: SearchOptions): SearchHit[];
  /** Load one tool's details; schemas only on request (lazy, spec §8). */
  describe(path: string, options?: DescribeOptions): ToolDescription | undefined;
  readonly size: number;
}

export interface SearchOptions {
  query: string;
  limit?: number;
}

export interface SearchHit {
  /** Callable path, e.g. `github.issues.create`. */
  path: string;
  description?: string;
  riskClass: RiskClass;
  score: number;
}

export interface DescribeOptions {
  includeSchemas?: boolean;
}

export interface ToolDescription {
  path: string;
  namespace: string;
  description?: string;
  riskClass: RiskClass;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

const DEFAULT_LIMIT = 10;

/**
 * Lexical scoring, deterministic by construction: name-segment hits beat
 * name-substring hits beat description hits; ties break lexicographically.
 * Good enough for Phase 0 intent search; smarter ranking lives behind the
 * same interface.
 */
export class InMemoryCatalog implements Catalog {
  #tools = new Map<string, Tool>();

  get size(): number {
    return this.#tools.size;
  }

  upsert(tools: readonly Tool[]): void {
    for (const tool of tools) {
      this.#tools.set(tool.name, tool);
    }
  }

  removeNamespace(namespace: string): void {
    for (const [name, tool] of this.#tools) {
      if (tool.namespace === namespace) {
        this.#tools.delete(name);
      }
    }
  }

  search(options: SearchOptions): SearchHit[] {
    const tokens = tokenize(options.query);
    if (tokens.length === 0) {
      return [];
    }
    const hits: SearchHit[] = [];
    for (const tool of this.#tools.values()) {
      const score = scoreTool(tool, tokens);
      if (score > 0) {
        const hit: SearchHit = { path: tool.name, riskClass: tool.riskClass, score };
        if (tool.description !== undefined) {
          hit.description = tool.description;
        }
        hits.push(hit);
      }
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return hits.slice(0, options.limit ?? DEFAULT_LIMIT);
  }

  describe(path: string, options: DescribeOptions = {}): ToolDescription | undefined {
    const tool = this.#tools.get(path);
    if (tool === undefined) {
      return undefined;
    }
    const described: ToolDescription = {
      path: tool.name,
      namespace: tool.namespace,
      riskClass: tool.riskClass,
    };
    if (tool.description !== undefined) {
      described.description = tool.description;
    }
    if (options.includeSchemas === true) {
      described.inputSchema = tool.inputSchema;
      described.outputSchema = tool.outputSchema;
    }
    return described;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function scoreTool(tool: Tool, tokens: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const segments = name.split(/[._]/);
  const description = (tool.description ?? "").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (segments.includes(token)) {
      score += 3;
    } else if (name.includes(token)) {
      score += 2;
    }
    if (description.includes(token)) {
      score += 1;
    }
  }
  return score;
}
