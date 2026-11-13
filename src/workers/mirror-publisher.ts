/**
 * The mirror feed's publisher: cuts a batch on a cadence
 * (services/mirror-feed-service.ts, docs/mirror.md).
 *
 * Started only on a deployment configured to publish (MIRROR_PUBLISH). A
 * cut holds a lock on the batches table, so every task may run this: a
 * second cut waits for the first and then finds nothing left to publish.
 */
import { loadConfig } from "../config.js";
import { cutBatches, MirrorPublishError, type CutResult } from "../services/mirror-feed-service.js";

/** One cut, described for the log. */
export function describeCut(result: CutResult): string | null {
  if (result.batches.length === 0) return null;
  const first = result.batches[0]!;
  const last = result.batches.at(-1)!;
  const rows = result.batches.reduce((n, b) => n + b.rows, 0);
  const removals = result.batches.reduce((n, b) => n + b.removals, 0);
  const bytes = result.batches.reduce((n, b) => n + b.bytes, 0);
  const span = first.sequence === last.sequence ? `batch ${first.sequence}` : `batches ${first.sequence} to ${last.sequence}`;
  return `Mirror feed: cut ${span} (${first.kind}; ${rows} rows, ${removals} removals, ${bytes} bytes)`;
}

export function startMirrorPublisher(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? Math.max(1, loadConfig().mirrorPublishIntervalSeconds) * 1000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const line = describeCut(await cutBatches());
      if (line) options.logger.info(line);
    } catch (err) {
      options.logger.error(
        err instanceof MirrorPublishError ? `Mirror feed: ${err.message}` : "Mirror feed: the cut failed and nothing was published",
        err instanceof MirrorPublishError ? undefined : err instanceof Error ? err.message : err
      );
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info(`Mirror feed publisher started (a cut every ${Math.round(interval / 1000)} seconds)`);
  return { stop: () => clearInterval(timer) };
}
