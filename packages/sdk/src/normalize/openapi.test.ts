import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../types.js";
import { normalizeOpenApi } from "./openapi.js";

/** Mini petstore exercising refs, cycles, path-level params, and naming. */
const fixture = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.example.com/v1" }],
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          // Deliberate cycle: Pet → Pet.
          friend: { $ref: "#/components/schemas/Pet" },
        },
        required: ["name"],
      },
    },
    parameters: {
      PetId: { name: "petId", in: "path", required: true, schema: { type: "integer" } },
    },
  },
  paths: {
    "/pets/{petId}": {
      parameters: [{ $ref: "#/components/parameters/PetId" }],
      get: {
        operationId: "pets/getById",
        summary: "Fetch a pet",
        responses: {
          "200": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
      delete: {
        operationId: "deletePet",
        responses: { "204": { description: "gone" } },
      },
    },
    "/pets": {
      post: {
        operationId: "addPet",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
          },
        },
        responses: {},
      },
      get: { responses: {} },
    },
  },
};

function normalized() {
  return normalizeOpenApi({ namespace: "petstore", document: fixture });
}

function toolByName(name: string) {
  const tool = normalized().tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`fixture tool not found: ${name}`);
  }
  return tool;
}

function property(schema: JsonSchema, key: string): JsonSchema {
  const value = (schema.properties as Record<string, JsonSchema>)[key];
  if (value === undefined) {
    throw new Error(`fixture schema property not found: ${key}`);
  }
  return value;
}

describe("normalizeOpenApi", () => {
  describe("tool naming", () => {
    it("produces one tool per operation", () => {
      expect(normalized().tools).toHaveLength(4);
    });

    it("namespaces operationIds and converts slashes to dots", () => {
      expect(normalized().tools.map((t) => t.name)).toContain("petstore.pets.getById");
    });

    it("derives a deterministic name when operationId is missing", () => {
      expect(normalized().tools.map((t) => t.name)).toContain("petstore.get_pets");
    });
  });

  describe("risk classification", () => {
    it("classifies GET as safe, POST as review, DELETE as destructive", () => {
      expect(toolByName("petstore.pets.getById").riskClass).toBe("safe");
      expect(toolByName("petstore.addPet").riskClass).toBe("review");
      expect(toolByName("petstore.deletePet").riskClass).toBe("destructive");
    });
  });

  describe("input schema", () => {
    it("includes path-level $ref parameters as required properties", () => {
      const schema = toolByName("petstore.deletePet").inputSchema;
      expect(schema.properties).toHaveProperty("petId", { type: "integer" });
      expect(schema.required).toContain("petId");
    });

    it("mounts a required request body under `body` with refs inlined", () => {
      const schema = toolByName("petstore.addPet").inputSchema;
      const body = property(schema, "body");
      expect(schema.required).toContain("body");
      expect(body.required).toEqual(["name"]);
      expect(body.properties).toHaveProperty("name", { type: "string" });
    });

    it("collapses cyclic refs to the permissive schema instead of failing", () => {
      const body = property(toolByName("petstore.addPet").inputSchema, "body");
      expect(property(body, "friend")).toEqual({});
    });
  });

  describe("output schema", () => {
    it("inlines the JSON response schema when declared", () => {
      const schema = toolByName("petstore.pets.getById").outputSchema;
      expect(schema.properties).toHaveProperty("name", { type: "string" });
    });

    it("falls back to the permissive schema when none is declared", () => {
      expect(toolByName("petstore.deletePet").outputSchema).toEqual({});
      expect(toolByName("petstore.addPet").outputSchema).toEqual({});
    });
  });

  describe("descriptions and semantics", () => {
    it("carries the operation summary and source semantics", () => {
      const tool = toolByName("petstore.pets.getById");
      expect(tool.description).toBe("Fetch a pet");
      expect(tool.sourceSemantics).toEqual({
        kind: "openapi",
        method: "GET",
        path: "/pets/{petId}",
      });
    });
  });

  describe("base URL resolution", () => {
    it("uses the document's absolute servers entry", () => {
      expect(normalized().baseUrl).toBe("https://api.example.com/v1");
    });

    it("prefers an explicit baseUrl over the document", () => {
      const result = normalizeOpenApi({
        namespace: "petstore",
        document: fixture,
        baseUrl: "https://staging.example.com",
      });
      expect(result.baseUrl).toBe("https://staging.example.com");
    });

    it("throws when servers are relative and no baseUrl is given", () => {
      const relative = { ...fixture, servers: [{ url: "/v1" }] };
      expect(() => normalizeOpenApi({ namespace: "petstore", document: relative })).toThrow(
        /no absolute base URL/,
      );
    });

    it("rejects a document that is not structurally OpenAPI", () => {
      expect(() => normalizeOpenApi({ namespace: "x", document: "not a doc" })).toThrow(
        /not a structurally valid OpenAPI object/,
      );
    });
  });
});
