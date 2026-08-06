/**
 * Allocation scheduler — the time-based half of the allocation engine.
 *
 * Each tick walks the engine's three layers in order, all idempotent:
 *
 *  1. RECONCILE the action ledger (action-service.ts): every pending claim
 *     has its assess/reassess exclusion group open, grant plans have their
 *     ingest/planning actions, stale groups are cancelled. The mechanical
 *     table never lags the graph by more than a sweep.
 *
 *  2. REFRESH VALUATIONS (mandate-valuer-service.ts): every mandate
 *     re-judges the open actions it cares about — the General mandate over
 *     the whole graph (also refreshing the queue_priority display cache),
 *     scoped mandates over their scopes — so staleness drift reorders
 *     everyone's ranking without per-event bookkeeping.
 *
 *  3. ALLOCATE (allocation-service.ts): every mandate with a daily rate
 *     takes its allocation pass, backing its best marginal increments up
 *     to the day's room. The executor then runs whatever became covered.
 *
 *  4. CADENCE (#283): an assessed claim is due a fresh look after an
 *     interval that shrinks as its value grows —
 *     stalenessBaseDays / clamp(value, 0.25, 2) days — re-enqueued at most
 *     stalenessMaxPerSweep per tick: a bounded reassessment inflow, so
 *     cadence can never cascade the candidate set (#295's R<1 holds by
 *     construction). Which of them actually run stays the ledger's call.
 *
 * The last-sweep timestamp rides in memory: an extra sweep after a restart
 * is harmless (every job is idempotent).
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { enqueueSteward } from "../services/queue-service.js";
import { getEffectiveAllocationPolicy } from "../services/allocation-policy-service.js";
import { reconcileActions } from "../services/action-service.js";
import { refreshGeneralValuations } from "../services/mandate-valuer-service.js";
import {
  fundGrantSelfActions,
  runDailyAllocators,
} from "../services/allocation-service.js";

export interface AllocationTickResult {
  actionsReconciled: number;
  valuationsRefreshed: number;
  stalenessEnqueued: number;
  allocationsPlaced: number;
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
    actionsReconciled: 0,
    valuationsRefreshed: 0,
    stalenessEnqueued: 0,
    allocationsPlaced: 0,
  };
  if (config.allocationSweepIntervalHours <= 0) return result;
  const intervalMs = config.allocationSweepIntervalHours * 3_600_000;
  if (now - lastSweepAt < intervalMs) return result;
  lastSweepAt = now;

  // 1. The ledger catches up with the graph.
  const reconciled = await reconcileActions().catch(() => null);
  if (reconciled) result.actionsReconciled = reconciled.assessEnsured;

  // 2. The General mandate's formula valuations refresh (other mandates
  // judge for themselves in their own review passes, which the reconcile
  // above keeps opening on cadence).
  const valued = await refreshGeneralValuations().catch(() => 0);
  result.valuationsRefreshed = valued;

  // 3. Grants cover their own planning/review/ingest actions, then every
  // mandate with a daily rate places its next allocations on the fresh
  // values (the drains also do both opportunistically between sweeps).
  await fundGrantSelfActions().catch(() => 0);
  const placed = await runDailyAllocators().catch(() => null);
  if (placed) result.allocationsPlaced = placed.allocated;

  // Cadence knobs come from the governing mandate's allocation policy.
  const policy = await getEffectiveAllocationPolicy();
  if (policy.staleness_base_days > 0 && policy.staleness_max_per_sweep > 0) {
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
      [policy.staleness_base_days, policy.staleness_max_per_sweep]
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
      if (
        result.valuationsRefreshed > 0 ||
        result.stalenessEnqueued > 0 ||
        result.allocationsPlaced > 0
      ) {
        options.logger.info(
          `Allocation scheduler: actions reconciled=${result.actionsReconciled}, ` +
            `valuations refreshed=${result.valuationsRefreshed}, ` +
            `allocations placed=${result.allocationsPlaced}, ` +
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
