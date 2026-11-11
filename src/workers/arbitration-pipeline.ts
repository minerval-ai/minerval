/**
 * Arbitration pipeline worker.
 *
 * Wraps the Dispute Arbitrator agent in a crash-safe claim (#218), like
 * contribution-pipeline.ts. The claimed row depends on the flavor:
 *  - appeal-driven arbitration claims the appeal row (status='pending');
 *  - reviewer escalation (no appealId) claims the contribution row
 *    (review_status='escalated').
 * Either way, duplicate messages no-op and a crashed run is reclaimable after
 * the window. Budget errors release the claim and refund the attempt; other
 * errors keep it (reclaim-window backoff, attempt cap parks poisoned rows).
 */
import type { ArbitrationMessage } from "../services/queue-service.js";
import { runArbitration } from "../llm/agents/dispute-arbitrator.js";
import { rawQuery } from "../db/client.js";
import { LlmBudgetExceededError } from "../llm/errors.js";
import { runAtLabel, runWithUsageContext } from "../llm/usage-context.js";
import {
  MAX_REVIEW_ATTEMPTS,
  REVIEW_RECLAIM_MINUTES,
} from "./contribution-pipeline.js";

/**
 * Claim the row the arbitration is for. Returns the claimed row, with the
 * label the arbitration runs at (src/labels.ts): the appeal's for an appeal,
 * the contribution's for a reviewer's escalation. Null when there is nothing
 * to claim.
 */
async function claimWork(message: ArbitrationMessage): Promise<{ id: string; sensitivity_label: string } | null> {
  if (message.appealId) {
    const rows = await rawQuery<{ id: string; sensitivity_label: string }>(
      `UPDATE appeals
          SET claimed_at = now(),
              arbitration_attempts = arbitration_attempts + 1
        WHERE id = $1
          AND status = 'pending'
          AND (claimed_at IS NULL
               OR claimed_at < now() - interval '${REVIEW_RECLAIM_MINUTES} minutes')
          AND arbitration_attempts < ${MAX_REVIEW_ATTEMPTS}
        RETURNING id, sensitivity_label`,
      [message.appealId]
    );
    return rows[0] ?? null;
  }
  const rows = await rawQuery<{ id: string; sensitivity_label: string }>(
    `UPDATE contributions
        SET review_claimed_at = now(),
            review_attempts = review_attempts + 1
      WHERE id = $1
        AND review_status = 'escalated'
        AND (review_claimed_at IS NULL
             OR review_claimed_at < now() - interval '${REVIEW_RECLAIM_MINUTES} minutes')
        AND review_attempts < ${MAX_REVIEW_ATTEMPTS}
      RETURNING id, sensitivity_label`,
    [message.contributionId]
  );
  return rows[0] ?? null;
}

async function releaseClaim(message: ArbitrationMessage): Promise<void> {
  if (message.appealId) {
    await rawQuery(
      `UPDATE appeals
          SET claimed_at = NULL,
              arbitration_attempts = arbitration_attempts - 1
        WHERE id = $1 AND status = 'pending'`,
      [message.appealId]
    );
    return;
  }
  await rawQuery(
    `UPDATE contributions
        SET review_claimed_at = NULL,
            review_attempts = review_attempts - 1
      WHERE id = $1 AND review_status = 'escalated'`,
    [message.contributionId]
  );
}

/**
 * Whose dispute this is. An APPEAL is attributed to the appellant, who is not
 * necessarily the original contributor — someone else's rejected contribution
 * can be appealed, and the party who asked for the arbitration is the party it
 * is for. A reviewer escalation has no appellant, so it stays with the
 * contributor whose submission provoked it.
 *
 * Arbitration is the most expensive governance call in the system and was
 * being metered to nobody at all.
 */
async function disputeSubject(
  message: ArbitrationMessage
): Promise<string | null> {
  if (message.appealId) {
    const [appeal] = await rawQuery<{ appellant_id: string | null }>(
      `SELECT appellant_id FROM appeals WHERE id = $1`,
      [message.appealId]
    );
    if (appeal?.appellant_id) return appeal.appellant_id;
  }
  const [row] = await rawQuery<{ contributor_id: string | null }>(
    `SELECT contributor_id FROM contributions WHERE id = $1`,
    [message.contributionId]
  );
  return row?.contributor_id ?? null;
}

export async function handleArbitrationMessage(
  message: ArbitrationMessage
): Promise<void> {
  const claimed = await claimWork(message);
  if (!claimed) return; // resolved, in flight, or parked

  try {
    const userId = await disputeSubject(message);
    await runAtLabel(
      claimed.sensitivity_label,
      message.appealId ? `appeal ${message.appealId}` : `escalated contribution ${message.contributionId}`,
      () =>
        runWithUsageContext({ userId }, () =>
          runArbitration({
            contributionId: message.contributionId,
            trigger: message.trigger,
            appealId: message.appealId,
          })
        )
    );
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) await releaseClaim(message);
    throw err;
  }
}
