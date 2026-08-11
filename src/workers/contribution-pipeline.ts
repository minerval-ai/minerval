/**
 * Contribution pipeline worker.
 *
 * Wraps the Contribution Reviewer agent in a crash-safe claim (#218), the same
 * shape as the Steward's drain: the contribution row is atomically stamped
 * before the agent runs, so duplicate messages — recovery-sweep re-enqueues,
 * SQS redelivery, multi-process races — no-op instead of double-reviewing.
 *
 * Error semantics mirror steward-pipeline.ts:
 *  - budget errors release the claim and refund the attempt (the work stopped
 *    for lack of budget, not because it is poisoned; the local runner
 *    re-queues the message and retries next window);
 *  - other errors KEEP the claim, so the retry waits out the reclaim window —
 *    a natural backoff — and the attempt stays spent, so the recovery sweep
 *    parks the row after MAX_REVIEW_ATTEMPTS instead of hot-looping on a
 *    poisoned contribution.
 */
import type { ContributionMessage } from "../services/queue-service.js";
import { runContributionReview } from "../llm/agents/contribution-reviewer.js";
import { rawQuery } from "../db/client.js";
import { LlmBudgetExceededError } from "../llm/errors.js";
import { runWithUsageContext } from "../llm/usage-context.js";

/**
 * Who this review is for. A contribution exists because one contributor
 * submitted it, so that contributor is the review's subject — `contributors`
 * IS the user table (llm_usage.user_id references it), so this is a usable
 * attribution and not just a label.
 *
 * Without it the Reviewer's spend landed on rows with a null user and a null
 * job: real money, metered correctly, assigned to nobody. Reviewing is not
 * platform overhead — it happens because somebody asked for something.
 */
async function reviewSubject(contributionId: string): Promise<string | null> {
  const [row] = await rawQuery<{ contributor_id: string | null }>(
    `SELECT contributor_id FROM contributions WHERE id = $1`,
    [contributionId]
  );
  return row?.contributor_id ?? null;
}

/** Reclaim window: a claim older than this counts as abandoned (crashed process). */
export const REVIEW_RECLAIM_MINUTES = 15;
/** Attempt cap per phase; the recovery sweep stops re-driving a row past it. */
export const MAX_REVIEW_ATTEMPTS = 3;

export async function handleContributionMessage(
  message: ContributionMessage
): Promise<void> {
  const claimed = await rawQuery<{ id: string }>(
    `UPDATE contributions
        SET review_claimed_at = now(),
            review_attempts = review_attempts + 1
      WHERE id = $1
        AND review_status = 'pending'
        AND (review_claimed_at IS NULL
             OR review_claimed_at < now() - interval '${REVIEW_RECLAIM_MINUTES} minutes')
        AND review_attempts < ${MAX_REVIEW_ATTEMPTS}
      RETURNING id`,
    [message.contributionId]
  );
  if (claimed.length === 0) return; // already reviewed, in flight, or parked

  try {
    const userId = await reviewSubject(message.contributionId);
    await runWithUsageContext({ userId }, () =>
      runContributionReview({
        contributionId: message.contributionId,
      })
    );
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) {
      await rawQuery(
        `UPDATE contributions
            SET review_claimed_at = NULL,
                review_attempts = review_attempts - 1
          WHERE id = $1 AND review_status = 'pending'`,
        [message.contributionId]
      );
    }
    throw err;
  }
}
