/**
 * Shared read tools for governance agents.
 *
 * These give agents the ability to gather context about claims, contributions,
 * and contributors before making decisions.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { eq, sql, desc } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { rawQuery } from "../../db/client.js";
import {
  claims,
  assessments,
  claimInstances,
  arguments_,
  sources,
  contributions,
  contributionReviews,
  contributors,
  appeals,
  arbitrationResults,
} from "../../db/schema.js";
import { trustLevelFor } from "../../services/reputation-service.js";
import { microUsdToOwls } from "../../services/owl.js";
import { hasWrittenForm } from "../../services/argument-service.js";
import { getClaimDependents as fetchClaimDependents } from "../../services/tree-service.js";

export function getGovernanceToolDefinitions(): Tool[] {
  return [
    {
      name: "get_claim_with_context",
      description:
        "Get comprehensive context about a claim: its text, type, current " +
        "assessment, subclaims, instances, and arguments. Use this to " +
        "understand the full state of a claim before making decisions.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim",
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
        "arbitration results.",
      input_schema: {
        type: "object" as const,
        properties: {
          contribution_id: {
            type: "string",
            description: "The UUID of the contribution",
          },
        },
        required: ["contribution_id"],
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
        "Get all claims that depend on (have as a subclaim) a given claim. " +
        "Useful for understanding the impact of changing a claim's assessment.",
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
        "Get recent contribution review decisions, optionally filtered. " +
        "Useful for audit agents analyzing patterns.",
      input_schema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "integer",
            description: "Maximum number of results (default 20)",
          },
          decision_filter: {
            type: "string",
            description: "Filter by decision type: accept, reject, escalate",
          },
          contributor_id: {
            type: "string",
            description: "Filter by contributor ID",
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
  "get_claim_with_context",
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
      case "get_claim_with_context":
        return JSON.stringify(
          await getClaimWithContext(input.claim_id as string),
          null,
          2
        );

      case "get_contribution_details":
        return JSON.stringify(
          await getContributionDetails(input.contribution_id as string),
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
          await getRecentDecisions(
            (input.limit as number) ?? 20,
            input.decision_filter as string | undefined,
            input.contributor_id as string | undefined
          ),
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

async function getClaimWithContext(claimId: string) {
  const db = getDb();

  const [claim] = await db
    .select()
    .from(claims)
    .where(eq(claims.id, claimId))
    .limit(1);

  if (!claim) return { error: `Claim not found: ${claimId}` };

  // Current assessment
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(
      sql`${assessments.claimId} = ${claimId} AND ${assessments.isCurrent} = true`
    )
    .limit(1);

  // Subclaims (with the argument each edge belongs to, so the steward can see
  // which line of reasoning a subclaim serves — and write_argument accordingly)
  const subclaims = await rawQuery<{
    child_id: string;
    child_text: string;
    child_type: string;
    relation_type: string;
    confidence: number;
    child_status: string | null;
    child_confidence: number | null;
    argument_id: string | null;
    argument_name: string | null;
  }>(
    `SELECT cr.child_claim_id AS child_id, c.text AS child_text,
            c.claim_type AS child_type, cr.relation_type, cr.confidence,
            a.status AS child_status, a.confidence AS child_confidence,
            cr.argument_id, arg.name AS argument_name
     FROM claim_relationships cr
     JOIN claims c ON c.id = cr.child_claim_id
     LEFT JOIN assessments a ON a.claim_id = cr.child_claim_id AND a.is_current = true
     LEFT JOIN arguments arg ON arg.id = cr.argument_id
     WHERE cr.parent_claim_id = $1`,
    [claimId]
  );

  // Instances
  const instances = await db
    .select({
      originalText: claimInstances.originalText,
      context: claimInstances.context,
      stance: claimInstances.stance,
      confidence: claimInstances.confidence,
      // Attribution metadata (#278/#281), null where unknown: lets a reader
      // (and a re-running Steward) weigh who said it, where, and when.
      speaker: claimInstances.speaker,
      publication: claimInstances.publication,
      sourceDate: claimInstances.sourceDate,
      link: claimInstances.link,
      sourceTitle: sources.title,
      sourceType: sources.sourceType,
      sourceUrl: sources.url,
    })
    .from(claimInstances)
    .innerJoin(sources, eq(sources.id, claimInstances.sourceId))
    .where(eq(claimInstances.claimId, claimId));

  // Arguments, each with its current evaluation (issue #173) so a re-running
  // steward sees its prior judgment of the inference and can revise or confirm.
  const args = await db
    .select()
    .from(arguments_)
    .where(eq(arguments_.claimId, claimId));

  const evaluations = await rawQuery<{
    argument_id: string;
    verdict: string;
    content: string;
    stale: boolean;
  }>(
    `SELECT ae.argument_id, ae.verdict, ae.content,
            (ca.id IS NULL OR ae.assessment_id IS DISTINCT FROM ca.id) AS stale
       FROM argument_evaluations ae
       JOIN arguments a ON a.id = ae.argument_id
       LEFT JOIN assessments ca ON ca.claim_id = a.claim_id AND ca.is_current = true
      WHERE a.claim_id = $1
        AND ae.is_current = true`,
    [claimId]
  );
  const evaluationByArgument = new Map(
    evaluations.map((e) => [e.argument_id, e])
  );

  // Steward-seeded prior (#285): the hint the parent claim's Steward left when
  // it minted this claim. Served only while the claim has no current
  // assessment — once its own Steward has judged, the seed is history and must
  // not sit beside the verdict as a second opinion.
  const preliminarySeed =
    !assessment && (claim.seedCredence != null || claim.seedNote != null)
      ? {
          credence: claim.seedCredence,
          note: claim.seedNote,
          seeded_by_claim_id: claim.seedSourceClaimId,
        }
      : null;

  return {
    claim: {
      id: claim.id,
      text: claim.text,
      claim_type: claim.claimType,
      state: claim.state,
      decomposition_status: claim.decompositionStatus,
      importance: claim.importance,
      children_total: claim.childrenTotal,
      children_assessed: claim.childrenAssessed,
    },
    // The parent Steward's preliminary prior, when one exists and the claim is
    // still unassessed: one input among many, superseded by a real assessment.
    ...(preliminarySeed ? { preliminary_seed: preliminarySeed } : {}),
    current_assessment: assessment
      ? {
          status: assessment.status,
          confidence: assessment.confidence,
          reasoning: assessment.reasoningTrace,
          assessed_at: assessment.assessedAt.toISOString(),
        }
      : null,
    subclaims: subclaims.map((sc) => ({
      id: sc.child_id,
      text: sc.child_text,
      type: sc.child_type,
      relation: sc.relation_type,
      confidence: sc.confidence,
      assessment_status: sc.child_status,
      assessment_confidence: sc.child_confidence,
      argument_id: sc.argument_id,
      argument_name: sc.argument_name,
    })),
    instances: instances.map((inst) => ({
      original_text: inst.originalText,
      context: inst.context,
      // Whether this source affirms or denies the canonical claim — credible
      // sources on both sides is a strong CONTESTED signal (#28/#30).
      stance: inst.stance,
      confidence: inst.confidence,
      // Null where unrecorded — most extraction-era instances carry none of
      // these; steward-recorded sightings (#278) fill what the source showed.
      speaker: inst.speaker,
      publication: inst.publication,
      source_date: inst.sourceDate,
      link: inst.link,
      source_title: inst.sourceTitle,
      source_type: inst.sourceType,
      source_url: inst.sourceUrl,
    })),
    arguments: args.map((a) => {
      const evaluation = evaluationByArgument.get(a.id) ?? null;
      return {
        id: a.id,
        name: a.name,
        stance: a.stance,
        content: a.content,
        // False when content is still just the creation-time label — the steward
        // owes this argument a write_argument call (issue #129).
        has_written_form: hasWrittenForm(a.content),
        // The steward's current judgment of the inference (issue #173); null
        // when the argument has never been evaluated. `stale` means it was
        // derived under an assessment that is no longer current.
        evaluation: evaluation
          ? {
              verdict: evaluation.verdict,
              content: evaluation.content,
              stale: evaluation.stale,
            }
          : null,
      };
    }),
  };
}

async function getContributionDetails(contributionId: string) {
  const db = getDb();

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

  return {
    child_claim_id: claimId,
    dependents: rows.map((r) => ({
      id: r.id,
      text: r.text,
      type: r.claim_type,
      relation: r.relation_type,
      current_status: r.assessment_status,
    })),
    count: rows.length,
  };
}

async function getRecentDecisions(
  limit: number,
  decisionFilter?: string,
  contributorId?: string
) {
  const db = getDb();

  // Superseded reviews are history, not decisions in force — an audit
  // re-review replaced them (#180).
  let conditions = sql`${contributionReviews.superseded} = false`;
  if (decisionFilter) {
    conditions = sql`${conditions} AND ${contributionReviews.decision} = ${decisionFilter}`;
  }
  if (contributorId) {
    conditions = sql`${conditions} AND ${contributions.contributorId} = ${contributorId}`;
  }

  const rows = await db
    .select({
      reviewId: contributionReviews.id,
      decision: contributionReviews.decision,
      reasoning: contributionReviews.reasoning,
      confidence: contributionReviews.confidence,
      policyCitations: contributionReviews.policyCitations,
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
    .limit(limit);

  return {
    decisions: rows.map((r) => ({
      review_id: r.reviewId,
      decision: r.decision,
      reasoning: r.reasoning,
      confidence: r.confidence,
      policy_citations: r.policyCitations,
      reviewed_at: r.reviewedAt.toISOString(),
      contribution_type: r.contributionType,
      contributor_id: r.contributorId,
      claim_id: r.claimId,
    })),
    count: rows.length,
  };
}
