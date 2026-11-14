/**
 * Recovery sweep (#218).
 *
 * The Contribution/Arbitration queues are in-memory: a process restart
 * (deploy, crash, scale-in) loses whatever was queued, and a handler that
 * throws after dequeue loses that message. For the work that has a durable
 * row — contributions awaiting review, escalated contributions awaiting
 * arbitration, appeals awaiting arbitration — the row itself is the source of
 * truth, so this sweep periodically re-enqueues any row that is still in a
 * waiting status with no live claim. The pipeline handlers' atomic claim
 * (contribution-pipeline.ts / arbitration-pipeline.ts) makes duplicate
 * enqueues no-op, so sweeping is safe across multiple processes.
 *
 * Rows that have exhausted MAX_REVIEW_ATTEMPTS are left alone (parked) and
 * surfaced in the sweep's log line — they need operator attention, not more
 * spend. Curator and Audit runs need no sweep: they are ledger actions
 * (#363), and the action row is their durable queue.
 *
 * URL extractions that stopped are swept here too (sweepStalledIngests):
 * an ingest row the engine executor left 'running' whose extraction has
 * made no progress for INGEST_STALL_MINUTES goes back to open, and the
 * executor submits the source again (docs/infrastructure.md, "The
 * extraction lane").
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import {
  enqueueArbitration,
  enqueueContribution,
  getLocalQueue,
} from "../services/queue-service.js";
import {
  MAX_REVIEW_ATTEMPTS,
  ORDINARY_REVIEW_TYPE_FILTER,
  REVIEW_RECLAIM_MINUTES,
} from "./contribution-pipeline.js";
import { withSystemClearance } from "../db/clearance.js";

/** Don't re-enqueue rows younger than this — their original message is
 * almost certainly still queued or in flight. */
const SWEEP_GRACE_MINUTES = 2;

export interface SweepStats {
  contributionsRequeued: number;
  escalationsRequeued: number;
  appealsRequeued: number;
  ordersRequeued: number;
  parked: number;
}

/** How long a dispatched order may sit 'running' before we presume the
 * worker died. Longer than any real Steward run; the claim-slot reclaim
 * (15 min) prevents a double run either way, and the order's idempotent
 * charge key (`charge:order:<id>`) makes the re-dispatch charge a no-op. */
const ORDER_RECLAIM_MINUTES = 45;

/**
 * Return crashed orders to the pending lane (#stuck-running): a worker
 * death after the charge left the user's owls taken, the run never
 * settled, and the open-order check blocking the claim forever. The charge
 * rides along (charge_entry_id survives), so the retry never double-debits.
 */
async function sweepStuckOrders(): Promise<number> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE assessment_orders
        SET status = 'pending', started_at = NULL
      WHERE status = 'running'
        AND started_at < now() - interval '${ORDER_RECLAIM_MINUTES} minutes'
      RETURNING id`
  );
  return rows.length;
}

export async function sweepStalledReviewWork(): Promise<SweepStats> {
  const stale = `(review_claimed_at IS NULL
                  OR review_claimed_at < now() - interval '${REVIEW_RECLAIM_MINUTES} minutes')`;

  // A claim_prize contribution is reviewed by the prize-check worker under
  // the bounty's reserve; re-enqueuing it here would run a second Reviewer
  // attributed to the claimant (docs/mathematics.md §8.4).
  const pending = await rawQuery<{ id: string }>(
    `SELECT id FROM contributions
      WHERE review_status = 'pending'
        AND ${ORDINARY_REVIEW_TYPE_FILTER}
        AND submitted_at < now() - interval '${SWEEP_GRACE_MINUTES} minutes'
        AND ${stale}
        AND review_attempts < ${MAX_REVIEW_ATTEMPTS}`
  );
  for (const row of pending) {
    await enqueueContribution({ contributionId: row.id });
  }

  const escalated = await rawQuery<{ id: string }>(
    `SELECT id FROM contributions
      WHERE review_status = 'escalated'
        AND ${stale}
        AND review_attempts < ${MAX_REVIEW_ATTEMPTS}`
  );
  for (const row of escalated) {
    await enqueueArbitration({
      contributionId: row.id,
      trigger: "escalated_review",
    });
  }

  const appeals = await rawQuery<{ id: string; contribution_id: string }>(
    `SELECT id, contribution_id FROM appeals
      WHERE status = 'pending'
        AND submitted_at < now() - interval '${SWEEP_GRACE_MINUTES} minutes'
        AND (claimed_at IS NULL
             OR claimed_at < now() - interval '${REVIEW_RECLAIM_MINUTES} minutes')
        AND arbitration_attempts < ${MAX_REVIEW_ATTEMPTS}`
  );
  for (const row of appeals) {
    await enqueueArbitration({
      contributionId: row.contribution_id,
      trigger: "appeal",
      appealId: row.id,
    });
  }

  const parked = await rawQuery<{ n: number }>(
    `SELECT (SELECT count(*) FROM contributions
              WHERE review_status IN ('pending', 'escalated')
                AND review_attempts >= ${MAX_REVIEW_ATTEMPTS})
          + (SELECT count(*) FROM appeals
              WHERE status = 'pending'
                AND arbitration_attempts >= ${MAX_REVIEW_ATTEMPTS}) AS n`
  );

  const ordersRequeued = await sweepStuckOrders();

  return {
    contributionsRequeued: pending.length,
    escalationsRequeued: escalated.length,
    appealsRequeued: appeals.length,
    ordersRequeued,
    parked: Number(parked[0]?.n ?? 0),
  };
}

/**
 * How long an extraction may show no progress before the sweep presumes no
 * attempt holds it. A run stamps its job's heartbeat at least every half
 * minute while its model calls finish (url-extraction.ts), and the poller
 * gives up on a run after the lane's stall window (URL_EXTRACTION_STALL_
 * MINUTES) and returns its message, whose next attempt stamps the job
 * afresh. Twice that window, and never under half an hour, means neither a
 * live attempt nor one about to start: the run died with its process, its
 * message went to the dead-letter queue, or (with in-memory queues) a
 * restart lost it. Until this sweep the row stayed 'running' for days
 * (2026-11-13: ingests opened at 00:01 still running at 22:00), counted as
 * work in hand by the mandate that planned it. It is a wait on a hang, which
 * spends nothing, so no budget could end it.
 */
export function ingestStallMinutes(): number {
  return Math.max(30, 2 * (loadConfig().urlExtractionStallMinutes ?? 15));
}

/**
 * How many times the sweep gives up on one ledger row's extractions before
 * it cancels the row instead of reopening it. A source whose reading hangs
 * every time would otherwise be submitted again forever, and a hang spends
 * nothing, so its funders' budget would never stop it. Three tries is
 * enough to ride out a provider's or a process's bad hour.
 */
const MAX_INGEST_REAPS = 3;

export interface IngestSweepStats {
  /** Rows sent back to open, for the executor to submit again. */
  reopened: number;
  /** Rows cancelled after MAX_INGEST_REAPS abandoned extractions. */
  cancelled: number;
}

/**
 * Give up on extractions that stopped, and put their ledger rows back in
 * line. A job is abandoned in one guarded write (it must still be
 * 'processing', or with in-memory queues still 'pending' and no longer
 * queued, with no progress for the window), so two sweeps never both act on
 * it; the abandoned job is never run again (job-service.startJobAttempt),
 * and the run that held it stops at its next step. The row is released to
 * open, keeping its allocations: the executor submits the source again
 * under a new job, and only that extraction's metered cost is consumed
 * when it completes (url-extraction.ts), so the funders are not charged
 * twice. What the stopped run spent before it stopped stays metered to the
 * job it ran under, as any model call is.
 */
export async function sweepStalledIngests(): Promise<IngestSweepStats> {
  const minutes = ingestStallMinutes();
  // With in-memory queues a restart loses what was queued, and a job no one
  // took up waits forever. With SQS a queued message is kept for days (the
  // reconcile in action-service.ts owns that case), so only a job a worker
  // took up is judged by its heartbeat.
  const inMemory = !loadConfig().sqsUrlExtractionQueue;
  const queued = inMemory ? getLocalQueue("urlExtraction").map((m) => m.jobId) : [];
  const stalled = await rawQuery<{ job_id: string; action_id: string; target_ref: string | null }>(
    `UPDATE jobs j
        SET status = 'failed',
            error = 'The extraction stopped making progress and was given up on. ' ||
                    'Nothing about the source failed, and the platform submits it again on its own.',
            result = jsonb_build_object('abandoned', true, 'retried_by_platform', true,
                                        'attempts', j.attempts),
            completed_at = now()
       FROM actions a
      WHERE a.id = j.action_id AND a.kind = 'ingest' AND a.status = 'running'
        AND j.type = 'url_extraction'
        AND ((j.status = 'processing'
              AND COALESCE(j.heartbeat_at, j.started_at, j.created_at)
                  < now() - make_interval(mins => $1::int))
             OR ($2::boolean AND j.status = 'pending'
                 AND j.created_at < now() - make_interval(mins => $1::int)
                 AND NOT (j.id::text = ANY($3::text[]))))
      RETURNING j.id AS job_id, a.id AS action_id, a.target_ref`,
    [minutes, inMemory, queued]
  );
  let reopened = 0;
  let cancelled = 0;
  for (const row of stalled) {
    try {
      const [prior] = await rawQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs
          WHERE action_id = $1 AND status = 'failed'
            AND COALESCE(result->>'abandoned', '') = 'true'`,
        [row.action_id]
      );
      if (Number(prior?.n ?? 0) >= MAX_INGEST_REAPS) {
        await rawQuery(
          `UPDATE actions SET status = 'cancelled', updated_at = now()
            WHERE id = $1 AND status = 'running'`,
          [row.action_id]
        );
        await rawQuery(
          `UPDATE jobs SET error = $2, result = result - 'retried_by_platform' WHERE id = $1`,
          [
            row.job_id,
            `The extraction stopped making progress ${MAX_INGEST_REAPS} times and was given up on; ` +
              `the platform does not submit it again.`,
          ]
        );
        cancelled++;
        continue;
      }
      const { releaseAction } = await import("../services/action-service.js");
      await releaseAction(row.action_id);
      reopened++;
    } catch (err) {
      console.error(
        `[recovery-sweep] returning the ingest row of ${row.target_ref ?? row.action_id} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return { reopened, cancelled };
}

/**
 * Run the sweep on an interval (and once at startup, so a deploy immediately
 * re-drives whatever the previous process lost). Sweep failures are logged and
 * skipped — the next interval retries; the sweep must never take the runner
 * down with it.
 */
export function startRecoverySweep(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? 60_000;
  let running = true;

  const sweep = async () => {
    if (!running) return;
    try {
      const stats = await withSystemClearance(
        "The recovery sweep finds stalled reviews and orders at every label and re-enqueues each at its own.",
        () => sweepStalledReviewWork()
      );
      const requeued =
        stats.contributionsRequeued +
        stats.escalationsRequeued +
        stats.appealsRequeued +
        stats.ordersRequeued;
      if (requeued > 0 || stats.parked > 0) {
        options.logger.info(
          `[recovery-sweep] requeued ${stats.contributionsRequeued} reviews, ` +
            `${stats.escalationsRequeued} escalations, ${stats.appealsRequeued} appeals, ` +
            `${stats.ordersRequeued} orders` +
            (stats.parked > 0
              ? `; ${stats.parked} parked at the attempt cap — needs an operator`
              : "")
        );
      }
    } catch (err) {
      options.logger.error(
        "[recovery-sweep] failed:",
        err instanceof Error ? err.message : err
      );
    }
    try {
      const ingests = await withSystemClearance(
        "The ingest sweep finds extractions that stopped at every label and returns each one's ledger row to open, or cancels it.",
        () => sweepStalledIngests()
      );
      if (ingests.reopened > 0 || ingests.cancelled > 0) {
        options.logger.info(
          `[recovery-sweep] gave up on stalled extractions: ${ingests.reopened} ingest rows reopened, ` +
            `${ingests.cancelled} cancelled after ${MAX_INGEST_REAPS} tries`
        );
      }
    } catch (err) {
      options.logger.error(
        "[recovery-sweep] the ingest sweep failed:",
        err instanceof Error ? err.message : err
      );
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), interval);

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
    },
  };
}
