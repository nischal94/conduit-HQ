import { z } from "zod";
import { PERMISSIVE_SCHEMA } from "../jsonschema.js";
import { deriveRiskClass } from "../risk.js";
import type { Tool } from "../types.js";

/**
 * MCP normalizer (spec §7): turns an MCP server's `tools/list` result into
 * normalized Tools. No I/O here — the caller speaks the protocol and hands
 * over the parsed tool array, same boundary as the OpenAPI normalizer.
 */

export interface NormalizeMcpOptions {
  /** Groups and addresses the tools, e.g. "linear" → `linear.createIssue`. */
  namespace: string;
  /** The `tools` array from a `tools/list` response. */
  tools: unknown;
}

// Boundary validation: just the envelope we rely on, not the full MCP schema.
const toolEnvelope = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional(),
    annotations: z
      .object({
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const listEnvelope = z.array(toolEnvelope);

/** Same convention as OpenAPI operationIds: slashes read as path dots. */
function toolSegment(name: string): string {
  return name.replace(/\//g, ".").replace(/[^A-Za-z0-9_.]/g, "_");
}

export function normalizeMcp(options: NormalizeMcpOptions): Tool[] {
  const parsed = listEnvelope.safeParse(options.tools);
  if (!parsed.success) {
    throw new Error(
      `[normalizeMcp] Failed to normalize: payload is not a structurally valid tools/list result. Context: { namespace: ${options.namespace} }`,
    );
  }

  const tools: Tool[] = [];
  const seen = new Set<string>();

  for (const entry of parsed.data) {
    const name = `${options.namespace}.${toolSegment(entry.name)}`;
    if (seen.has(name)) {
      // Two upstream tools collapsing onto one name would make policy
      // (keyed by tool name, spec §7) ambiguous — refuse rather than guess.
      throw new Error(
        `[normalizeMcp] Failed to normalize: duplicate tool name after namespacing. Context: { namespace: ${options.namespace}, name: ${name} }`,
      );
    }
    seen.add(name);

    // Annotations are untrusted hints (MCP spec's own words), so only
    // explicit values reach the classifier. An absent hint means "unknown"
    // → review (spec §10.1); note MCP's schema documents destructiveHint as
    // defaulting to true, but review and destructive land on the same
    // require-approval policy default (§10.2), so ignoring the implicit
    // default loses no safety — only label precision.
    const semantics: {
      kind: "mcp";
      upstreamName?: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
    } = {
      kind: "mcp",
      // Raw upstream wire name recorded at normalize time (C5 design D4);
      // absent on legacy rows → serve-time falls back to prefix-strip.
      upstreamName: entry.name,
    };
    const readOnlyHint = entry.annotations?.readOnlyHint;
    if (readOnlyHint !== undefined) {
      semantics.readOnlyHint = readOnlyHint;
    }
    const destructiveHint = entry.annotations?.destructiveHint;
    if (destructiveHint !== undefined) {
      semantics.destructiveHint = destructiveHint;
    }

    const tool: Tool = {
      name,
      namespace: options.namespace,
      inputSchema: entry.inputSchema ?? PERMISSIVE_SCHEMA,
      outputSchema: entry.outputSchema ?? PERMISSIVE_SCHEMA,
      riskClass: deriveRiskClass(semantics),
      sourceSemantics: semantics,
    };
    if (entry.description !== undefined && entry.description.length > 0) {
      tool.description = entry.description;
    }
    tools.push(tool);
  }

  return tools;
}
