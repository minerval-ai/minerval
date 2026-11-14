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
 * Between sweeps, on every tick (STANDING_ORDER_RETRY_MINUTES apart by
 * default), the plans' standing orders are asked for again and the mandates
 * no agent ends are tended (betweenSweeps).
 *
 * The last-sweep timestamp rides in memory: an extra sweep after a restart
 * is harmless (every job is idempotent).
 */
import { loadConfig } from "../config.js";
import { sweepFollowUps } from "../services/petition-service.js";
import { sweepSessions } from "../services/session-service.js";
import { rawQuery } from "../db/client.js";
import { enqueueSteward } from "../services/queue-service.js";
import { getEffectiveAllocationPolicy } from "../services/allocation-policy-service.js";
import { materializeStandingOrders, reconcileActions } from "../services/action-service.js";
import { tendMandates } from "../services/mandate-lifecycle-service.js";
import { STANDING_ORDER_RETRY_MINUTES } from "../services/standing-order-service.js";
import { scanReconcileCandidates } from "../services/curation-service.js";
import { refreshPendingQueuePriorities } from "../services/priority-service.js";
import { fundGrantSelfActions } from "../services/allocation-service.js";
import { runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "../services/judgment-version-service.js";
import { slotColumnSql } from "../services/steward-lease.js";
import { followShowings, retryGatePayments } from "../services/showing-service.js";
import { settleWaiting } from "../services/release-gate-service.js";
import { offerMandatesWhereEverythingFlows } from "../services/gate-service.js";

async function gateUpkeep(): Promise<void> {
  if (oneLabelOnly()) return;
  await offerMandatesWhereEverythingFlows();
  await retryGatePayments();
  await settleWaiting();
}
import { followOutbound } from "../services/outbound-service.js";
import { followOutwardActs } from "../services/outward-follow.js";
import {
  openReassessmentsForVersionsMadeBesideEarlier,
  openReassessmentsForJudgmentsLeftStanding,
} from "../services/version-upkeep.js";
import { withSystemClearance } from "../db/clearance.js";

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

/**
 * The mandates no agent ends are tended (mandate-lifecycle-service.ts):
 * a `deepen` mandate's scope ordered, a spent escrow paused, a finished
 * mandate completed and refunded. No models run here.
 */
async function tend(): Promise<void> {
  await tendMandates().catch((err: unknown) =>
    console.error(
      `[allocation-scheduler] mandate upkeep failed: ${err instanceof Error ? err.message : String(err)}`
    )
  );
}

/**
 * A tick between full sweeps: the standing orders of mandates' plans are
 * asked for again and brought up to date, and the mandates are tended. This
 * is where the direct steward lane's every-tick work went when its passes
 * became commissions (#849): room that opens in a pace's window or an escrow
 * is used at the scheduler's next tick (STANDING_ORDER_RETRY_MINUTES), not
 * at the next six-hour sweep.
 */
async function betweenSweeps(): Promise<void> {
  await materializeStandingOrders().catch((err: unknown) =>
    console.error(
      `[allocation-scheduler] standing orders failed: ${err instanceof Error ? err.message : String(err)}`
    )
  );
  await tend();
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
  if (now - lastSweepAt < intervalMs) {
    await betweenSweeps();
    return result;
  }
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

  // 1c. Versions of a judgment made beside one that has since been replaced
  // (version-upkeep.ts): the reassessment is opened on the ledger at the
  // version's own label. Opening it runs nothing; a mandate funds it or not.
  await openReassessmentsForVersionsMadeBesideEarlier().catch((err: unknown) =>
    console.error(
      `[allocation-scheduler] version upkeep failed: ${err instanceof Error ? err.message : String(err)}`
    )
  );
  // And judgments a label left standing that have since been replaced: the
  // question is open again at that label.
  await openReassessmentsForJudgmentsLeftStanding().catch((err: unknown) =>
    console.error(
      `[allocation-scheduler] version upkeep (left standing) failed: ${err instanceof Error ? err.message : String(err)}`
    )
  );

  // 1d. Standing showings of a page below its label (showing-service.ts):
  // a page is opened for each new version, with its redaction on the ledger,
  // and nodes that came under a shown node or left it are recorded. Opening
  // a redaction runs nothing; it runs when it is paid for.
  await followShowings().catch((err: unknown) =>
    console.error(`[allocation-scheduler] following showings failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  // 1d''. The rest of the gate's own upkeep (docs/the-gate.md): pay again
  // for work whose budget could not pay, let through what a delay or a
  // changed setting was keeping, and offer mandates where everything flows.
  await gateUpkeep().catch((err: unknown) =>
    console.error(`[allocation-scheduler] the gate's upkeep failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  // 1d'. What passes between this deployment and the public graph besides
  // pages (docs/outward-acts.md), before the packages are built so that a
  // package says what is now so. Contributions the mirror brought about a
  // page this deployment published are taken in and their reading opened on
  // the ledger; summaries already written are given to the node's Steward
  // at the page's label. Requests on the public graph addressed to a
  // mandate this deployment published are put in its inbox. Changed
  // versions are offered to each gate that names a mandate to keep the other
  // side current, agents' reports about Minerval's machinery are offered to
  // the gate to outside, published mandates are restated where a setting
  // changed, and what the gate to outside has let through is sent. None of
  // it runs an agent here, and on a graph with one label none of it does
  // anything.
  await followOutwardActs().catch((err: unknown) =>
    console.error(`[allocation-scheduler] following outward acts failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  // 1e. Pages shown outside (outbound-service.ts): a signed package is
  // built for each change in what the outside would read, and sent where
  // the person who asked for the showing chose that. It runs no agent.
  await followOutbound().catch((err: unknown) =>
    console.error(`[allocation-scheduler] following pages shown outside failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  // 2. The pending list's order, for display and the fallback lane. It
  // decides no funding: mandates fund work through their agents and their
  // written operating policies.
  result.prioritiesRefreshed = await refreshPendingQueuePriorities().catch(() => 0);

  // 3. Grants cover their own planning/review/ingest actions: the funded
  // plan items and their agents' runs (the drains also do this
  // opportunistically between sweeps).
  await fundGrantSelfActions().catch(() => 0);
  // The sweep above placed the plans' standing orders (reconcileActions);
  // the mandates no agent ends are tended on top of it.
  await tend();
  // Follow-ups granted to runs that have since ended, which the lanes'
  // settle hooks missed (petition-service.ts).
  await sweepFollowUps().catch(() => 0);
  // Sessions: a running one whose run died closes, a paused one past its
  // deadline expires, and either's unshown answers go to the node's inbox.
  await sweepSessions().catch(() => 0);
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
    // Where a node carries a version at more than one label, each is
    // checked against its own age and its pass is asked for at its own
    // label, with that label's slot: a version is kept current on its own
    // inputs, whatever another label's has done since. With one label it is
    // the one statement it always was.
    const due = await rawQuery<{ id: string; sensitivity_label: string; days_old: number }>(
      oneLabelOnly()
        ? `SELECT c.id, c.sensitivity_label,
              FLOOR(EXTRACT(EPOCH FROM (now() - a.assessed_at)) / 86400)::int
                AS days_old
         FROM claims c
         JOIN assessments_in_force a ON a.claim_id = c.id
        WHERE c.state = 'active'
          AND c.steward_state = 'done'
          AND a.assessed_at < now() - make_interval(days =>
                ($1::real / GREATEST(0.25, LEAST(2.0, c.queue_priority)))::int)
        ORDER BY a.assessed_at ASC`
        : `SELECT c.id, a.sensitivity_label,
              FLOOR(EXTRACT(EPOCH FROM (now() - a.assessed_at)) / 86400)::int
                AS days_old
         FROM claims c
         JOIN assessments_versions a ON a.claim_id = c.id
        WHERE c.state = 'active'
          AND ${slotColumnSql("steward_state", "c", "a.sensitivity_label")} = 'done'
          AND a.assessed_at < now() - make_interval(days =>
                ($1::real / GREATEST(0.25, LEAST(2.0, c.queue_priority)))::int)
        ORDER BY a.assessed_at ASC`,
      [policy.staleness_base_days]
    );
    for (const claim of due) {
      // The check starts from the version, outside any run, so the pass it
      // asks for is opened at the version's label, which for a node with
      // one version is the node's own.
      await runAtLabel(claim.sensitivity_label, `claim ${claim.id}`, () =>
        enqueueSteward({
          claimId: claim.id,
          trigger: "staleness_check",
          context:
            `Cadence check: this claim's current assessment is ${claim.days_old} ` +
            `days old, past its reassessment interval. Re-examine whether the ` +
            `evidence landscape has moved; if nothing material changed, ` +
            `re-affirm cheaply and record a low marginal_yield.`,
        })
      );
      result.stalenessEnqueued++;
    }
  }

  return result;
}

export function startAllocationScheduler(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? STANDING_ORDER_RETRY_MINUTES * 60_000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await withSystemClearance(
        "The scheduler reconciles the ledger and looks for stale or pending work at every label; each piece it starts runs at its own row's label.",
        () => allocationSchedulerTick()
      );
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
