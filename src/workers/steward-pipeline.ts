/**
 * Steward executor — the drain over the ACTION LEDGER.
 *
 * The Steward is NOT an SQS/in-memory message queue, and the pending set is
 * not a queue in the FIFO sense either: a claim's `steward_state` column
 * marks it a CANDIDATE (`enqueueSteward` sets 'pending' and materializes
 * its assess/reassess action rows), and each executor pass runs whatever
 * the ledger says is covered (action-service.ts): most-backed sibling wins
 * its exclusion group, the winning variant picks the model tier, the
 * metered cost is consumed pro rata from the covering allocations. What to
 * value and what to fund is decided upstream, by each mandate's valuer and
 * allocator; this file deliberately contains NO selection judgment. When
 * nothing is covered it invites the General mandate's allocator once, then
 * rests. Everything unfunded simply waits as an embedded stub. One
 * mechanism in dev and prod.
 *
 * Why this shape:
 *  - The executor is a dumb loop over covered rows, so "why did this run"
 *    is always answerable from the ledger alone — no hidden ordering.
 *  - Spend is bounded by each mandate's daily rate + the LLM budget
 *    tracker (token/call limits), not by a per-process run counter that
 *    would permanently wedge a long-lived worker. Deployments with no
 *    General mandate seeded (dev, tests) fall back to direct budgeted
 *    runs under backgroundDailyBudgetOwls.
 *  - `FOR UPDATE SKIP LOCKED` + atomic action claiming make it safe for
 *    several prod tasks to drain concurrently; a 'running' claim stuck
 *    >15m (crashed worker) is reclaimable.
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
import { getGeneralMandate } from "../services/allocation-policy-service.js";
import { runGeneralAllocator } from "../services/allocation-service.js";
import {
  claimAction,
  completeAction,
  largestActionFunder,
  nextRunnableAction,
  releaseAction,
  type RunnableAction,
} from "../services/action-service.js";
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
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
  );
  return Number(row?.spent ?? 0);
}

/**
 * Take the next task the ACTION LEDGER says to run, and steward it.
 *
 * The rule is the allocation engine's, uniform for every funder: an
 * action runs exactly when the allocations on its exclusion group cover
 * its expected cost, and among covered siblings the most-backed variant
 * wins. The executor is deliberately a dumb loop over that table
 * (action-service.ts) — no selection logic of its own. When nothing is
 * covered, it invites the General mandate's allocator to place the day's
 * next allocations (marginal value per dollar, best first, within its
 * daily rate and escrow) and looks again. The run happens at the winning
 * variant's tier, its metered cost is consumed pro rata from the
 * covering allocations, and the run is attributed to the largest funder
 * (which is what stamps the funding disclosure).
 *
 * Deployments without a General mandate seeded (dev, tests) fall back to
 * direct budgeted execution under the config daily budget: best expected
 * value first, standard tier, no allocation bookkeeping.
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

  const mandate = await getGeneralMandate();

  // The ledger's verdict first — the engine's only execution rule.
  let action = await nextRunnableAction(["assess", "reassess"]);
  if (!action && mandate) {
    // Nothing covered: let the General mandate place today's next
    // allocations, then look again. Rate- or escrow-exhausted allocators
    // place nothing, and the lane rests until tomorrow or a top-up.
    const placed = await runGeneralAllocator();
    if (placed && placed.allocated > 0) {
      action = await nextRunnableAction(["assess", "reassess"]);
    }
    if (!action) {
      const pending = await pendingStewardCount();
      return { status: pending > 0 ? "budget" : "empty" };
    }
  }
  if (action) {
    return runCoveredAction(action, opts);
  }

  // Fallback mode (no General mandate seeded): direct budgeted runs on
  // the standard tier, best expected value first.
  const dailyBudgetOwls = config.backgroundDailyBudgetOwls ?? 0;
  if (dailyBudgetOwls > 0) {
    const spent = await unattributedSpentTodayMicroUsd();
    const budgetMicro = dailyBudgetOwls * (config.owlCostMicroUsd ?? 1_000_000);
    if (spent >= budgetMicro) return { status: "budget" };
  }
  const rows = await rawQuery<StewardTaskRow>(
    `UPDATE claims
        SET steward_state = 'running', stewarded_at = now()
      WHERE id = (
        SELECT id FROM claims
         WHERE state = 'active'
           AND (steward_state = 'pending'
                OR (steward_state = 'running'
                    AND stewarded_at < now() - interval '15 minutes'))
         ORDER BY queue_priority DESC, updated_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, steward_trigger, steward_context, steward_attempts,
                queue_priority`
  );
  if (rows.length === 0) return { status: "empty" };
  return runStewardOnClaim(rows[0]!, {
    model: opts.model ?? config.stewardModel,
  });
}

/**
 * Execute one covered action from the ledger: claim the action row and
 * its claim, run the Steward at the winning variant's tier, then close
 * the exclusion group (siblings superseded, losing pinned allocations
 * released, metered cost consumed pro rata).
 */
async function runCoveredAction(
  action: RunnableAction,
  opts: { model?: string }
): Promise<StewardProcessResult> {
  const config = loadConfig();
  if (!action.claim_id || !(await claimAction(action.id))) {
    // Raced by another worker (or a malformed row); the next pass decides.
    return { status: "empty" };
  }

  // Claim the claim row, guarding against a concurrent express-lane run.
  const rows = await rawQuery<StewardTaskRow>(
    `UPDATE claims
        SET steward_state = 'running', stewarded_at = now()
      WHERE id = $1 AND state = 'active'
        AND (steward_state = 'pending'
             OR (steward_state = 'running'
                 AND stewarded_at < now() - interval '15 minutes'))
      RETURNING id, steward_trigger, steward_context, steward_attempts,
                queue_priority`,
    [action.claim_id]
  );
  if (rows.length === 0) {
    const [claim] = await rawQuery<{ steward_state: string }>(
      `SELECT steward_state FROM claims WHERE id = $1 AND state = 'active'`,
      [action.claim_id]
    );
    if (
      claim &&
      (claim.steward_state === "pending" || claim.steward_state === "running")
    ) {
      // Mid-run on the express lane: the action simply waits its turn.
      await releaseAction(action.id);
    } else {
      // The claim left the candidate set (parked, archived, assessed
      // elsewhere): retire the whole group. Allocations stay on the
      // group — they still fund this claim's next pass if it revives.
      await rawQuery(
        `UPDATE actions SET status = 'cancelled', updated_at = now()
          WHERE exclusion_group = $1 AND status IN ('open', 'running')`,
        [action.exclusion_group]
      );
    }
    return { status: "empty" };
  }

  // The winning variant picks the tier; an explicit override (corpus
  // harness) wins.
  const model =
    opts.model ??
    (action.variant === "strong" && config.stewardStrongModel
      ? config.stewardStrongModel
      : config.stewardModel);

  // Attribution: the largest funder — a mandate's budget job (which also
  // stamps the funding disclosure) or a person.
  const usageCtx = await largestActionFunder(action.id).catch(() => ({}));
  return runStewardOnClaim(rows[0]!, { model, usageCtx, action });
}

/**
 * The shared execution core: run the Steward on one claimed claim row,
 * with the #97 failure classification (transient failures requeue without
 * counting an attempt; genuine errors park the claim after the cap).
 */
async function runStewardOnClaim(
  task: StewardTaskRow,
  input: {
    model: string;
    usageCtx?: { jobId?: string; userId?: string };
    action?: RunnableAction;
  }
): Promise<StewardProcessResult> {
  const trigger = task.steward_trigger ?? "structure_and_assess";
  const attempts = task.steward_attempts ?? 0;
  const action = input.action;

  try {
    const { billedMicroUsd } = await runWithUsageContext(
      input.usageCtx ?? {},
      () =>
        withCostMeter(() =>
          runClaimSteward({
            trigger,
            claimId: task.id,
            context: task.steward_context ?? "",
            model: input.model,
          })
        )
    );
    // Close the ledger group: winner done, siblings superseded, losing
    // pinned allocations released, metered cost consumed pro rata — each
    // funder pays their share, never another's.
    if (action) {
      await completeAction(action.id, billedMicroUsd, {
        meteredJobId: input.usageCtx?.jobId ?? null,
      }).catch((err) =>
        console.error(
          `[steward] completeAction failed for ${action.id} (allocation ` +
            `consumption missed; reconciliation needed): ${
              err instanceof Error ? err.message : err
            }`
        )
      );
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
    // Whatever the failure, the action returns to open: coverage is
    // unspent, and the next pass (or the recovery sweep) decides again.
    if (action) {
      await releaseAction(action.id).catch(() => {});
    }

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
      // A parked claim is out of the candidate set; retire its group so
      // the executor stops re-picking a covered-but-poisoned action.
      if (action) {
        await rawQuery(
          `UPDATE actions SET status = 'cancelled', updated_at = now()
            WHERE exclusion_group = $1 AND status IN ('open', 'running')`,
          [action.exclusion_group]
        ).catch(() => {});
      }
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
