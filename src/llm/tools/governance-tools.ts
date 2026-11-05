/**
 * Shared read tools for governance agents.
 *
 * These give agents the ability to gather context about claims, contributions,
 * and contributors before making decisions.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { eq, sql, desc } from "drizzle-orm";
import { getDb, rawQuery } from "../../db/client.js";
import {
  claims,
  sources,
  contributions,
  contributionReviews,
  contributors,
  appeals,
  arbitrationResults,
} from "../../db/schema.js";
import { trustLevelFor } from "../../services/reputation-service.js";
import { microUsdToOwls } from "../../services/owl.js";
import {
  DEFAULT_INSTANCE_PAGE,
  MAX_INSTANCE_PAGE,
  getClaimInstancePage,
} from "../../services/claim-instance-service.js";
import { getClaimDependents as fetchClaimDependents } from "../../services/tree-service.js";
import { executeGraphReadTool, getClaimToolDefinition } from "./graph-read-tools.js";

export function getGovernanceToolDefinitions(): Tool[] {
  return [
    // The one get_claim every agent and MCP share (#774): the governance
    // roles read the same view, asking for the sections they need.
    getClaimToolDefinition(),
    {
      name: "get_claim_instances",
      description:
        "Read the instances the graph currently records for a claim: each " +
        "source that asserts, denies, poses or mentions the proposition " +
        "(each with its stance; a mention takes no side), with the " +
        "passage, its attribution (speaker, publication, date, link), any " +
        "reading recorded from opening the source, what it was recorded as " +
        "drawing on, and where the source sits in the claim's provenance " +
        "story. These are the instances recorded so far, not a sample of the " +
        "discourse, and not necessarily the right set; the claim's Steward " +
        "decides which instances the claim should carry. They come in the " +
        "order a reader sees them: the Steward's chosen order first, then " +
        "origins before what derives from them, then by date. Paged: pass " +
        "offset to continue when has_more is true.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim",
          },
          limit: {
            type: "integer",
            description: `How many instances to return (default ${DEFAULT_INSTANCE_PAGE}, at most ${MAX_INSTANCE_PAGE}).`,
          },
          offset: {
            type: "integer",
            description: "How many to skip, for the next page (default 0).",
          },
          include_detached: {
            type: "boolean",
            description:
              "Also return instances the Steward detached from the claim, " +
              "after the rest, each with why it was detached. Default false.",
          },
        },
        required: ["claim_id"],
      },
    },
    {
      name: "get_contribution_details",
      description:
        "Get full details about a contribution, including the contributor, " +
        "the target claim, any existing review, the reviewer's escalation " +
        "reason, any appeals (with the appellant's reasoning), and prior " +
        "arbitration results. Pass contribution_id, or a review_id (as " +
        "get_recent_decisions returns) to load the contribution that " +
        "review decided.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the contribution",
          },
          review_id: {
            type: "string",
            description:
              "The UUID of a review decision; loads the contribution it " +
              "reviewed. Use when you have a review but not its contribution.",
          },
        },
      },
    },
    {
      name: "get_contributor_profile",
      description:
        "Get a contributor's profile including reputation score, acceptance " +
        "history, and trust level.",
      input_schema: {
        type: "object" as const,
        properties: {
          contributor_id: {
            type: "string",
            description: "The UUID of the contributor",
          },
        },
        required: ["contributor_id"],
      },
    },
    {
      name: "get_claim_dependents",
      description:
        "Get the nodes that depend on a given one: those that have it as a " +
        "subclaim, answer, or subquestion, and, for a quantity, the claims " +
        "that cut it (say which side of a figure it lies; relation 'cuts'), " +
        "whose credence must agree with its estimate. Each comes with its " +
        "status, confidence and credence. Use it to see whom a change of " +
        "judgment could matter to.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim to find dependents of",
          },
        },
        required: ["claim_id"],
      },
    },
    {
      name: "get_recent_decisions",
      description:
        "List contribution review decisions in force, newest first, with " +
        "each one's reasoning, confidence, the sections it cites, and any " +
        "bad-faith flag. Superseded reviews (replaced by a re-review) are " +
        "left out. Each row carries the contribution_id, so " +
        "get_contribution_details can load what was reviewed. Paged: pass " +
        "offset to continue when has_more is true.",
      input_schema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "integer",
            description: `Maximum number of results (default 20, at most ${MAX_DECISION_PAGE})`,
          },
          offset: {
            type: "integer",
            description: "How many to skip, for the next page (default 0)",
          },
          decision_filter: {
            type: "string",
            enum: ["accept", "reject", "escalate"],
            description: "Only decisions of this kind",
          },
          contributor_id: {
            type: "string",
            description: "Only decisions on this contributor's contributions",
          },
          claim_id: {
            type: "string",
            description: "Only decisions on contributions targeting this claim",
          },
          since: {
            type: "string",
            description: "ISO 8601 time: only decisions made at or after it",
          },
          bad_faith_only: {
            type: "boolean",
            description: "Only decisions that flagged suspected bad faith",
          },
        },
      },
    },
  ];
}

// The claim-facing subset of the bundle. The Steward and Curator work on
// claims, not contributions — their prompts never mention the contribution/
// contributor/decision tools, so attaching the whole bundle was pure extra
// context surface (#100). Those agents get just the claim readers; the
// Reviewer, Arbitrator, and Audit Agent keep the full bundle.
const CLAIM_CONTEXT_TOOL_NAMES = new Set([
  "get_claim",
  "get_claim_instances",
  "get_claim_dependents",
]);

export function getClaimContextToolDefinitions(): Tool[] {
  return getGovernanceToolDefinitions().filter((t) =>
    CLAIM_CONTEXT_TOOL_NAMES.has(t.name)
  );
}

export async function executeGovernanceTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  try {
    switch (toolName) {
      case "get_claim":
        return (await executeGraphReadTool("get_claim", input))!;

      case "get_claim_instances":
        return JSON.stringify(
          await getClaimInstancePage(input.claim_id as string, {
            limit: input.limit as number | undefined,
            offset: input.offset as number | undefined,
            includeDetached: input.include_detached === true,
          }),
          null,
          2
        );

      case "get_contribution_details":
        return JSON.stringify(
          await getContributionDetails(
            input.contribution_id as string | undefined,
            input.review_id as string | undefined
          ),
          null,
          2
        );

      case "get_contributor_profile":
        return JSON.stringify(
          await getContributorProfile(input.contributor_id as string),
          null,
          2
        );

      case "get_claim_dependents":
        return JSON.stringify(
          await getClaimDependents(input.claim_id as string),
          null,
          2
        );

      case "get_recent_decisions":
        return JSON.stringify(
          await getRecentDecisions({
            limit: input.limit as number | undefined,
            offset: input.offset as number | undefined,
            decisionFilter: input.decision_filter as string | undefined,
            contributorId: input.contributor_id as string | undefined,
            claimId: input.claim_id as string | undefined,
            since: input.since as string | undefined,
            badFaithOnly: input.bad_faith_only === true,
          }),
          null,
          2
        );

      default:
        return `Error: Unknown governance tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function getContributionDetails(
  contributionIdInput: string | undefined,
  reviewId: string | undefined
) {
  const db = getDb();

  // A review id is an alternative key (#495): get_recent_decisions lists
  // reviews, and audit needs the text a review decided on. Any review row
  // resolves, superseded ones included, since audit reads history too.
  let contributionId = contributionIdInput;
  if (!contributionId && reviewId) {
    const [byReview] = await db
      .select({ contributionId: contributionReviews.contributionId })
      .from(contributionReviews)
      .where(eq(contributionReviews.id, reviewId))
      .limit(1);
    if (!byReview) return { error: `Review not found: ${reviewId}` };
    contributionId = byReview.contributionId;
  }
  if (!contributionId)
    return { error: "Pass contribution_id or review_id" };

  const [contribution] = await db
    .select()
    .from(contributions)
    .where(eq(contributions.id, contributionId))
    .limit(1);

  if (!contribution)
    return { error: `Contribution not found: ${contributionId}` };

  // Contributor
  const [contributor] = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, contribution.contributorId))
    .limit(1);

  // Review if exists — the decision in force (a superseded row is history
  // an audit re-review replaced, #180).
  const [review] = await db
    .select()
    .from(contributionReviews)
    .where(
      sql`${contributionReviews.contributionId} = ${contributionId} AND ${contributionReviews.superseded} = false`
    )
    .orderBy(desc(contributionReviews.reviewedAt))
    .limit(1);

  // Appeals, newest first — the appellant's reasoning is the substance of an
  // appeal adjudication, so the Arbitrator must be able to read it (#178).
  const appealRows = await db
    .select({
      id: appeals.id,
      appealReasoning: appeals.appealReasoning,
      appellantId: appeals.appellantId,
      appellantName: contributors.displayName,
      originalReviewId: appeals.originalReviewId,
      status: appeals.status,
      submittedAt: appeals.submittedAt,
    })
    .from(appeals)
    .leftJoin(contributors, eq(contributors.id, appeals.appellantId))
    .where(eq(appeals.contributionId, contributionId))
    .orderBy(desc(appeals.submittedAt));

  // Prior arbitrations, newest first — repeat arbitration is a real path
  // (uphold_original returns the contribution to 'rejected', which can be
  // appealed again), and the second arbitrator should see the first's
  // reasoning (#178).
  const arbitrations = await db
    .select()
    .from(arbitrationResults)
    .where(eq(arbitrationResults.contributionId, contributionId))
    .orderBy(desc(arbitrationResults.arbitratedAt));

  // Target claim — null for pending intake contributions (#157), which
  // propose NEW content and have no claim until accepted and materialized.
  const [claim] = contribution.claimId
    ? await db
        .select({
          id: claims.id,
          text: claims.text,
          claimType: claims.claimType,
        })
        .from(claims)
        .where(eq(claims.id, contribution.claimId))
        .limit(1)
    : [undefined];

  // Proposed source for 'propose_source' intake: the stored document under
  // review. Only a bounded excerpt of the raw content — enough to judge good
  // faith and whether the document plausibly carries claims.
  const [source] = contribution.sourceId
    ? await db
        .select({
          id: sources.id,
          url: sources.url,
          title: sources.title,
          sourceType: sources.sourceType,
          rawContent: sources.rawContent,
        })
        .from(sources)
        .where(eq(sources.id, contribution.sourceId))
        .limit(1)
    : [undefined];

  return {
    contribution: {
      id: contribution.id,
      type: contribution.contributionType,
      content: contribution.content,
      evidence_urls: contribution.evidenceUrls,
      review_status: contribution.reviewStatus,
      submitted_at: contribution.submittedAt.toISOString(),
      proposed_canonical_form: contribution.proposedCanonicalForm,
      merge_target_claim_id: contribution.mergeTargetClaimId,
      // Why the reviewer escalated — present even when the reviewer skipped
      // record_review_decision, so an escalation never arrives reasonless.
      escalation_reason: contribution.escalationReason,
    },
    ...(source
      ? {
          proposed_source: {
            id: source.id,
            url: source.url,
            title: source.title,
            source_type: source.sourceType,
            content_excerpt: source.rawContent
              ? source.rawContent.slice(0, 4000)
              : null,
          },
        }
      : {}),
    contributor: contributor
      ? {
          id: contributor.id,
          display_name: contributor.displayName,
          reputation_score: contributor.reputationScore,
          contributions_accepted: contributor.contributionsAccepted,
          contributions_rejected: contributor.contributionsRejected,
          is_verified: contributor.isVerified,
        }
      : null,
    target_claim: claim
      ? { id: claim.id, text: claim.text, type: claim.claimType }
      : null,
    existing_review: review
      ? {
          id: review.id,
          decision: review.decision,
          reasoning: review.reasoning,
          confidence: review.confidence,
          policy_citations: review.policyCitations,
          reviewed_at: review.reviewedAt.toISOString(),
        }
      : null,
    ...(appealRows.length > 0
      ? {
          appeals: appealRows.map((a) => ({
            id: a.id,
            appeal_reasoning: a.appealReasoning,
            appellant: {
              id: a.appellantId,
              display_name: a.appellantName,
            },
            original_review_id: a.originalReviewId,
            status: a.status,
            submitted_at: a.submittedAt.toISOString(),
          })),
        }
      : {}),
    ...(arbitrations.length > 0
      ? {
          arbitration_history: arbitrations.map((r) => ({
            id: r.id,
            appeal_id: r.appealId,
            outcome: r.outcome,
            decision: r.decision,
            reasoning: r.reasoning,
            human_review_recommended: r.humanReviewRecommended,
            arbitrated_at: r.arbitratedAt.toISOString(),
          })),
        }
      : {}),
  };
}

async function getContributorProfile(contributorId: string) {
  const db = getDb();

  const [contributor] = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .limit(1);

  if (!contributor)
    return { error: `Contributor not found: ${contributorId}` };

  const total =
    contributor.contributionsAccepted +
    contributor.contributionsRejected +
    contributor.contributionsEscalated;

  const trustLevel = trustLevelFor(
    contributor.reputationScore,
    contributor.isSuspended
  );

  return {
    id: contributor.id,
    display_name: contributor.displayName,
    reputation_score: contributor.reputationScore,
    trust_level: trustLevel,
    owls_earned: microUsdToOwls(contributor.owlsEarnedMicroUsd),
    // Good-faith standing (#71): 'must_pay' means a prior suspected-bad-faith
    // flag — weigh history charitably but attend to patterns of abuse.
    contribution_standing: contributor.contributionStanding,
    bad_faith_flags: contributor.badFaithFlags,
    is_verified: contributor.isVerified,
    is_suspended: contributor.isSuspended,
    suspension_reason: contributor.suspensionReason,
    contributions_accepted: contributor.contributionsAccepted,
    contributions_rejected: contributor.contributionsRejected,
    contributions_escalated: contributor.contributionsEscalated,
    total_contributions: total,
    acceptance_rate:
      total > 0
        ? Math.round((contributor.contributionsAccepted / total) * 100)
        : null,
    last_active_at: contributor.lastActiveAt.toISOString(),
  };
}

// Same reverse-edge query as the API's dependents endpoint (tree-service), kept
// behind the agents' historical field names so tool payloads don't change.
async function getClaimDependents(claimId: string) {
  const rows = await fetchClaimDependents(claimId);
  // A claim that says which side of a figure a quantity lies is joined to
  // the quantity by a cut, not an edge, yet its credence must agree with the
  // quantity's estimate (§21), so it is a dependent the quantity's Steward
  // tells when the estimate moves (§22; #767).
  const cuts = await rawQuery<{
    id: string;
    text: string;
    claim_type: string;
    direction: string;
    value: number;
    status: string | null;
    confidence: number | null;
    credence: number | null;
  }>(
    `SELECT c.id, c.text, c.claim_type, qc.direction, qc.value,
            a.status, a.confidence, a.claim_credence AS credence
       FROM quantity_cuts qc
       JOIN claims c ON c.id = qc.claim_id AND c.state = 'active'
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
      WHERE qc.quantity_id = $1
      ORDER BY c.importance DESC, c.id`,
    [claimId]
  );

  const dependents = [
    ...rows.map((r) => ({
      id: r.id,
      text: r.text,
      type: r.claim_type,
      kind: r.node_kind,
      relation: r.relation_type,
      current_status: r.assessment_status,
      confidence: r.assessment_confidence,
      credence: r.assessment_credence,
    })),
    ...cuts.map((c) => ({
      id: c.id,
      text: c.text,
      type: c.claim_type,
      kind: "claim",
      relation: "cuts",
      cut: { direction: c.direction, value: c.value },
      current_status: c.status,
      confidence: c.confidence,
      credence: c.credence,
    })),
  ];
  return { child_claim_id: claimId, dependents, count: dependents.length };
}

/** The most rows one get_recent_decisions page returns. */
export const MAX_DECISION_PAGE = 100;

/**
 * Review decisions in force, newest first. The pattern sweep asks the Audit
 * to weigh bad-faith flags and to look at one window of time (#696), so the
 * rows carry the flag and the read takes a window, a flag filter, and an
 * offset to page past the first page.
 */
export async function getRecentDecisions(opts: {
  limit?: number;
  offset?: number;
  decisionFilter?: string;
  contributorId?: string;
  claimId?: string;
  since?: string;
  badFaithOnly?: boolean;
}) {
  const db = getDb();
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit ?? 20)) || 20, 1), MAX_DECISION_PAGE);
  const offset = Math.max(Math.floor(Number(opts.offset ?? 0)) || 0, 0);

  let since: Date | null = null;
  if (opts.since) {
    since = new Date(opts.since);
    if (Number.isNaN(since.getTime())) {
      return { error: `since "${opts.since}" is not an ISO 8601 time` };
    }
  }

  // Superseded reviews are history, not decisions in force — an audit
  // re-review replaced them (#180).
  let conditions = sql`${contributionReviews.superseded} = false`;
  if (opts.decisionFilter) {
    conditions = sql`${conditions} AND ${contributionReviews.decision} = ${opts.decisionFilter}`;
  }
  if (opts.contributorId) {
    conditions = sql`${conditions} AND ${contributions.contributorId} = ${opts.contributorId}`;
  }
  if (opts.claimId) {
    conditions = sql`${conditions} AND ${contributions.claimId} = ${opts.claimId}`;
  }
  if (since) {
    conditions = sql`${conditions} AND ${contributionReviews.reviewedAt} >= ${since}`;
  }
  if (opts.badFaithOnly) {
    conditions = sql`${conditions} AND ${contributionReviews.suspectedBadFaith} = true`;
  }

  // One extra row says whether another page exists.
  const rows = await db
    .select({
      reviewId: contributionReviews.id,
      contributionId: contributionReviews.contributionId,
      decision: contributionReviews.decision,
      reasoning: contributionReviews.reasoning,
      confidence: contributionReviews.confidence,
      policyCitations: contributionReviews.policyCitations,
      suspectedBadFaith: contributionReviews.suspectedBadFaith,
      badFaithCategory: contributionReviews.badFaithCategory,
      reviewedAt: contributionReviews.reviewedAt,
      contributionType: contributions.contributionType,
      contributorId: contributions.contributorId,
      claimId: contributions.claimId,
    })
    .from(contributionReviews)
    .innerJoin(
      contributions,
      eq(contributions.id, contributionReviews.contributionId)
    )
    .where(conditions)
    .orderBy(desc(contributionReviews.reviewedAt))
    .limit(limit + 1)
    .offset(offset);

  const page = rows.slice(0, limit);
  return {
    decisions: page.map((r) => ({
      review_id: r.reviewId,
      // The key get_contribution_details takes (#495): without it audit
      // can read a reviewer's reasoning but not what was reviewed.
      contribution_id: r.contributionId,
      decision: r.decision,
      reasoning: r.reasoning,
      confidence: r.confidence,
      policy_citations: r.policyCitations,
      suspected_bad_faith: r.suspectedBadFaith,
      bad_faith_category: r.badFaithCategory,
      reviewed_at: r.reviewedAt.toISOString(),
      contribution_type: r.contributionType,
      contributor_id: r.contributorId,
      claim_id: r.claimId,
    })),
    count: page.length,
    offset,
    has_more: rows.length > limit,
  };
}
