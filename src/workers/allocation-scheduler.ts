/**
 * Allocation scheduler — the time-based half of the allocation core.
 *
 * Two jobs per tick, both mechanical (the judgments live in the recorded
 * signals it reads — Steward-set importance/contestation/marginal_yield,
 * user stakes):
 *
 *  1. Refresh the composite queue_priority of every PENDING claim, so
 *     staleness drift and newly placed stakes reorder the background queue
 *     without per-event bookkeeping.
 *
 *  2. CADENCE (#283): give the long-orphaned 'staleness_check' trigger its
 *     producer. An assessed claim is due for a fresh look after an interval
 *     that shrinks as its priority grows:
 *
 *         due after stalenessBaseDays / clamp(queue_priority, 0.25, 2) days
 *
 *     — a priority-2 claim every base/2 days, a peripheral one at 4× base.
 *     At most stalenessMaxPerSweep claims are re-enqueued per tick: a
 *     bounded reassessment inflow, so cadence can never cascade the queue
 *     (#295's R<1 constraint holds by construction). The sweep marks each
 *     due claim 'pending' via the normal enqueue path; which of them
 *     actually run, and with how much effort, stays the drain's decision.
 *
 * The last-sweep timestamp rides in memory: an extra sweep after a restart
 * is harmless (both jobs are idempotent).
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { refreshPendingQueuePriorities } from "../services/priority-service.js";
import { enqueueSteward } from "../services/queue-service.js";

export interface AllocationTickResult {
  prioritiesRefreshed: number;
  stalenessEnqueued: number;
}

let lastSweepAt = Number.NEGATIVE_INFINITY;

/** Test hook. */
export function resetAllocationScheduler(): void {
  lastSweepAt = Number.NEGATIVE_INFINITY;
}

/** One scheduler pass; exported separately so tests can drive the clock. */
export async function allocationSchedulerTick(
  now: number = Date.now()
): Promise<AllocationTickResult> {
  const config = loadConfig();
  const result: AllocationTickResult = {
    prioritiesRefreshed: 0,
    stalenessEnqueued: 0,
  };
  if (config.allocationSweepIntervalHours <= 0) return result;
  const intervalMs = config.allocationSweepIntervalHours * 3_600_000;
  if (now - lastSweepAt < intervalMs) return result;
  lastSweepAt = now;

  result.prioritiesRefreshed = await refreshPendingQueuePriorities();

  if (config.stalenessBaseDays > 0 && config.stalenessMaxPerSweep > 0) {
    // Most-overdue first, judged against each claim's own cadence.
    const due = await rawQuery<{ id: string; days_old: number }>(
      `SELECT c.id,
              FLOOR(EXTRACT(EPOCH FROM (now() - a.assessed_at)) / 86400)::int
                AS days_old
         FROM claims c
         JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
        WHERE c.state = 'active'
          AND c.steward_state = 'done'
          AND a.assessed_at < now() - make_interval(days =>
                ($1::real / GREATEST(0.25, LEAST(2.0, c.queue_priority)))::int)
        ORDER BY a.assessed_at ASC
        LIMIT $2`,
      [config.stalenessBaseDays, config.stalenessMaxPerSweep]
    );
    for (const claim of due) {
      await enqueueSteward({
        claimId: claim.id,
        trigger: "staleness_check",
        context:
          `Cadence check: this claim's current assessment is ${claim.days_old} ` +
          `days old, past its reassessment interval. Re-examine whether the ` +
          `evidence landscape has moved; if nothing material changed, ` +
          `re-affirm cheaply and record a low marginal_yield.`,
      });
      result.stalenessEnqueued++;
    }
  }

  return result;
}

export function startAllocationScheduler(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? 15 * 60_000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await allocationSchedulerTick();
      if (result.prioritiesRefreshed > 0 || result.stalenessEnqueued > 0) {
        options.logger.info(
          `Allocation scheduler: priorities refreshed=${result.prioritiesRefreshed}, ` +
            `staleness re-enqueued=${result.stalenessEnqueued}`
        );
      }
    } catch (err) {
      options.logger.error(
        "Allocation scheduler error",
        err instanceof Error ? err.message : err
      );
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info("Allocation scheduler started");

  return { stop: () => clearInterval(timer) };
}
