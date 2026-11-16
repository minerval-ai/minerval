/**
 * In-process queue runner.
 *
 * Drives the whole agent organization without external infrastructure. Two kinds
 * of work are interleaved here:
 *  - the in-memory queues (claim-pipeline, contribution, arbitration,
 *    url-extraction) — populated by enqueue* when no SQS queue is set; and
 *  - the DB-backed Steward queue (claims with steward_state='pending'), drained
 *    highest-importance-first by steward-pipeline.ts.
 *
 * The Steward queue is NOT in-memory: it lives in the `claims` table, so it is
 * the SAME mechanism in dev and prod (prod just also runs SQS pollers for the
 * ingestion queues). `drainLocalQueues()` runs everything to quiescence (used by
 * the corpus harness); `startLocalRunner()` polls continuously (dev server AND
 * prod, so the Steward actually runs everywhere — previously it was enqueued
 * in prod but never drained). Curator and Audit runs are ledger actions
 * (#363), run by the engine executor in this same loop.
 */
import { getLocalQueue } from "../services/queue-service.js";
import { handleClaimPipeline } from "./claim-pipeline.js";
import { handleUrlExtraction } from "./url-extraction.js";
import { handleContributionMessage } from "./contribution-pipeline.js";
import { handleArbitrationMessage } from "./arbitration-pipeline.js";
import { processNextStewardTask, pendingStewardCount } from "./steward-pipeline.js";
import { processNextOrderTask } from "./order-pipeline.js";
import { processNextBudgetJobTask } from "./budget-job-pipeline.js";
import { processNextEngineAction } from "./engine-executor.js";
import { processNextPrizeCheck } from "./prize-check-pipeline.js";
import { runPrizeWindowCloser } from "./prize-window-closer.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError } from "../llm/errors.js";
import { loadConfig } from "../config.js";
import { featureOn } from "../features.js";
import { withSystemClearance } from "../db/clearance.js";
import { isDeploymentFaultReason } from "../services/deployment-fault.js";

export type LocalQueueName =
  | "claimPipeline"
  | "contribution"
  | "arbitration"
  | "urlExtraction";

// Priority order for the in-memory queues. The Steward is handled separately
// (DB-backed, importance-ordered) and drained between in-memory passes.
const HANDLERS: Array<[LocalQueueName, (m: never) => Promise<void>]> = [
  ["claimPipeline", handleClaimPipeline as (m: never) => Promise<void>],
  ["contribution", handleContributionMessage as (m: never) => Promise<void>],
  ["arbitration", handleArbitrationMessage as (m: never) => Promise<void>],
  ["urlExtraction", handleUrlExtraction as (m: never) => Promise<void>],
];

/** One processed message — the unit of the observability trace. */
export interface RunnerEvent {
  seq: number;
  queue:
    | LocalQueueName
    | "steward"
    | "order"
    | "budgetJob"
    | "engine"
    | "prizeCheck"
    | "prizeWindow";
  message: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface DrainStats {
  processed: Record<string, number>;
  errors: Record<string, number>;
  capped: boolean;
  /**
   * Set when the drain stopped on a transient API/infra failure (429, 5xx,
   * overload, network): the work was requeued untouched, and the continuous
   * runner backs off and lowers its concurrency rather than retrying at once.
   */
  stoppedOnTransient?: boolean;
  /**
   * Set (only with surfaceBudgetErrors: false) when unattributed work met
   * the spent breaker: its message was requeued and the in-memory queues
   * were skipped for the rest of the drain.
   */
  unattributedBudgetSpent?: boolean;
}

export interface DrainOptions {
  /** Safety cap on total messages, to bound runaway propagation loops. */
  maxMessages?: number;
  /** Observer called after every processed message (for tracing). */
  onEvent?: (e: RunnerEvent) => void;
  /** Monotonic clock; injectable so callers control timestamps. Defaults to Date.now. */
  now?: () => number;
  /** Override the Steward model (defaults to config.stewardModel). */
  stewardModel?: string;
  /**
   * Cap on Steward tasks processed in this drain (cost backstop). Defaults to
   * STEWARD_MAX_RUNS (0 = unlimited). When the cap is reached, remaining pending
   * claims are left as embedded stubs — the intended under-budget steady state.
   */
  maxStewardTasks?: number;
  /**
   * Whether this drain also takes the in-memory queues and the prize lanes
   * (default true). The continuous runner gives these to one slot only: the
   * in-memory handlers were written for one consumer, and the prize lanes
   * check their concurrency cap before submitting. Its other slots run the
   * DB-claimed lanes, whose SKIP LOCKED and guarded transitions make
   * concurrent drains safe.
   */
  singletonLanes?: boolean;
  /**
   * Checked before each unit of work; returning false ends the drain after
   * the unit in flight. The continuous runner uses it to take a slot back
   * when it lowers its concurrency or pauses, so a lower limit applies to
   * running drains, not only to new ones.
   */
  shouldContinue?: () => boolean;
  /**
   * What the drain does when the process-wide LLM breaker (which covers
   * UNATTRIBUTED work only) is spent. True, the default: throw the
   * LlmBudgetExceededError, so a one-shot caller (the corpus harness) stops
   * and reports it. False, for the continuous runner: keep going with the
   * funded lanes, which the breaker exempts, skip the in-memory queues for
   * the rest of the drain, and report it in `unattributedBudgetSpent`.
   */
  surfaceBudgetErrors?: boolean;
}

/** The window closer's work is dated in days; once a minute per process is plenty. */
export const PRIZE_WINDOW_CLOSER_INTERVAL_MS = 60_000;
let lastWindowCloserAt = 0;

/** Test hook: let the next drain run the window closer at once. */
export function resetPrizeWindowCloserThrottle(): void {
  lastWindowCloserAt = 0;
}

function inMemoryPending(): boolean {
  return HANDLERS.some(([name]) => getLocalQueue(name).length > 0);
}

/** Remove and return the next FIFO message for an in-memory queue. */
function dequeue(name: LocalQueueName): unknown {
  return (getLocalQueue(name) as unknown[]).shift();
}

/**
 * Process every queued message — in-memory queues AND the DB-backed Steward
 * queue — until all are quiescent (or the safety cap is hit). Budget-exceeded
 * errors propagate so the caller can stop; other handler errors are counted and
 * skipped, mirroring the SQS poller.
 *
 * In-memory work is drained first each round; then one Steward task is processed
 * (it may request curation on the ledger and mint new pending subclaims), and the
 * loop repeats — so the two queues settle together.
 */
export async function drainLocalQueues(opts: DrainOptions = {}): Promise<DrainStats> {
  const cap = opts.maxMessages ?? 20_000;
  const now = opts.now ?? Date.now;
  const { stewardMaxRuns } = loadConfig();
  const stewardCap =
    opts.maxStewardTasks ?? (stewardMaxRuns > 0 ? stewardMaxRuns : Number.POSITIVE_INFINITY);
  const processed: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let stewardProcessed = 0;
  let seq = 0;
  let windowClosed = false;
  // The prize lanes run only where a checker is configured: without one no
  // statement publishes and no bounty binds (docs/mathematics.md §5.3).
  // And only while the prizes feature is on, which needs mathematics
  // (src/features.ts).
  const config = loadConfig();
  const singletonLanes = opts.singletonLanes ?? true;
  const surfaceBudget = opts.surfaceBudgetErrors ?? true;
  let unattributedBudgetSpent = false;
  const budgetFlag = () => (unattributedBudgetSpent ? { unattributedBudgetSpent: true } : {});
  const prizeLanesOn =
    singletonLanes &&
    featureOn("prizes", config) &&
    typeof config.leanCheckerUrl === "string" &&
    config.leanCheckerUrl.trim().length > 0;

  while (seq < cap) {
    if (opts.shouldContinue && !opts.shouldContinue()) {
      return { ...budgetFlag(), processed, errors, capped: true };
    }
    // 1. Drain a ready in-memory message if any.
    const entry =
      singletonLanes && !unattributedBudgetSpent
        ? HANDLERS.find(([name]) => getLocalQueue(name).length > 0)
        : undefined;
    if (entry) {
      const [name, handler] = entry;
      const message = dequeue(name) as never;
      const startedAt = now();
      seq++;
      try {
        await handler(message);
        processed[name] = (processed[name] ?? 0) + 1;
        opts.onEvent?.({ seq, queue: name, message, ok: true, durationMs: now() - startedAt });
      } catch (err) {
        if (err instanceof LlmBudgetExceededError) {
          // The message was dequeued before the handler ran; without this it
          // would be silently dropped (#218). Put it back at the front so the
          // next drain — after the budget pause — retries it first.
          (getLocalQueue(name) as unknown[]).unshift(message);
          if (surfaceBudget) throw err;
          // The breaker covers this unattributed work, not the funded lanes
          // below: leave the in-memory queues for the next window and go on.
          unattributedBudgetSpent = true;
          continue;
        }
        errors[name] = (errors[name] ?? 0) + 1;
        opts.onEvent?.({
          seq,
          queue: name,
          message,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: now() - startedAt,
        });
      }
      continue;
    }

    // 2. Express lane: paid assessment orders dispatch ahead of ALL
    //    background stewarding — a purchase doesn't queue. Order and
    //    budget-job runs are Steward runs, so they count toward the same
    //    per-drain cap as the batch drain.
    if (stewardProcessed >= stewardCap) {
      return { ...budgetFlag(), processed, errors, capped: (await pendingStewardCount()) > 0 };
    }
    {
      const startedAt = now();
      const o = await processNextOrderTask({ model: opts.stewardModel });
      if (o.status === "budget") {
        if (surfaceBudget) checkBudget();
        return { ...budgetFlag(), processed, errors, capped: false };
      }
      if (o.status === "transient") {
        return { ...budgetFlag(), processed, errors, capped: true, stoppedOnTransient: true };
      }
      if (o.status === "processed") {
        seq++;
        stewardProcessed++;
        if (o.ok) processed.order = (processed.order ?? 0) + 1;
        else errors.order = (errors.order ?? 0) + 1;
        opts.onEvent?.({
          seq,
          queue: "order",
          message: { orderId: o.orderId, claimId: o.claimId },
          ok: !!o.ok,
          error: o.error,
          durationMs: now() - startedAt,
        });
        continue;
      }
      // 'empty' or 'busy' — fall through to the funded and background lanes.
    }

    // 3. Funded budget jobs (deep decomposition): one target per pass, so
    //    orders and background work stay interleaved with long-running jobs.
    {
      const startedAt = now();
      const b = await processNextBudgetJobTask({ model: opts.stewardModel });
      if (b.status === "budget") {
        if (surfaceBudget) checkBudget();
        return { ...budgetFlag(), processed, errors, capped: false };
      }
      if (b.status === "transient") {
        return { ...budgetFlag(), processed, errors, capped: true, stoppedOnTransient: true };
      }
      if (b.status === "processed") {
        seq++;
        stewardProcessed++;
        if (b.ok) processed.budgetJob = (processed.budgetJob ?? 0) + 1;
        else errors.budgetJob = (errors.budgetJob ?? 0) + 1;
        opts.onEvent?.({
          seq,
          queue: "budgetJob",
          message: { jobId: b.jobId, claimId: b.claimId },
          ok: !!b.ok,
          error: b.error,
          durationMs: now() - startedAt,
        });
        continue;
      }
      if (b.status === "paused" || b.status === "completed") {
        // A settlement, not a model run — loop for the next unit of work.
        continue;
      }
      // 'empty' — fall through to the next lane.
    }

    // 4. The engine executor: covered planning / mandate-review / ingest /
    //    curate / audit actions from the ledger, one unit per pass.
    {
      const startedAt = now();
      const e = await processNextEngineAction({ model: opts.stewardModel });
      if (e.status === "budget") {
        if (surfaceBudget) checkBudget();
        return { ...budgetFlag(), processed, errors, capped: false };
      }
      if (e.status === "transient" && isDeploymentFaultReason(e.waitingOn)) {
        // A deployment fault (the provider's account out of credits, its
        // key rejected) stopped the row, and the row now waits with the
        // funded rows of its kind and tier (action-service.ts,
        // releaseAction). That is no reason to stop the drain or slow the
        // runner: the fault is not load, backing off does not clear it, and
        // the lanes behind this one may run on a provider that is healthy.
        // On 2026-11-12 stopping here on one lookout's refused call, every
        // few minutes for thirteen hours, kept every Steward pass from
        // starting (#971).
        seq++;
        errors.engine = (errors.engine ?? 0) + 1;
        opts.onEvent?.({
          seq,
          queue: "engine",
          message: { actionId: e.actionId, kind: e.kind, grantId: e.grantId, waitingOn: e.waitingOn },
          ok: false,
          error: e.error,
          durationMs: now() - startedAt,
        });
        continue;
      }
      if (e.status === "transient") {
        return { ...budgetFlag(), processed, errors, capped: true, stoppedOnTransient: true };
      }
      if (e.status === "processed") {
        seq++;
        stewardProcessed++;
        if (e.ok) processed.engine = (processed.engine ?? 0) + 1;
        else errors.engine = (errors.engine ?? 0) + 1;
        opts.onEvent?.({
          seq,
          queue: "engine",
          message: { actionId: e.actionId, kind: e.kind, grantId: e.grantId },
          ok: !!e.ok,
          error: e.error,
          durationMs: now() - startedAt,
        });
        continue;
      }
      // 'empty' — fall through to the next lane.
    }

    // 4b. The prize-check lane (docs/mathematics.md §8.4), two-step so a
    //     twenty-minute check never holds the drain: a tick submits one
    //     claim to the cold lane and returns, or polls the checks in flight
    //     once each and lands the first finished one, running the Reviewer
    //     and the Steward under the bounty's reserve. A landing counts
    //     toward the Steward cap because an accepted check runs one; a
    //     submission is bookkeeping and does not.
    if (prizeLanesOn) {
      const startedAt = now();
      let p: Awaited<ReturnType<typeof processNextPrizeCheck>>;
      try {
        p = await processNextPrizeCheck({ model: opts.stewardModel });
      } catch (err) {
        if (err instanceof LlmBudgetExceededError) throw err;
        // A lane failure is counted, never fatal to the drain.
        p = { status: "empty", error: err instanceof Error ? err.message : String(err) };
        errors.prizeCheck = (errors.prizeCheck ?? 0) + 1;
      }
      if (p.status === "processed" || p.status === "submitted") {
        seq++;
        if (p.status === "processed") stewardProcessed++;
        if (!p.error) processed.prizeCheck = (processed.prizeCheck ?? 0) + 1;
        else errors.prizeCheck = (errors.prizeCheck ?? 0) + 1;
        opts.onEvent?.({
          seq,
          queue: "prizeCheck",
          message: { prizeClaimId: p.prizeClaimId, checkId: p.checkId, verdict: p.verdict, outcome: p.outcome, status: p.status },
          ok: !p.error,
          error: p.error,
          durationMs: now() - startedAt,
        });
        continue;
      }
      // 'polling', 'empty', 'capped', or 'no_checker' — fall through.
    }

    // 4c. The window closer (§8.5): promotions, voids, forfeits, expiries,
    //     rebinds, and tranches, once per drain, dated work only.
    if (prizeLanesOn && !windowClosed && now() - lastWindowCloserAt >= PRIZE_WINDOW_CLOSER_INTERVAL_MS) {
      windowClosed = true;
      lastWindowCloserAt = now();
      const startedAt = now();
      try {
        const w = await runPrizeWindowCloser({ model: opts.stewardModel });
        const moved = w.promoted + w.voided + w.forfeited + w.expired + w.withdrawn + w.rebound + w.tranches;
        if (moved > 0) {
          seq++;
          processed.prizeWindow = (processed.prizeWindow ?? 0) + moved;
          opts.onEvent?.({ seq, queue: "prizeWindow", message: w, ok: true, durationMs: now() - startedAt });
          continue;
        }
      } catch (err) {
        errors.prizeWindow = (errors.prizeWindow ?? 0) + 1;
        opts.onEvent?.({
          seq: ++seq,
          queue: "prizeWindow",
          message: {},
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: now() - startedAt,
        });
      }
    }

    // 5. (A mandate's plan items used to run here, on a direct steward lane
    //    of their own. They are commissions on the ledger now, #849, and
    //    run with every other covered pass in step 6.)

    // 6. No in-memory, order, or funded work — one background Steward task
    //    (highest priority pending), leaving the rest as stubs when capped.
    const startedAt = now();
    const r = await processNextStewardTask({ model: opts.stewardModel });
    if (r.status === "empty") {
      // Both the in-memory queues and the Steward queue are drained.
      return { ...budgetFlag(), processed, errors, capped: false };
    }
    if (r.status === "budget") {
      // Surface the real budget error so the run stops and reports cleanly.
      if (surfaceBudget) checkBudget();
      return { ...budgetFlag(), processed, errors, capped: false };
    }
    if (r.status === "transient" && isDeploymentFaultReason(r.waitingOn)) {
      // As in the engine lane above: the pass's row waits on a deployment
      // fault and paces itself, so the drain goes on to what else is covered.
      seq++;
      errors.steward = (errors.steward ?? 0) + 1;
      opts.onEvent?.({
        seq,
        queue: "steward",
        message: { claimId: r.claimId, trigger: r.trigger, waitingOn: r.waitingOn },
        ok: false,
        error: r.error,
        durationMs: now() - startedAt,
      });
      continue;
    }
    if (r.status === "transient") {
      // A transient API/infra failure (billing/credit/429/5xx/network). The
      // claim was requeued untouched (#97). Stop this pass cleanly — the API is
      // struggling — leaving the queue for the next interval to retry.
      return {
        ...budgetFlag(),
        processed,
        errors,
        capped: (await pendingStewardCount()) > 0,
        stoppedOnTransient: true,
      };
    }
    seq++;
    stewardProcessed++;
    if (r.ok) {
      processed.steward = (processed.steward ?? 0) + 1;
    } else {
      errors.steward = (errors.steward ?? 0) + 1;
    }
    opts.onEvent?.({
      seq,
      queue: "steward",
      message: { claimId: r.claimId, trigger: r.trigger },
      ok: !!r.ok,
      error: r.error,
      durationMs: now() - startedAt,
    });
  }

  return { ...budgetFlag(), processed, errors, capped: inMemoryPending() };
}

/**
 * How many drains the continuous runner may run at once, and when it may
 * start the next one. A ceiling (STEWARD_CONCURRENCY), not a target:
 *
 *  - A deployment fault (a provider's account out of credits, its key
 *    rejected) is not the governor's business either: no pace clears it, the
 *    row it stopped waits on its own (action-service.ts, releaseAction), and
 *    the drain goes on to the other lanes, which may run on a provider that
 *    is healthy (#971).
 *  - Any other transient failure (429, 5xx, overload, network: the provider or the
 *    network is struggling, not the work) halves the live limit, never below
 *    one, and pauses every slot for a backoff that doubles with each
 *    consecutive transient stop, from 5 s to at most 5 minutes. The SDK has
 *    already retried the call by then, so retrying at once only adds load.
 *  - A drain that did work and ended cleanly resets the backoff and raises
 *    the limit by one, back toward the ceiling.
 *
 * The process-wide LLM breaker is not the governor's business: it covers
 * unattributed work only, so the runner rests that work and keeps the
 * funded lanes going (startLocalRunner).
 *
 * The runner slows down under pressure instead of stopping, so a burst of
 * rate limits costs throughput for a few minutes, never the drain.
 */
export class RunnerGovernor {
  static readonly BASE_BACKOFF_MS = 5_000;
  static readonly MAX_BACKOFF_MS = 300_000;

  readonly ceiling: number;
  private live: number;
  private consecutiveTransient = 0;
  private pausedUntil = 0;

  constructor(ceiling: number) {
    this.ceiling = Math.max(1, Math.floor(ceiling));
    this.live = this.ceiling;
  }

  /** The number of slots that may run now. */
  get limit(): number {
    return this.live;
  }

  /** Whether slot `index` (0-based) may start a drain at time `now`. */
  mayStart(index: number, now: number): boolean {
    return index < this.live && now >= this.pausedUntil;
  }

  /** A drain stopped on a transient failure. Returns the pause it set, in ms. */
  onTransient(now: number): number {
    this.consecutiveTransient++;
    this.live = Math.max(1, Math.floor(this.live / 2));
    const backoff = Math.min(
      RunnerGovernor.BASE_BACKOFF_MS * 2 ** (this.consecutiveTransient - 1),
      RunnerGovernor.MAX_BACKOFF_MS
    );
    this.pausedUntil = Math.max(this.pausedUntil, now + backoff);
    return backoff;
  }

  /** A drain did work and ended without a transient failure. */
  onClean(): void {
    this.consecutiveTransient = 0;
    if (this.live < this.ceiling) this.live++;
  }
}

/** How long unattributed work rests once the process-wide breaker is spent. */
export const UNATTRIBUTED_BUDGET_PAUSE_MS = 60_000;

/** An idle extra slot waits this long before looking again (slot 0 keeps the tick). */
export const IDLE_SLOT_RECHECK_MS = 5_000;

/**
 * Continuously drain the queues on an interval. Used in BOTH dev and prod (in
 * prod alongside the SQS ingestion pollers) so the Steward and Curator actually
 * run everywhere.
 *
 * Up to STEWARD_CONCURRENCY drains run at once, each its own loop over the
 * lanes, so that many Steward passes (orders first) can be in flight in one
 * process. Slot 0 alone takes the in-memory queues and the prize lanes;
 * the others run the DB-claimed lanes, and an extra slot that found nothing
 * waits a few seconds before looking again, so an idle process does not
 * poll the ledger N times a tick. RunnerGovernor paces them: transient
 * failures halve the live concurrency and back off, clean drains climb back.
 */
export function startLocalRunner(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  maxMessages?: number;
  stewardModel?: string;
  /** Override STEWARD_CONCURRENCY. */
  concurrency?: number;
}): { stop: () => void } {
  const interval = options.intervalMs ?? 500;
  const governor = new RunnerGovernor(
    options.concurrency ?? loadConfig().stewardConcurrency ?? 1
  );
  const busy: boolean[] = Array.from({ length: governor.ceiling }, () => false);
  const idleUntil: number[] = Array.from({ length: governor.ceiling }, () => 0);
  let running = true;
  // When unattributed in-memory work meets the spent breaker, slot 0 leaves
  // the in-memory queues (and the prize lanes beside them) alone for a
  // minute, as the single-slot runner paused for one. The funded lanes keep
  // running: the breaker does not cover them.
  let singletonPausedUntil = 0;

  const runSlot = async (index: number) => {
    busy[index] = true;
    try {
      const stats = await withSystemClearance(
        "The runner finds waiting work at every label (queued jobs, covered ledger rows, pending claims); each piece then runs at the label of its own row.",
        () =>
          drainLocalQueues({
            maxMessages: options.maxMessages,
            stewardModel: options.stewardModel,
            singletonLanes: index === 0 && Date.now() >= singletonPausedUntil,
            surfaceBudgetErrors: false,
            shouldContinue: () => running && governor.mayStart(index, Date.now()),
          })
      );
      const worked =
        Object.values(stats.processed).some((n) => n > 0) ||
        Object.values(stats.errors).some((n) => n > 0);
      if (stats.unattributedBudgetSpent) {
        singletonPausedUntil = Date.now() + UNATTRIBUTED_BUDGET_PAUSE_MS;
        options.logger.error(
          "LLM budget for unattributed work spent; in-memory queues paused 60s, funded lanes continue"
        );
      }
      if (stats.stoppedOnTransient) {
        const pause = governor.onTransient(Date.now());
        options.logger.error(
          `Transient API failure; runner concurrency now ${governor.limit}/${governor.ceiling}, ` +
            `all slots paused ${Math.round(pause / 1000)}s`
        );
      } else if (worked && governor.mayStart(index, Date.now())) {
        // A drain the governor cut short (it paused or lowered the limit
        // under this slot) is not a sign the pressure has passed.
        governor.onClean();
      } else if (index > 0) {
        idleUntil[index] = Date.now() + IDLE_SLOT_RECHECK_MS;
      }
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        // Only this slot rests: the other slots' funded work is exempt.
        idleUntil[index] = Date.now() + UNATTRIBUTED_BUDGET_PAUSE_MS;
        options.logger.error("Budget exceeded, pausing this runner slot for 60s:", err.message);
      } else {
        options.logger.error("Local runner error", err instanceof Error ? err.message : err);
      }
    } finally {
      busy[index] = false;
    }
  };

  const tick = () => {
    if (!running) return;
    const now = Date.now();
    for (let i = 0; i < governor.ceiling; i++) {
      if (busy[i] || now < idleUntil[i]! || !governor.mayStart(i, now)) continue;
      void runSlot(i);
    }
  };

  const timer = setInterval(tick, interval);
  options.logger.info(
    `In-process queue runner started (in-memory queues + DB Steward drain, ` +
      `up to ${governor.ceiling} at once)`
  );

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
    },
  };
}
