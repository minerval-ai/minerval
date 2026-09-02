/**
 * Trace retention sweep (#334 L0): delete agent_runs older than
 * TRACE_RETENTION_DAYS, agent_steps cascading with them, so production can
 * keep tracing on by default without the tables growing without bound.
 * llm_usage is untouched — its rows keep run_id and cost indefinitely; only
 * the transcript behind a run expires.
 *
 * Deletes in bounded batches so a long-neglected table never becomes one
 * giant transaction, and stops after a bounded number of batches per tick
 * so a tick never runs away — the next tick picks up the rest. Idempotent
 * and safe from every task at once (a row deleted by another task is simply
 * not found).
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";

export interface TraceRetentionResult {
  /** Runs deleted this tick (steps cascade and are not counted). */
  deleted: number;
  /** False when retention is disabled (TRACE_RETENTION_DAYS=0). */
  swept: boolean;
}

const BATCH = 500;
const MAX_BATCHES_PER_TICK = 20;

export async function traceRetentionTick(
  now: Date = new Date()
): Promise<TraceRetentionResult> {
  const days = loadConfig().traceRetentionDays;
  if (!(days > 0)) return { deleted: 0, swept: false };
  const cutoff = new Date(now.getTime() - days * 86_400_000);

  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
    const rows = await rawQuery<{ id: string }>(
      `DELETE FROM agent_runs
        WHERE id IN (
          SELECT id FROM agent_runs WHERE started_at < $1
          ORDER BY started_at LIMIT $2
        )
        RETURNING id`,
      [cutoff, BATCH]
    );
    deleted += rows.length;
    if (rows.length < BATCH) break;
  }
  return { deleted, swept: true };
}

/** Run the sweep on an interval; see the queue-depth sampler for the pattern. */
export function startTraceRetention(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? 6 * 3_600_000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await traceRetentionTick();
      if (result.deleted > 0) {
        options.logger.info(`Trace retention: deleted ${result.deleted} expired agent runs`);
      }
    } catch (err) {
      options.logger.error("Trace retention tick failed:", err);
    } finally {
      busy = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), interval);
  return {
    stop: () => clearInterval(timer),
  };
}
