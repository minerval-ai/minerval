/**
 * In-process queue runner.
 *
 * Drives the whole agent organization without external infrastructure. Two kinds
 * of work are interleaved here:
 *  - the in-memory queues (claim-pipeline, curator, contribution, arbitration,
 *    audit, url-extraction) — populated by enqueue* when no SQS queue is set; and
 *  - the DB-backed Steward queue (claims with steward_state='pending'), drained
 *    highest-importance-first by steward-pipeline.ts.
 *
 * The Steward queue is NOT in-memory: it lives in the `claims` table, so it is
 * the SAME mechanism in dev and prod (prod just also runs SQS pollers for the
 * ingestion queues). `drainLocalQueues()` runs everything to quiescence (used by
 * the corpus harness); `startLocalRunner()` polls continuously (dev server AND
 * prod, so the Steward/Curator actually run everywhere — previously they were
 * enqueued in prod but never drained).
 */
import { getLocalQueue } from "../services/queue-service.js";
import { handleClaimPipeline } from "./claim-pipeline.js";
import { handleUrlExtraction } from "./url-extraction.js";
import { handleCuratorMessage } from "./curator-pipeline.js";
import { handleContributionMessage } from "./contribution-pipeline.js";
import { handleArbitrationMessage } from "./arbitration-pipeline.js";
import { handleAuditMessage } from "./audit-pipeline.js";
import { processNextStewardTask, pendingStewardCount } from "./steward-pipeline.js";
import { processNextOrderTask } from "./order-pipeline.js";
import { processNextBudgetJobTask } from "./budget-job-pipeline.js";
import { processNextGrantTask } from "./grant-pipeline.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError } from "../llm/errors.js";
import { loadConfig } from "../config.js";

export type LocalQueueName =
  | "claimPipeline"
  | "curator"
  | "contribution"
  | "arbitration"
  | "audit"
  | "urlExtraction";

// Priority order for the in-memory queues. The Steward is handled separately
// (DB-backed, importance-ordered) and drained between in-memory passes.
const HANDLERS: Array<[LocalQueueName, (m: never) => Promise<void>]> = [
  ["claimPipeline", handleClaimPipeline as (m: never) => Promise<void>],
  ["curator", handleCuratorMessage as (m: never) => Promise<void>],
  ["contribution", handleContributionMessage as (m: never) => Promise<void>],
  ["arbitration", handleArbitrationMessage as (m: never) => Promise<void>],
  ["audit", handleAuditMessage as (m: never) => Promise<void>],
  ["urlExtraction", handleUrlExtraction as (m: never) => Promise<void>],
];

/** One processed message — the unit of the observability trace. */
export interface RunnerEvent {
  seq: number;
  queue: LocalQueueName | "steward" | "order" | "budgetJob" | "grant";
  message: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface DrainStats {
  processed: Record<string, number>;
  errors: Record<string, number>;
  capped: boolean;
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
 * (it may enqueue Curator work in-memory and mint new pending subclaims), and the
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

  while (seq < cap) {
    // 1. Drain a ready in-memory message if any.
    const entry = HANDLERS.find(([name]) => getLocalQueue(name).length > 0);
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
          throw err;
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
      return { processed, errors, capped: (await pendingStewardCount()) > 0 };
    }
    {
      const startedAt = now();
      const o = await processNextOrderTask({ model: opts.stewardModel });
      if (o.status === "budget") {
        checkBudget();
        return { processed, errors, capped: false };
      }
      if (o.status === "transient") {
        return { processed, errors, capped: true };
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
        checkBudget();
        return { processed, errors, capped: false };
      }
      if (b.status === "transient") {
        return { processed, errors, capped: true };
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
      // 'empty' — fall through to the grant lane.
    }

    // 4. Grantmaker mandates: planning runs and funded steward passes, one
    //    unit per pass so they interleave with everything else.
    {
      const startedAt = now();
      const g = await processNextGrantTask({ model: opts.stewardModel });
      if (g.status === "budget") {
        checkBudget();
        return { processed, errors, capped: false };
      }
      if (g.status === "transient") {
        return { processed, errors, capped: true };
      }
      if (g.status === "processed" || g.status === "planned") {
        seq++;
        stewardProcessed++;
        if (g.ok) processed.grant = (processed.grant ?? 0) + 1;
        else errors.grant = (errors.grant ?? 0) + 1;
        opts.onEvent?.({
          seq,
          queue: "grant",
          message: { grantId: g.grantId, claimId: g.claimId },
          ok: !!g.ok,
          error: g.error,
          durationMs: now() - startedAt,
        });
        continue;
      }
      if (g.status === "paused" || g.status === "completed") {
        continue;
      }
      // 'empty' — fall through to the background drain.
    }

    // 5. No in-memory, order, or funded work — one background Steward task
    //    (highest priority pending), leaving the rest as stubs when capped.
    const startedAt = now();
    const r = await processNextStewardTask({ model: opts.stewardModel });
    if (r.status === "empty") {
      // Both the in-memory queues and the Steward queue are drained.
      return { processed, errors, capped: false };
    }
    if (r.status === "budget") {
      // Surface the real budget error so the run stops and reports cleanly.
      checkBudget();
      return { processed, errors, capped: false };
    }
    if (r.status === "transient") {
      // A transient API/infra failure (billing/credit/429/5xx/network). The
      // claim was requeued untouched (#97). Stop this pass cleanly — the API is
      // struggling — leaving the queue for the next interval to retry.
      return { processed, errors, capped: (await pendingStewardCount()) > 0 };
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

  return { processed, errors, capped: inMemoryPending() };
}

/**
 * Continuously drain the queues on an interval. Used in BOTH dev and prod (in
 * prod alongside the SQS ingestion pollers) so the Steward and Curator actually
 * run everywhere. Budget errors pause the loop briefly (like the SQS poller)
 * rather than killing it.
 */
export function startLocalRunner(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  maxMessages?: number;
  stewardModel?: string;
}): { stop: () => void } {
  const interval = options.intervalMs ?? 500;
  let running = true;
  let busy = false;

  const tick = async () => {
    if (!running || busy) return;
    busy = true;
    try {
      await drainLocalQueues({
        maxMessages: options.maxMessages,
        stewardModel: options.stewardModel,
      });
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        options.logger.error("Budget exceeded, pausing local runner for 60s:", err.message);
        await new Promise((r) => setTimeout(r, 60_000));
      } else {
        options.logger.error("Local runner error", err instanceof Error ? err.message : err);
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  options.logger.info("In-process queue runner started (in-memory queues + DB Steward drain)");

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
    },
  };
}
