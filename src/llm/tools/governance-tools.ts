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
import { getSourceMapSummary } from "../../services/source-map-service.js";
import {
  DEFAULT_INSTANCE_PAGE,
  MAX_INSTANCE_PAGE,
  countClaimInstances,
  getClaimInstancePage,
} from "../../services/claim-instance-service.js";
import { getClaimDependents as fetchClaimDependents } from "../../services/tree-service.js";
import { listFindings } from "../../services/finding-service.js";
import { getClaimFormalizationRecord } from "../../services/formalization-service.js";
import { listRelatedClaims } from "../../services/claim-link-service.js";
import { getQuantityDetail, getThresholdOf } from "../../services/quantity-service.js";
import { getQuestionDetail } from "../../services/question-service.js";
import { listRequests } from "../../services/request-service.js";

export function getGovernanceToolDefinitions(): Tool[] {
  return [
    {
      name: "get_claim",
      description:
        "Read a claim as the graph records it: its canonical text, type, " +
        "state, current assessment, subclaims grouped by argument, arguments " +
        "with their evaluations, related claims, formalization record, " +
        "preliminary seed, findings already noted, and Steward state. A claim " +
        "is a proposition, not a passage in any document, so this returns no " +
        "sources; instance_count says how many instances it carries, and " +
        "get_claim_instances reads them. decomposition_status \"complete\" " +
        "only means the claim was handed to its Steward; read steward_state " +
        "and stewarded_at to tell whether a Steward has actually worked it " +
        "(stewarded_at null = never run).",
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
      name: "get_claim_instances",
      description:
        "Read the instances the graph currently records for a claim: each " +
        "source that asserts, denies or poses the proposition, with the " +
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
        "Useful for audit agents analyzing patterns. Each row carries the " +
        "contribution_id, so get_contribution_details can load the text " +
        "that was reviewed.",
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
          claim_id: {
            type: "string",
            description: "Filter to decisions on contributions targeting this claim",
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
        return JSON.stringify(await getClaim(input.claim_id as string), null, 2);

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
          await getRecentDecisions(
            (input.limit as number) ?? 20,
            input.decision_filter as string | undefined,
            input.contributor_id as string | undefined,
            input.claim_id as string | undefined
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

/**
 * The canonical record of a claim. A claim has no home source, so no
 * instance is read here: the count says how many it carries, and
 * get_claim_instances reads them in the order a reader sees them.
 */
async function getClaim(claimId: string) {
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
  // which line of reasoning a subclaim serves — and write_argument accordingly).
  // An edge grouped under several arguments (#437) is listed once per
  // argument; an ungrouped basis edge once, with a null argument.
  const subclaims = await rawQuery<{
    edge_id: string;
    child_id: string;
    child_text: string;
    child_type: string;
    relation_type: string;
    confidence: number;
    child_status: string | null;
    child_confidence: number | null;
    argument_id: string | null;
    argument_name: string | null;
    child_kind: string;
    child_estimate: unknown | null;
    child_standing: string | null;
  }>(
    `SELECT cr.id AS edge_id, cr.child_claim_id AS child_id, c.text AS child_text,
            c.claim_type AS child_type, cr.relation_type, cr.confidence,
            a.status AS child_status, a.confidence AS child_confidence,
            am.argument_id, arg.name AS argument_name,
            c.kind AS child_kind, qe.estimate AS child_estimate, qa.standing AS child_standing
     FROM claim_relationships cr
     JOIN claims c ON c.id = cr.child_claim_id
     LEFT JOIN assessments a ON a.claim_id = cr.child_claim_id AND a.is_current = true
     LEFT JOIN quantity_estimates qe ON qe.claim_id = c.id AND qe.is_current = true
     LEFT JOIN question_assessments qa ON qa.claim_id = c.id AND qa.is_current = true
     LEFT JOIN argument_subclaims am ON am.relationship_id = cr.id
     LEFT JOIN arguments arg ON arg.id = am.argument_id
     WHERE cr.parent_claim_id = $1
     ORDER BY cr.created_at, cr.id, am.created_at`,
    [claimId]
  );

  // How many instances the claim carries; detached ones never count.
  const instanceCount = await countClaimInstances(claimId);

  // Arguments, each with its current evaluation (issue #173) so a re-running
  // steward sees its prior judgment of the inference and can revise or confirm.
  const args = await db
    .select()
    .from(arguments_)
    .where(eq(arguments_.claimId, claimId));

  const evaluations = await rawQuery<{
    argument_id: string;
    verdict: string;
    decisive: boolean;
    content: string;
    stale: boolean;
  }>(
    `SELECT ae.argument_id, ae.verdict, ae.decisive, ae.content,
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

  // The claim's source map (#286): the Steward's account of what the support
  // rests on, a claim-level summary rather than any one source. Readings and
  // edges per instance come with get_claim_instances. A failure here
  // degrades to no map, never a failed read (§20).
  const sourceMap = await getSourceMapSummary(claim.id).catch(() => null);

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

  // Findings already noted on this claim (#394): one line each, a courtesy
  // for the Steward's common case. The check that prevents a repeat lives in
  // note_finding itself, for every role; this list is passive and carries no
  // instruction. `stale` marks a note whose cited assessment is no longer
  // current, so the Steward knows the graph has moved since it was written.
  const findingsNoted = await listFindings({ claimId, limit: 10 }).catch(() => []);

  // The claim's formal statement and the checks on it (#435): the published
  // version, any draft or reviewed one awaiting publication, every version's
  // status, and the checker's verdicts. The Steward reads this before
  // formalizing (is there already a statement, or a draft to review?) and
  // after an attempt (which statement did it run against, what did the
  // checker say). Empty history means nothing has ever been recorded.
  const formalizationRecord = await getClaimFormalizationRecord(claimId);
  // Lateral links (#436): claims a reader of this one would want beside it,
  // with the reason. Not dependencies; they never enter the assessment.
  const relatedClaims = await listRelatedClaims(claimId);

  // Kinds (constitution §2, §7a): a quantity's definition, estimate,
  // readings and cuts; a question's standing and structure; for a claim
  // about which side of a figure a quantity lies, that quantity; and the
  // requests that bear on the node.
  const kindRecord: Record<string, unknown> = {};
  if (claim.kind === "quantity") {
    const q = await getQuantityDetail(claimId);
    // Figures that ingestion linked here but whose value nobody has recorded
    // yet: get_claim_instances shows them; record_estimate with instance_id
    // records each one's figure.
    const [unrecorded] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM claim_instances
        WHERE claim_id = $1 AND stance = 'states' AND stated_estimate IS NULL AND detached_at IS NULL`,
      [claimId]
    );
    kindRecord.quantity = {
      definition: q.definition,
      current_estimate: q.estimate,
      estimated: q.assessed,
      stated_estimates: q.estimates.length,
      figures_not_yet_recorded: unrecorded?.n ?? 0,
      readings: q.readings,
      cuts: q.cuts,
    };
  } else if (claim.kind === "question") {
    kindRecord.question = await getQuestionDetail(claimId);
  } else {
    const threshold = await getThresholdOf(claimId);
    if (threshold) kindRecord.threshold_of = threshold;
  }
  const requests = await listRequests({ claimId, limit: 20 }).catch(() => ({ items: [], total: 0 }));
  if (requests.items.length > 0) {
    kindRecord.requests = requests.items.map((r) => ({
      id: r.id,
      ask: r.ask,
      state: r.state,
      // The Steward of the one node a request bears on keeps it.
      kept_by_this_node: r.keeper.kind === "steward" && r.bears_on.length === 1 && r.bears_on[0]!.id === claimId,
      filed_by: r.filed_by.label,
      work: r.work.map((w) => ({ by: w.by, outcome: w.outcome, summary: w.summary })),
    }));
  }

  return {
    claim: {
      id: claim.id,
      kind: claim.kind,
      text: claim.text,
      claim_type: claim.claimType,
      state: claim.state,
      decomposition_status: claim.decompositionStatus,
      // Whether a Steward has actually worked this claim (#415).
      // decomposition_status flips to "complete" at onboarding, when the
      // claim is handed to its Steward, so on its own it cannot tell "never
      // structured" from "structured and judged to need no children". The
      // Steward queue state can: stewarded_at is null and steward_state is
      // 'pending' or 'deferred' until a Steward run has started, and 'done'
      // only once one has finished. A high-importance claim with no children,
      // no assessment and no stewarded_at has simply not been worked yet.
      steward_state: claim.stewardState,
      stewarded_at: claim.stewardedAt?.toISOString() ?? null,
      importance: claim.importance,
      // Derived from the subclaims loaded below, never from a stored counter
      // (#417): every edge in claim_relationships counts once, argument-grouped
      // or not — an edge shared by two arguments is two rows above but one
      // child (#437) — and a child is assessed when it has a current
      // assessment.
      children_total: new Set(subclaims.map((sc) => sc.edge_id)).size,
      children_assessed: new Set(
        subclaims.filter((sc) => sc.child_status != null).map((sc) => sc.edge_id)
      ).size,
      // Why the canonical form runs in the direction it does (#360): chosen
      // on the proposition's terms when the claim was minted, so a Steward
      // improving the wording keeps the polarity every stance is read
      // against. Null for claims minted before the note existed.
      canonical_direction_note: claim.canonicalDirectionNote ?? null,
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
    ...kindRecord,
    ...formalizationRecord,
    findings_noted: findingsNoted.map((f) => ({
      id: f.id,
      noted_at: f.first_noted_at instanceof Date ? f.first_noted_at.toISOString() : f.first_noted_at,
      agent: f.agent,
      importance: Number(f.importance),
      sighting_count: Number(f.sighting_count),
      headline: f.headline,
      cites: (Array.isArray(f.refs) ? f.refs : []).map((r) => `${r.kind} ${r.id}`),
      ...(f.stale ? { stale: "cites an assessment that is no longer current" } : {}),
    })),
    related_claims: relatedClaims.map((r) => ({
      id: r.id,
      text: r.text,
      kind: r.kind,
      reasoning: r.reasoning,
      assessment_status: r.assessment_status,
    })),
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
      ...(sc.child_kind !== "claim" ? { kind: sc.child_kind } : {}),
      ...(sc.child_kind === "quantity" ? { estimate: sc.child_estimate } : {}),
      ...(sc.child_kind === "question" ? { standing: sc.child_standing } : {}),
    })),
    // The claim's source map (#286): null until a Steward has written one.
    // Refresh it with provenance_write_map when the instances have changed.
    source_map: sourceMap,
    // How many instances the claim carries. The instances themselves, with
    // readings and attribution, come from get_claim_instances.
    instance_count: instanceCount,
    arguments: args.map((a) => {
      const evaluation = evaluationByArgument.get(a.id) ?? null;
      return {
        id: a.id,
        name: a.name,
        stance: a.stance,
        ...(a.shows ? { shows: a.shows } : {}),
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
              decisive: evaluation.decisive,
              content: evaluation.content,
              stale: evaluation.stale,
            }
          : null,
      };
    }),
  };
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
  contributorId?: string,
  claimId?: string
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
  if (claimId) {
    conditions = sql`${conditions} AND ${contributions.claimId} = ${claimId}`;
  }

  const rows = await db
    .select({
      reviewId: contributionReviews.id,
      contributionId: contributionReviews.contributionId,
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
      // The key get_contribution_details takes (#495): without it audit
      // can read a reviewer's reasoning but not what was reviewed.
      contribution_id: r.contributionId,
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
