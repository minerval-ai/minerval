/**
 * The Correspondents' graph_change trigger (#563): every quarter hour, queue
 * one wake on each correspondent whose scope has a material change after its
 * cursor and that has no such wake waiting (services/correspondent-service.ts,
 * graphChangeScanTick). A scan, not a judgment: it opens no ledger row and
 * decides nothing about what matters to the audience. The reconcile sweep
 * makes a woken correspondent due once its min_wake_hours have passed, and
 * the mandate's money decides whether it runs.
 */
import { loadConfig } from "../config.js";
import { graphChangeScanTick } from "../services/correspondent-service.js";

export function startCorrespondentTriggers(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  if (loadConfig().correspondentRunsEnabled === false) {
    options.logger.info("Correspondent triggers disabled (CORRESPONDENT_RUNS_ENABLED=false)");
    return { stop: () => {} };
  }
  const interval = options.intervalMs ?? 15 * 60_000;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await graphChangeScanTick();
      if (r.queued > 0) {
        options.logger.info(`Correspondent change scan: ${r.checked} checked, ${r.queued} woken`);
      }
    } catch (err) {
      options.logger.error("Correspondent change scan error", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, interval);
  void tick();
  return { stop: () => clearInterval(timer) };
}
