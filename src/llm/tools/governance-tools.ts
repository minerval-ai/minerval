/**
 * Shared read tools for governance agents.
 *
 * These give agents the ability to gather context about claims, contributions,
 * and contributors before making decisions.
 */
import { oneCutForClaimSql } from "../../services/mirrored-node-service.js";
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
import { MANDATE_LABEL } from "../../services/contribution-service.js";
import { STATED_VIEW_CONTRIBUTION_TYPE } from "../../schemas/common.js";
import { statedViewForContribution } from "../../services/stated-view-service.js";

const HISTORY_DEFAULT = 10;
const HISTORY_MAX = 30;
/** How much of each listed contribution's text and reasoning the history carries. */
const HISTORY_EXCERPT = 1500;

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
        "reading recorded from opening the source, any interest recorded " +
        "for the source on this claim (source_interest: a stake its author " +
        "or publisher has, a fact about the source and not a finding " +
        "against it), what it was recorded as " +
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
        "Get full details about a contribution: what was submitted (type, " +
        "content, evidence, proposed wording, merge target), who filed it " +
        "(a contributor's id and name, or \"a funded mandate\"), the target " +
        "claim, any existing review, the reviewer's escalation reason, any " +
        "human-review reason, the prize claim a challenge targets, for a " +
        "state_view the view as stated (`stated_view`: how the speaker stands " +
        "toward the node, any probability or figure, its words, its reasons, " +
        "the stake it declared, whether the account is verified, and what " +
        "became of the reasons), any " +
        "appeals (with the appellant's reasoning), and prior arbitration " +
        "results. Reputation is not here: " +
        "get_contributor_profile has it, for when bad faith or coordination " +
        "is in question. Pass contribution_id, or a review_id (as " +
        "get_recent_decisions returns) to load the contribution that review " +
        "decided.",
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
        "Get a contributor's profile: reputation score, trust level, " +
        "standing, bad-faith flags, acceptance history, and how many appeals " +
        "they have filed. It bears on bad faith and coordination (§13, §15), " +
        "never on the merits of a contribution. Pass contributor_id, or the " +
        "contribution_id of the contribution in question. A contribution a " +
        "funded mandate filed has no contributor profile: a mandate has no " +
        "reputation, and the account behind it is not shown.",
      input_schema: {
        type: "object" as const,
        properties: {
          contributor_id: {
            type: "string",
            description: "The UUID of the contributor",
          },
          contribution_id: {
            type: "string",
            description: "Alternatively, a contribution whose filer to look up",
          },
        },
      },
    },
    {
      name: "get_review_history",
      description:
        "The record a review is judged against, for one contribution: the " +
        "other contributions on the same target, and the same filer's earlier " +
        "contributions (a mandate's, for a contribution a mandate filed). " +
        "Each comes with its text (the first 1,500 characters, marked when " +
        "cut), the decision in force with its reasoning, and its appeals and " +
        "arbitrations. This is how you find an argument already answered " +
        "(§14), contributions that conflict on the same claim, and earlier " +
        "appeals of similar rejections. Decided contributions only, unless " +
        "include_pending is true. Newest first.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The contribution under review",
          },
          include_pending: {
            type: "boolean",
            description:
              "Also list contributions still awaiting review or arbitration. Default false.",
          },
          limit: {
            type: "integer",
            description: `How many of each list to return (default ${HISTORY_DEFAULT}, at most ${HISTORY_MAX}).`,
          },
        },
        required: ["contribution_id"],
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
// claims, not contributions, so the contributor and decision-history tools
// stay out of their toolsets (#100). They do get get_contribution_details:
// an accepted contribution or an arbitration ruling is handed to the
// Steward by id, and the Steward integrates the record itself, not a
// paraphrase of it (#697). The Reviewer, Arbitrator, and Audit Agent keep
// the full bundle.
const CLAIM_CONTEXT_TOOL_NAMES = new Set([
  "get_claim",
  "get_claim_instances",
  "get_claim_dependents",
  "get_contribution_details",
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
          await getContributorProfile(
            input.contributor_id as string | undefined,
            input.contribution_id as string | undefined
          ),
          null,
          2
        );

      case "get_review_history":
        return JSON.stringify(
          await getReviewHistory(
            input.contribution_id as string,
            input.include_pending === true,
            input.limit as number | undefined
          ),
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

  const statedView =
    contribution.contributionType === STATED_VIEW_CONTRIBUTION_TYPE
      ? await statedViewForContribution(contribution.id)
      : null;

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
      // One of the node's arguments, when the contribution is about it
      // (#541); get_argument opens it.
      ...(contribution.argumentId ? { argument_id: contribution.argumentId } : {}),
      ...(contribution.mergeTargetArgumentId
        ? { merge_target_argument_id: contribution.mergeTargetArgumentId }
        : {}),
      // Why the reviewer escalated — present even when the reviewer skipped
      // record_review_decision, so an escalation never arrives reasonless.
      escalation_reason: contribution.escalationReason,
      // Why the Arbitrator sent it to humans, when it did (#713).
      ...(contribution.humanReviewReason
        ? { human_review_reason: contribution.humanReviewReason }
        : {}),
      // A challenge to a prize claim names it; get_prize_claim reads it (#710).
      ...(contribution.challengedPrizeClaimId
        ? { challenged_prize_claim_id: contribution.challengedPrizeClaimId }
        : {}),
    },
    // A view stated to the graph (§4): how the speaker stands, its stake and
    // its reasons, as it gave them, and whether anyone has checked who is
    // behind the account.
    ...(statedView ? { stated_view: statedView } : {}),
    ...(source && !statedView
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
    // Who filed it, and nothing about their standing (#702): reputation is
    // for weighing bad faith or coordination, read deliberately with
    // get_contributor_profile, never set beside the merits. A mandate's
    // contribution is filed under its funder's account but shown, here as
    // everywhere, as the arrangement (#705): a mandate has no reputation, and
    // the account behind it is not the reviewer's business.
    ...(contribution.grantId
      ? {
          filed_by: MANDATE_LABEL,
          contributor: null,
          mandate_note:
            "A funded mandate filed this. It has no reputation and no " +
            "contributor profile: judge the contribution alone. A bad-faith " +
            "flag on it is recorded and audited, with no reputation consequence.",
        }
      : {
          filed_by: contributor?.displayName ?? null,
          contributor: contributor
            ? { id: contributor.id, display_name: contributor.displayName }
            : null,
        }),
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

async function getContributorProfile(
  contributorIdInput: string | undefined,
  contributionId: string | undefined
) {
  const db = getDb();

  let contributorId = contributorIdInput;
  if (!contributorId && contributionId) {
    const [row] = await db
      .select({ contributorId: contributions.contributorId, grantId: contributions.grantId })
      .from(contributions)
      .where(eq(contributions.id, contributionId))
      .limit(1);
    if (!row) return { error: `Contribution not found: ${contributionId}` };
    // A mandate's contribution sits under its funder's personal account,
    // which the graph never shows in the mandate's place (#705).
    if (row.grantId) {
      return {
        filed_by: MANDATE_LABEL,
        profile: null,
        note:
          "A funded mandate filed this contribution. A mandate has no " +
          "reputation or standing to read: judge the contribution alone.",
      };
    }
    contributorId = row.contributorId;
  }
  if (!contributorId) return { error: "Pass contributor_id or contribution_id" };

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

  const [appealsFiled] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM appeals WHERE appellant_id = $1`,
    [contributorId]
  );

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
    appeals_filed: appealsFiled?.n ?? 0,
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
       LEFT JOIN assessments_in_force a ON a.claim_id = c.id
      WHERE qc.quantity_id = $1${oneCutForClaimSql("qc")}
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

interface HistoryRow {
  id: string;
  contribution_type: string;
  claim_id: string | null;
  content: string;
  evidence_urls: string[] | null;
  review_status: string;
  submitted_at: Date | string;
  same_filer: boolean;
  decision: string | null;
  decision_reasoning: string | null;
  appeals: Array<{ status: string; reasoning: string }> | null;
  arbitrations: Array<{ outcome: string; decision: string }> | null;
}

function historyExcerpt(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text.length > HISTORY_EXCERPT
    ? `${text.slice(0, HISTORY_EXCERPT)} [first ${HISTORY_EXCERPT} of ${text.length} characters; get_contribution_details reads it whole]`
    : text;
}

/**
 * The record a review is judged against (#702): the same target's other
 * contributions and the same filer's earlier ones, each with the decision in
 * force, appeals and arbitrations. Keyed on the contribution, so a mandate's
 * history is the mandate's, never its funder's personal one (#705).
 */
async function getReviewHistory(
  contributionId: string,
  includePending: boolean,
  limitInput: number | undefined
) {
  const [subject] = await rawQuery<{
    claim_id: string | null;
    contributor_id: string;
    grant_id: string | null;
  }>(
    `SELECT claim_id, contributor_id, grant_id FROM contributions WHERE id = $1`,
    [contributionId]
  );
  if (!subject) return { error: `Contribution not found: ${contributionId}` };
  const limit = Math.min(
    HISTORY_MAX,
    Math.max(1, Math.floor(Number(limitInput) || HISTORY_DEFAULT))
  );

  const sameFiler = subject.grant_id
    ? `c.grant_id = $2`
    : `(c.contributor_id = $2 AND c.grant_id IS NULL)`;
  const filerKey = subject.grant_id ?? subject.contributor_id;
  const decidedOnly = includePending
    ? ""
    : `AND c.review_status NOT IN ('pending', 'escalated')`;

  const select = (where: string) => `
    SELECT c.id, c.contribution_type, c.claim_id, c.content, c.evidence_urls,
           c.review_status, c.submitted_at,
           (${sameFiler}) AS same_filer,
           r.decision, r.reasoning AS decision_reasoning,
           (SELECT json_agg(json_build_object('status', a.status, 'reasoning', a.appeal_reasoning)
                            ORDER BY a.submitted_at DESC)
              FROM appeals a WHERE a.contribution_id = c.id) AS appeals,
           (SELECT json_agg(json_build_object('outcome', ar.outcome, 'decision', ar.decision)
                            ORDER BY ar.arbitrated_at DESC)
              FROM arbitration_results ar WHERE ar.contribution_id = c.id) AS arbitrations
      FROM contributions c
      LEFT JOIN LATERAL (
        SELECT decision, reasoning FROM contribution_reviews
         WHERE contribution_id = c.id AND superseded = false
         ORDER BY reviewed_at DESC LIMIT 1
      ) r ON true
     WHERE c.id <> $1 ${decidedOnly} AND ${where}
     ORDER BY c.submitted_at DESC
     LIMIT ${limit}`;

  const onTarget = subject.claim_id
    ? await rawQuery<HistoryRow>(select(`c.claim_id = $3`), [
        contributionId,
        filerKey,
        subject.claim_id,
      ])
    : [];
  const fromFiler = await rawQuery<HistoryRow>(select(sameFiler), [
    contributionId,
    filerKey,
  ]);

  const shape = (r: HistoryRow) => ({
    id: r.id,
    type: r.contribution_type,
    target_claim_id: r.claim_id,
    review_status: r.review_status,
    submitted_at:
      r.submitted_at instanceof Date ? r.submitted_at.toISOString() : r.submitted_at,
    same_filer: r.same_filer,
    content: historyExcerpt(r.content),
    evidence_urls: r.evidence_urls ?? [],
    decision_in_force: r.decision
      ? { decision: r.decision, reasoning: historyExcerpt(r.decision_reasoning) }
      : null,
    appeals: (r.appeals ?? []).map((a) => ({
      status: a.status,
      reasoning: historyExcerpt(a.reasoning),
    })),
    arbitrations: r.arbitrations ?? [],
  });

  return {
    filed_by: subject.grant_id ? MANDATE_LABEL : "this contributor",
    on_same_target: subject.claim_id
      ? onTarget.map(shape)
      : "This contribution proposes new content and has no target yet.",
    from_same_filer: fromFiler.map(shape),
  };
}
