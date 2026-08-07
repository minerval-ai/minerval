/**
 * Intake service (#157): user suggestions that would mint NEW graph content.
 *
 * The constitution's governance principle is "suggestions, not writes": no
 * user-submitted content becomes part of the graph until it has passed
 * review, and only canonical claims are admitted. Contributions against
 * existing claims already flow through the Contribution Reviewer; this module
 * gives the two surfaces that previously wrote directly — proposing a claim
 * and submitting a source — the same shape. A proposal is stored as a
 * contribution row (claim_id null, nothing in the claims table), reviewed by
 * the Contribution Reviewer, and only an accept MATERIALIZES it: the Matcher
 * decides identity first (dedup/canonicalization, including negation), then
 * either the existing claim absorbs the proposal or a new claim is created
 * live and handed to its Steward.
 *
 * The reviewer's accept/reject/escalate is the judgment; materialization is
 * deliberately mechanical (Judgment over Mechanism — the agent decides, code
 * applies).
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { claims, arguments_, contributions } from "../db/schema.js";
import { intakeContributionTypeEnum } from "../schemas/common.js";
import { matchClaim } from "../llm/agents/matcher.js";
import { generateEmbedding } from "./embedding-service.js";
import { createJob } from "./job-service.js";
import {
  enqueueClaimPipeline,
  enqueueContribution,
  enqueueSteward,
  enqueueUrlExtraction,
} from "./queue-service.js";
import { getOrCreateSource } from "./source-service.js";
import { loadConfig } from "../config.js";
import { createOrder } from "./order-service.js";
import { rawQuery } from "../db/client.js";

/**
 * An accepted claim proposal was PAID for (the claim_proposal owl at
 * submission), so its claim gets an express-lane assessment order funded by
 * that same charge — a paid proposal never sits behind the background queue
 * (#284). Best-effort: a failure here leaves the claim on the background
 * queue rather than failing the acceptance.
 */
async function createProposalFundedOrder(
  contribution: { id: string; contributorId: string },
  claimId: string
): Promise<void> {
  try {
    const [charge] = await rawQuery<{ id: string }>(
      `SELECT id FROM owl_ledger
        WHERE contribution_id = $1 AND reason = 'charge'
        ORDER BY created_at ASC LIMIT 1`,
      [contribution.id]
    );
    await createOrder({
      userId: contribution.contributorId,
      claimId,
      contributionId: contribution.id,
      chargeEntryId: charge?.id ?? null,
    });
  } catch (err) {
    console.warn(
      `[intake] could not create funded order for contribution ${contribution.id}:`,
      err instanceof Error ? err.message : err
    );
  }
}

export type IntakeContributionType = "propose_claim" | "propose_source";

export function isIntakeContributionType(
  type: string
): type is IntakeContributionType {
  return intakeContributionTypeEnum.options.includes(
    type as IntakeContributionType
  );
}

/**
 * Store a user's proposed claim as a pending intake contribution and enqueue
 * it for review. Writes nothing to the claims table.
 */
export async function createClaimProposal(input: {
  claimText: string;
  argumentText: string;
  contributorId: string;
}) {
  const db = getDb();
  const [contribution] = await db
    .insert(contributions)
    .values({
      claimId: null,
      contributorId: input.contributorId,
      contributionType: "propose_claim",
      // The argument is the contribution's substance; the proposed claim text
      // rides in proposed_canonical_form, same as a propose_edit.
      content: input.argumentText,
      proposedCanonicalForm: input.claimText,
    })
    .returning();

  await enqueueContribution({ contributionId: contribution!.id });
  return contribution!;
}

/**
 * Store a user's submitted source as a pending intake contribution and
 * enqueue it for review. The source row itself is created immediately — it is
 * inert until extraction runs — but no extraction is enqueued.
 */
export async function createSourceProposal(input: {
  url: string;
  title?: string;
  content?: string;
  contributorId: string;
}) {
  const db = getDb();
  const source = await getOrCreateSource({
    url: input.url,
    title: input.title,
    content: input.content,
  });

  const [contribution] = await db
    .insert(contributions)
    .values({
      claimId: null,
      contributorId: input.contributorId,
      contributionType: "propose_source",
      content: input.url,
      sourceId: source.id,
      evidenceUrls: [input.url],
    })
    .returning();

  await enqueueContribution({ contributionId: contribution!.id });
  return { contribution: contribution!, sourceId: source.id };
}

export interface IntakeMaterializationResult {
  action:
    | "matched_existing_claim"
    | "created_claim"
    | "enqueued_extraction"
    | "already_materialized";
  claimId?: string;
  canonicalText?: string;
  stance?: "affirms" | "denies";
  jobId?: string;
}

/**
 * Apply an ACCEPTED intake contribution to the graph. Called from the
 * reviewer's record_review_decision tool before the review is recorded, so a
 * failure here surfaces to the reviewing agent instead of leaving an accepted
 * contribution with nothing materialized. Idempotent: a contribution that
 * already materialized (claim linked / extraction job created) is a no-op.
 */
export async function materializeAcceptedIntake(
  contributionId: string
): Promise<IntakeMaterializationResult> {
  const db = getDb();
  const [contribution] = await db
    .select()
    .from(contributions)
    .where(eq(contributions.id, contributionId))
    .limit(1);

  if (!contribution) {
    throw new Error(`Contribution not found: ${contributionId}`);
  }
  if (!isIntakeContributionType(contribution.contributionType)) {
    throw new Error(
      `Contribution ${contributionId} is type '${contribution.contributionType}', not an intake type`
    );
  }

  if (contribution.contributionType === "propose_claim") {
    return materializeProposedClaim(contribution);
  }

  // Idempotency for propose_source: materialization runs before the review is
  // recorded, so an already-accepted contribution has already been applied.
  // (A prior extraction job for the same URL from internal seeding must NOT
  // short-circuit this — an accepted re-submission is a legitimate
  // re-process, same as the direct service path.)
  if (contribution.reviewStatus === "accepted") {
    return { action: "already_materialized" };
  }
  return materializeProposedSource(contribution);
}

async function materializeProposedClaim(contribution: {
  id: string;
  claimId: string | null;
  contributorId: string;
  content: string;
  proposedCanonicalForm: string | null;
}): Promise<IntakeMaterializationResult> {
  if (contribution.claimId) {
    return { action: "already_materialized", claimId: contribution.claimId };
  }
  const claimText = contribution.proposedCanonicalForm;
  if (!claimText) {
    throw new Error(
      `propose_claim contribution ${contribution.id} has no proposed claim text`
    );
  }

  const db = getDb();

  // Only canonical claims enter: the Matcher is the single decider of claim
  // identity (any wording, or the negation), exactly as on the extraction
  // path. A duplicate proposal lands on the existing node instead of forking
  // the debate.
  const match = await matchClaim({
    extractedText: claimText,
    proposedCanonical: claimText,
  });

  if (match.is_match && match.matched_claim_id) {
    await db
      .update(contributions)
      .set({ claimId: match.matched_claim_id })
      .where(eq(contributions.id, contribution.id));

    // The claim exists, so its Steward owns integrating the proposal's
    // argument — same handoff as an accepted challenge/support.
    await enqueueSteward({
      claimId: match.matched_claim_id,
      trigger: "contribution_accepted",
      context:
        `An accepted propose_claim contribution matched this claim` +
        (match.instance_stance === "denies"
          ? " (the proposal asserts its negation)"
          : "") +
        `. Proposed wording: "${claimText}". Supporting argument from the ` +
        `contributor: ${contribution.content}`,
    });

    // The proposal was paid for: run that steward pass on the express lane.
    await createProposalFundedOrder(contribution, match.matched_claim_id);

    return {
      action: "matched_existing_claim",
      claimId: match.matched_claim_id,
      stance: match.instance_stance,
    };
  }

  // Novel: materialize as a live claim under the matcher's canonical wording
  // and hand it to its Steward. created_by='user' stays honest provenance —
  // after #157 it means "user-proposed, review-approved".
  const canonicalText = match.new_canonical_form ?? claimText;
  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(canonicalText);
  } catch {
    // Proceed without embedding; retried in pipeline
  }

  const { pipelineEpoch, proposedClaimImportancePrior } = loadConfig();
  const [claim] = await db
    .insert(claims)
    .values({
      text: canonicalText,
      createdBy: "user",
      embedding,
      importance: proposedClaimImportancePrior,
      // contestation stays NULL (not yet judged): intake sees no discourse
      // context, so unlike the Extractor it has no basis for a prior; the
      // Steward records the first real value (#172 phase 1).
      pipelineEpoch,
    })
    .returning();

  await db.insert(arguments_).values({
    claimId: claim!.id,
    stance: "for",
    content: contribution.content,
    createdBy: "user",
  });

  await db
    .update(contributions)
    .set({ claimId: claim!.id })
    .where(eq(contributions.id, contribution.id));

  const job = await createJob(
    "claim_pipeline",
    { claimId: claim!.id },
    { userId: contribution.contributorId, apiKeyId: null }
  );
  await enqueueClaimPipeline({ claimId: claim!.id, jobId: job.id });

  // The proposal was paid for: the new claim's first Steward pass runs on
  // the express lane instead of waiting its turn in the background queue.
  await createProposalFundedOrder(contribution, claim!.id);

  return {
    action: "created_claim",
    claimId: claim!.id,
    canonicalText,
    jobId: job.id,
  };
}

async function materializeProposedSource(contribution: {
  id: string;
  contributorId: string;
  content: string;
  sourceId: string | null;
}): Promise<IntakeMaterializationResult> {
  if (!contribution.sourceId) {
    throw new Error(
      `propose_source contribution ${contribution.id} has no source`
    );
  }

  const job = await createJob(
    "url_extraction",
    { sourceId: contribution.sourceId, url: contribution.content },
    { userId: contribution.contributorId, apiKeyId: null }
  );
  await enqueueUrlExtraction({
    sourceId: contribution.sourceId,
    jobId: job.id,
    url: contribution.content,
  });

  return { action: "enqueued_extraction", jobId: job.id };
}
