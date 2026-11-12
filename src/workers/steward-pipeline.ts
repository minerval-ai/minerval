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
 *    several prod tasks to drain concurrently (a rolling deploy runs two).
 *    That holds only because 'pending' means no run is live: a message for
 *    a running claim sets `steward_requeued` rather than re-pending it
 *    (#482). A live run heartbeats its lease, so only a 'running' claim
 *    whose lease is >15m old (crashed worker) is reclaimable.
 *
 * Failure handling (#97): a failed Steward run is classified, not blindly parked.
 * Budget-tracker and transient API/infra failures (billing/credit outage,
 * rejected credentials, 429, 5xx, network) return the claim to 'pending' untouched — they are not the
 * claim's fault. Only genuine logic errors count against `steward_attempts`, and
 * a claim parks as 'error' only after MAX_STEWARD_ATTEMPTS of them. A run of
 * consecutive transient failures trips a circuit breaker that stops the drain,
 * so a credit outage can never again silently strand half the graph as 'error'.
 *
 * A covered pass a platform fault stops leaves its ledger row waiting, with
 * the fault's class on it, and the funded rows of its kind and tier wait
 * with it (#971; action-service.ts releaseAction, deployment-fault.ts). When
 * the fault is the deployment's (a provider account out of credits, a
 * rejected key) the drain goes on to whatever else is covered, since the
 * other tier or the other lanes may run on a provider that is healthy.
 */
import { rawQuery } from "../db/client.js";
import { runClaimSteward } from "../llm/agents/claim-steward.js";
import { loadConfig } from "../config.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import { getGeneralMandate } from "../services/allocation-policy-service.js";
import {
  actionBudgetMicroUsd,
  actionWaitingOn,
  claimAction,
  completeAction,
  largestActionFunder,
  nextRunnableAction,
  releaseAction,
  type RunnableAction,
} from "../services/action-service.js";
import { runAtLabel, runWithUsageContext, withPassBudget, type RunFunding } from "../llm/usage-context.js";
import { commissionFollowUps } from "../services/petition-service.js";

/** The budget a lane sets on a Steward pass, or none. */
type PassBudgetInput = { microUsd: number; source: string; funding?: RunFunding } | null;
import { classifyStewardFailure } from "../services/steward-park-reason.js";
import { isDeploymentFaultReason, type PlatformFaultReason } from "../services/deployment-fault.js";
import { noteDeploymentFault } from "../services/deployment-fault-service.js";
import {
  MAX_STEWARD_ATTEMPTS,
  STEWARD_LEASE_STALE_MINUTES,
  STEWARD_SUCCESS_CLEAR_SET,
  parksAtOnce,
  reportStewardPark,
  stewardReleaseSet,
  withStewardLease,
} from "../services/steward-lease.js";

interface StewardTaskRow {
  id: string;
  steward_trigger: string | null;
  steward_attempts: number | null;
  queue_priority: number;
}

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
  /**
   * With 'transient': the class of the platform fault the pass's ledger row
   * now waits on (action-service.ts, releaseAction). The row paces itself,
   * so the drain may go on to other work; absent, the drain stops.
   */
  waitingOn?: PlatformFaultReason;
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

  // The process-wide breaker covers unattributed work only, so it is not
  // consulted before a covered action: that run carries its funder, and the
  // breaker exempts it. (Checked here, outside any usage context, it read
  // the unattributed counters and stalled funded work along with them.)
  const mandate = await getGeneralMandate();

  // The ledger's verdict first — the engine's only execution rule. What
  // runs is what some payer commissioned; with a mandate in place, nothing
  // commissioned means the lane rests until someone commissions work.
  const action = await nextRunnableAction(["assess", "reassess"]);
  if (!action && mandate) {
    const pending = await pendingStewardCount();
    return { status: pending > 0 ? "budget" : "empty" };
  }
  if (action) {
    // The pass runs at the label of the ledger row that pays for it, which
    // is the label of the work that opened the row (src/labels.ts). The
    // bookkeeping after the run is inside too, so a follow-up it commissions
    // carries the same label.
    const result = await runAtLabel(action.sensitivity_label, `ledger action ${action.id}`, () =>
      runCoveredAction(action, opts)
    );
    if (result.status === "transient") {
      // Unreadable is read as "not waiting": the drain then stops, as before.
      let waitingOn: PlatformFaultReason | null = null;
      try {
        waitingOn = await actionWaitingOn(action.id);
      } catch {
        waitingOn = null;
      }
      if (waitingOn) return { ...result, waitingOn };
    }
    return result;
  }

  // Fallback mode (no ACTIVE General mandate): direct budgeted runs on the
  // standard tier, best expected value first, attributed to nobody and
  // bounded only by the config owl budget.
  //
  // Opt-in, because "no active General mandate" is not only the fresh-dev
  // case it was written for: a mandate that has been completed or cancelled
  // reaches the same state, and its own review pass can decide that. Off by
  // default, a deployment that loses its mandate rests until someone tops it
  // up or re-seeds, rather than quietly moving its spending off the ledger.
  if (!config.backgroundFallbackLaneEnabled) {
    const pending = await pendingStewardCount();
    return { status: pending > 0 ? "budget" : "empty" };
  }
  // This lane picks a claim, not a piece of work: no row here says what
  // label the pending pass was asked for at, so its run opens with none and
  // writes as public. A deployment with more than one label must not turn
  // the lane on until the claim's pending slot carries a label.
  // The fallback lane IS unattributed work, so the breaker applies: don't
  // even claim a task if it is already spent this window.
  try {
    checkBudget();
  } catch {
    return { status: "budget" };
  }
  const dailyBudgetOwls = config.backgroundDailyBudgetOwls ?? 0;
  // The pass may spend what is left of the day's background budget.
  let passBudget: PassBudgetInput = null;
  if (dailyBudgetOwls > 0) {
    const spent = await unattributedSpentTodayMicroUsd();
    const budgetMicro = dailyBudgetOwls * (config.owlCostMicroUsd ?? 1_000_000);
    if (spent >= budgetMicro) return { status: "budget" };
    passBudget = { microUsd: budgetMicro - spent, source: "what is left of today's background budget" };
  }
  const rows = await rawQuery<StewardTaskRow>(
    `UPDATE claims
        SET steward_state = 'running', stewarded_at = now(),
            steward_requeued = false
      WHERE id = (
        SELECT id FROM claims
         WHERE state = 'active'
           AND (steward_state = 'pending'
                OR (steward_state = 'running'
                    AND stewarded_at < now()
                          - make_interval(mins => ${STEWARD_LEASE_STALE_MINUTES})))
         ORDER BY queue_priority DESC, updated_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, steward_trigger, steward_attempts,
                queue_priority`
  );
  if (rows.length === 0) return { status: "empty" };
  return runStewardOnClaim(rows[0]!, {
    model: opts.model ?? config.stewardModel,
    passBudget,
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
  if (!action.claim_id || !(await claimAction(action.id, action.sensitivity_label))) {
    // Raced by another worker (or a malformed row); the next pass decides.
    return { status: "empty" };
  }

  // Claim the claim row, guarding against a concurrent express-lane run.
  const rows = await rawQuery<StewardTaskRow>(
    `UPDATE claims
        SET steward_state = 'running', stewarded_at = now(),
            steward_requeued = false
      WHERE id = $1 AND state = 'active'
        AND (steward_state = 'pending'
             OR (steward_state = 'running'
                 AND stewarded_at < now()
                       - make_interval(mins => ${STEWARD_LEASE_STALE_MINUTES})))
      RETURNING id, steward_trigger, steward_attempts,
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
  // The pass spends what the allocations covering its action hold.
  const passBudget = {
    microUsd: actionBudgetMicroUsd(action),
    source: action.commissioned ? "a commission" : "the allocations funding this pass",
    funding: { actionId: action.id },
  };
  return runStewardOnClaim(rows[0]!, { model, usageCtx, action, passBudget });
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
    passBudget?: PassBudgetInput;
  }
): Promise<StewardProcessResult> {
  const trigger = task.steward_trigger ?? "structure_and_assess";
  const attempts = task.steward_attempts ?? 0;
  const action = input.action;

  try {
    const { billedMicroUsd } = await withStewardLease(
      { claimId: task.id, ...(action ? { actionId: action.id } : {}) },
      () =>
        runWithUsageContext(input.usageCtx ?? {}, () =>
          withPassBudget(input.passBudget ?? null, () =>
            runClaimSteward({
              trigger,
              claimId: task.id,
              // The messages are the node's inbox, which the run reads itself.
              context: "",
              model: input.model,
            })
          )
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
    // A follow-up granted to this run's petitions is commissioned now that
    // the run has ended (petition-service.ts). Best-effort: the scheduler's
    // sweep picks up any this misses.
    if (action) {
      await commissionFollowUps(action.id).catch((err) =>
        console.warn(`[steward] follow-ups for ${action.id} failed: ${err instanceof Error ? err.message : err}`)
      );
    }
    // Success clears the error state AND the attempt counter, so a claim that
    // failed transiently before is treated fresh next time. A message that
    // arrived mid-run (#182) turns the release into 'pending' rather than
    // 'done' (#482) — the message would otherwise be silently lost.
    await rawQuery(
      `UPDATE claims
          SET ${stewardReleaseSet("'done'")},
              ${STEWARD_SUCCESS_CLEAR_SET}
        WHERE id = $1`,
      [task.id]
    );
    return { status: "processed", claimId: task.id, trigger, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Whatever the failure, the action returns to open: coverage is
    // unspent, and the next pass (or the recovery sweep) decides again.
    if (action) {
      await releaseAction(action.id, err).catch(() => {});
    }

    // Budget tracker (internal circuit breaker) or a transient API/infra failure
    // (billing/credit outage, 429, 5xx, network) — NOT the claim's fault. Return
    // it to the queue for the next window without counting an attempt (#97). We
    // stamp updated_at so the requeued claim sorts behind its importance peers
    // rather than being re-picked immediately.
    if (err instanceof LlmBudgetExceededError) {
      await rawQuery(
        `UPDATE claims
            SET steward_state = 'pending', steward_requeued = false,
                updated_at = now()
          WHERE id = $1`,
        [task.id]
      );
      return { status: "budget", claimId: task.id };
    }
    if (isTransientApiError(err)) {
      await rawQuery(
        `UPDATE claims
            SET steward_state = 'pending', steward_requeued = false,
                updated_at = now()
          WHERE id = $1`,
        [task.id]
      );
      console.warn(
        `[steward] transient failure on claim ${task.id}; requeued (not counted): ${msg}`
      );
      // A pass with no ledger row (the fallback lane) has no row to record
      // the fault from; a no-op for any failure that is not a deployment fault.
      if (!action) await noteDeploymentFault(err, { surface: "the Steward's fallback lane" });
      return { status: "transient", claimId: task.id, trigger, ok: false, error: msg };
    }

    // Genuine logic error. Count the attempt; requeue for a retry until the cap,
    // then park as 'error' so the drain stops spinning on a poison claim. A
    // model refusal parks on the first (parksAtOnce says why). The public
    // class of the error is stored beside its raw text (#846).
    const nextAttempts = attempts + 1;
    const reason = classifyStewardFailure(err);
    if (nextAttempts >= MAX_STEWARD_ATTEMPTS || parksAtOnce(err)) {
      // Same mid-run rule as the success path: a message that arrived during
      // this run survives the park. The attempt counter is still recorded, so
      // a genuinely poisoned claim converges to 'error' anyway after its
      // retriggered runs also fail.
      await rawQuery(
        `UPDATE claims
            SET ${stewardReleaseSet("'error'")},
                steward_error = $2, steward_attempts = $3,
                steward_error_reason = $4
          WHERE id = $1`,
        [task.id, msg, nextAttempts, reason]
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
        `[steward] claim ${task.id} parked as error (${reason}) after ${nextAttempts} attempt(s): ${msg}`
      );
      // A park retires funded rows unrun, so it is surfaced to maintainers
      // rather than left for whoever next reads queue health (#834).
      await reportStewardPark(task.id, "steward-pipeline");
    } else {
      await rawQuery(
        `UPDATE claims
            SET steward_state = 'pending', steward_requeued = false,
                steward_error = $2, steward_attempts = $3,
                steward_error_reason = $4, updated_at = now()
          WHERE id = $1`,
        [task.id, msg, nextAttempts, reason]
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
    if (r.status === "transient" && isDeploymentFaultReason(r.waitingOn)) {
      // The row waits on a deployment fault and paces itself, with the
      // funded rows of its kind and tier: go on to whatever else is covered.
      continue;
    }
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
