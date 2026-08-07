/**
 * Queue-depth sampler (#334 L0, #217): persists a periodic snapshot of the
 * steward lane by state plus the open action ledger, so fan-out spikes and
 * silent pile-ups (#97) are visible over time rather than only at the moment
 * an operator hits GET /queue.
 *
 * The tick interval controls how promptly a due period is noticed; the
 * period key (floor(now / sample interval), UNIQUE on the row) is what makes
 * the cadence — ticking often, or from several instances, never records a
 * period twice. Same discipline as the audit scheduler.
 */
import { getDb, rawQuery } from "../db/client.js";
import { queueDepthSnapshots } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { stewardQueueHealth } from "./steward-pipeline.js";

export interface QueueDepthSampleResult {
  sampled: boolean;
}

export async function queueDepthSamplerTick(
  now: number = Date.now()
): Promise<QueueDepthSampleResult> {
  const config = loadConfig();
  if (config.queueDepthSampleIntervalHours <= 0) return { sampled: false };

  const intervalMs = config.queueDepthSampleIntervalHours * 3_600_000;
  const period = Math.floor(now / intervalMs);

  const [steward, actions] = await Promise.all([
    stewardQueueHealth(),
    rawQuery<{ kind: string; status: string; n: number }>(
      `SELECT kind, status, COUNT(*)::int AS n
         FROM actions
        WHERE status IN ('open', 'running')
        GROUP BY kind, status`
    ),
  ]);
  const ledger: Record<string, { open: number; running: number }> = {};
  for (const row of actions) {
    const entry = (ledger[row.kind] ??= { open: 0, running: 0 });
    if (row.status === "open") entry.open = row.n;
    if (row.status === "running") entry.running = row.n;
  }

  const inserted = await getDb()
    .insert(queueDepthSnapshots)
    .values({
      periodKey: `${period}`,
      stewardPending: steward.pending,
      detail: { steward, actions: ledger },
    })
    .onConflictDoNothing({ target: queueDepthSnapshots.periodKey })
    .returning({ id: queueDepthSnapshots.id });

  return { sampled: inserted.length > 0 };
}

/** Run the sampler on an interval; see the audit scheduler for the pattern. */
export function startQueueDepthSampler(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? 15 * 60_000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await queueDepthSamplerTick();
      if (result.sampled) {
        options.logger.info("Queue-depth sampler: recorded snapshot");
      }
    } catch (err) {
      options.logger.error("Queue-depth sampler tick failed:", err);
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
