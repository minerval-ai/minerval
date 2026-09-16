/**
 * Report embedding backfill (#432): the repair for reports the meaning
 * search cannot see.
 *
 * raiseIssue() embeds a report's title + body at write time so the next
 * paraphrase of the same problem is matched against it instead of minting
 * a new row. When the embedder is down the report is still recorded, with
 * no vector, and reports from before the column existed have none either.
 * Such a report is invisible to the meaning search, so its repeats file as
 * new issues and the maintainers' note on it never reaches the next agent.
 * This worker embeds those rows a bounded batch per tick, oldest first,
 * until none remain; a tick with nothing pending costs one read.
 *
 * Idempotent through the row: the update only lands where the embedding is
 * still null, so two API tasks ticking at once at worst embed a row twice,
 * never disagree about it.
 */
import { loadConfig } from "../config.js";
import { backfillReportEmbeddings } from "../services/report-service.js";

export interface ReportEmbeddingBackfillTickResult {
  pending: number;
  embedded: number;
  failed: number;
}

/** One pass; exported separately so tests can drive it. */
export async function reportEmbeddingBackfillTick(): Promise<ReportEmbeddingBackfillTickResult> {
  const config = loadConfig();
  if (config.reportEmbeddingBackfillPerTick <= 0) {
    return { pending: 0, embedded: 0, failed: 0 };
  }
  return backfillReportEmbeddings(config.reportEmbeddingBackfillPerTick);
}

/**
 * Run the backfill on an interval. A tick that finds nothing is silent;
 * one that embedded something says so, and one that failed everything it
 * tried says that too, since it will keep retrying the same rows.
 */
export function startReportEmbeddingBackfill(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const config = loadConfig();
  if (config.reportEmbeddingBackfillPerTick <= 0) {
    options.logger.info(
      "Report embedding backfill disabled (REPORT_EMBEDDING_BACKFILL_PER_TICK=0)"
    );
    return { stop: () => {} };
  }
  const interval =
    options.intervalMs ??
    Math.max(30, config.reportEmbeddingBackfillIntervalSeconds) * 1000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await reportEmbeddingBackfillTick();
      if (result.pending > 0) {
        options.logger.info(
          `Report embedding backfill: ${result.embedded} embedded, ` +
            `${result.failed} failed of ${result.pending} pending report(s)`
        );
      }
    } catch (err) {
      options.logger.error(
        "Report embedding backfill error",
        err instanceof Error ? err.message : err
      );
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info(
    `Report embedding backfill started (${config.reportEmbeddingBackfillPerTick}/tick)`
  );

  return { stop: () => clearInterval(timer) };
}
