/**
 * Contribution service -- DB operations for contributions, reviews, appeals.
 */
import { eq, sql, desc, inArray } from "drizzle-orm";
import { getDb, rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { enqueueContribution } from "./queue-service.js";
import { getRequest } from "./request-service.js";
import { CLOSED_REQUEST_STATES } from "../schemas/kinds.js";
import { grantCommittedMicroUsd } from "./regrant-service.js";
import {
  contributions,
  contributionReviews,
  appeals,
  arbitrationResults,
  contributors,
  type NewContribution,
} from "../db/schema.js";

/**
 * The review cost a submission reserves against its run's budget until its
 * review has run: the average real cost of recent reviews, or the
 * configured estimate while there are none to average.
 */
export async function reviewCostEstimateMicroUsd(): Promise<number> {
  const [row] = await rawQuery<{ avg: string | null }>(
    `SELECT avg(review_cost_micro_usd)::bigint AS avg FROM (
       SELECT review_cost_micro_usd FROM contributions
        WHERE review_cost_micro_usd > 0
        ORDER BY submitted_at DESC LIMIT 50) recent`
  );
  const avg = row?.avg == null ? 0 : Number(row.avg);
  return avg > 0 ? avg : Math.round(loadConfig().contributionReviewEstimateUsd * 1_000_000);
}

export interface MandateContributionBudget {
  budgetMicroUsd: number;
  /** Real review costs of the run's reviewed contributions plus the estimate reserved for each one not yet reviewed. */
  committedMicroUsd: number;
  submitted: number;
}

/** Where a run's delegated contribution budget stands, unreviewed submissions reserved at `estimate`. */
export async function mandateContributionBudget(
  researchRunId: string,
  estimate: number,
  run: { query: <T>(q: string, p?: unknown[]) => Promise<T[]> } = { query: rawQuery }
): Promise<MandateContributionBudget> {
  const [row] = await run.query<{ budget: string; committed: string; submitted: string }>(
    `SELECT r.contribution_budget_micro_usd::bigint AS budget,
            COALESCE(SUM(COALESCE(c.review_cost_micro_usd, $2::bigint)), 0)::bigint AS committed,
            COUNT(c.id) AS submitted
       FROM research_runs r LEFT JOIN contributions c ON c.research_run_id = r.id
      WHERE r.id = $1
      GROUP BY r.id`,
    [researchRunId, estimate]
  );
  return {
    budgetMicroUsd: Number(row?.budget ?? 0),
    committedMicroUsd: Number(row?.committed ?? 0),
    submitted: Number(row?.submitted ?? 0),
  };
}

const usdText = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/**
 * The review budget as the agents working under it see it: what is
 * committed, what is left, and what a review is expected to cost.
 */
export function contributionBudgetLine(budget: MandateContributionBudget, estimate: number): string {
  const left = Math.max(0, budget.budgetMicroUsd - budget.committedMicroUsd);
  const more = estimate > 0 ? Math.floor(left / estimate) : 0;
  return (
    `Contribution reviews: ${usdText(budget.committedMicroUsd)} of ${usdText(budget.budgetMicroUsd)} committed ` +
    `across ${budget.submitted} submission${budget.submitted === 1 ? "" : "s"}, ${usdText(left)} left. ` +
    `A review is estimated at ${usdText(estimate)} (the average of recent reviews), so about ${more} more ` +
    `submission${more === 1 ? "" : "s"} fit. Reviews not yet run count at the estimate until their real cost is known.`
  );
}

/**
 * A contribution submitted by research a mandate funds (Part VIII): filed
 * under the mandate's funder account but shown as "a funded mandate", its
 * review metered to the mandate's budget job and paid from the review
 * budget the run's Grantmaker delegated. A submission reserves the
 * estimated cost of its review and is refused when that would exceed the
 * budget; once reviewed, its real cost replaces the estimate. Refusals come
 * back as a message the researcher can act on.
 */
export async function submitMandateContribution(input: {
  researchRunId: string;
  input: Record<string, unknown>;
}): Promise<{ success: boolean; message: string; contribution_id?: string; budget?: string }> {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const claimId = text(input.input.claim_id);
  const type = text(input.input.contribution_type);
  const content = text(input.input.content);
  const allowed: readonly string[] = RESEARCH_CONTRIBUTION_TYPES;
  if (!allowed.includes(type)) return { success: false, message: `contribution_type must be one of ${allowed.join(", ")}.` };
  if (content.length < 40) return { success: false, message: "content must say what you found and what it rests on." };
  const [node] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id::text = $1 AND state = 'active'`, [claimId]);
  if (!node) return { success: false, message: `No active node ${claimId}.` };
  const structural = await checkStructuralProposal(type, claimId, input.input);
  if (!structural.ok) return { success: false, message: structural.message };
  const urls = Array.isArray(input.input.evidence_urls)
    ? input.input.evidence_urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20)
    : [];
  const estimate = await reviewCostEstimateMicroUsd();

  const outcome = await withTransaction(async (tx) => {
    // The run row is the lock: two submissions from one run cannot both
    // reserve the budget's last dollars.
    const [run] = await tx.query<{ grant_id: string | null; job_id: string | null; requested_by: string }>(
      `SELECT grant_id, job_id, requested_by FROM research_runs WHERE id = $1 FOR UPDATE`,
      [input.researchRunId]
    );
    if (!run || run.requested_by !== "grantmaker" || !run.grant_id) {
      return { success: false as const, message: "Only research a mandate funds submits contributions." };
    }
    const [grant] = await tx.query<{ funder_user_id: string }>(`SELECT funder_user_id FROM grants WHERE id = $1`, [run.grant_id]);
    if (!grant) return { success: false as const, message: "The mandate behind this run no longer exists." };
    const budget = await mandateContributionBudget(input.researchRunId, estimate, tx);
    if (budget.committedMicroUsd + estimate > budget.budgetMicroUsd) {
      return {
        success: false as const,
        message:
          `The review budget delegated to this run does not cover another review. ` +
          `${contributionBudgetLine(budget, estimate)} Put the rest of what you found in your report.`,
      };
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO contributions
         (claim_id, contributor_id, contribution_type, content, evidence_urls, grant_id, funded_by_job_id, research_run_id,
          merge_target_claim_id, proposed_canonical_form)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        claimId,
        grant.funder_user_id,
        type,
        content.slice(0, 10_000),
        urls,
        run.grant_id,
        run.job_id,
        input.researchRunId,
        structural.mergeTarget,
        structural.proposedText,
      ]
    );
    const after = { ...budget, committedMicroUsd: budget.committedMicroUsd + estimate, submitted: budget.submitted + 1 };
    return { success: true as const, id: row!.id, budget: contributionBudgetLine(after, estimate) };
  });
  if (!outcome.success) return outcome;
  await enqueueContribution({ contributionId: outcome.id });
  return {
    success: true,
    message: `Contribution ${outcome.id} submitted for review under the mandate.`,
    contribution_id: outcome.id,
    budget: outcome.budget,
  };
}

/** The contributions a mandate's research may submit: on existing nodes. */
export const MANDATE_CONTRIBUTION_TYPES = [
  "challenge",
  "support",
  "add_instance",
  "add_estimate",
  "propose_argument",
  "propose_answer",
  "propose_request",
  "answer_request",
] as const;

/**
 * The structural proposals any caller may make (#699): two nodes that are
 * one (propose_merge, naming the other node), one node that is two
 * (propose_split), a better canonical wording (propose_edit). A Grantmaker
 * or lookout surveying a territory is well placed to notice these (Part
 * VIII), and §19 lets it contribute "like anyone". propose_source is not
 * here: a mandate brings a source in directly, as an ingest plan item paid
 * from its own escrow.
 */
export const CURATION_CONTRIBUTION_TYPES = ["propose_merge", "propose_split", "propose_edit"] as const;

/**
 * What research a mandate funds may submit: contributions on existing
 * nodes, and the structural proposals among them (#832). A consistency
 * audit is where duplicates turn up; filed as a challenge instead, a merge
 * case goes to the node's Steward rather than to the Curator, who
 * adjudicates merges and splits (§5). New claims and questions stay with
 * the Grantmaker, which sees the whole mandate.
 */
export const RESEARCH_CONTRIBUTION_TYPES = [...MANDATE_CONTRIBUTION_TYPES, ...CURATION_CONTRIBUTION_TYPES] as const;

/**
 * The fields a structural proposal needs beyond its node: for a merge, the
 * other active node it duplicates; for an edit, the wording proposed.
 */
async function checkStructuralProposal(
  type: string,
  claimId: string,
  input: Record<string, unknown>
): Promise<{ ok: true; mergeTarget: string | null; proposedText: string | null } | { ok: false; message: string }> {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (type === "propose_merge") {
    const mergeTarget = text(input.merge_target_claim_id);
    const [other] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id::text = $1 AND state = 'active'`, [mergeTarget]);
    if (!other || mergeTarget === claimId) {
      return { ok: false, message: "propose_merge needs merge_target_claim_id: the other active node, which this one duplicates." };
    }
    return { ok: true, mergeTarget, proposedText: null };
  }
  if (type === "propose_edit") {
    const proposed = text(input.proposed_text);
    if (!proposed) return { ok: false, message: "propose_edit needs proposed_text: the canonical wording you propose." };
    if (proposed.length > 2000) return { ok: false, message: "proposed_text is too long: a claim or question, not an essay." };
    return { ok: true, mergeTarget: null, proposedText: proposed };
  }
  return { ok: true, mergeTarget: null, proposedText: null };
}

/** What a mandate's Grantmaker (and its lookouts) may submit: the same, structural proposals, and new claims and questions. */
export const GRANTMAKER_CONTRIBUTION_TYPES = [
  ...MANDATE_CONTRIBUTION_TYPES,
  ...CURATION_CONTRIBUTION_TYPES,
  "propose_claim",
  "propose_question",
] as const;

/**
 * A contribution a live mandate's Grantmaker submits (constitution §19: a
 * mandate's agents write nothing to the graph directly, and like anyone may
 * contribute through the Contribution Reviewer, paying for the review). It
 * is filed under the funder's account and shown as "a funded mandate", its
 * review metered to the mandate's budget job. A proposed claim or question
 * has no node yet: it is an intake contribution, and an accept materializes
 * it through the Matcher. Before writing, the mandate's uncommitted escrow
 * must cover the estimated review, counting the reviews still pending on
 * its earlier submissions.
 */
export async function submitGrantContribution(input: {
  grantId: string;
  input: Record<string, unknown>;
}): Promise<{ success: boolean; message: string; contribution_id?: string }> {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const type = text(input.input.contribution_type);
  const content = text(input.input.content);
  const claimId = text(input.input.claim_id);
  const proposed = text(input.input.proposed_text);
  if (!(GRANTMAKER_CONTRIBUTION_TYPES as readonly string[]).includes(type)) {
    return { success: false, message: `contribution_type must be one of ${GRANTMAKER_CONTRIBUTION_TYPES.join(", ")}.` };
  }
  if (content.length < 40) {
    return { success: false, message: "content must say what you found and what it rests on, or why the question needs asking." };
  }
  const intake = type === "propose_claim" || type === "propose_question";
  // A request may bear on several nodes, sources, or something the graph
  // does not hold yet (Part VIII, #724): with no node named, content says
  // what it bears on and the review settles it.
  const unanchoredRequest = type === "propose_request" && !claimId;
  if (intake) {
    if (!proposed) return { success: false, message: `${type} needs proposed_text: the wording you propose.` };
    if (proposed.length > 2000) return { success: false, message: "proposed_text is too long: a claim or question, not an essay." };
  } else if (!unanchoredRequest) {
    const [node] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id::text = $1 AND state = 'active'`, [claimId]);
    if (!node) return { success: false, message: `No active node ${claimId || "(none given)"}; ${type} is about an existing node.` };
  }
  const structural = await checkStructuralProposal(type, claimId, input.input);
  if (!structural.ok) return { success: false, message: structural.message };
  const urls = Array.isArray(input.input.evidence_urls)
    ? input.input.evidence_urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20)
    : [];
  const estimate = await reviewCostEstimateMicroUsd();

  const outcome = await withTransaction(async (tx) => {
    // The grant row is the lock: two submissions cannot both reserve the
    // escrow's last dollars.
    const [grant] = await tx.query<{ funder_user_id: string; status: string; budget_job_id: string; budget: string }>(
      `SELECT g.funder_user_id, g.status, g.budget_job_id, j.budget_micro_usd AS budget
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
        WHERE g.id = $1 FOR UPDATE OF g`,
      [input.grantId]
    );
    if (!grant) return { success: false as const, message: "The mandate does not exist." };
    if (grant.status !== "active") {
      return { success: false as const, message: `The mandate is ${grant.status}; contributions are paid from a live mandate's escrow.` };
    }
    const committed = await grantCommittedMicroUsd({ id: input.grantId, budgetJobId: grant.budget_job_id }, tx);
    // Reviews not yet run are not metered yet: reserve the estimate for each.
    const [pending] = await tx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM contributions
        WHERE grant_id = $1 AND research_run_id IS NULL
          AND review_status = 'pending' AND review_cost_micro_usd IS NULL`,
      [input.grantId]
    );
    const left = Number(grant.budget) - committed - Number(pending?.n ?? 0) * estimate;
    if (left < estimate) {
      return {
        success: false as const,
        message:
          `The mandate's uncommitted escrow (${usdText(Math.max(0, left))}) does not cover a review ` +
          `(about ${usdText(estimate)}).`,
      };
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO contributions
         (claim_id, contributor_id, contribution_type, content, proposed_canonical_form,
          evidence_urls, grant_id, funded_by_job_id, merge_target_claim_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        intake || unanchoredRequest ? null : claimId,
        grant.funder_user_id,
        type,
        content.slice(0, 10_000),
        intake ? proposed : structural.proposedText,
        urls,
        input.grantId,
        grant.budget_job_id,
        structural.mergeTarget,
      ]
    );
    return { success: true as const, id: row!.id, left: left - estimate };
  });
  if (!outcome.success) return outcome;
  await enqueueContribution({ contributionId: outcome.id });
  return {
    success: true,
    message:
      `Contribution ${outcome.id} submitted for review under the mandate; its review (about ` +
      `${usdText(estimate)}) is paid from the escrow, about ${usdText(Math.max(0, outcome.left))} of which ` +
      `is left uncommitted.`,
    contribution_id: outcome.id,
  };
}

/** How a contribution from a mandate's research is shown: the arrangement, not the funder. */
export const MANDATE_LABEL = "a funded mandate";

export async function createContribution(input: {
  /** Null only for a propose_request that names no node (#724). */
  claimId: string | null;
  contributorId: string;
  contributionType: string;
  content: string;
  evidenceUrls?: string[];
  mergeTargetClaimId?: string;
  proposedCanonicalForm?: string;
  /** Submitted by research a mandate funds (Part VIII): the mandate, and the job its review is metered to. */
  grantId?: string | null;
  fundedByJobId?: string | null;
}) {
  const db = getDb();
  const values: NewContribution = {
    claimId: input.claimId,
    contributorId: input.contributorId,
    contributionType: input.contributionType,
    content: input.content,
    evidenceUrls: input.evidenceUrls ?? [],
    mergeTargetClaimId: input.mergeTargetClaimId ?? null,
    proposedCanonicalForm: input.proposedCanonicalForm ?? null,
    grantId: input.grantId ?? null,
    fundedByJobId: input.fundedByJobId ?? null,
  };

  const [contribution] = await db
    .insert(contributions)
    .values(values)
    .returning();

  return contribution!;
}

export async function getContributionById(id: string) {
  const db = getDb();
  const [contribution] = await db
    .select()
    .from(contributions)
    .where(eq(contributions.id, id))
    .limit(1);
  return contribution ?? null;
}

export async function listContributions(filters: {
  claimId?: string;
  contributorId?: string;
  status?: string;
  contributionType?: string;
  limit: number;
  offset: number;
}) {
  const db = getDb();

  let conditions = sql`1=1`;
  if (filters.claimId) {
    conditions = sql`${conditions} AND ${contributions.claimId} = ${filters.claimId}`;
  }
  if (filters.contributorId) {
    conditions = sql`${conditions} AND ${contributions.contributorId} = ${filters.contributorId}`;
  }
  if (filters.status) {
    conditions = sql`${conditions} AND ${contributions.reviewStatus} = ${filters.status}`;
  }
  if (filters.contributionType) {
    conditions = sql`${conditions} AND ${contributions.contributionType} = ${filters.contributionType}`;
  }

  const rows = await db
    .select()
    .from(contributions)
    .where(conditions)
    .orderBy(desc(contributions.submittedAt))
    .limit(filters.limit)
    .offset(filters.offset);

  return rows;
}

export async function getReviewForContribution(contributionId: string) {
  const db = getDb();
  // The decision in force: an audit re-review marks the old row superseded
  // (#180), and an appeal must attach to the live decision, not history.
  const [review] = await db
    .select()
    .from(contributionReviews)
    .where(
      sql`${contributionReviews.contributionId} = ${contributionId} AND ${contributionReviews.superseded} = false`
    )
    .orderBy(desc(contributionReviews.reviewedAt))
    .limit(1);
  return review ?? null;
}

export async function createAppeal(input: {
  contributionId: string;
  originalReviewId: string;
  appellantId: string;
  appealReasoning: string;
}) {
  const db = getDb();
  const [appeal] = await db
    .insert(appeals)
    .values({
      contributionId: input.contributionId,
      originalReviewId: input.originalReviewId,
      appellantId: input.appellantId,
      appealReasoning: input.appealReasoning,
    })
    .returning();

  return appeal!;
}

export async function getAppealById(id: string) {
  const db = getDb();
  const [appeal] = await db
    .select()
    .from(appeals)
    .where(eq(appeals.id, id))
    .limit(1);
  return appeal ?? null;
}

// The assembled public record for one claim (#171): every contribution with
// its review, latest appeal, and arbitration outcome, plus display names for
// attribution. The constitution's Burden of Engagement makes this exchange
// part of the claim's public record, so it is read as one unit rather than
// stitched together client-side from the single-record endpoints.
export async function getContributionRecordForClaim(claimId: string) {
  const db = getDb();

  const rows = await db
    .select({
      contribution: contributions,
      contributorDisplayName: contributors.displayName,
    })
    .from(contributions)
    .innerJoin(contributors, eq(contributions.contributorId, contributors.id))
    .where(eq(contributions.claimId, claimId))
    .orderBy(desc(contributions.submittedAt));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.contribution.id);

  const [reviewRows, appealRows, arbitrationRows] = await Promise.all([
    db
      .select()
      .from(contributionReviews)
      .where(inArray(contributionReviews.contributionId, ids)),
    db
      .select({
        appeal: appeals,
        appellantDisplayName: contributors.displayName,
      })
      .from(appeals)
      .innerJoin(contributors, eq(appeals.appellantId, contributors.id))
      .where(inArray(appeals.contributionId, ids))
      .orderBy(desc(appeals.submittedAt)),
    db
      .select()
      .from(arbitrationResults)
      .where(inArray(arbitrationResults.contributionId, ids))
      .orderBy(desc(arbitrationResults.arbitratedAt)),
  ]);

  const reviewFor = new Map(reviewRows.map((r) => [r.contributionId, r]));
  // Rows arrive newest-first; first write wins, so each map holds the latest.
  const appealFor = new Map<string, (typeof appealRows)[number]>();
  for (const row of appealRows) {
    if (!appealFor.has(row.appeal.contributionId)) {
      appealFor.set(row.appeal.contributionId, row);
    }
  }
  const arbitrationFor = new Map<string, (typeof arbitrationRows)[number]>();
  for (const row of arbitrationRows) {
    if (!arbitrationFor.has(row.contributionId)) {
      arbitrationFor.set(row.contributionId, row);
    }
  }

  return rows.map((row) => {
    const appealRow = appealFor.get(row.contribution.id);
    return {
      contribution: row.contribution,
      // A mandate's contribution names the arrangement, never the party (§12/§19).
      contributorDisplayName: row.contribution.grantId ? MANDATE_LABEL : row.contributorDisplayName,
      review: reviewFor.get(row.contribution.id) ?? null,
      appeal: appealRow
        ? {
            ...appealRow.appeal,
            appellantDisplayName: appealRow.appellantDisplayName,
          }
        : null,
      arbitration: arbitrationFor.get(row.contribution.id) ?? null,
    };
  });
}

export async function getArbitrationForContribution(contributionId: string) {
  const db = getDb();
  const [result] = await db
    .select()
    .from(arbitrationResults)
    .where(eq(arbitrationResults.contributionId, contributionId))
    .limit(1);
  return result ?? null;
}

/**
 * A contribution as a caller sees it, on REST (`GET /contributions/:id`,
 * `GET /contributions`) and MCP (get_contribution_status) alike, so the two
 * cannot drift (#723).
 */
export function formatContribution(c: {
  id: string;
  // Null while an intake contribution is pending review (#157).
  claimId: string | null;
  contributorId: string;
  contributionType: string;
  content: string;
  evidenceUrls: string[];
  submittedAt: Date;
  reviewStatus: string;
  mergeTargetClaimId: string | null;
  proposedCanonicalForm: string | null;
  grantId?: string | null;
}) {
  return {
    id: c.id,
    claim_id: c.claimId,
    // A mandate's contribution does not name its funder (§12/§19).
    contributor_id: c.grantId ? null : c.contributorId,
    contribution_type: c.contributionType,
    content: c.content,
    evidence_urls: c.evidenceUrls,
    submitted_at: c.submittedAt.toISOString(),
    review_status: c.reviewStatus,
    merge_target_claim_id: c.mergeTargetClaimId,
    proposed_canonical_form: c.proposedCanonicalForm,
    // The node's page on the public site: the claim contributed to, or, for
    // an accepted proposal, the claim, question or quantity it became (which
    // may still be under assessment). Null while a proposal is pending.
    page_url: c.claimId
      ? `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${c.claimId}`
      : null,
    // Set only for an accepted propose_claim / propose_question: the node it
    // became or landed on, so the contributor can follow it. (An accepted
    // propose_source mints its claims through extraction, not here.)
    became_claim_id:
      c.claimId &&
      (c.contributionType === "propose_claim" || c.contributionType === "propose_question")
        ? c.claimId
        : null,
  };
}

/**
 * An answer_request names the request it is offered for. The reviewer must
 * name that request to accept it (review_contribution's request_id), and a
 * contribution has no column for one, so the id rides at the head of the
 * content where the reviewer reads it (#723). The request must bear on the
 * node the contribution is filed on and still be open. Any other type takes
 * no request_id.
 */
export async function withAnsweredRequest(input: {
  contributionType: string;
  // Absent only for a propose_request (#724); an answer_request always names its node.
  claimId?: string | null;
  requestId?: string | null;
  content: string;
}): Promise<{ ok: true; content: string } | { ok: false; code: string; message: string }> {
  const requestId = input.requestId?.trim() || null;
  if (input.contributionType !== "answer_request") {
    if (!requestId) return { ok: true, content: input.content };
    return {
      ok: false,
      code: "REQUEST_ID_NOT_EXPECTED",
      message: "request_id goes only with contribution_type answer_request",
    };
  }
  if (!requestId) {
    return {
      ok: false,
      code: "REQUEST_ID_REQUIRED",
      message:
        "An answer_request needs request_id, the request the material is offered for " +
        "(get_claim lists a node's open requests; list_requests finds others)",
    };
  }
  const request = await getRequest(requestId);
  if (!request) return { ok: false, code: "REQUEST_NOT_FOUND", message: `No request ${requestId}` };
  if (!request.bears_on.some((n) => n.id === input.claimId)) {
    return {
      ok: false,
      code: "REQUEST_NOT_ON_NODE",
      message:
        `Request ${requestId} does not bear on ${input.claimId}; file the answer on a node it bears on: ` +
        (request.bears_on.map((n) => n.id).join(", ") || "it names none, so it cannot be answered here"),
    };
  }
  if (CLOSED_REQUEST_STATES.includes(request.state)) {
    return {
      ok: false,
      code: "REQUEST_CLOSED",
      message: `Request ${requestId} is ${request.state}; it takes no more material`,
    };
  }
  return { ok: true, content: `Answers request ${requestId}.\n\n${input.content}` };
}
