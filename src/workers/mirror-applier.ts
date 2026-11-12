/**
 * The mirror's applier: brings this deployment's mirror of the public graph
 * up to its feed on a cadence (services/mirror-apply-service.ts,
 * docs/mirror.md).
 *
 * Started only on a deployment configured with a feed (MIRROR_FEED_URL or
 * MIRROR_FEED_DIR). It fetches batches by their sequence and nothing else,
 * so the publisher learns that this deployment exists and when it pulls,
 * and nothing about what it reads. Applying a batch holds a lock, and a
 * batch already applied changes nothing, so every task may run this.
 *
 * It runs no agent and funds nothing: a batch only changes mirrored rows.
 */
import { loadConfig } from "../config.js";
import {
  MirrorConfigError,
  configuredSource,
  syncMirror,
  type SyncResult,
} from "../services/mirror-apply-service.js";

/** One sync, described for the log; null when there was nothing new. */
export function describeSync(result: SyncResult): { info: string | null; error: string | null } {
  const applied = result.applied.filter((a) => a.status === "applied");
  const last = applied.at(-1);
  return {
    info: last
      ? `Mirror: applied ${applied.length} ${applied.length === 1 ? "batch" : "batches"}, now at batch ${last.sequence}: the public graph as of ${last.cut_at}`
      : null,
    error: result.refusal ? `Mirror: ${result.refusal.message}` : null,
  };
}

export function startMirrorApplier(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? Math.max(1, loadConfig().mirrorApplyIntervalSeconds) * 1000;
  let busy = false;
  // A refusal repeats on every tick until someone acts; it is logged when
  // it first appears and when it changes, not every few minutes.
  let lastError: string | null = null;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const source = configuredSource();
      if (!source) return;
      const { info, error } = describeSync(await syncMirror(source));
      if (info) options.logger.info(info);
      if (error && error !== lastError) options.logger.error(error);
      lastError = error;
    } catch (err) {
      const message =
        err instanceof MirrorConfigError
          ? `Mirror: ${err.message}`
          : `Mirror: the feed could not be read (${err instanceof Error ? err.message : String(err)}); the mirror stays where it is`;
      if (message !== lastError) options.logger.error(message);
      lastError = message;
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info(`Mirror applier started (checking its feed every ${Math.round(interval / 1000)} seconds)`);
  return { stop: () => clearInterval(timer) };
}
