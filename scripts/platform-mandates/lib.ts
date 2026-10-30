/**
 * Pure logic for platform-mandate funding requests (#529): the request
 * file's shape, the check of a request against the live conversation, and
 * the pull-request body that lays the draft out for review. No network and
 * no database, so the PR check, the funding workflow, and the tests share
 * one definition of what a valid request is.
 *
 * A request file (mandates/platform/<slug>.json) is the platform's funding
 * decision, not its mandate: the mandate is the Grantmaker's draft, carried
 * here as a snapshot for reviewers with the hash that pins it. The only
 * words in the file that are the platform's own are the rationale, which
 * says why Minerval puts money behind this draft. It appears in the pull
 * request and nowhere on the graph.
 */
import { mandateDraftHash } from "../../src/services/mandate-draft-hash.js";

/** The same ceiling the fund routes accept. */
export const MAX_BUDGET_OWLS = 10_000;

export interface DraftSnapshot {
  title: string;
  objective: string;
  scope_claim_id?: string | null;
  scope_query?: string | null;
  plan: { strategy?: string; items: Array<Record<string, unknown>> };
  expected_cost_owls: number;
  notes?: string;
  skills?: string[];
  [key: string]: unknown;
}

export interface PlatformMandateRequest {
  conversation_id: string;
  budget_owls: number;
  rationale: string;
  mandate_sha256: string;
  draft: DraftSnapshot;
}

/** What the public conversation route returns (GET /grant-conversations/platform/:id). */
export interface PublicPlatformConversation {
  id: string;
  status: string;
  messages: Array<{ role: "user" | "assistant"; content: string; at?: string }>;
  draft: DraftSnapshot | null;
  draft_sha256: string | null;
  /** The Grantmaker's turn: "replying" until the reply lands. */
  turn?: { state: "replying" | "idle" | "failed"; error: string | null };
  grant_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Validated =
  | { ok: true; request: PlatformMandateRequest }
  | { ok: false; problems: string[] };

/** Validate a parsed request file on its own terms (no network). */
export function validateRequest(raw: unknown, slug: string): Validated {
  const problems: string[] = [];
  if (!SLUG.test(slug)) {
    problems.push(`the file name "${slug}" is not a lowercase-hyphenated slug`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problems: [...problems, "the file is not a JSON object"] };
  }
  const r = raw as Record<string, unknown>;
  const allowed = new Set(["conversation_id", "budget_owls", "rationale", "mandate_sha256", "draft"]);
  for (const key of Object.keys(r)) {
    if (!allowed.has(key)) problems.push(`unknown field "${key}"`);
  }
  if (typeof r.conversation_id !== "string" || !UUID.test(r.conversation_id)) {
    problems.push("conversation_id must be the platform conversation's uuid");
  }
  const budget = r.budget_owls;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0 || budget > MAX_BUDGET_OWLS) {
    problems.push(`budget_owls must be a number above 0 and at most ${MAX_BUDGET_OWLS}`);
  }
  if (typeof r.rationale !== "string" || r.rationale.trim().length < 20) {
    problems.push("rationale must say, in a sentence or more, why Minerval funds this");
  }
  if (typeof r.mandate_sha256 !== "string" || !SHA256.test(r.mandate_sha256)) {
    problems.push("mandate_sha256 must be a lowercase hex SHA-256");
  }
  const draft = r.draft as DraftSnapshot | undefined;
  if (
    !draft ||
    typeof draft !== "object" ||
    typeof draft.title !== "string" ||
    typeof draft.objective !== "string" ||
    !draft.plan ||
    !Array.isArray(draft.plan.items) ||
    typeof draft.expected_cost_owls !== "number"
  ) {
    problems.push("draft must be the Grantmaker's draft exactly as the conversation holds it");
  } else {
    if (typeof r.mandate_sha256 === "string" && mandateDraftHash(draft) !== r.mandate_sha256) {
      problems.push("mandate_sha256 does not hash the draft in this file; the snapshot was edited or the hash is stale");
    }
    if (typeof budget === "number" && budget < draft.expected_cost_owls) {
      problems.push(
        `budget_owls (${budget}) is below the Grantmaker's quote (${draft.expected_cost_owls}); unspent budget refunds, so fund at least the quote`
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, request: r as unknown as PlatformMandateRequest };
}

export type ConversationCheck =
  | { state: "fundable" }
  | { state: "funded"; grantId: string }
  | { state: "refused"; problem: string };

/** Check a valid request against the live public conversation. */
export function checkAgainstConversation(
  request: PlatformMandateRequest,
  convo: PublicPlatformConversation | null
): ConversationCheck {
  if (!convo) {
    return { state: "refused", problem: "no platform granting conversation has that id" };
  }
  if (convo.draft_sha256 !== request.mandate_sha256) {
    return {
      state: "refused",
      problem:
        convo.status === "funded"
          ? "the conversation was funded with a different draft than this file pins"
          : `the Grantmaker's draft has changed since this file pinned it (now ${convo.draft_sha256 ?? "none"}); write the request again from the current draft`,
    };
  }
  if (convo.status === "funded" && convo.grant_id) {
    return { state: "funded", grantId: convo.grant_id };
  }
  if (convo.status !== "proposed") {
    return {
      state: "refused",
      problem: `the conversation is ${convo.status}, not proposed: there is no standing draft to fund`,
    };
  }
  return { state: "fundable" };
}

/** Build a request file's contents from a proposed conversation. */
export function buildRequest(input: {
  convo: PublicPlatformConversation;
  budgetOwls: number;
  rationale: string;
}): PlatformMandateRequest {
  const { convo } = input;
  if (convo.status !== "proposed" || !convo.draft || !convo.draft_sha256) {
    throw new Error(`the conversation is ${convo.status}; only a proposed draft can be requested`);
  }
  return {
    conversation_id: convo.id,
    budget_owls: input.budgetOwls,
    rationale: input.rationale.trim(),
    mandate_sha256: mandateDraftHash(convo.draft),
    draft: convo.draft,
  };
}

/** Pretty JSON with a trailing newline, as the request files are committed. */
export function serializeRequest(request: PlatformMandateRequest): string {
  return JSON.stringify(request, null, 2) + "\n";
}

/**
 * The pull request's body: the platform's rationale and budget, the
 * Grantmaker's draft laid out for review, and the conversation that
 * produced it. The reviewer approves the money; the mandate is the draft.
 */
export function renderPullRequestBody(input: {
  request: PlatformMandateRequest;
  convo: PublicPlatformConversation;
  slug: string;
  conversationUrl: string;
}): string {
  const { request, convo, slug } = input;
  const d = request.draft;
  const lines: string[] = [];
  lines.push(`## Platform funding request: ${d.title}`);
  lines.push("");
  lines.push(
    `Merging this pull request funds the Grantmaker's draft below with **${request.budget_owls} owls** of ` +
      `Minerval's money, bought at cost. The draft is pinned by its hash; if the Grantmaker revises it, ` +
      `the funding is refused and the request has to be written again. The Grantmaker wrote the mandate ` +
      `and could have declined it; this request is only the decision to pay for it.`
  );
  lines.push("");
  lines.push("### Why Minerval funds this");
  lines.push("");
  lines.push(request.rationale);
  lines.push("");
  lines.push("### The Grantmaker's draft");
  lines.push("");
  lines.push(`**Objective.** ${d.objective}`);
  if (d.plan.strategy) {
    lines.push("");
    lines.push(`**Strategy.** ${d.plan.strategy}`);
  }
  lines.push("");
  lines.push(`**Quote.** ${d.expected_cost_owls} owls (an estimate and a ceiling; actual spend is metered, and unspent budget refunds).`);
  if (d.scope_query) lines.push(`**Scope.** ${d.scope_query}`);
  if (d.scope_claim_id) lines.push(`**Scope claim.** \`${d.scope_claim_id}\``);
  if (d.skills && d.skills.length > 0) lines.push(`**Skills.** ${d.skills.join(", ")}`);
  if (d.plan.items.length > 0) {
    lines.push("");
    const n = d.plan.items.length;
    lines.push(`**Plan** (${n} ${n === 1 ? "item" : "items"}):`);
    lines.push("");
    for (const item of d.plan.items.slice(0, 50)) {
      const action = String(item.action ?? "item");
      const target = String(item.claim_id ?? item.url ?? "").slice(0, 160);
      const why = item.rationale ? ` — ${String(item.rationale).slice(0, 200)}` : "";
      lines.push(`- \`${action}\` ${target}${why}`);
    }
    if (d.plan.items.length > 50) lines.push(`- … and ${d.plan.items.length - 50} more (see the file)`);
  }
  if (d.notes) {
    lines.push("");
    lines.push(`**The Grantmaker's notes.** ${d.notes}`);
  }
  lines.push("");
  lines.push("### Record");
  lines.push("");
  lines.push(`- Request file: \`mandates/platform/${slug}.json\``);
  lines.push(`- Conversation (public): ${input.conversationUrl}`);
  lines.push(`- Draft SHA-256: \`${request.mandate_sha256}\``);
  lines.push("");
  lines.push("<details><summary>The granting conversation</summary>");
  lines.push("");
  for (const m of convo.messages) {
    lines.push(`**${m.role === "user" ? "Minerval" : "Grantmaker"}:**`);
    lines.push("");
    lines.push(m.content.trim());
    lines.push("");
  }
  lines.push("</details>");
  return lines.join("\n");
}
