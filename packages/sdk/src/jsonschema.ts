import type { JsonSchema } from "./types.js";

/**
 * Empty JSON Schema: matches any value. The spec §7 fallback whenever a
 * source declares no schema — the "one tool shape" stays uniform without
 * over-claiming validation. Frozen because every tool that lacks a schema
 * shares this one instance.
 */
export const PERMISSIVE_SCHEMA: JsonSchema = Object.freeze({});
