#!/usr/bin/env node

// Bundled demo upstream for the §4.2 token demo (design 2026-07-13, D2/D6).
// Serves a deterministic catalog of exactly 800 realistic tool schemas over
// the same bare JSON-RPC POST tools/list shape fetchToolsList
// (packages/cli/src/mcp-fetch.ts) and scripts/seed-demo.mjs speak. No MCP
// SDK, no sessions, no other methods — this is demo scaffolding, not a
// product surface.
//
// Usage: node scripts/token-demo-upstream.mjs
// stdout: NOTHING, ever.
// stderr: "PORT=<n>" once listening (scraped by scripts/token-demo.mjs).
//
// Determinism (design D5): the catalog is a pure function of the template
// tables below — no RNG, no time. Re-runs serve byte-identical definitions.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const CATALOG_SIZE = 800;

const STR = (description) => ({ type: "string", description });
const INT = (description) => ({ type: "integer", description });
const BOOL = (description) => ({ type: "boolean", description });

const plural = (resource) => (resource.endsWith("s") ? resource : `${resource}s`);
const human = (resource) => resource.replace(/_/g, " ");

// 4 families x 20 resources x 10 verbs = 800 tools, sized to land near the
// ~174 tokens/tool density the spec's own 1,600 ≈ 278,800 figure implies.
// (First measured run landed at ~166.8 tokens/tool — close enough to the
// calibration target that the demo's honesty rules hold without retuning.)
const FAMILIES = [
  {
    service: "github",
    context: "the GitHub REST API",
    scope: "repository",
    resources: [
      "repo",
      "issue",
      "pull_request",
      "branch",
      "commit_status",
      "release",
      "workflow",
      "workflow_run",
      "deployment",
      "gist",
      "label",
      "milestone",
      "project_board",
      "team",
      "webhook",
      "check_run",
      "code_scanning_alert",
      "dependabot_alert",
      "environment",
      "tag_protection",
    ],
  },
  {
    service: "stripe",
    context: "the Stripe payments API",
    scope: "account",
    resources: [
      "customer",
      "charge",
      "payment_intent",
      "invoice",
      "subscription",
      "refund",
      "payout",
      "product",
      "price",
      "coupon",
      "dispute",
      "balance_transaction",
      "transfer",
      "setup_intent",
      "payment_method",
      "credit_note",
      "tax_rate",
      "webhook_endpoint",
      "checkout_session",
      "quote",
    ],
  },
  {
    service: "jira",
    context: "the Jira Cloud REST API",
    scope: "project",
    resources: [
      "issue",
      "epic",
      "sprint",
      "board",
      "backlog_item",
      "component",
      "version",
      "worklog",
      "comment",
      "attachment",
      "filter",
      "dashboard",
      "field_config",
      "workflow_scheme",
      "permission_scheme",
      "issue_type",
      "project_role",
      "screen",
      "status",
      "audit_record",
    ],
  },
  {
    service: "sentry",
    context: "the Sentry monitoring API",
    scope: "organization",
    resources: [
      "project",
      "issue_group",
      "event",
      "release",
      "alert_rule",
      "metric_alert",
      "dashboard",
      "team",
      "member",
      "monitor",
      "replay",
      "source_map",
      "dsym_file",
      "integration",
      "service_hook",
      "environment",
      "session",
      "span",
      "profile",
      "crons_checkin",
    ],
  },
];

const VERBS = [
  {
    verb: "list",
    description: (r, f) =>
      `List ${plural(human(r))} visible to the authenticated principal in ${f.context}, newest first. Supports cursor pagination and server-side filtering by lifecycle state.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} whose ${plural(human(r))} to list.`),
      cursor: STR("Opaque pagination cursor returned by a previous page."),
      per_page: INT("Page size between 1 and 100. Defaults to 30."),
      state: STR(`Lifecycle filter for ${plural(human(r))}: open, closed, or all.`),
    }),
    required: (_r, f) => [`${f.scope}_id`],
  },
  {
    verb: "get",
    description: (r, f) =>
      `Fetch a single ${human(r)} by identifier from ${f.context}, including its full metadata and relationship references.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the ${human(r)} to fetch.`),
      include_deleted: BOOL(`Whether a soft-deleted ${human(r)} may be returned.`),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`],
  },
  {
    verb: "search",
    description: (r, f) =>
      `Search ${plural(human(r))} in ${f.context} with a free-text query plus structured filters. Results are relevance-ranked and cursor-paginated.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} to scope the search to.`),
      query: STR(`Free-text search query matched against ${human(r)} titles and bodies.`),
      created_after: STR("ISO 8601 lower bound on creation time."),
      cursor: STR("Opaque pagination cursor returned by a previous page."),
      per_page: INT("Page size between 1 and 100. Defaults to 30."),
    }),
    required: (_r, f) => [`${f.scope}_id`, "query"],
  },
  {
    verb: "create",
    description: (r, f) =>
      `Create a new ${human(r)} in ${f.context}. Returns the created ${human(r)} with its server-assigned identifier.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} to create the ${human(r)} in.`),
      name: STR(`Human-readable name for the new ${human(r)}.`),
      description: STR(`Longer free-text description of the ${human(r)}.`),
      metadata: STR("JSON-encoded key/value metadata attached to the resource."),
    }),
    required: (_r, f) => [`${f.scope}_id`, "name"],
  },
  {
    verb: "update",
    description: (r, f) =>
      `Update mutable fields of an existing ${human(r)} in ${f.context}. Only the provided fields change; omitted fields keep their values.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the ${human(r)} to update.`),
      name: STR(`New human-readable name for the ${human(r)}.`),
      description: STR(`New free-text description of the ${human(r)}.`),
      expected_version: INT("Optimistic-concurrency version the update must match."),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`],
  },
  {
    verb: "delete",
    description: (r, f) =>
      `Permanently delete a ${human(r)} from ${f.context}. This operation cannot be undone; dependent resources are detached.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the ${human(r)} to delete.`),
      confirm: BOOL("Must be true to acknowledge the deletion is permanent."),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`, "confirm"],
  },
  {
    verb: "archive",
    description: (r, f) =>
      `Archive a ${human(r)} in ${f.context}, hiding it from default listings while preserving its history for audit.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the ${human(r)} to archive.`),
      reason: STR("Optional operator note recorded with the archive action."),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`],
  },
  {
    verb: "restore",
    description: (r, f) =>
      `Restore a previously archived ${human(r)} in ${f.context} back to its active state, reattaching it to default listings.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the archived ${human(r)} to restore.`),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`],
  },
  {
    verb: "export",
    description: (r, f) =>
      `Start an asynchronous export of ${plural(human(r))} from ${f.context} to a downloadable file. Returns a job reference to poll.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} whose ${plural(human(r))} to export.`),
      format: STR("Output format: csv or json."),
      created_after: STR("ISO 8601 lower bound on creation time."),
      notify_email: STR("Email address notified when the export completes."),
    }),
    required: (_r, f) => [`${f.scope}_id`, "format"],
  },
  {
    verb: "subscribe",
    description: (r, f) =>
      `Subscribe a callback URL to change events for ${plural(human(r))} in ${f.context}. Events are delivered as signed JSON webhooks.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(
        `Identifier of the ${f.scope} whose ${human(r)} events to subscribe to.`,
      ),
      callback_url: STR("HTTPS URL that will receive the signed event payloads."),
      events: STR(
        `Comma-separated ${human(r)} event types to deliver (created, updated, deleted).`,
      ),
      secret_hint: STR("Label of the signing secret to use for payload signatures."),
    }),
    required: (_r, f) => [`${f.scope}_id`, "callback_url"],
  },
];

export function buildCatalog() {
  const tools = [];
  for (const family of FAMILIES) {
    for (const resource of family.resources) {
      for (const template of VERBS) {
        tools.push({
          name: `${family.service}_${template.verb}_${resource}`,
          description: template.description(resource, family),
          inputSchema: {
            type: "object",
            properties: template.params(resource, family),
            required: template.required(resource, family),
            additionalProperties: false,
          },
        });
      }
    }
  }
  if (tools.length !== CATALOG_SIZE) {
    throw new Error(
      `[token-demo-upstream] catalog builder produced ${tools.length} tools, expected ${CATALOG_SIZE}`,
    );
  }
  return tools;
}

// Serve only when run directly (buildCatalog stays importable for checks).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = buildCatalog();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let id = null;
      let method;
      try {
        const parsed = JSON.parse(body);
        id = parsed?.id ?? null;
        method = parsed?.method;
      } catch (error) {
        process.stderr.write(
          `[token-demo-upstream] malformed request body: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        method = undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method !== "POST" || method !== "tools/list") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "only POST tools/list is served here" },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: catalog } }));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    process.stderr.write(`PORT=${server.address().port}\n`);
  });
}
