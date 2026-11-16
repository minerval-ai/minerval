/**
 * The usage report worker (docs/usage-report.md).
 *
 * In a members-only deployment on the metered price, on an interval: write
 * a report for each UTC day that has closed and has none, then send every
 * report that has not been sent, to the public graph or to files to be
 * handed over (services/usage-report-service.ts). A deployment that was
 * offline, or has no destination set yet, keeps its reports and sends them
 * when it can, oldest first.
 *
 * It is not started where the deployment does not report: on the public
 * graph, and on the flat price (src/index.ts). Preparing runs under a
 * database lock and a report is recorded once whoever sends it, so every
 * task may run this.
 */
import { loadConfig } from "../config.js";
import {
  prepareUsageReports,
  sendUsageReports,
  usageReporting,
} from "../services/usage-report-service.js";

export interface UsageReportTick {
  prepared: number;
  sent: number;
  /** Why sending stopped before the end, when it did. */
  stopped: string | null;
}

export async function usageReportTick(now: Date = new Date()): Promise<UsageReportTick> {
  if (!usageReporting()) return { prepared: 0, sent: 0, stopped: null };
  const prepared = await prepareUsageReports(now);
  const outcome = await sendUsageReports();
  return { prepared: prepared.length, sent: outcome.sent, stopped: outcome.stopped };
}

/** Run the tick on an interval; see the queue-depth sampler for the pattern. */
export function startUsageReports(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? loadConfig().usageReportIntervalSeconds * 1000;
  let busy = false;
  // Said once per reason, not on every pass: a deployment with no
  // destination set would otherwise log the same line every hour.
  let lastStopped: string | null = null;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await usageReportTick();
      if (result.prepared > 0 || result.sent > 0) {
        options.logger.info(
          `Usage reports: prepared ${result.prepared}, sent ${result.sent}`
        );
      }
      if (result.stopped && result.stopped !== lastStopped) {
        options.logger.error(`Usage reports were not all sent: ${result.stopped}`);
      }
      lastStopped = result.stopped;
    } catch (err) {
      options.logger.error("Usage report tick failed:", err);
    } finally {
      busy = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), interval);
  return { stop: () => clearInterval(timer) };
}
