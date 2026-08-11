/**
 * Trace retention (#334 L0) — the job that lets tracing run in production.
 *
 * `agent_runs` + `agent_steps` record the full tool-use transcript of every
 * agent invocation, which is exactly why TRACE_LEVEL has defaulted OFF in
 * production since #343: steps are large, nothing pruned them, and an
 * always-on firehose with no drain is a disk-full incident waiting to happen.
 * This is that drain. With it in place the production default can flip on, and
 * S9's monitors and the per-run cost joins get real data to read.
 *
 * TWO TIERS, because the two tables are not the same kind of thing:
 *
 *   agent_steps  — the bulk. Message content, tool calls, tool results; capped
 *                  at 200k chars each but still the overwhelming majority of
 *                  the bytes. Useful for debugging a recent run, rarely for
 *                  anything older. Pruned aggressively.
 *   agent_runs   — one small row per invocation: agent, outcome, timings, step
 *                  count, and the attribution that `llm_usage.run_id` joins
 *                  against. This is the row that answers "what did this claim
 *                  cost" months later. Pruned far more slowly, and deleting it
 *                  cascades any steps that outlived their tier anyway.
 *
 * Keeping runs long after their steps are gone is the whole point: the
 * expensive-to-store part expires quickly while the analytically valuable part
 * survives. A run whose steps have been pruned is still a complete cost and
 * outcome record — consumers already tolerate a run with missing steps, since
 * step inserts are fire-and-forget and can individually fail.
 *
 * Deletes are BATCHED. A single unbounded `DELETE ... WHERE started_at < x` on
 * a table with months of backlog takes a long lock and a large transaction;
 * batching keeps each statement short and lets the sweep make partial progress
 * and resume next tick instead of timing out forever on the first run.
 *
 * Retention is a policy knob, not a law: 0 on either tier disables that tier's
 * pruning entirely, which is what the corpus harness wants (an eval run keeps
 * everything, per #334 §5's "production can sample or expire, corpus runs keep
 * everything").
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";

export interface TraceRetentionResult {
  stepsDeleted: number;
  runsDeleted: number;
  /** True when a tier hit its batch ceiling and has more to delete next tick. */
  moreRemaining: boolean;
}

/**
 * Rows per DELETE statement. Large enough that a real backlog drains in a
 * sensible number of statements, small enough that no single statement holds a
 * long lock on a hot table.
 */
const BATCH_SIZE = 5_000;

/**
 * Batches per tier per tick — the backstop that keeps one sweep from running
 * for hours on first deployment against a large backlog. What it doesn't
 * finish, the next tick picks up.
 */
const MAX_BATCHES = 20;

/**
 * Delete in batches until the tier is drained or the ceiling is hit.
 * Returns the row count and whether work remains.
 */
async function deleteInBatches(
  sql: string,
  params: unknown[]
): Promise<{ deleted: number; more: boolean }> {
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await rawQuery<{ id: string }>(sql, params);
    deleted += rows.length;
    if (rows.length < BATCH_SIZE) return { deleted, more: false };
  }
  return { deleted, more: true };
}

/** One retention pass; exported separately so tests can drive the clock. */
export async function traceRetentionTick(
  now: number = Date.now()
): Promise<TraceRetentionResult> {
  const config = loadConfig();
  const result: TraceRetentionResult = {
    stepsDeleted: 0,
    runsDeleted: 0,
    moreRemaining: false,
  };

  // Steps first: they are the bulk, and pruning a run in the same tick would
  // cascade-delete its steps anyway — doing steps first keeps the counts
  // honest about which tier actually reclaimed the space.
  if (config.traceStepRetentionDays > 0) {
    const cutoff = new Date(now - config.traceStepRetentionDays * 86_400_000);
    // Join to the run rather than filtering on agent_steps.created_at: a
    // step's age is its RUN's age. A long-running agent whose run started
    // before the cutoff should expire wholesale, not leave a tail of steps
    // that happen to have been written recently.
    const { deleted, more } = await deleteInBatches(
      `DELETE FROM agent_steps
        WHERE id IN (
          SELECT s.id FROM agent_steps s
            JOIN agent_runs r ON r.id = s.run_id
           WHERE r.started_at < $1
           LIMIT ${BATCH_SIZE}
        )
        RETURNING id`,
      [cutoff]
    );
    result.stepsDeleted = deleted;
    result.moreRemaining ||= more;
  }

  if (config.traceRunRetentionDays > 0) {
    const cutoff = new Date(now - config.traceRunRetentionDays * 86_400_000);
    // agent_steps.run_id cascades, so this cleans up any straggler steps too.
    const { deleted, more } = await deleteInBatches(
      `DELETE FROM agent_runs
        WHERE id IN (
          SELECT id FROM agent_runs WHERE started_at < $1 LIMIT ${BATCH_SIZE}
        )
        RETURNING id`,
      [cutoff]
    );
    result.runsDeleted = deleted;
    result.moreRemaining ||= more;
  }

  return result;
}

/**
 * Run the sweep on an interval. Hourly by default: retention is measured in
 * days, so there is nothing to gain from checking more often, and each tick
 * is a no-op once the backlog is drained.
 */
export function startTraceRetention(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? 60 * 60_000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await traceRetentionTick();
      if (result.stepsDeleted > 0 || result.runsDeleted > 0) {
        options.logger.info(
          `Trace retention: pruned ${result.stepsDeleted} step(s), ` +
            `${result.runsDeleted} run(s)` +
            (result.moreRemaining ? " — more remaining, continuing next tick" : "")
        );
      }
    } catch (err) {
      options.logger.error(
        "Trace retention error",
        err instanceof Error ? err.message : err
      );
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info("Trace retention started");

  return { stop: () => clearInterval(timer) };
}
