import { z } from "zod";
import { PERMISSIVE_SCHEMA } from "../jsonschema.js";
import { deriveRiskClass } from "../risk.js";
import type { JsonSchema, Tool } from "../types.js";

/**
 * OpenAPI 3.x normalizer (spec §7): turns an OpenAPI document into normalized
 * Tools — { name, namespace, inputSchema, outputSchema, riskClass,
 * sourceSemantics } — the "one tool shape" of spec §4.1.
 */

export interface NormalizeOpenApiOptions {
  /** Groups and addresses the tools, e.g. "petstore" → `petstore.addPet`. */
  namespace: string;
  /** A parsed OpenAPI 3.x document. Validated structurally at this boundary. */
  document: unknown;
  /** Required when the document has no absolute `servers` entry (spec §7). */
  baseUrl?: string;
}

export interface NormalizedOpenApi {
  tools: Tool[];
  /** Resolved upstream base URL every tool call will target. */
  baseUrl: string;
}

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

// Boundary validation: just the envelope we rely on, not full OpenAPI.
const documentEnvelope = z
  .object({
    paths: z.record(z.unknown()).optional(),
    servers: z.array(z.object({ url: z.string() }).passthrough()).optional(),
  })
  .passthrough();

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSchema(value: unknown): JsonSchema {
  return isObject(value) ? value : PERMISSIVE_SCHEMA;
}

/** Resolve a local `#/…` JSON pointer against the document. */
function resolveLocalRef(doc: JsonObject, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    if (!isObject(node)) {
      return undefined;
    }
    node = node[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}

/**
 * Inline every local $ref so each tool's schemas are self-contained.
 * Cyclic and unresolvable refs collapse to the permissive schema rather than
 * failing the whole ingestion.
 */
function inlineRefs(node: unknown, doc: JsonObject, stack: readonly string[]): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => inlineRefs(item, doc, stack));
  }
  if (!isObject(node)) {
    return node;
  }
  const ref = node.$ref;
  if (typeof ref === "string") {
    if (stack.includes(ref)) {
      return PERMISSIVE_SCHEMA;
    }
    const target = resolveLocalRef(doc, ref);
    if (target === undefined) {
      return PERMISSIVE_SCHEMA;
    }
    return inlineRefs(target, doc, [...stack, ref]);
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = inlineRefs(value, doc, stack);
  }
  return out;
}

interface ParameterObject extends JsonObject {
  name: string;
  in: string;
}

function isParameter(value: unknown): value is ParameterObject {
  return isObject(value) && typeof value.name === "string" && typeof value.in === "string";
}

/** Path-level parameters apply to every operation; op-level wins on (name, in). */
function mergeParameters(pathLevel: unknown, opLevel: unknown, doc: JsonObject): ParameterObject[] {
  const merged = new Map<string, ParameterObject>();
  for (const raw of [pathLevel, opLevel]) {
    if (!Array.isArray(raw)) {
      continue;
    }
    for (const entry of raw) {
      const resolved = inlineRefs(entry, doc, []);
      if (isParameter(resolved)) {
        merged.set(`${resolved.in}:${resolved.name}`, resolved);
      }
    }
  }
  return [...merged.values()];
}

/**
 * Tool name segment: prefer operationId (slashes become dots, so GitHub-style
 * "issues/create" reads as `github.issues.create`); otherwise derive a
 * deterministic name from the method and path.
 */
function toolSegment(method: string, path: string, operationId: unknown): string {
  if (typeof operationId === "string" && operationId.length > 0) {
    return operationId.replace(/\//g, ".").replace(/[^A-Za-z0-9_.]/g, "_");
  }
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, "").replace(/[^A-Za-z0-9_]/g, "_"));
  return [method, ...segments].join("_");
}

/** One input object per call: parameters by name, request body under `body`. */
function buildInputSchema(
  parameters: ParameterObject[],
  requestBody: unknown,
  doc: JsonObject,
): JsonSchema {
  const properties: JsonObject = {};
  const required: string[] = [];

  for (const param of parameters) {
    properties[param.name] = asSchema(param.schema);
    if (param.required === true || param.in === "path") {
      required.push(param.name);
    }
  }

  const body = inlineRefs(requestBody, doc, []);
  if (isObject(body)) {
    const content = isObject(body.content) ? body.content : {};
    const json = isObject(content["application/json"]) ? content["application/json"] : undefined;
    if (json !== undefined) {
      // A parameter literally named "body" keeps its slot; the payload moves over.
      const bodyKey = "body" in properties ? "requestBody" : "body";
      properties[bodyKey] = asSchema(json.schema);
      if (body.required === true) {
        required.push(bodyKey);
      }
    }
  }

  const schema: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

/** First JSON response schema among 200/201/2XX/default; else permissive. */
function buildOutputSchema(responses: unknown, doc: JsonObject): JsonSchema {
  if (!isObject(responses)) {
    return PERMISSIVE_SCHEMA;
  }
  for (const code of ["200", "201", "2XX", "default"]) {
    const response = inlineRefs(responses[code], doc, []);
    if (!isObject(response)) {
      continue;
    }
    const content = isObject(response.content) ? response.content : {};
    const json = content["application/json"];
    if (isObject(json) && json.schema !== undefined) {
      return asSchema(json.schema);
    }
  }
  return PERMISSIVE_SCHEMA;
}

export function normalizeOpenApi(options: NormalizeOpenApiOptions): NormalizedOpenApi {
  const parsed = documentEnvelope.safeParse(options.document);
  if (!parsed.success) {
    throw new Error(
      `[normalizeOpenApi] Failed to normalize: document is not a structurally valid OpenAPI object. Context: { namespace: ${options.namespace} }`,
    );
  }
  const doc = parsed.data as JsonObject;

  const absoluteServer = parsed.data.servers?.find((server) =>
    /^https?:\/\//.test(server.url),
  );
  const baseUrl = options.baseUrl ?? absoluteServer?.url;
  if (baseUrl === undefined) {
    throw new Error(
      `[normalizeOpenApi] Failed to normalize: no absolute base URL — the document's servers entries are missing or relative, so baseUrl is required (spec §7). Context: { namespace: ${options.namespace} }`,
    );
  }

  const tools: Tool[] = [];
  const paths = isObject(doc.paths) ? doc.paths : {};

  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = inlineRefs(rawItem, doc, []);
    if (!isObject(pathItem)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) {
        continue;
      }
      const parameters = mergeParameters(pathItem.parameters, operation.parameters, doc);
      const sourceSemantics = {
        kind: "openapi",
        method: method.toUpperCase(),
        path,
      } as const;

      const tool: Tool = {
        name: `${options.namespace}.${toolSegment(method, path, operation.operationId)}`,
        namespace: options.namespace,
        inputSchema: buildInputSchema(parameters, operation.requestBody, doc),
        outputSchema: buildOutputSchema(operation.responses, doc),
        riskClass: deriveRiskClass(sourceSemantics),
        sourceSemantics,
      };
      const description = operation.summary ?? operation.description;
      if (typeof description === "string" && description.length > 0) {
        tool.description = description;
      }
      tools.push(tool);
    }
  }

  return { tools, baseUrl };
}
