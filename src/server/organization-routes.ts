/**
 * What may be done in an organization's name, by route (docs/organizations.md,
 * "What an organization grants" and "Acting as the organization").
 *
 * Two kinds of caller act as an organization on the public graph:
 *
 * - a person acting as it (`x-acting-organization`), who is a live member and
 *   holds the permission the route names, or is an admin, who holds every
 *   member permission;
 * - a connected deployment signing with its own key, which holds the grant the
 *   route names.
 *
 * Each route says what it needs from each, separately. A side the route does
 * not name is closed to that kind of caller. So a route added later is closed
 * to both until someone decides, and tests/unit/server/organization-routes.test.ts
 * fails on a route that writes and is neither here nor in PERSON_ROUTES with
 * its reason.
 *
 * Reads a person makes while acting as an organization are open to any live
 * member unless PERSON_ROUTES names them: a person can read the public graph
 * either way, and the organization's own state (its balance, its mandates) is
 * every member's to read. A deployment's reads are only those named here,
 * because the public graph keeps no record of what a deployment looks at and
 * so should answer it as little as it needs (docs/mirror.md).
 */
import type { DeploymentGrant, MemberPermission } from "../db/schema.js";

export interface OrganizationRouteRule {
  /**
   * What a person acting as the organization needs: a permission, "member"
   * (any live member), or "admin" (an admin only).
   */
  member?: MemberPermission | "member" | "admin";
  /**
   * What a deployment needs: any one of these grants, or "any" (any live
   * grant: the deployment reading its own organization's state).
   */
  deployment?: readonly DeploymentGrant[] | "any";
}

const spend: OrganizationRouteRule = { member: "spend", deployment: ["spend"] };
const speak: OrganizationRouteRule = { member: "speak", deployment: ["speak"] };
const propose: OrganizationRouteRule = { member: "propose", deployment: ["propose"] };
const takeUp: OrganizationRouteRule = { member: "take_up", deployment: ["take_up"] };

export const ORGANIZATION_ROUTES: Readonly<Record<string, OrganizationRouteRule>> = {
  // ---- spend: spending or escrowing the organization's owls ----
  "POST /grant-conversations": spend,
  "POST /grant-conversations/:id/messages": spend,
  "POST /grant-conversations/:id/fund": spend,
  "POST /grants/:id/approve": spend,
  "POST /grants/:id/topup": spend,
  "POST /grants/:id/cancel": spend,
  "POST /mandates/:id/contribute": spend,
  "POST /mandates/:id/raise": spend,
  "POST /mandates/:id/withdraw": spend,
  "POST /claims/:claim_id/contribute": spend,
  "POST /requests/:request_id/contribute": spend,
  "POST /claims/:claim_id/order": spend,
  "DELETE /orders/:id": spend,
  "POST /claims/:claim_id/decompose": spend,
  "POST /budget-jobs/:id/topup": spend,
  "POST /budget-jobs/:id/cancel": spend,
  "POST /correspondents/:id/poke": spend,

  // ---- buy: owls for the organization, paid by the person ----
  "POST /billing/checkout": { member: "buy" },

  // ---- speak: words on the public record in the organization's name ----
  "POST /contributions": speak,
  "POST /claims/:claim_id/stated-views": speak,
  "POST /appeals": speak,
  "POST /reports": speak,
  "POST /prize-claims/:id/challenge": speak,

  // ---- propose: new claims, lists and sources ----
  // A deployment also proposes the nodes the pages it publishes cite.
  "POST /claims/propose": { member: "propose", deployment: ["propose", "publish"] },
  "POST /claims/propose-list": propose,
  "POST /sources": propose,

  // ---- take_up: committing the organization to a request's work ----
  "POST /requests/:request_id/take-up": takeUp,
  "POST /requests/:request_id/take-up/decline": takeUp,

  // ---- publish, read_feed, report_usage: a deployment's own work ----
  "POST /publishers": { deployment: ["publish"] },
  "POST /published-pages": { deployment: ["publish"] },
  "POST /published-mandates": { deployment: ["publish"] },
  "GET /mirror/feed/:sequence": { deployment: ["read_feed"] },
  "POST /usage-reports": { deployment: ["report_usage"] },

  // ---- the Assistant, working for the organization (its model calls are the organization's spend) ----
  "POST /assistant/conversations": { member: "spend" },
  "POST /assistant/conversations/:id/messages": { member: "spend" },
  // Each tool call a held action makes is checked on its own, as the Assistant's are.
  "POST /assistant/conversations/:id/held/:action_id": { member: "member" },
  "POST /assistant/conversations/:id/stop": { member: "member" },
  "PATCH /assistant/conversations/:id": { member: "member" },
  "DELETE /assistant/conversations/:id": { member: "member" },

  // ---- reads that write nothing, sent as POST ----
  "POST /sql": { member: "member" },

  // ---- the organization's own state ----
  "GET /billing/ledger": { member: "admin" },
  "GET /organizations/me": { deployment: "any" },
  "POST /deployments/me/retire": { deployment: "any" },
  "GET /users/me": { member: "member", deployment: "any" },
  "GET /grants": { member: "member", deployment: "any" },
  "GET /reports/mine/:id": { member: "member", deployment: "any" },
  "GET /contributions/:id": { member: "member", deployment: "any" },
  "GET /grant-conversations/:id": { member: "member", deployment: "any" },
};

const PERSONAL = "A person's own credentials and settings: they are the person's, whoever they are acting as.";
const MANAGING =
  "Running the organization, not acting on the public graph in its name: an admin does it as themselves, on the organization's pages.";
const SERVICE = "Not a caller's route: the service, the operator key or a provider's callback calls it, for no organization.";
const PRIZES =
  "The prize rules name natural persons (docs/prizes.md, \"What a winner must do\"). An organization files under claim_prizes once a version of the rules allows it.";

/**
 * Routes that write and that nobody calls as an organization, with the reason.
 * The header that says someone is acting as one is refused on them, so a page
 * that sends it everywhere cannot do one of these in the organization's name.
 */
export const PERSON_ROUTES: Readonly<Record<string, string>> = {
  "POST /api-keys": PERSONAL,
  "DELETE /api-keys/:key_id": PERSONAL,
  "POST /oauth/register": PERSONAL,
  "POST /oauth/token": PERSONAL,
  "POST /oauth/requests/:request_id/approve": PERSONAL,
  "POST /oauth/requests/:request_id/deny": PERSONAL,
  "POST /mcp": "The MCP transport: a client acts as the identity its credential was made for (docs/organizations.md, \"Other credentials\").",
  "DELETE /mcp": "The MCP transport: a client acts as the identity its credential was made for (docs/organizations.md, \"Other credentials\").",
  "POST /users/provision": SERVICE,
  "POST /pages": "A saved page is its person's notebook, not an act on the public graph.",
  "DELETE /pages/:id": "A saved page is its person's notebook, not an act on the public graph.",
  "POST /pages/:id/share": "A saved page is its person's notebook, not an act on the public graph.",
  "DELETE /pages/:id/share": "A saved page is its person's notebook, not an act on the public graph.",
  "POST /extension/analyze": "The browser extension acts as the person whose key it holds.",

  "PUT /assistant/allowance": "What the Assistant may do without asking is the person's own choice, wherever they are acting.",

  "POST /claims/:claim_id/prize-claims": PRIZES,
  "POST /prize-claims/:id/attachments": PRIZES,
  "POST /prize-claims/:id/code": PRIZES,
  "POST /prize-claims/:id/withdraw": PRIZES,
  "POST /prize-claims/:id/payee": PRIZES,

  "POST /organizations": "An organization does not make organizations: a person does, and becomes its first admin.",
  "PATCH /organizations/:id": MANAGING,
  "PUT /organizations/:id/members/:account_id": MANAGING,
  "DELETE /organizations/:id/members/:account_id": MANAGING,
  "POST /organizations/:id/grants": MANAGING,
  "DELETE /organizations/:id/grants/:grant_id": MANAGING,
  "POST /organizations/:id/invitations": MANAGING,
  "DELETE /organizations/:id/invitations/:invitation_id": MANAGING,
  "DELETE /organizations/:id/old-keys/:key_id": MANAGING,
  "POST /organization-invitations/:token/accept": "Accepting an invitation is the person joining, as themselves.",
  "POST /account-conversion": "Converting a shared login is done signed in as that login.",
  "DELETE /account-conversion": "Converting a shared login is done signed in as that login.",
  "POST /account-conversions/:id/accept": "Accepting a conversion makes the person its first admin, as themselves.",
  "POST /connect-requests/:code/approve": MANAGING,
  "POST /connect-requests/:code/deny": MANAGING,
  "POST /deployments/connect": "A deployment asks to connect with its own key, before it belongs to any organization.",

  "POST /operator/organizations/:id/admins": SERVICE,
  "POST /operator/platform-grantmaking-keys": SERVICE,
  "DELETE /operator/platform-grantmaking-keys/:id": SERVICE,
  "POST /operator/platform-mandates/fund": SERVICE,
  "POST /bounties/:id/confirm": SERVICE,
  "POST /prize-claims/:id/sign-off": SERVICE,
  "POST /prize-claims/:id/void": SERVICE,
  "POST /prize-claims/:id/screening": SERVICE,
  "POST /prize-claims/:id/pay": SERVICE,
  "POST /prize-claims/:id/retry-check": SERVICE,
  "POST /billing/webhook": SERVICE,
  "POST /grants": SERVICE,
  "PATCH /claims/:claim_id": SERVICE,
  "PATCH /findings/:id": SERVICE,
  "PATCH /reports/:id": SERVICE,
  "POST /admin/attempts/:id/cancel": SERVICE,
};

/** Reads that are a person's own and are refused while acting as an organization. */
export const PERSON_READS: Readonly<Record<string, string>> = {
  "GET /api-keys": PERSONAL,
  "GET /assistant/allowance": "What the Assistant may do without asking is the person's own choice, wherever they are acting.",
};

/**
 * MCP tools that stand for no route of their own and are not reads
 * (src/mcp/server.ts), with what a person acting as an organization needs to
 * be offered them. A tool that stands for a route (mcp/route-tools.ts,
 * ROUTE_TOOLS and NATIVE_TOOL_ROUTES) takes that route's rule instead.
 * tests/unit/server/organization-routes.test.ts fails on a native tool that
 * writes or spends and is in neither.
 */
export const NATIVE_TOOL_PERMISSIONS: Readonly<Record<string, MemberPermission>> = {
  // Paid analyses: each runs a model, charged to whoever the call is for.
  match_claim: "spend",
  extract_claims: "spend",
  assess_text: "spend",
};

export type MemberCheck =
  | { ok: true }
  | { ok: false; code: "NOT_AN_ORGANIZATION_ACT" | "PERMISSION_NOT_HELD" | "ADMIN_REQUIRED"; reason: string; permission?: MemberPermission };

/**
 * Whether a person may call a route as an organization, given their role and
 * live permissions there. The caller has checked they are a live member.
 */
export function memberMayCall(
  route: string,
  method: string,
  standing: { role: "admin" | "member"; permissions: readonly MemberPermission[] }
): MemberCheck {
  const personal = PERSON_ROUTES[route] ?? PERSON_READS[route];
  if (personal) return { ok: false, code: "NOT_AN_ORGANIZATION_ACT", reason: personal };
  const rule = ORGANIZATION_ROUTES[route]?.member;
  if (!rule) {
    if (method === "GET") return { ok: true };
    return {
      ok: false,
      code: "NOT_AN_ORGANIZATION_ACT",
      reason: ORGANIZATION_ROUTES[route]
        ? "This is a connected deployment's work, done with its own keys."
        : "Nobody has decided whether this may be done in an organization's name, so it may not yet.",
    };
  }
  if (rule === "member") return { ok: true };
  if (standing.role === "admin") return { ok: true };
  if (rule === "admin") return { ok: false, code: "ADMIN_REQUIRED", reason: "Only the organization's admins do this." };
  if (standing.permissions.includes(rule)) return { ok: true };
  return { ok: false, code: "PERMISSION_NOT_HELD", reason: `This needs ${rule}.`, permission: rule };
}

/** What a deployment needs to call a route: null where it may not call it at all. */
export function deploymentNeeds(route: string): readonly DeploymentGrant[] | "any" | null {
  return ORGANIZATION_ROUTES[route]?.deployment ?? null;
}
