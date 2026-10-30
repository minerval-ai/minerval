/**
 * MCP ↔ REST parity (docs/mcp.md, "Parity with the REST API").
 *
 * The rule: anything a caller can do through the REST API, an MCP client can
 * do too, unless there is a stated reason it should not. Every REST route
 * therefore sits in exactly one of three tables below:
 *
 *   ROUTE_TOOLS         exposed as an MCP tool generated from the route
 *   NATIVE_TOOL_ROUTES  covered by a hand-written tool in server.ts
 *   MCP_EXCLUDED_ROUTES deliberately not on MCP, with the reason
 *
 * tests/unit/mcp/parity.test.ts builds the full app and fails when a route is
 * in none of them (or a table names a route that no longer exists), so a new
 * route cannot reach REST alone by accident: adding one means choosing.
 *
 * A generated tool takes its input schema (the route's params, querystring,
 * and body, merged) and its description (the route's summary) from the
 * route, and runs by dispatching into the route in-process (dispatch.ts), so
 * guards, owl charges, and validation are the route's own.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestAuth } from "../server/plugins/auth.js";
import { routeKey, type CatalogRoute } from "../server/plugins/route-catalog.js";
import { dispatchToRoute } from "./dispatch.js";

export interface RouteTool {
  name: string;
  /** Added after the route's summary: what an agent should know first. */
  note?: string;
}

const SPENDS_OWLS =
  "Spends owls from your balance; get_account shows the balance and the cap on each operation.";
const ESCROWS_OWLS =
  "Escrows owls from your balance now; unspent owls refund on completion or cancellation.";

export const ROUTE_TOOLS: Record<string, RouteTool> = {
  // ---- claims ----
  "GET /claims": { name: "list_claims" },
  "GET /claims/:claim_id/citation": { name: "cite_claim" },
  "GET /claims/:claim_id/provenance": { name: "get_claim_provenance" },
  "GET /claims/:claim_id/nanopub": { name: "export_claim_nanopub" },
  "GET /claims/:claim_id/record": { name: "get_claim_record" },
  "GET /claims/:claim_id/assessments": { name: "get_assessment_history" },
  "GET /claims/:claim_id/assessments/trajectory": {
    name: "get_assessment_trajectory",
  },
  "GET /claims/:claim_id/events": { name: "get_claim_events" },
  "POST /claims/propose": {
    name: "propose_claim",
    note:
      "The proposal is reviewed by the Contribution Reviewer before anything " +
      "enters the graph; track it with get_contribution_status. " +
      SPENDS_OWLS +
      " A rejected good-faith proposal refunds.",
  },

  // ---- funding work on claims ----
  "POST /claims/:claim_id/order": { name: "order_assessment", note: SPENDS_OWLS },
  "POST /claims/:claim_id/contribute": {
    name: "fund_claim_assessment",
    note: ESCROWS_OWLS,
  },
  "POST /claims/:claim_id/decompose": {
    name: "fund_deep_decomposition",
    note: ESCROWS_OWLS,
  },
  "GET /orders": { name: "list_orders" },
  "GET /orders/:id": { name: "get_order" },
  "DELETE /orders/:id": { name: "cancel_order" },
  "GET /budget-jobs": { name: "list_budget_jobs" },
  "GET /budget-jobs/:id": { name: "get_budget_job" },
  "POST /budget-jobs/:id/topup": { name: "top_up_budget_job", note: ESCROWS_OWLS },
  "POST /budget-jobs/:id/cancel": { name: "cancel_budget_job" },

  // ---- grants and mandates ----
  "POST /grant-conversations": { name: "start_grant_conversation" },
  "GET /grant-conversations": { name: "list_grant_conversations" },
  "GET /grant-conversations/:id": { name: "get_grant_conversation" },
  "GET /grant-conversations/platform/:id": {
    name: "get_platform_grant_conversation",
  },
  "POST /grant-conversations/:id/messages": { name: "send_grant_message" },
  "POST /grant-conversations/:id/fund": { name: "fund_grant", note: ESCROWS_OWLS },
  "GET /grants": { name: "list_grants" },
  "GET /grants/:id": { name: "get_grant" },
  "POST /grants/:id/approve": { name: "approve_grant_plan" },
  "POST /grants/:id/topup": { name: "top_up_grant", note: ESCROWS_OWLS },
  "POST /grants/:id/cancel": { name: "cancel_grant" },
  "GET /mandates": { name: "list_mandates" },
  "GET /mandates/:id": { name: "get_mandate" },
  "GET /mandates/:id/allocation": { name: "get_mandate_allocation" },
  "POST /mandates/:id/contribute": { name: "fund_mandate", note: ESCROWS_OWLS },
  "GET /mandates/:id/lookouts/:lookoutId": { name: "get_mandate_lookout" },

  // ---- sources ----
  "POST /sources": {
    name: "submit_source",
    note:
      "The submission is reviewed before any extraction runs; track it with " +
      "get_contribution_status. " +
      SPENDS_OWLS,
  },
  "GET /sources/:source_id": { name: "get_source" },
  "GET /sources/:source_id/context": { name: "get_source_context" },
  "GET /sources/:source_id/examinations": { name: "get_source_examinations" },
  "GET /sources/:source_id/document": { name: "get_source_document" },
  "GET /jobs/:job_id": { name: "get_job" },

  // ---- contributions, appeals, contributors ----
  "GET /contributions": { name: "list_contributions" },
  "POST /appeals": { name: "submit_appeal" },
  "GET /appeals/:id": { name: "get_appeal" },
  "GET /contributors": { name: "list_contributors" },
  "GET /contributors/:id": { name: "get_contributor" },

  // ---- your account ----
  "GET /users/me": { name: "get_account" },
  "GET /usage": { name: "get_usage" },
  "GET /billing/packs": { name: "list_owl_packs" },
  "GET /billing/ledger": { name: "get_owl_ledger" },
  "GET /api-keys": { name: "list_api_keys" },

  // ---- requests: work that would improve what the graph knows ----
  "GET /requests": { name: "list_requests" },
  "GET /requests/:request_id": { name: "get_request" },
  "POST /requests/:request_id/contribute": { name: "fund_request_work", note: ESCROWS_OWLS },

  // ---- tags, findings, platform health ----
  "GET /tags/:slug": { name: "get_tag" },
  "GET /findings": { name: "list_findings" },
  "GET /findings/:id": { name: "get_finding" },
  "GET /consistency": { name: "get_consistency_record" },
  "GET /queue": { name: "get_queue" },
  "GET /monitors": { name: "list_monitors" },
  "GET /monitors/:signal": { name: "get_monitor" },

  // ---- formal mathematics, solver attempts, prizes ----
  "GET /claims/:claim_id/formalization.lean": { name: "get_formalization_lean" },
  "GET /claims/:claim_id/formalizations": { name: "list_formalizations" },
  "GET /lean-checks/:id": { name: "get_lean_check" },
  "GET /claims/:id/attempts": { name: "list_solver_attempts" },
  "GET /attempts/stats": { name: "get_attempt_stats" },
  "GET /attempts/:id": { name: "get_solver_attempt" },
  "GET /prizes": { name: "list_prizes" },
  "GET /prizes/rules": { name: "get_prize_rules" },
  "GET /prizes/rules/:version": { name: "get_prize_rules_version" },
  "GET /claims/:id/prize-claims": { name: "list_prize_claims" },
  "GET /claims/:id/prize-claims/eligibility": {
    name: "get_prize_claim_eligibility",
  },
  "GET /prize-claims/:id": { name: "get_prize_claim" },
  "POST /prize-claims/:id/challenge": { name: "challenge_prize_claim" },
};

/** Routes a hand-written tool in server.ts already covers. */
export const NATIVE_TOOL_ROUTES: Record<string, string[]> = {
  "GET /claims/search/:query": ["search_claims"],
  "GET /claims/:claim_id": ["get_claim", "get_decomposition"],
  "GET /claims/:claim_id/dependents": ["get_dependents"],
  "GET /claims/:claim_id/formalization": ["get_claim"],
  "GET /claims/:id/bounty": ["get_bounty_terms"],
  "GET /tags": ["list_tags"],
  "POST /contributions": ["submit_contribution"],
  "GET /contributions/:id": ["get_contribution_status"],
};

const SERVICE_ONLY =
  "First-party tooling: requires a service key, which the web tier and " +
  "internal jobs hold. Not an affordance of any account.";
const OPERATOR_ONLY =
  "Moves platform or prize money: requires the operator key, which is held " +
  "outside every deployment surface on purpose (docs/accounts.md).";
const SESSION_ONLY =
  "Requires a signed-in dashboard session, so that a leaked key (an MCP " +
  "credential included) can never mint keys or start a purchase.";
const PRIZE_FILING =
  "Filing and pursuing a prize claim carries declarations, a residency " +
  "statement, and a rules version a person must read and make, plus " +
  "documents and one-time codes sent to the owner's session; deferred until " +
  "the first prize has been paid (docs/mcp.md).";

/** Routes deliberately not on MCP, each with its reason. */
export const MCP_EXCLUDED_ROUTES: Record<string, string> = {
  "GET /health": "A load-balancer liveness probe, not an affordance.",
  "PATCH /claims/:claim_id":
    "Writes an argument straight onto a claim without review. MCP's " +
    "governed path is submit_contribution with contribution_type " +
    "'argument', which goes through the Contribution Reviewer.",

  "POST /users/provision": SERVICE_ONLY,
  "GET /usage/allocation": SERVICE_ONLY,
  "GET /usage/system": SERVICE_ONLY,
  "GET /reports": SERVICE_ONLY + " (raise_issue is the MCP side of reports.)",
  "GET /reports/:id": SERVICE_ONLY,
  "PATCH /reports/:id": SERVICE_ONLY,
  "PATCH /findings/:id": SERVICE_ONLY,
  "POST /admin/attempts/:id/cancel": SERVICE_ONLY,
  "POST /grants":
    SERVICE_ONLY +
    " Accounts create grants through the Grantmaker conversation " +
    "(start_grant_conversation), never by direct form.",

  "POST /api-keys": SESSION_ONLY,
  "DELETE /api-keys/:key_id": SESSION_ONLY,
  "POST /billing/checkout": SESSION_ONLY,
  "POST /billing/webhook": "Stripe's signature-verified callback, not a caller surface.",

  "POST /operator/platform-mandates/fund": OPERATOR_ONLY,
  "POST /operator/platform-grantmaking-keys": OPERATOR_ONLY,
  "GET /operator/platform-grantmaking-keys": OPERATOR_ONLY,
  "DELETE /operator/platform-grantmaking-keys/:id": OPERATOR_ONLY,
  "GET /operator/prizes": OPERATOR_ONLY,
  "POST /bounties/:id/confirm": OPERATOR_ONLY,
  "POST /prize-claims/:id/sign-off": OPERATOR_ONLY,
  "POST /prize-claims/:id/void": OPERATOR_ONLY,
  "POST /prize-claims/:id/screening": OPERATOR_ONLY,
  "POST /prize-claims/:id/pay": OPERATOR_ONLY,
  "POST /prize-claims/:id/retry-check": OPERATOR_ONLY,

  "POST /claims/:claim_id/prize-claims": PRIZE_FILING,
  "POST /prize-claims/:id/attachments": PRIZE_FILING,
  "POST /prize-claims/:id/code": PRIZE_FILING,
  "POST /prize-claims/:id/withdraw": PRIZE_FILING,
  "POST /prize-claims/:id/payee": PRIZE_FILING,
  "GET /attachments/:id":
    "Serves document bodies (PDF tax forms and the like); an MCP tool " +
    "result is text. Attachment metadata comes with get_prize_claim.",
  "GET /prizes.atom": "The Atom feed rendering of list_prizes.",

  "POST /extension/analyze":
    "The browser extension's page protocol (content hashing, polling, " +
    "sharing by URL hash); assess_text and extract_claims are the MCP " +
    "equivalents for text an agent holds.",
  "GET /extension/analysis/:content_hash": "Polls POST /extension/analyze; see it.",
  "GET /extension/shared": "Part of the extension's page protocol; see POST /extension/analyze.",
  "GET /extension/shared/:url_hash": "Part of the extension's page protocol; see POST /extension/analyze.",
  "POST /extension/chat":
    "The extension's chat over the page open in the browser; an MCP client " +
    "is itself the conversation, with the graph tools in hand.",
};

/** Whole route families excluded by prefix, each with its reason. */
export const MCP_EXCLUDED_PREFIXES: Record<string, string> = {
  "/mcp": "The MCP endpoint itself.",
  "/oauth/": "The OAuth authorization server that issues MCP credentials.",
  "/.well-known/": "OAuth discovery metadata for MCP clients.",
};

// ---- tool generation --------------------------------------------------------

type JsonSchemaObject = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
};

interface RouteInput {
  schema: z.ZodObject;
  params: string[];
  query: string[];
  body: string[] | null;
}

const inputCache = new WeakMap<CatalogRoute, RouteInput>();

/**
 * One input object for the tool: the route's params, querystring, and body
 * properties merged, with each name remembered by where it goes back. The
 * three never share a name on an exposed route (the parity test checks).
 */
export function routeInput(route: CatalogRoute): RouteInput {
  const cached = inputCache.get(route);
  if (cached) return cached;

  const part = (s: unknown) => (s ?? {}) as JsonSchemaObject;
  const params = part(route.schema?.params);
  const query = part(route.schema?.querystring);
  const body = route.schema?.body ? part(route.schema.body) : null;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const section of [params, query, body ?? {}]) {
    for (const [name, prop] of Object.entries(section.properties ?? {})) {
      if (name in properties) {
        throw new Error(
          `${routeKey(route.method, route.url)}: input "${name}" appears in ` +
            `more than one of params, querystring, and body`
        );
      }
      properties[name] = prop;
    }
    required.push(...(section.required ?? []));
  }
  // Path params are always required, whether or not the schema says so.
  for (const name of Object.keys(params.properties ?? {})) {
    if (!required.includes(name)) required.push(name);
  }

  const schema = z.fromJSONSchema({
    type: "object",
    properties,
    required,
  } as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;

  const input: RouteInput = {
    schema,
    params: Object.keys(params.properties ?? {}),
    query: Object.keys(query.properties ?? {}),
    body: body ? Object.keys(body.properties ?? {}) : null,
  };
  inputCache.set(route, input);
  return input;
}

function toolDescription(route: CatalogRoute, tool: RouteTool): string {
  const schema = route.schema as
    | { summary?: string; description?: string }
    | undefined;
  return [
    schema?.summary,
    schema?.description,
    tool.note,
    `Same operation as the REST API's ${route.method} ${route.url}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function toolResult(statusCode: number, contentType: string, raw: string): CallToolResult {
  let parsed: unknown = undefined;
  if (contentType.includes("json") && raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }

  if (statusCode >= 200 && statusCode < 300) {
    const text =
      parsed !== undefined
        ? JSON.stringify(parsed, null, 2)
        : raw.length > 0
          ? raw
          : JSON.stringify({ ok: true });
    return { content: [{ type: "text", text }] };
  }

  // Routes answer errors as {error: "message", code} or as {error: {code,
  // message}}; either way the tool error keeps the code, the message, and
  // anything else the route sent (an entitlement, the owl packs, a cap).
  const body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const { error, code, message, ...rest } = body;
  const nested =
    error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: (nested?.code ?? code ?? `HTTP_${statusCode}`) as string,
            message: (nested?.message ??
              (typeof error === "string" ? error : undefined) ??
              message ??
              (raw.length > 0 && parsed === undefined ? raw : undefined) ??
              `Request failed with status ${statusCode}`) as string,
            status: statusCode,
            ...rest,
          },
        }),
      },
    ],
  };
}

/** Register a tool for every catalog route that ROUTE_TOOLS names. */
export function registerRouteTools(
  server: McpServer,
  app: FastifyInstance,
  auth: RequestAuth
): void {
  for (const route of app.routeCatalog ?? []) {
    const tool = ROUTE_TOOLS[routeKey(route.method, route.url)];
    if (!tool) continue;
    const input = routeInput(route);

    server.registerTool(
      tool.name,
      {
        title: (route.schema as { summary?: string } | undefined)?.summary,
        description: toolDescription(route, tool),
        inputSchema: input.schema,
        annotations: { readOnlyHint: route.method === "GET" },
      },
      async (args: Record<string, unknown>) => {
        let url = route.url;
        for (const name of input.params) {
          url = url.replace(
            new RegExp(`:${name}(?=[/.]|$)`),
            encodeURIComponent(String(args[name]))
          );
        }
        const query: Record<string, string | string[]> = {};
        for (const name of input.query) {
          const value = args[name];
          if (value === undefined || value === null) continue;
          query[name] = Array.isArray(value) ? value.map(String) : String(value);
        }
        let body: Record<string, unknown> | undefined;
        if (input.body) {
          body = {};
          for (const name of input.body) {
            if (args[name] !== undefined) body[name] = args[name];
          }
        }

        const response = await dispatchToRoute(app, auth, {
          method: route.method,
          url,
          query,
          body,
        });
        return toolResult(response.statusCode, response.contentType, response.body);
      }
    );
  }
}
