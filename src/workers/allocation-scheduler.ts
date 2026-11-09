/**
 * Allocation scheduler — the time-based half of the allocation engine.
 *
 * Each tick, all idempotent:
 *
 *  1. RECONCILE the action ledger (action-service.ts): every pending claim
 *     has its assess/reassess rows open, grant plans have their
 *     ingest/planning actions, stale groups are cancelled. The mechanical
 *     table never lags the graph by more than a sweep.
 *
 *  2. ORDER the pending list by importance (priority-service.ts), for
 *     display and for the fallback lane. It funds nothing.
 *
 *  3. SELF-FUND what mandates already decided: approved plan items and
 *     their agents' runs (fundGrantSelfActions); commission the follow-ups
 *     granted to runs that have ended; and, when enabled, hold program
 *     officer sittings for inboxes no run is waiting on. What else runs is
 *     what someone commissions: mandates through their officers and
 *     lookouts under their written operating policies, agents from their
 *     own budgets, people from their owls. There is no formula and no
 *     allocation pass.
 *
 *  4. CADENCE (#283): an assessed claim is due a fresh look after an
 *     interval that shrinks as its importance grows, and every claim past
 *     its interval is re-enqueued with a staleness message. Enqueueing
 *     only makes it a candidate a mandate's lookouts can see; it spends
 *     nothing.
 *
 * The last-sweep timestamp rides in memory: an extra sweep after a restart
 * is harmless (every job is idempotent).
 */
import { loadConfig } from "../config.js";
import { sweepFollowUps } from "../services/petition-service.js";
import { rawQuery } from "../db/client.js";
import { enqueueSteward } from "../services/queue-service.js";
import { getEffectiveAllocationPolicy } from "../services/allocation-policy-service.js";
import { reconcileActions } from "../services/action-service.js";
import { scanReconcileCandidates } from "../services/curation-service.js";
import { refreshPendingQueuePriorities } from "../services/priority-service.js";
import { fundGrantSelfActions } from "../services/allocation-service.js";

export interface AllocationTickResult {
  actionsReconciled: number;
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
    actionsReconciled: 0,
    prioritiesRefreshed: 0,
    stalenessEnqueued: 0,
  };
  if (config.allocationSweepIntervalHours <= 0) return result;
  const intervalMs = config.allocationSweepIntervalHours * 3_600_000;
  if (now - lastSweepAt < intervalMs) return result;
  lastSweepAt = now;

  // 1. The ledger catches up with the graph. A failure here is the one the
  // mandates feel most (plan items that never become work, #416), so it is
  // never silent: the sweep isolates per-mandate failures itself and
  // reports them; anything that still escapes is logged here.
  const reconciled = await reconcileActions().catch((err: unknown) => {
    console.error(
      `[allocation-scheduler] reconcileActions failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`
    );
    return null;
  });
  if (reconciled) {
    result.actionsReconciled = reconciled.assessEnsured;
    if (reconciled.plansFailed > 0) {
      console.error(
        `[allocation-scheduler] ${reconciled.plansFailed} mandate plan(s) failed to materialize this sweep`
      );
    }
  }

  // 1b. The reconcile-candidate scan (#363): curation requests for pairs
  // of unlinked, unusually similar claims, bounded per sweep by the
  // governing policy (0, the default, is off). Requests only; General's
  // officers decide whether any is worth a Curator's run.
  await scanReconcileCandidates(await getEffectiveAllocationPolicy()).catch(
    (err: unknown) =>
      console.error(
        `[allocation-scheduler] reconcile-candidate scan failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
  );

  // 2. The pending list's order, for display and the fallback lane. It
  // decides no funding: mandates fund work through their agents and their
  // written operating policies.
  result.prioritiesRefreshed = await refreshPendingQueuePriorities().catch(() => 0);

  // 3. Grants cover their own planning/review/ingest actions: the funded
  // plan items and their agents' runs (the drains also do this
  // opportunistically between sweeps).
  await fundGrantSelfActions().catch(() => 0);
  // Follow-ups granted to runs that have since ended, which the lanes'
  // settle hooks missed (petition-service.ts).
  await sweepFollowUps().catch(() => 0);
  // Mandates' inboxes: what lookouts raised and outcomes no run is waiting
  // on, decided by each mandate's program officers. Off unless enabled, as
  // it runs models.
  if (config.officerSittingsEnabled) {
    const { workWaitingInboxes } = await import("../llm/agents/program-officer.js");
    await workWaitingInboxes().catch(() => 0);
  }

  // Cadence knobs come from the governing mandate's allocation policy.
  const policy = await getEffectiveAllocationPolicy();
  if (policy.staleness_base_days > 0) {
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
        ORDER BY a.assessed_at ASC`,
      [policy.staleness_base_days]
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
          `Allocation scheduler: actions reconciled=${result.actionsReconciled}, ` +
            `priorities refreshed=${result.prioritiesRefreshed}, ` +
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
