/**
 * The label a request works at: one decision for every route that writes
 * (src/labels.ts, src/db/clearance.ts).
 *
 * The database lets a connection add a row only at its own label. A run has
 * a label, the label of the work that started it. A person's request has a
 * clearance, the labels they were granted to read, and until it is given a
 * label it can add nothing but `public` rows. Where a deployment holds
 * material at more than one label, each request that writes is therefore
 * given one label, and it comes from one of two places. No agent chooses
 * it, and a missing label is never read as `public`.
 *
 *  - From what the request is about ("from"). A contribution, an appeal, an
 *    order, funding, a message in a conversation that already exists: each
 *    is about a row that already carries a label, and the work it starts
 *    carries that label. The row is read with the request's own clearance,
 *    so a person who may not read it is told it does not exist.
 *  - From the person, when they start something new ("chosen"). A new
 *    source, a proposed node, a new granting conversation, a new
 *    conversation with the Assistant: the person says which label it is
 *    for, in a `label` field, among the labels they may read. There is no
 *    preselected answer. A request that names none is refused and told
 *    which labels it may name.
 *
 * A credential that an agent holds works the other way round. An API key,
 * an access token and the Assistant in one conversation each work at one
 * label, fixed by the person when the key was minted, the token approved or
 * the conversation started (RequestAuth.fixedLabel). Every request made
 * with it reads what that label reads, within what the person may read, and
 * writes at that label: what it starts new is at that label with no
 * parameter, and it changes an existing row only where the row carries that
 * same label. The reason is the one the Assistant's cards have: an agent
 * reads other people's text while it works, and text it read must not be
 * able to file private material where more people can read it, by choosing
 * a label or by picking a row at another one to write into.
 *
 * Starting work on a node is not a change to the node. A node may carry a
 * judgment at each label, and work on it at one label has its own order,
 * its own ledger row and its own slot (src/labels.ts, "A judgment at each
 * label"), so the three routes that start work on an existing node (order,
 * fund, decompose) let the work be at the node's own label or at one that
 * reads it ("orReader"). A signed-in person may name such a label. A
 * credential names nothing: its work is at its own label, on any node that
 * label reads, and everything it writes is still at its own label alone.
 *
 * "none" is for a route that adds no row that carries a label: accounts,
 * keys, owls, the tables that say what a clearance is (written as the
 * database's owner once the route has checked the administrator), and the
 * routes the operator key guards, which act for no person.
 *
 * Every route that is not a read is listed below, and
 * tests/unit/server/request-labels.test.ts builds the app and fails for one
 * that is not, so a route that writes cannot be added without deciding.
 *
 * On a deployment whose only label is `public` none of this runs: nothing
 * is asked, and a `label` field is not in any route's schema.
 */

/** The rows a request can be about, by the table that holds them. */
export const CARRIERS = {
  claim: { table: "claims", noun: "node" },
  source: { table: "sources", noun: "source" },
  contribution: { table: "contributions", noun: "contribution" },
  order: { table: "assessment_orders", noun: "order" },
  budget_job: { table: "budget_jobs", noun: "funded job" },
  correspondent: { table: "correspondents", noun: "Correspondent" },
  mandate: { table: "grants", noun: "mandate" },
  grant_conversation: { table: "grant_conversations", noun: "granting conversation" },
  assistant_conversation: { table: "assistant_conversations", noun: "conversation" },
  page: { table: "assistant_pages", noun: "page" },
  report: { table: "agent_reports", noun: "report" },
  finding: { table: "agent_findings", noun: "finding" },
  request: { table: "requests", noun: "request" },
  prize_claim: { table: "prize_claims", noun: "prize claim" },
  showing_page: { table: "showing_pages", noun: "page under a showing" },
  proof_attempt: { table: "proof_attempts", noun: "proof attempt" },
  connection: { table: "connections", noun: "connection" },
  file_set: { table: "file_sets", noun: "file set" },
} as const;

export type Carrier = keyof typeof CARRIERS;

export type RequestLabelRule =
  /** Starts something new: the person names the label; a credential uses its own. */
  | { rule: "chosen"; why: string }
  /**
   * About a row that carries a label. `otherwise: "chosen"` is for a route
   * where naming the row is optional and leaving it out starts something new.
   */
  | {
      rule: "from";
      carrier: Carrier;
      in: "params" | "body";
      field: string;
      otherwise?: "chosen";
      /**
       * The request starts work on the row, and the work may be at the
       * row's own label or at one that reads it: an internal assessment of
       * a public claim. A signed-in person may name such a label among
       * those they may read; left out, the work is at the row's own. A
       * credential works at its own label, which reads every row it sees.
       */
      orReader?: true;
      why: string;
    }
  /**
   * Many acts behind one address, each decided when it is made: the request
   * works at its credential's label, and a signed-in session, which has
   * none, is refused.
   */
  | { rule: "credential"; why: string }
  /** Adds no row that carries a label. */
  | { rule: "none"; why: string };

const from = (
  carrier: Carrier,
  field: string,
  why: string,
  where: "params" | "body" = "params"
): Extract<RequestLabelRule, { rule: "from" }> => ({ rule: "from", carrier, in: where, field, why });

const SHOWING =
  "Writes on both sides of a boundary, the label a page was written at and the label it is shown to. The two may share no label, so the request cannot work at one. The route checks the person's permission, and the showing service writes each row on the database owner's connection, naming its label (services/showing-service.ts).";

const OUTBOUND =
  "What a showing outside has released is kept at `public`, and so is the record of its leaving: packages, " +
  "proposals and sends. The route checks the person's permission and the service writes those rows at `public` " +
  "as the tables' owner (services/outbound-service.ts). It reads nothing at the person's other labels.";
const OPERATOR =
  "Guarded by the operator key, which names no person and carries no clearance: the request reads and writes `public` alone.";
const ADMINISTRATION =
  "Changes who may read or do what. The route checks the administrator and the change is written on the database owner's connection, to tables that carry no label.";
const ACCOUNT = "Writes only to the account's own tables, which carry no label.";
const OAUTH = "The OAuth server's own tables, which carry no label.";

/** Every route that is not a read, with how its request gets a label. */
export const REQUEST_LABELS: Readonly<Record<string, RequestLabelRule>> = {
  // ---- nodes ----
  "POST /claims/propose": { rule: "chosen", why: "A proposed node is new." },
  "POST /claims/:claim_id/order": {
    ...from("claim", "claim_id", "An order is for an assessment of this node, at the node's label or at one that reads it."),
    orReader: true,
  },
  "POST /claims/:claim_id/contribute": {
    ...from(
      "claim",
      "claim_id",
      "The money is for this node's next assessment, at the node's label or at one that reads it."
    ),
    orReader: true,
  },
  "POST /claims/:claim_id/decompose": {
    ...from(
      "claim",
      "claim_id",
      "The mandate this opens is scoped to this node and funds work on it, at the node's label or at one that reads it."
    ),
    orReader: true,
  },
  "PATCH /claims/:claim_id": from("claim", "claim_id", "An argument written onto this node."),
  "POST /claims/:claim_id/prize-claims": from("claim", "claim_id", "A prize claim is made on this node."),

  // ---- sources and contributions ----
  "POST /sources": { rule: "chosen", why: "A source is new material." },
  "POST /contributions": {
    rule: "from",
    carrier: "claim",
    in: "body",
    field: "claim_id",
    otherwise: "chosen",
    why: "A contribution is about the node it names. A proposed request that names no node is new.",
  },
  "POST /appeals": from("contribution", "contribution_id", "An appeal is against the review of this contribution.", "body"),

  // ---- orders and funded jobs ----
  "DELETE /orders/:id": from("order", "id", "Cancels this order."),
  "POST /budget-jobs/:id/topup": from("budget_job", "id", "Adds to this job's budget."),
  "POST /budget-jobs/:id/cancel": from("budget_job", "id", "Cancels this job."),
  "POST /requests/:request_id/contribute": from("request", "request_id", "The money is for work on this request."),

  // ---- mandates ----
  "POST /grants": { rule: "chosen", why: "A mandate created directly is new." },
  "POST /grants/:id/approve": from("mandate", "id", "Approves this mandate's plan."),
  "POST /grants/:id/topup": from("mandate", "id", "Adds to this mandate's budget."),
  "POST /grants/:id/cancel": from("mandate", "id", "Stops this mandate."),
  "POST /mandates/:id/contribute": from("mandate", "id", "Backs this mandate."),
  "POST /mandates/:id/withdraw": from("mandate", "id", "Takes a funder's share back from this mandate."),
  "POST /grant-conversations": {
    rule: "chosen",
    why: "A granting conversation is new, and the mandate drafted in it takes its label.",
  },
  "POST /grant-conversations/:id/messages": from(
    "grant_conversation",
    "id",
    "A message in this conversation, answered by a Grantmaker's turn at its label."
  ),
  "POST /grant-conversations/:id/fund": from(
    "grant_conversation",
    "id",
    "Funds the mandate drafted in this conversation, which takes the conversation's label."
  ),
  "POST /correspondents/:id/poke": from("correspondent", "id", "A note to this Correspondent."),

  // ---- the Assistant and pages ----
  "POST /assistant/conversations": {
    rule: "chosen",
    why: "A conversation with the Assistant is new, and every turn of it runs at its label.",
  },
  "POST /assistant/conversations/:id/messages": from(
    "assistant_conversation",
    "id",
    "A message in this conversation, answered by a turn at its label."
  ),
  "POST /assistant/conversations/:id/stop": from("assistant_conversation", "id", "Stops this conversation's turn."),
  "PATCH /assistant/conversations/:id": from("assistant_conversation", "id", "Changes this conversation's model."),
  "DELETE /assistant/conversations/:id": from("assistant_conversation", "id", "Deletes this conversation."),
  "POST /assistant/conversations/:id/held/:action_id": from(
    "assistant_conversation",
    "id",
    "Runs or declines an action the Assistant prepared in this conversation, at the conversation's label."
  ),
  "PUT /assistant/allowance": { rule: "none", why: ACCOUNT },
  "POST /pages": {
    rule: "from",
    carrier: "page",
    in: "body",
    field: "id",
    otherwise: "chosen",
    why: "Replacing a page keeps the page's label. A page saved without an id is new.",
  },
  "DELETE /pages/:id": from("page", "id", "Deletes this page."),

  // ---- reports and findings (service callers) ----
  "PATCH /reports/:id": from("report", "id", "Sets this report's triage status."),
  "PATCH /findings/:id": from("finding", "id", "Withdraws or restores this finding."),

  // ---- mathematics and prizes ----
  "POST /admin/attempts/:id/cancel": from("proof_attempt", "id", "Cancels this proof attempt."),
  "POST /prize-claims/:id/attachments": from("prize_claim", "id", "A file added to this prize claim."),
  "POST /prize-claims/:id/code": from("prize_claim", "id", "A one-time code for this prize claim."),
  "POST /prize-claims/:id/withdraw": from("prize_claim", "id", "Withdraws this prize claim."),
  "POST /prize-claims/:id/payee": from("prize_claim", "id", "Records who is paid for this prize claim."),
  "POST /prize-claims/:id/challenge": from("prize_claim", "id", "A challenge to this prize claim."),
  "POST /bounties/:id/confirm": { rule: "none", why: OPERATOR },
  "POST /prize-claims/:id/sign-off": { rule: "none", why: OPERATOR },
  "POST /prize-claims/:id/void": { rule: "none", why: OPERATOR },
  "POST /prize-claims/:id/screening": { rule: "none", why: OPERATOR },
  "POST /prize-claims/:id/pay": { rule: "none", why: OPERATOR },
  "POST /prize-claims/:id/retry-check": { rule: "none", why: OPERATOR },

  // ---- the browser extension ----
  "POST /extension/analyze": {
    rule: "chosen",
    why: "An analysis of a page the reader has open is new, and what is kept of it carries a label.",
  },
  "POST /extension/chat": { rule: "chosen", why: "A question about a page the reader has open is new." },

  // ---- MCP ----
  "POST /mcp": {
    rule: "credential",
    why: "Each tool call is a request of its own with its own rule here, and the tools that are not routes write at the label of the key or token that called.",
  },
  "DELETE /mcp": { rule: "none", why: "Answers 405. The endpoint keeps no session to end." },

  // ---- read-only SQL ----
  "POST /sql": { rule: "none", why: "A read. The query runs on a role that can write nothing." },

  // ---- accounts, keys and money ----
  "POST /users/provision": { rule: "none", why: ACCOUNT },
  "POST /api-keys": {
    rule: "none",
    why: "A key is the account's own and carries no label of the kind a reader is held to. The label the key will work at is named in this request and checked by the route (routes/api-keys.ts).",
  },
  "DELETE /api-keys/:key_id": { rule: "none", why: ACCOUNT },
  "POST /billing/checkout": { rule: "none", why: "Starts a payment with the payment provider. Nothing is written to the graph." },
  "POST /billing/webhook": { rule: "none", why: "Credits a purchase to the owl ledger, which carries no label." },
  "POST /oauth/register": { rule: "none", why: OAUTH },
  "POST /oauth/token": { rule: "none", why: OAUTH },
  "POST /oauth/requests/:request_id/approve": {
    rule: "none",
    why: `${OAUTH} The label the issued tokens will work at is named in this request and checked by the route (routes/oauth.ts).`,
  },
  "POST /oauth/requests/:request_id/deny": { rule: "none", why: OAUTH },

  // ---- administration: members-only deployments only ----
  "POST /permissions/grants": { rule: "none", why: ADMINISTRATION },
  "DELETE /permissions/grants/:grant_id": { rule: "none", why: ADMINISTRATION },
  "POST /parties": { rule: "none", why: ADMINISTRATION },
  "PUT /sources/:source_id/party": {
    rule: "none",
    why: "Says whose material a source is. It changes one column of a source that is already there and adds no row; the source keeps its label, and the change is made at that label (services/party-service.ts), since a row is changed only by work at its own.",
  },
  "POST /labels": { rule: "none", why: ADMINISTRATION },
  "POST /labels/:label/reads": { rule: "none", why: ADMINISTRATION },
  "DELETE /labels/:label/reads/:reads": { rule: "none", why: ADMINISTRATION },

  // ---- showing a page below its label: members-only deployments only ----
  "POST /showings": { rule: "none", why: SHOWING },
  "POST /showings/:showing_id/end": { rule: "none", why: SHOWING },
  "POST /showings/:showing_id/pages/:page_id/hold": { rule: "none", why: SHOWING },
  "POST /showings/:showing_id/pages/:page_id/commission": from(
    "showing_page",
    "page_id",
    "The money is for the redaction of this page or the check of it, which run at the page's label."
  ),
  "POST /release/decisions": { rule: "none", why: SHOWING },
  "POST /release/rules": { rule: "none", why: SHOWING },
  "DELETE /release/rules/:rule_id": { rule: "none", why: SHOWING },
  "PUT /redaction-policies": { rule: "none", why: SHOWING },

  // ---- connections to an organization's systems: members-only deployments only ----
  "POST /connections": {
    rule: "chosen",
    why: "A connection is new, and its label says which runs are offered it. The administrator names it among the labels they read: administering does not by that alone let a person read at a label, and the connection's tools and calls are read there.",
  },
  "PATCH /connections/:connection_id": from(
    "connection",
    "connection_id",
    "Changes the connection's own row, which is changed by work at its own label. An administrator who does not read that label is told the connection does not exist."
  ),
  "POST /connections/:connection_id/look": from(
    "connection",
    "connection_id",
    "Stores the tools the connection's server lists, which are the system describing itself and carry the connection's label."
  ),
  "PUT /connections/:connection_id/tools": from(
    "connection",
    "connection_id",
    "Changes which of the connection's tools are offered: rows at the connection's label."
  ),

  // ---- file sets: members-only deployments only ----
  "POST /file-sets": {
    rule: "chosen",
    why: "A set of files is new material. The person adding it names its label among the labels they read.",
  },
  "POST /file-sets/register": {
    rule: "chosen",
    why: "A directory registered as a set is new to the graph: the administrator names the label its files get, among the labels they read.",
  },
  "PUT /file-sets/:file_set_id/files/*": from(
    "file_set",
    "file_set_id",
    "A file uploaded into a set is a row of the set's manifest, which carries the set's label."
  ),
  "POST /file-sets/:file_set_id/close": from("file_set", "file_set_id", "Closing a set changes the set's own row."),
  "POST /file-sets/:file_set_id/rehash": from(
    "file_set",
    "file_set_id",
    "Walking a registered directory again rewrites the set's manifest, at the set's label."
  ),
  "PATCH /file-sets/:file_set_id": from("file_set", "file_set_id", "Switching a set off or on changes the set's own row."),

  // ---- a shown page leaves the deployment: members-only deployments only ----
  "POST /outbound/send": { rule: "none", why: OUTBOUND },
  "POST /outbound/packages/:package_id/file": { rule: "none", why: OUTBOUND },
  "POST /outbound/proposals": { rule: "none", why: OUTBOUND },
  "POST /outbound/proposals/:proposal_id/release": { rule: "none", why: OUTBOUND },
  "POST /outbound/registration": { rule: "none", why: "Signs a statement with the deployment's key and writes nothing." },

  // ---- published pages ----
  "POST /publishers": { rule: "chosen", why: "A registration is new: the record that an account publishes for a deployment's key." },
  "POST /published-pages": { rule: "chosen", why: "A published page is new material, as a submitted source is." },

  // ---- the operator key ----
  "POST /operator/administrators": { rule: "none", why: OPERATOR },
  "POST /operator/platform-mandates/fund": { rule: "none", why: OPERATOR },
  "POST /operator/platform-grantmaking-keys": { rule: "none", why: OPERATOR },
  "DELETE /operator/platform-grantmaking-keys/:id": { rule: "none", why: OPERATOR },
};

/** Whether the rule lets the person name a label in the request's body. */
export function takesChosenLabel(rule: RequestLabelRule | undefined): boolean {
  return rule !== undefined && (rule.rule === "chosen" || (rule.rule === "from" && rule.otherwise === "chosen"));
}
