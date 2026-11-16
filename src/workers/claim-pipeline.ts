import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { claims } from "../db/schema.js";
import { enqueueSteward } from "../services/queue-service.js";
import type { QueuedClaimPipelineMessage } from "../services/queue-service.js";
import { labelIsDefined, publicIsTheOnlyLabel } from "../services/label-service.js";
import { currentLabel, runAtLabel } from "../llm/usage-context.js";
import { MissingLabelError, PUBLIC_LABEL, UndefinedLabelError } from "../labels.js";

/**
 * Claim onboarding dispatcher.
 *
 * This is the single entry point for a newly created claim (from URL extraction
 * or the API). It does NOT decompose, match, or assess — all of that is the
 * Claim Steward's job now: the Steward owns the claim's structure (it decomposes
 * and, via match_claim, links existing claims or creates new ones) and its
 * assessment (constitution Part VII). Onboarding just hands the claim to its
 * Steward.
 *
 * Termination is guaranteed without a depth limit: the Steward calls match_claim
 * before creating any subclaim, so any pre-existing claim (including an ancestor)
 * is found and merely linked — only genuinely new claims enqueue further work.
 * Spend is bounded by money, not by decomposition depth: the Steward lane
 * runs only what the action ledger funds (steward-pipeline.ts); the rest
 * waits.
 *
 * The hand-over happens at the label the message was enqueued at
 * (src/labels.ts), so the claim's first pass is opened on the ledger at the
 * label of the work that made the claim. Which label that is, and when the
 * message is refused instead, is labelToRunAt below.
 */
export async function handleClaimPipeline(
  message: QueuedClaimPipelineMessage
): Promise<void> {
  const work = `the claim pipeline message for claim ${message.claimId}`;
  const label = await labelToRunAt(message, work);
  return runAtLabel(label, work, () => onboardClaim(message.claimId));
}

/**
 * The label a queued message is run at, or the refusal.
 *
 * A message carries its label in its `label` field, and is run at it. Two
 * things are checked first, because a message is the one carrier of a label
 * that the database does not check:
 *
 * - A label that is there but empty or null is refused (MissingLabelError),
 *   as a row without one would be.
 * - A label that names no row in `labels` is refused (UndefinedLabelError).
 *   A row's foreign key makes that impossible for a row. Without the check
 *   here the claim would be marked onboarded, the ledger would turn away
 *   its first pass (the ledger row's own foreign key), the enqueue would
 *   log that and carry on, and the scheduler's sweep, which works outside
 *   any run, would later open that pass at `public`.
 *
 * A message with no `label` key at all is a different case, and the one
 * place where missing does not simply mean refused. The code before the
 * label field enqueued messages without it, and a queue outlives a deploy:
 * the first worker running this code finds those messages still waiting.
 * The rows that carry a label did not have this problem, because the
 * migration's column default made every row that already existed public.
 * This gives the waiting messages the same treatment, where it is safe:
 *
 * - If `public` is the only label this deployment has, there is no other
 *   label the work could have been created at, so the message is public
 *   work and is run at `public`. That is the public graph, where refusing
 *   would leave those claims without a Steward until someone redrove the
 *   messages by hand.
 * - If the deployment has any other label, the message is refused like any
 *   other work without a label. There a missing field could be private
 *   work, and private work must never be written as public because a field
 *   went missing.
 *
 * The question of whether `public` is the only label is asked only for a
 * message without the key, never for one that carries its label.
 *
 * The path for a message without the key, PreLabelClaimPipelineMessage and
 * publicIsTheOnlyLabel can be deleted once no message written before the
 * field can remain in any queue: when the queue's retention period has
 * passed since the deploy that introduced the field (SQS keeps a message
 * for 14 days at most, and a dead-letter queue that is redriven into this
 * one has a retention period of its own, which counts too). After that
 * every message has the key, and one without it is refused everywhere.
 */
async function labelToRunAt(message: QueuedClaimPipelineMessage, work: string): Promise<string> {
  if (!("label" in message)) {
    if (await publicIsTheOnlyLabel()) return PUBLIC_LABEL;
    throw new MissingLabelError(work);
  }
  // The type says string, but this was parsed from a queue, so it is
  // whatever the message held.
  const label: unknown = message.label;
  if (typeof label !== "string" || label.length === 0) throw new MissingLabelError(work);
  if (!(await labelIsDefined(label))) throw new UndefinedLabelError(work, label);
  return label;
}

async function onboardClaim(claimId: string): Promise<void> {
  const db = getDb();

  const [claim] = await db
    .select({
      id: claims.id,
      decompositionStatus: claims.decompositionStatus,
      label: claims.sensitivityLabel,
    })
    .from(claims)
    .where(eq(claims.id, claimId))
    .limit(1);

  if (!claim) return;

  // Onboarding hands a node to its own Steward for its first pass, and is
  // the node's own label's work: a message at another label does not
  // onboard it (a node's row is changed only by work at its own label).
  if (claim.label !== currentLabel()) return;

  // Idempotency: only onboard once. "complete" here means "handed to the
  // Steward, which owns ongoing structure" — not that decomposition is frozen.
  if (claim.decompositionStatus === "complete") return;

  await db
    .update(claims)
    .set({ decompositionStatus: "complete", updatedAt: new Date() })
    .where(eq(claims.id, claimId));

  await enqueueSteward({
    claimId,
    trigger: "structure_and_assess",
    // How much structure a claim needs is a question of its importance (§6),
    // so the context asks for the judgment rather than prescribing a split.
    context:
      "New claim onboarded. Give it the structure and assessment its importance " +
      "warrants; a minor or settled claim may need no decomposition.",
  });
}
