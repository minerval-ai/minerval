/**
 * Steward work lane — DB-backed, drained by expected value over expected
 * cost, up to a daily budget.
 *
 * The Steward is NOT an SQS/in-memory message queue, and the pending set is
 * not a queue in the FIFO sense either: a claim's `steward_state` column
 * marks it a CANDIDATE (`enqueueSteward` sets 'pending'), and each drain
 * pass picks the candidate whose expected marginal value
 * (claims.queue_priority — priority-service.ts) per unit of expected
 * marginal cost (cost-estimate-service.ts, tier-dependent) is highest, runs
 * its Steward, and marks it 'done' (or 'error'). The lane spends until the
 * day's background budget (backgroundDailyBudgetOwls) is gone; everything
 * else simply waits as an embedded stub. One mechanism in dev and prod.
 *
 * Why this shape:
 *  - Value/cost ordering is native SQL, so under a budget the spend lands
 *    where the marginal-value estimate per owl is highest and the rest stay
 *    embedded stubs — the expected steady state, since each assessed claim
 *    tends to mint >1 novel subclaim until claimspace densifies, so the
 *    candidate set is perpetually non-empty.
 *  - Spend is bounded by the daily budget + the LLM budget tracker
 *    (token/call limits), not by a per-process run counter that would
 *    permanently wedge a long-lived worker.
 *  - `FOR UPDATE SKIP LOCKED` makes it safe for several prod tasks to drain
 *    concurrently; a 'running' row stuck >15m (crashed worker) is reclaimable.
 *
 * Failure handling (#97): a failed Steward run is classified, not blindly parked.
 * Budget-tracker and transient API/infra failures (billing/credit outage, 429,
 * 5xx, network) return the claim to 'pending' untouched — they are not the
 * claim's fault. Only genuine logic errors count against `steward_attempts`, and
 * a claim parks as 'error' only after MAX_STEWARD_ATTEMPTS of them. A run of
 * consecutive transient failures trips a circuit breaker that stops the drain,
 * so a credit outage can never again silently strand half the graph as 'error'.
 */
import { rawQuery } from "../db/client.js";
import { runClaimSteward } from "../llm/agents/claim-steward.js";
import { loadConfig } from "../config.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import { stewardTierCostEstimates } from "../services/cost-estimate-service.js";
import {
  getEffectiveAllocationPolicy,
  getGeneralMandate,
} from "../services/allocation-policy-service.js";
import {
  consumeAllocations,
  largestAllocator,
  runGeneralAllocator,
} from "../services/allocation-service.js";
import { runWithUsageContext, withCostMeter } from "../llm/usage-context.js";

interface StewardTaskRow {
  id: string;
  steward_trigger: string | null;
  steward_context: string | null;
  steward_attempts: number | null;
  queue_priority: number;
}

// After this many *genuine* (non-transient) failures a claim parks as 'error'
// so the drain stops spinning on a truly poison claim. Transient failures
// (API budget/credit/429/5xx/network) never count toward this — they requeue.
const MAX_STEWARD_ATTEMPTS = 3;

// If this many claims in a row fail transiently, the API itself is down (e.g. a
// credit outage): stop the drain instead of hammering it and re-parking work.
const TRANSIENT_CIRCUIT_BREAK = 5;

export type StewardDrainStatus =
  | "processed"
  | "empty"
  | "budget"
  // A transient API failure (billing/credit/429/5xx/network). The claim was
  // returned to the queue untouched — it is not the claim's fault (#97).
  | "transient";

export interface StewardProcessResult {
  status: StewardDrainStatus;
  claimId?: string;
  trigger?: string;
  ok?: boolean;
  error?: string;
}

/**
 * Legacy fallback budget accounting for deployments with no General
 * mandate seeded: system work with no paying user and no funded job.
 */
async function unattributedSpentTodayMicroUsd(): Promise<number> {
  const [row] = await rawQuery<{ spent: number }>(
    `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
       FROM llm_usage
      WHERE user_id IS NULL AND job_id IS NULL
        AND created_at >= date_trunc('day', now())`
  );
  return Number(row?.spent ?? 0);
}

// A covered candidate: a pending claim whose unspent allocations cover the
// expected cost of its pass at its tier. Parameters: $1 strong tier cost
// (0 = tiering off), $2 strong-min value, $3 standard tier cost.
const CLAIM_COVERED_SQL = `
  UPDATE claims
      SET steward_state = 'running', stewarded_at = now()
    WHERE id = (
      SELECT id FROM claims
       WHERE state = 'active'
         AND (steward_state = 'pending'
              OR (steward_state = 'running'
                  AND stewarded_at < now() - interval '15 minutes'))
         AND COALESCE((SELECT SUM(a.amount_micro_usd - a.spent_micro_usd)
                         FROM action_allocations a
                        WHERE a.claim_id = claims.id AND a.action = 'assess'), 0)
             >= (CASE WHEN $1::real > 0 AND queue_priority >= $2::real
                      THEN $1::real ELSE $3::real END)
       ORDER BY queue_priority DESC, updated_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    RETURNING id, steward_trigger, steward_context, steward_attempts,
              queue_priority`;

/**
 * Atomically claim the single best candidate and steward it.
 *
 * The rule is the allocation engine's, uniform for every funder: an
 * action runs exactly when the allocations on it cover its expected
 * cost. The drain therefore only ever executes COVERED candidates; when
 * none is covered, it invites the General mandate's allocator to place
 * the day's next allocations (value per dollar, best first, within its
 * daily rate and escrow) and tries again. The run's metered cost is then
 * split across the action's allocations pro rata, so co-funders each pay
 * their share, and the run is attributed to the largest allocator (which
 * is what stamps the funding disclosure).
 *
 * Deployments without a General mandate seeded (dev, tests) fall back to
 * direct budgeted execution under the config daily budget: same
 * value-per-cost ordering, no allocation bookkeeping.
 *
 * Returns 'empty' when nothing is pending and 'budget' when a budget or
 * the LLM tracker is spent (claims stay pending — not their fault).
 */
export async function processNextStewardTask(
  opts: { model?: string } = {}
): Promise<StewardProcessResult> {
  const config = loadConfig();

  // Don't even claim a task if we're already over budget this window.
  try {
    checkBudget();
  } catch {
    return { status: "budget" };
  }

  const policy = await getEffectiveAllocationPolicy();
  const strongMin = policy.strong_min_value;
  const tierCosts = await stewardTierCostEstimates();
  const strongConfigured = !!config.stewardStrongModel && !opts.model;
  const tierParams = [
    strongConfigured ? tierCosts.strongMicroUsd : 0,
    strongMin,
    tierCosts.standardMicroUsd,
  ];

  const mandate = await getGeneralMandate();

  // Covered candidates first — the engine's only execution rule.
  let rows = await rawQuery<StewardTaskRow>(CLAIM_COVERED_SQL, tierParams);
  let covered = rows.length > 0;

  if (!covered && mandate) {
    // Nothing covered: let the General mandate place today's next
    // allocations, then look again. Rate- or escrow-exhausted allocators
    // place nothing, and the lane rests until tomorrow or a top-up.
    const placed = await runGeneralAllocator();
    if (placed && placed.allocated > 0) {
      rows = await rawQuery<StewardTaskRow>(CLAIM_COVERED_SQL, tierParams);
      covered = rows.length > 0;
    }
    if (!covered) {
      const pending = await pendingStewardCount();
      return { status: pending > 0 ? "budget" : "empty" };
    }
  }

  if (!covered && !mandate) {
    // Fallback mode (no General mandate seeded): direct budgeted runs.
    const dailyBudgetOwls = config.backgroundDailyBudgetOwls ?? 0;
    if (dailyBudgetOwls > 0) {
      const spent = await unattributedSpentTodayMicroUsd();
      const budgetMicro =
        dailyBudgetOwls * (config.owlCostMicroUsd ?? 1_000_000);
      if (spent >= budgetMicro) return { status: "budget" };
    }
    rows = await rawQuery<StewardTaskRow>(
      `UPDATE claims
          SET steward_state = 'running', stewarded_at = now()
        WHERE id = (
          SELECT id FROM claims
           WHERE state = 'active'
             AND (steward_state = 'pending'
                  OR (steward_state = 'running'
                      AND stewarded_at < now() - interval '15 minutes'))
           ORDER BY queue_priority / CASE
                      WHEN $1::real > 0 AND queue_priority >= $2::real
                      THEN $1::real ELSE $3::real END DESC,
                    updated_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, steward_trigger, steward_context, steward_attempts,
                  queue_priority`,
      tierParams
    );
  }
  if (rows.length === 0) return { status: "empty" };

  const task = rows[0]!;
  const trigger = task.steward_trigger ?? "structure_and_assess";
  const attempts = task.steward_attempts ?? 0;

  // Model tiering by the policy's threshold; the caller's explicit
  // override (corpus harness) wins.
  const model =
    opts.model ??
    (config.stewardStrongModel && task.queue_priority >= strongMin
      ? config.stewardStrongModel
      : config.stewardModel);

  // Attribution: the largest allocator — a mandate's budget job (which
  // also stamps the funding disclosure) or a person. Fallback mode runs
  // unattributed, as before.
  const usageCtx = covered ? await largestAllocator(task.id) : {};

  try {
    const { billedMicroUsd } = await runWithUsageContext(usageCtx, () =>
      withCostMeter(() =>
        runClaimSteward({
          trigger,
          claimId: task.id,
          context: task.steward_context ?? "",
          model,
        })
      )
    );
    // Split the metered cost across the action's allocations pro rata:
    // each funder pays their share, never another's.
    if (covered) {
      await consumeAllocations(task.id, billedMicroUsd).catch(() => {});
    }
    // Success clears the error state AND the attempt counter, so a claim that
    // failed transiently before is treated fresh next time. The state write is
    // guarded on the row still being 'running': if a new message re-pended the
    // claim mid-run, completing THIS run must not clobber that pending slot
    // (#182) — the message would be silently lost.
    await rawQuery(
      `UPDATE claims
          SET steward_state = CASE
                WHEN steward_state = 'running' THEN 'done'
                ELSE steward_state
              END,
              steward_error = NULL, steward_attempts = 0
        WHERE id = $1`,
      [task.id]
    );
    return { status: "processed", claimId: task.id, trigger, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Budget tracker (internal circuit breaker) or a transient API/infra failure
    // (billing/credit outage, 429, 5xx, network) — NOT the claim's fault. Return
    // it to the queue for the next window without counting an attempt (#97). We
    // stamp updated_at so the requeued claim sorts behind its importance peers
    // rather than being re-picked immediately.
    if (err instanceof LlmBudgetExceededError) {
      await rawQuery(
        `UPDATE claims SET steward_state = 'pending', updated_at = now() WHERE id = $1`,
        [task.id]
      );
      return { status: "budget", claimId: task.id };
    }
    if (isTransientApiError(err)) {
      await rawQuery(
        `UPDATE claims SET steward_state = 'pending', updated_at = now() WHERE id = $1`,
        [task.id]
      );
      console.warn(
        `[steward] transient failure on claim ${task.id}; requeued (not counted): ${msg}`
      );
      return { status: "transient", claimId: task.id, trigger, ok: false, error: msg };
    }

    // Genuine logic error. Count the attempt; requeue for a retry until the cap,
    // then park as 'error' so the drain stops spinning on a poison claim.
    const nextAttempts = attempts + 1;
    if (nextAttempts >= MAX_STEWARD_ATTEMPTS) {
      // Same mid-run guard as the success path: a message that re-pended the
      // claim during this run survives the park. The attempt counter is still
      // recorded, so a genuinely poisoned claim converges to 'error' anyway
      // after its retriggered runs also fail.
      await rawQuery(
        `UPDATE claims
            SET steward_state = CASE
                  WHEN steward_state = 'running' THEN 'error'
                  ELSE steward_state
                END,
                steward_error = $2, steward_attempts = $3
          WHERE id = $1`,
        [task.id, msg, nextAttempts]
      );
      console.error(
        `[steward] claim ${task.id} parked as error after ${nextAttempts} attempts: ${msg}`
      );
    } else {
      await rawQuery(
        `UPDATE claims
            SET steward_state = 'pending', steward_error = $2,
                steward_attempts = $3, updated_at = now()
          WHERE id = $1`,
        [task.id, msg, nextAttempts]
      );
      console.warn(
        `[steward] claim ${task.id} failed (attempt ${nextAttempts}/${MAX_STEWARD_ATTEMPTS}); requeued: ${msg}`
      );
    }
    return { status: "processed", claimId: task.id, trigger, ok: false, error: msg };
  }
}

/**
 * Drain the queue until empty, budget-exhausted, or `maxTasks` processed.
 * `maxTasks` defaults to STEWARD_MAX_RUNS (0 = unlimited); the real governor in
 * production is the token budget, with maxTasks mainly a test/dev cost knob.
 */
export async function drainStewardQueue(
  opts: {
    maxTasks?: number;
    model?: string;
    onResult?: (r: StewardProcessResult) => void;
  } = {}
): Promise<{ processed: number; budgetHit: boolean }> {
  const { stewardMaxRuns } = loadConfig();
  const cap =
    opts.maxTasks ?? (stewardMaxRuns > 0 ? stewardMaxRuns : Number.POSITIVE_INFINITY);

  let processed = 0;
  let consecutiveTransient = 0;
  while (processed < cap) {
    const r = await processNextStewardTask({ model: opts.model });
    opts.onResult?.(r);
    if (r.status === "empty") return { processed, budgetHit: false };
    if (r.status === "budget") return { processed, budgetHit: true };
    if (r.status === "transient") {
      // The API itself is failing (e.g. a credit outage). After a short run of
      // consecutive transient failures, stop the drain rather than churn through
      // every pending claim re-parking it — the next window will pick them up.
      if (++consecutiveTransient >= TRANSIENT_CIRCUIT_BREAK) {
        console.error(
          `[steward] ${consecutiveTransient} consecutive transient failures — ` +
            `API appears unavailable; stopping drain (claims remain pending).`
        );
        return { processed, budgetHit: true };
      }
      continue; // don't count a transient failure toward the maxTasks cap
    }
    consecutiveTransient = 0;
    processed++;
  }
  return { processed, budgetHit: false };
}

/** How many claims are waiting to be stewarded (the live queue depth). */
export async function pendingStewardCount(): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM claims
      WHERE state = 'active' AND steward_state = 'pending'`
  );
  return row?.n ?? 0;
}

export interface StewardQueueHealth {
  pending: number;
  running: number;
  done: number;
  error: number;
  /** Low-importance subclaims held out of the drain (#98 brake), not a failure. */
  deferred: number;
}

/**
 * Snapshot of the Steward queue by state — operational visibility so a silent
 * pile-up of `error` claims (the #97 failure mode: 81/142 parked with nothing
 * surfacing it) is observable. Call it from a worker/health endpoint.
 */
export async function stewardQueueHealth(): Promise<StewardQueueHealth> {
  const rows = await rawQuery<{ steward_state: string; n: number }>(
    `SELECT steward_state, count(*)::int AS n FROM claims
      WHERE state = 'active' GROUP BY steward_state`
  );
  const health: StewardQueueHealth = {
    pending: 0,
    running: 0,
    done: 0,
    error: 0,
    deferred: 0,
  };
  for (const row of rows) {
    if (row.steward_state in health) {
      health[row.steward_state as keyof StewardQueueHealth] = row.n;
    }
  }
  return health;
}
