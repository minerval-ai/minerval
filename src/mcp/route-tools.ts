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
 * The tables decide every route the product has. A deployment that switches
 * a feature off (src/features.ts) does not mount that feature's routes, so
 * their generated tools are absent there: registerRouteTools walks the
 * catalog of mounted routes. The hand-written tools of a feature are gated
 * in server.ts. The routes for permissions, parties, labels, connections and
 * file sets are mounted only by a members-only deployment
 * (src/permissions.ts), so their tools exist only there.
 *
 * In a members-only deployment a route may ask for a permission
 * (server/require-permission.ts). A caller who does not hold it is not
 * offered the route's tool: a tool that can only refuse is not an
 * affordance. withheldRouteTools says which were left out and why, for the
 * one caller that is told (the Assistant, llm/permissions-note.ts).
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
import {
  holdsPermission,
  membersOnly,
  standingOf,
  type PermissionName,
} from "../permissions.js";
import { loadConfig } from "../config.js";

export interface RouteTool {
  name: string;
  /** Added after the route's summary: what an agent should know first. */
  note?: string;
}

const SPENDS_OWLS =
  "Spends owls from your balance; get_account shows the balance and the cap on each operation.";
const ESCROWS_OWLS =
  "Escrows owls from your balance now; unspent owls refund on completion or cancellation.";

/** What every act at a gate says of itself. */
const GATE_ACT =
  "An act at a gate: it decides what goes to readers who do not read a label, and what has gone is not taken back. " +
  "It takes the account's own permission and is recorded under the account. The Assistant shows its user a card.";

export const ROUTE_TOOLS: Record<string, RouteTool> = {
  // ---- claims ----
  "GET /claims": { name: "list_claims" },
  // The judgment whole in one small shape (claim-card-service.ts). Each
  // route's description says when a card beats get_claim.
  "GET /claims/:claim_id/card": {
    name: "get_claim_card",
    note:
      "Free. Report what a card says whole: the status with its confidence, " +
      "and contestation beside them. Use get_claim when you need the " +
      "reasoning, arguments, sources or tree.",
  },
  "GET /claims/cards": {
    name: "get_claim_cards",
    note:
      "Free. One call instead of a get_claim per claim; a status still " +
      "travels with its confidence and the claim's contestation.",
  },
  // ---- read-only SQL ----
  "POST /sql": {
    name: "query_sql",
    note: "Load the sql skill (minerval://skills/sql) for the views and their columns before your first query.",
  },
  "GET /claims/:claim_id/citation": { name: "cite_claim" },
  "GET /claims/:claim_id/provenance": { name: "get_claim_provenance" },
  "GET /claims/:claim_id/nanopub": { name: "export_claim_nanopub" },
  "GET /claims/:claim_id/scasp": { name: "export_claim_scasp" },
  "GET /claims/:claim_id/mira": { name: "export_claim_mira" },
  "GET /claims/:claim_id/record": { name: "get_claim_record" },
  "GET /claims/:claim_id/assessments": { name: "get_assessment_history" },
  "GET /claims/:claim_id/judgment-inputs": { name: "get_judgment_inputs" },
  "GET /claims/:claim_id/assessments/trajectory": {
    name: "get_assessment_trajectory",
  },
  "GET /claims/:claim_id/events": { name: "get_claim_events" },
  "POST /claims/propose": {
    name: "propose_claim",
    note:
      "The proposal is reviewed by the Contribution Reviewer before anything " +
      "enters the graph; track it with get_contribution_status, which " +
      "returns became_claim_id and page_url once it is accepted. " +
      SPENDS_OWLS +
      " A rejected good-faith proposal refunds. There is no hourly cap: " +
      "your balance is the bound.",
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
  "GET /mandates/:id/work": { name: "get_mandate_work" },
  "GET /mandates/:id/updates": { name: "list_mandate_updates" },
  "POST /mandates/:id/contribute": { name: "fund_mandate", note: ESCROWS_OWLS },
  "POST /mandates/:id/withdraw": {
    name: "withdraw_from_mandate",
    note: "Returns owls to your balance; confirm with your user before withdrawing their share.",
  },
  "GET /mandates/:id/lookouts/:lookoutId": { name: "get_mandate_lookout" },

  // ---- the Assistant (#646): reads of the account's own conversations ----
  "GET /assistant/conversations": { name: "list_assistant_conversations" },
  "GET /assistant/conversations/:id": { name: "get_assistant_conversation" },
  "GET /assistant/allowance": { name: "get_assistant_allowance" },
  "POST /pages": { name: "save_page" },
  "GET /pages": { name: "list_pages" },
  "GET /pages/:id": { name: "get_page" },
  "GET /shared-pages/:token": { name: "get_shared_page" },

  // ---- correspondents (#563) ----
  "GET /correspondents": { name: "list_correspondents" },
  "GET /correspondents/:id": { name: "get_correspondent" },
  "GET /correspondents/:id/updates": { name: "list_correspondent_updates" },
  "GET /correspondents/:id/updates/:update_id": { name: "get_correspondent_update" },
  "POST /correspondents/:id/poke": {
    name: "poke_correspondent",
    note: "The mandate's manager only; the run it asks for is paid from the mandate's escrow, not your balance.",
  },

  // ---- sources ----
  "POST /sources": {
    name: "submit_source",
    note:
      "The submission is reviewed before any extraction runs; track it with " +
      "get_contribution_status. " +
      SPENDS_OWLS +
      " There is no hourly cap: your balance is the bound.",
  },
  "GET /sources/:source_id": { name: "get_source" },
  "GET /sources/:source_id/context": { name: "get_source_context" },
  "GET /sources/:source_id/examinations": { name: "get_source_examinations" },
  "GET /sources/:source_id/document": { name: "get_source_document" },
  "GET /jobs/:job_id": { name: "get_job" },

  // ---- views stated to the graph directly (constitution §4) ----
  "POST /claims/:claim_id/stated-views": {
    name: "state_view",
    // A getter, so the limits are read from the configuration when the tool
    // is registered and not when this module loads.
    get note() {
      const config = loadConfig();
      return (
        "For your user's own view, or their organization's when the account is the organization's, and only " +
        "when they ask: it is published under the account's name, in the words you pass, and is not edited " +
        "or withdrawn afterwards. It does not change the assessment. Nobody edits one: the statement is " +
        "recorded as a source and shown beside it, and placement there gives it no weight. The Contribution " +
        "Reviewer admits it on form and good faith, never on whether the view is right; track it with " +
        "get_contribution_status. Free, and so it counts toward the cap on contributions (" +
        `${config.contributionRateLimitPerHour} per hour, ${config.newContributorRateLimitPerHour} for accounts ` +
        "under a day old or below 50 reputation), because each one commands a review nobody pays for; past " +
        "it you get CONTRIBUTION_RATE_LIMITED."
      );
    },
  },
  "GET /stated-views": {
    name: "list_stated_views",
    note:
      "Free. With speaker_id, how one account's statements have held up against the graph's assessments; " +
      "with claim_id, what has been stated on one node. A stated view is its speaker's and the judgment is " +
      "the graph's: report each as whose it is. not_assessed means nobody has examined the node, which is " +
      "not agreement.",
  },

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

  // ---- the setups agent runs ran under: constitution, role prompts, tools ----
  "GET /setup/parts": { name: "list_setup_parts" },
  "GET /setup/parts/:kind/:name/:version": { name: "get_setup_part" },
  "GET /setup/prompt-set": { name: "get_prompt_set" },
  // What this deployment has switched on (src/features.ts): a route behind
  // a feature that is off is not mounted, so it is not a tool here either.
  "GET /setup/features": { name: "list_features" },

  // ---- the mirror feed (docs/mirror.md) ----
  // Mounted only on a deployment that publishes a feed or applies one
  // (services/mirror-roles.ts), so these are tools only there.
  "GET /mirror/feed/key": { name: "get_mirror_feed_key" },
  "GET /mirror/feed": { name: "list_mirror_batches" },
  "GET /mirror/status": {
    name: "get_mirror_status",
    note:
      "Free. What you read of the public graph in this deployment is as of public_graph_as_of, " +
      "not as of now.",
  },
  "GET /runs/:run_id": {
    name: "get_run",
    note: "A run that read private data answers public: false with its reasons and nothing else.",
  },
  "GET /runs/:run_id/verify": { name: "verify_run_log" },
  "GET /runs/:run_id/steps": { name: "list_run_steps" },
  "GET /runs/:run_id/steps/:seq": { name: "get_run_step" },

  // ---- permissions, parties and labels: members-only deployments only ----
  // The reads. The writes are excluded below: they take a signed-in session.
  "GET /permissions": { name: "list_permissions" },
  "GET /permissions/mine": { name: "get_my_permissions" },
  "GET /permissions/log": { name: "get_permission_log" },
  "GET /permissions/grants": { name: "list_permission_grants" },
  "GET /permissions/accounts": { name: "list_accounts" },
  "GET /parties": { name: "list_parties" },
  "GET /labels": { name: "list_labels" },
  "GET /labels/faces": { name: "list_label_faces" },
  "GET /asks/askable": { name: "list_askable" },
  "GET /labels/mine": {
    name: "get_my_labels",
    note:
      "Free. works_at is the one label this connection works at where the deployment holds " +
      "material at more than one: everything you add is filed there, and you act only on what " +
      "carries it.",
  },

  // ---- the gate: members-only deployments only (docs/the-gate.md) ----
  // Every route is a tool. An act at a gate takes the account's permission
  // (release for a party, direct, administer), from a session or through a
  // key or token of the account: the person a gate's authorities put there
  // may act through their own agent or a script. The Assistant holds each
  // act for its user (llm/tools/assistant-tools.ts).
  "GET /showings": { name: "list_showings" },
  "GET /showings/:showing_id": {
    name: "get_showing",
    note:
      "Free. Report a node's state as given: a page that is held, or released in part, is a fact about the " +
      "showing and says nothing about what the held text contains.",
  },
  "GET /showings/:showing_id/pages/:page_id": { name: "get_shown_page" },
  "GET /redaction-policies": { name: "list_redaction_policies" },
  "GET /redaction-policies/:policy_id": { name: "get_redaction_policy" },
  "GET /gates": { name: "list_gates" },
  "GET /gate/backlog": {
    name: "get_gate_backlog",
    note: "Free. Counts and fixed words only: it says how much waits and on whom, and nothing about what any item contains.",
  },
  "GET /gate/queue": { name: "get_gate_queue" },
  "GET /gate/items": { name: "list_gate_items" },
  "PUT /gates/:gate_id": { name: "set_gate", note: GATE_ACT },
  "PUT /gates/:gate_id/settings": { name: "set_gate_mode", note: GATE_ACT },
  "DELETE /gates/settings/:setting_id": { name: "end_gate_setting", note: GATE_ACT },
  "POST /gate/decisions": { name: "decide_at_gate", note: GATE_ACT },
  "POST /gate/offers": { name: "offer_to_gate", note: GATE_ACT },
  "POST /showings": { name: "set_page_flow", note: GATE_ACT },
  "POST /showings/:showing_id/end": { name: "end_page_flow", note: GATE_ACT },
  "POST /showings/:showing_id/pages/:page_id/hold": { name: "hold_gate_item", note: GATE_ACT },
  "PUT /redaction-policies": { name: "save_redaction_policy", note: GATE_ACT },
  "POST /showings/:showing_id/pages/:page_id/commission": { name: "fund_showing_work", note: ESCROWS_OWLS },
  // A shown page leaves the deployment (docs/published-pages.md). Reading
  // where it stands, and sending, which takes a person: the Assistant
  // holds it for its user, and a key or a token alone is refused.
  "GET /outbound": { name: "list_pages_going_outside" },
  "POST /outbound/send": {
    name: "send_pages_outside",
    note:
      "This is an outward act: it submits released pages to the public graph under the organization's account, and " +
      "shows outside that this graph assessed the node and when. It runs only for a person: the Assistant shows its " +
      "user a card, and a key or a token alone is refused.",
  },

  // ---- published pages: on a graph anyone may read ----
  "POST /publishers": {
    name: "register_publisher_key",
    note: "Free. The registration is public under your account's name.",
  },
  "GET /publishers/:account_id": { name: "get_publisher" },
  "POST /published-pages": {
    name: "submit_published_page",
    note:
      "The submission is reviewed before the page is attached to its node; track it with get_contribution_status. " +
      SPENDS_OWLS +
      " Only a publication's first package is charged.",
  },
  "GET /published-pages": { name: "list_published_pages" },
  "GET /published-pages/:published_page_id": {
    name: "get_published_page",
    note:
      "Free. A published page is another graph's assessment, made on evidence that is not public. Report it as that " +
      "graph's, with its publisher and what its record says, and keep it apart from this graph's own assessment of the node.",
  },
  "GET /published-pages/:published_page_id/package": { name: "get_published_page_package" },
  // A mandate another graph published here, which a request can be addressed to (published-mandate-service.ts).
  "POST /published-mandates": {
    name: "submit_published_mandate",
    note: "Free. The mandate stands on your publisher's record under your account's name, and requests here can be addressed to it.",
  },
  "GET /published-mandates": { name: "list_published_mandates" },
  "GET /published-mandates/:face_id/package": { name: "get_published_mandate_package" },
  // Connections to an organization's systems (src/connections.ts), in the
  // same deployments. The reads; the writes are excluded below.
  "GET /connections": { name: "list_connections" },
  "GET /connections/:connection_id": { name: "get_connection" },
  "GET /connections/:connection_id/calls": { name: "list_connection_calls" },
  // Sets of files the deployment holds for its agents (src/file-sets.ts),
  // in the same deployments. The reads; the writes are excluded below.
  "GET /file-sets": { name: "list_file_sets" },
  "GET /file-sets/:file_set_id": { name: "get_file_set" },
  "GET /file-sets/:file_set_id/files": { name: "list_file_set_files" },
  "GET /file-sets/:file_set_id/commands": { name: "list_file_set_commands" },
  // ---- the deployment's own mandates, owls and usage report: members-only deployments only ----
  "GET /standing-mandates": { name: "list_standing_mandates" },
  // Mounted only where the deployment creates its own owls (OWLS=created).
  "GET /owls/created": {
    name: "get_created_owls",
    note:
      "Free. Owls here are the organization's own unit for budgeting its agents' work, " +
      "created by its administrators and not bought.",
  },
  "GET /usage-reports/outgoing": { name: "list_usage_reports" },
  // How far the deployment's setup has got, for its administrators.
  "GET /setup/checklist": {
    name: "get_setup_checklist",
    note: "Free. Each call runs the preflight's checks afresh, which takes a few seconds.",
  },

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

  // ---- requests taken up, a funder's ask of a mandate, an account's own report (docs/outward-acts.md) ----
  "POST /requests/:request_id/take-up": {
    name: "take_up_request",
    note: "Public at once under your account's name, and it stays on the request's record. Free. Ask your user first.",
  },
  "POST /requests/:request_id/take-up/decline": {
    name: "decline_taken_up_request",
    note: "Public at once under your account's name. Free. Ask your user first.",
  },
  "POST /mandates/:id/raise": {
    name: "ask_mandate_for_assessment",
    note: "Free, and only for an account with money in the mandate. It asks; the mandate's officers decide.",
  },
  "GET /reports/mine/:id": { name: "get_my_report", note: "Free." },

  // ---- from inside a private deployment: the public graph (members-only deployments only) ----
  "GET /outside/account": { name: "get_public_graph_account", note: "Free." },
  "GET /outside/log": { name: "list_acts_on_public_graph", note: "Free." },
  "GET /outside/requests": { name: "list_public_requests", note: "Free. Read from the mirror, so it tells the public graph nothing." },
  "GET /outside/said-back": { name: "list_public_contributions_received", note: "Free." },
  "GET /outside/reports": { name: "list_agents_reports", note: "Free." },
  "GET /outside/mandates/conversations/:conversation_id": { name: "get_public_mandate_conversation", note: "Free." },
  "POST /outside/requests/adopted/:adoption_id/take-up": {
    name: "take_up_public_request",
    note: "An act on the public graph in the organization's name: it shows outside what this graph is working on. It takes a person, so your user is shown a card.",
  },
  "POST /outside/requests/adopted/:adoption_id/decline": {
    name: "decline_public_request",
    note: "An act on the public graph in the organization's name. It takes a person, so your user is shown a card.",
  },
  "POST /outside/mandates/conversations/:conversation_id/fund": {
    name: "fund_public_mandate",
    note: "Spends the organization's public owls and makes a mandate public under its name. It takes a person, so your user is shown a card.",
  },
  "POST /outside/mandates/:mandate_id/back": {
    name: "back_public_mandate",
    note: "Spends the organization's public owls, publicly. It takes a person, so your user is shown a card.",
  },
  "POST /outside/nodes/:node_id/fund": {
    name: "fund_public_node",
    note: "Spends the organization's public owls, and shows outside that the organization wanted this node assessed. It takes a person, so your user is shown a card.",
  },
  "POST /outside/nodes/:node_id/raise": {
    name: "ask_public_mandate_for_assessment",
    note: "Shows on a public mandate's page that the organization asked about this node. It takes a person, so your user is shown a card.",
  },
};

/** Routes a hand-written tool in server.ts already covers. */
export const NATIVE_TOOL_ROUTES: Record<string, string[]> = {
  "GET /claims/search/:query": ["search_claims"],
  "GET /claims/:claim_id": ["get_claim", "get_decomposition"],
  "GET /claims/:claim_id/dependents": ["get_dependents"],
  "GET /claims/:claim_id/formalization": ["get_claim"],
  // One view for agents and MCP, as get_claim (#541).
  "GET /arguments/:argument_id": ["get_argument"],
  "GET /claims/:id/bounty": ["get_bounty_terms"],
  "GET /tags": ["list_tags"],
  // The change stream (#562), defined once with the Correspondents' read.
  "GET /changes": ["list_graph_changes"],
  "POST /contributions": ["submit_contribution"],
  // The same report, for a caller that speaks REST (routes/reports.ts).
  "POST /reports": ["raise_issue"],
  "GET /contributions/:id": ["get_contribution_status"],
  // The URL hash is the only thing in the way: the native tool takes the
  // page's URL and hashes it on the server (#752).
  "GET /extension/shared/:url_hash": ["get_page_analysis"],
  // The same tool answers with what the graph recorded from the page.
  "GET /extension/recorded/:url_hash": ["get_page_analysis"],
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

const ASSISTANT_CONVERSATION =
  "The Assistant is the account's own agent on the site, given this same " +
  "tool list; an MCP client is itself the conversation, with the tools in hand.";
const ASSISTANT_GATE =
  "Releases an action the Assistant prepared, or widens what it may do " +
  "without asking. The Assistant's tools are this MCP list, so a tool here " +
  "would let it press its own button; the route also requires a signed-in " +
  "dashboard session.";

const PAGE_SHARING =
  "Making a private page readable by anyone with the link, or withdrawing that, is the " +
  "user's own act: it takes the signed-in dashboard session, so nothing an agent reads can " +
  "publish what the user keeps.";

const ADMINISTRATION_SESSION =
  "Changes who may read, release or do what in a members-only deployment, so it takes a " +
  "signed-in dashboard session as well as the permission to administer: a leaked key, an " +
  "access token, or an agent following text it read can then never widen anyone's access. " +
  "The matching reads (list_permission_grants, list_parties, list_labels) are tools.";

const OUTBOUND_SESSION =
  "Decides what leaves the deployment or who speaks for it outside: the words a node is proposed to the public " +
  "graph in, a party's release of those words, a package handed to a person as a file, and the signed statement " +
  "that registers the deployment's key to an account. Each is recorded with the person who did it and takes a " +
  "signed-in dashboard session, as asking for a showing does. Reading where things stand " +
  "(list_pages_going_outside) and sending what has been released (send_pages_outside) are tools.";

const CONNECTION_SESSION =
  "Changes which of an organization's systems agents may read, and which tools they are offered " +
  "there, so it takes a signed-in dashboard session as well as the permission to administer: a " +
  "leaked key, an access token, or an agent following text it read can then never point the " +
  "deployment at a server or widen what agents are offered. The matching reads " +
  "(list_connections, get_connection, list_connection_calls) are tools.";

const FILE_SET_SESSION =
  "Changes which files the graph's agents may read, so it takes a signed-in dashboard session as " +
  "well as the permission to direct: a leaked key, an access token, or an agent following text it " +
  "read can then never place files in front of agents or move them to another label. The matching " +
  "reads (list_file_sets, get_file_set, list_file_set_files, list_file_set_commands) are tools.";

const FILE_SET_REGISTER_SESSION =
  "Decides what label files already on the deployment's disk get, and so which agents may read " +
  "them, so it takes a signed-in dashboard session as well as the permission to administer: a " +
  "leaked key, an access token, or an agent following text it read can then never put a directory " +
  "in front of agents. The matching reads (list_file_sets, get_file_set, list_file_set_files, " +
  "list_file_set_commands) are tools.";

const BUDGET_SESSION =
  "Creates a budget in a members-only deployment: owls for an account or a mandate, or one " +
  "of the deployment's standing mandates. It takes a signed-in dashboard session as well as " +
  "the permission to administer, so that a leaked key, an access token, or an agent following " +
  "text it read can never create a budget for itself. The matching reads (get_created_owls, " +
  "list_standing_mandates) are tools.";

const OUTWARD_WORDS =
  "Words a person writes for the outside: the scope of a public mandate, or a message to the public Grantmaker. It takes a signed-in " +
  "session and is not a tool, because words an agent drafted would be an agent's words leaving the deployment without redaction or " +
  "release. Paying for the mandate once it is drafted (fund_public_mandate) is a tool, and waits for the user.";
const OUTWARD_SESSION =
  "Decides what leaves the deployment from then on with nobody acting, or which label work is recorded at. It takes a signed-in session " +
  "as well as the permission, so that a leaked key, an access token, or an agent following text it read can do neither. The matching " +
  "reads are tools.";

/** Routes deliberately not on MCP, each with its reason. */
export const MCP_EXCLUDED_ROUTES: Record<string, string> = {
  "POST /outside/mandates": OUTWARD_WORDS,
  "POST /outside/mandates/conversations/:conversation_id/messages": OUTWARD_WORDS,
  "POST /outside/requests/:public_request_id/adopt": OUTWARD_SESSION,
  "POST /requests/:request_id/adopt": OUTWARD_SESSION,
  "POST /asks": OUTWARD_SESSION,
  "POST /outbound/proposals": OUTBOUND_SESSION,
  "POST /outbound/packages/:package_id/file": OUTBOUND_SESSION,
  "POST /outbound/registration": OUTBOUND_SESSION,
  "POST /file-sets/register": FILE_SET_REGISTER_SESSION,
  "POST /file-sets/:file_set_id/rehash": FILE_SET_REGISTER_SESSION,
  "POST /file-sets": FILE_SET_SESSION,
  "PUT /file-sets/:file_set_id/files/*": FILE_SET_SESSION,
  "POST /file-sets/:file_set_id/close": FILE_SET_SESSION,
  "PATCH /file-sets/:file_set_id": FILE_SET_SESSION,
  "POST /connections": CONNECTION_SESSION,
  "PATCH /connections/:connection_id": CONNECTION_SESSION,
  "POST /connections/:connection_id/look": CONNECTION_SESSION,
  "PUT /connections/:connection_id/tools": CONNECTION_SESSION,
  "POST /permissions/grants": ADMINISTRATION_SESSION,
  "DELETE /permissions/grants/:grant_id": ADMINISTRATION_SESSION,
  "POST /parties": ADMINISTRATION_SESSION,
  "PUT /sources/:source_id/party": ADMINISTRATION_SESSION,
  "POST /labels": ADMINISTRATION_SESSION,
  "POST /labels/:label/reads": ADMINISTRATION_SESSION,
  "PUT /labels/:label/face": ADMINISTRATION_SESSION,
  "DELETE /labels/:label/face/:at": ADMINISTRATION_SESSION,
  "DELETE /labels/:label/reads/:reads": ADMINISTRATION_SESSION,
  "POST /operator/administrators":
    "The way back in for a deployment whose administrators cannot sign in: requires the " +
    "operator key, which is held outside every deployment surface on purpose (docs/accounts.md).",
  "POST /owls/created": BUDGET_SESSION,
  "POST /standing-mandates/:name": BUDGET_SESSION,
  "POST /usage-reports/outgoing/send":
    "Sends this deployment's usage reports to the public graph now instead of at the worker's " +
    "next pass. It is an administrator's act from a signed-in dashboard session, like every " +
    "administrative write; list_usage_reports is the tool that reads what was and will be sent.",
  "POST /usage-reports":
    "Machine to machine: a private deployment's own worker reports its day's owl spend to the " +
    "public graph under the organization's API key (docs/usage-report.md). An agent has no " +
    "report of its own to send, and a tool here would let one file a figure in an account's name.",

  "GET /health": "A load-balancer liveness probe, not an affordance.",
  "GET /mirror/feed/:sequence":
    "A batch is megabytes of whole rows for a deployment's mirror to verify and apply, not " +
    "something a model can read in a tool result. list_mirror_batches and get_mirror_feed_key " +
    "are the MCP side of the feed; the rows themselves are read through the ordinary claim and " +
    "source tools.",
  "PATCH /claims/:claim_id":
    "Direct service seeding only: writes an argument straight onto a " +
    "claim without review, and refuses every other caller. MCP's " +
    "governed path is submit_contribution with contribution_type " +
    "'propose_argument', which goes through the Contribution Reviewer.",

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

  "GET /setup/preflight":
    "Reports this deployment's configuration to whoever runs it (which keys " +
    "are missing, where reports are filed, the state of the database): " +
    "requires the operator key, which is held outside every deployment " +
    "surface, an MCP client included (docs/deployment.md).",
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
  "GET /correspondents/:id/feed": "The Atom feed rendering of list_correspondent_updates.",

  "POST /extension/analyze":
    "The browser extension's page protocol (content hashing, polling, " +
    "sharing by URL hash); assess_text and extract_claims are the MCP " +
    "equivalents for text an agent holds.",
  "GET /extension/analysis/:content_hash": "Polls POST /extension/analyze; see it.",
  "GET /extension/shared":
    "The extension's private lookup: it sends a 4-character hash prefix so " +
    "the server never learns which page a reader is on. An MCP caller is " +
    "authenticated and names its page anyway, so get_page_analysis takes " +
    "the URL directly.",
  "GET /assistant/conversations/:id/stream":
    "An event stream of a running turn, for a person watching the reply form. A tool call " +
    "returns once; get_assistant_conversation holds the same text, and the finished reply.",
  "POST /assistant/conversations": ASSISTANT_CONVERSATION,
  "POST /assistant/conversations/:id/messages": ASSISTANT_CONVERSATION,
  "POST /assistant/conversations/:id/stop": ASSISTANT_CONVERSATION,
  "PATCH /assistant/conversations/:id": ASSISTANT_CONVERSATION,
  "DELETE /assistant/conversations/:id": ASSISTANT_CONVERSATION,
  "POST /assistant/conversations/:id/held/:action_id": ASSISTANT_GATE,
  "PUT /assistant/allowance": ASSISTANT_GATE,
  "POST /pages/:id/share": PAGE_SHARING,
  "DELETE /pages/:id/share": PAGE_SHARING,
  "DELETE /pages/:id":
    "A page is its user's to throw away: deleting takes the signed-in dashboard session, so " +
    "nothing an agent reads can have it delete what the user keeps.",
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

/** The path params a route URL names: `:claim_id` in `/claims/:claim_id/x`. */
export function urlParams(url: string): string[] {
  return [...url.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
}

/**
 * One input object for the tool: the route's params, querystring, and body
 * properties merged, with each name remembered by where it goes back. The
 * three never share a name on an exposed route (the parity test checks).
 */
export function routeInput(route: CatalogRoute): RouteInput {
  const cached = inputCache.get(route);
  if (cached) return cached;

  const part = (s: unknown) => (s ?? {}) as JsonSchemaObject;
  // Every `:name` in the URL is an input, whether or not the route declares
  // a params schema: a route without one once produced tools that took
  // nothing and dispatched to a URL with `:id` left in it (#715). A declared
  // schema's property wins; an undeclared one is a plain string.
  const declared = part(route.schema?.params);
  const params: JsonSchemaObject = {
    ...declared,
    properties: { ...(declared.properties ?? {}) },
  };
  for (const name of urlParams(route.url)) {
    if (!(name in params.properties!)) params.properties![name] = { type: "string" };
  }
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

/**
 * The first permission a route asks for that `auth` does not hold, or null
 * when the caller may use the route. Always null on the public graph, where
 * no route's permission binds.
 */
function missingPermission(route: CatalogRoute, auth: RequestAuth): PermissionName | null {
  if (!membersOnly()) return null;
  const standing = standingOf(auth);
  const missing = (route.permissions ?? []).find((p) => !holdsPermission(standing, p));
  if (missing) return missing;
  // A route that any one of several permissions opens: the first of them is
  // the one named to a caller who holds none.
  for (const group of route.anyPermissions ?? []) {
    if (!group.some((p) => holdsPermission(standing, p))) return group[0] ?? null;
  }
  return null;
}

/**
 * The route tools `auth` is not offered because the account lacks the
 * permission each needs, in the catalog's order. Empty on the public graph.
 */
export function withheldRouteTools(
  app: FastifyInstance,
  auth: RequestAuth
): Array<{ tool: string; permission: PermissionName }> {
  const withheld: Array<{ tool: string; permission: PermissionName }> = [];
  for (const route of app.routeCatalog ?? []) {
    const tool = ROUTE_TOOLS[routeKey(route.method, route.url)];
    if (!tool) continue;
    const permission = missingPermission(route, auth);
    if (permission) withheld.push({ tool: tool.name, permission });
  }
  return withheld;
}

/**
 * Register a tool for every catalog route that ROUTE_TOOLS names and the
 * caller may use.
 */
export function registerRouteTools(
  server: McpServer,
  app: FastifyInstance,
  auth: RequestAuth
): void {
  for (const route of app.routeCatalog ?? []) {
    const tool = ROUTE_TOOLS[routeKey(route.method, route.url)];
    if (!tool) continue;
    if (missingPermission(route, auth)) continue;
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
