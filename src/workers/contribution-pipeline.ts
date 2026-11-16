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
 *  - a platform fault (deployment-fault.ts: a provider out of credits, a
 *    rejected key, a provider down through its retries) refunds the attempt
 *    and KEEPS the claim, restamped: the work is not poisoned, so the fault
 *    must never park it (#980, #996), and the reclaim window is the wait
 *    before it is tried again;
 *  - other errors KEEP the claim, so the retry waits out the reclaim window —
 *    a natural backoff — and the attempt stays spent, so the recovery sweep
 *    parks the row after MAX_REVIEW_ATTEMPTS instead of hot-looping on a
 *    poisoned contribution.
 */
import type { ContributionMessage } from "../services/queue-service.js";
import { runContributionReview } from "../llm/agents/contribution-reviewer.js";
import { rawQuery } from "../db/client.js";
import { LlmBudgetExceededError } from "../llm/errors.js";
import { runAtLabel, runWithUsageContext } from "../llm/usage-context.js";
import { platformFaultOf } from "../services/deployment-fault.js";

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
async function reviewSubject(
  contributionId: string
): Promise<{ userId: string | null; jobId: string | null }> {
  const [row] = await rawQuery<{ contributor_id: string | null; funded_by_job_id: string | null }>(
    `SELECT contributor_id, funded_by_job_id FROM contributions WHERE id = $1`,
    [contributionId]
  );
  // A contribution a mandate's research submitted is reviewed at the
  // mandate's expense: its review is metered to the mandate's budget job.
  return { userId: row?.contributor_id ?? null, jobId: row?.funded_by_job_id ?? null };
}

/** Reclaim window: a claim older than this counts as abandoned (crashed process). */
export const REVIEW_RECLAIM_MINUTES = 15;
/** Attempt cap per phase; the recovery sweep stops re-driving a row past it. */
export const MAX_REVIEW_ATTEMPTS = 3;

/**
 * The SQL that gives back an attempt a platform fault stopped, keeping the
 * claim with a fresh stamp. Before #980 a fault spent the attempt like a
 * genuine error, so three runs during the 2026-11-12 credits outage parked
 * a contribution as 'pending' with nothing left to re-drive it (#996).
 *
 * The claim is kept rather than released because nothing else paces the
 * retry: a call the provider refuses for credits or credentials is answered
 * before anything is billed, so money cannot (CLAUDE.md, "Constraints on
 * agents"), and a released row is re-enqueued by the recovery sweep every
 * minute. Kept, the row is tried again once the reclaim window has passed,
 * for as long as the fault lasts: a wait, not a limit, and one refused call
 * per contribution per window. `claimAt` and `attempts` name the row's
 * columns; `guard` keeps a row the run had already decided untouched.
 */
export function faultRefundSql(table: string, claimAt: string, attempts: string, guard: string): string {
  return `UPDATE ${table}
             SET ${claimAt} = now(),
                 ${attempts} = GREATEST(${attempts} - 1, 0)
           WHERE id = $1 AND ${guard}`;
}

/**
 * A prize claim's review is the prize-check worker's (docs/mathematics.md
 * §8.4): it runs under the bounty's reserve, never attributed to the
 * claimant, and only after the checker accepted. This pipeline and the
 * recovery sweep leave `claim_prize` alone, so a second Reviewer can never
 * race the worker's.
 */
export const ORDINARY_REVIEW_TYPE_FILTER = `contribution_type <> 'claim_prize'`;

export async function handleContributionMessage(
  message: ContributionMessage
): Promise<void> {
  const claimed = await rawQuery<{ id: string; sensitivity_label: string }>(
    `UPDATE contributions
        SET review_claimed_at = now(),
            review_attempts = review_attempts + 1
      WHERE id = $1
        AND review_status = 'pending'
        AND ${ORDINARY_REVIEW_TYPE_FILTER}
        AND (review_claimed_at IS NULL
             OR review_claimed_at < now() - interval '${REVIEW_RECLAIM_MINUTES} minutes')
        AND review_attempts < ${MAX_REVIEW_ATTEMPTS}
      RETURNING id, sensitivity_label`,
    [message.contributionId]
  );
  if (claimed.length === 0) return; // already reviewed, in flight, or parked
  // The review runs at the label the contribution was submitted at, read
  // from its row (src/labels.ts). The queue message carries none: the
  // recovery sweep enqueues the same message from outside any run.
  const label = claimed[0]!.sensitivity_label;

  // What the review cost, recorded on the contribution even when the review
  // fails partway: a mandate's research pays its reviews from a delegated
  // budget, and recent costs set the estimate a submission reserves.
  const meter = { billedMicroUsd: 0 };
  try {
    const { userId, jobId } = await reviewSubject(message.contributionId);
    await runAtLabel(label, `contribution ${message.contributionId}`, () =>
      runWithUsageContext({ userId, ...(jobId ? { jobId } : {}), meter }, () =>
        runContributionReview({
          contributionId: message.contributionId,
        })
      )
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
    } else if (platformFaultOf(err)) {
      // Raised by the Reviewer's own model call, or by a tool it called
      // (record_review_decision accepting an intake proposal runs the
      // Matcher), which ends the run with PlatformFaultStop.
      await rawQuery(
        faultRefundSql("contributions", "review_claimed_at", "review_attempts", "review_status = 'pending'"),
        [message.contributionId]
      );
    }
    throw err;
  } finally {
    if (meter.billedMicroUsd > 0) {
      await rawQuery(
        `UPDATE contributions
            SET review_cost_micro_usd = COALESCE(review_cost_micro_usd, 0) + $2
          WHERE id = $1`,
        [message.contributionId, Math.round(meter.billedMicroUsd)]
      );
    }
  }
}
