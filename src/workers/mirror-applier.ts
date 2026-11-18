/**
 * The mirror's applier: brings this deployment's mirror of the public graph
 * up to its feed on a cadence (services/mirror-apply-service.ts,
 * docs/mirror.md).
 *
 * Started on a deployment configured with a feed (MIRROR_FEED_URL or
 * MIRROR_FEED_DIR), and on a private one that may follow the public graph
 * from the app (services/mirror-following.ts), where it looks each turn at
 * whether an administrator started following and does nothing until one
 * has. Check now, pressed on the Mirror page, is picked up within seconds.
 * It fetches batches by their sequence and nothing else,
 * so the publisher learns that this deployment exists and when it pulls,
 * and nothing about what it reads. Applying a batch holds a lock, and a
 * batch already applied changes nothing, so every task may run this.
 *
 * It runs no agent and funds nothing: a batch only changes mirrored rows.
 * After a sync it opens, on the ledger, the work the batches call for in
 * this deployment's own rows (services/mirror-upkeep.ts): a reassessment
 * at its own label for a version made beside a public judgment that was
 * replaced, and the like. Opening runs nothing either.
 */
import { loadConfig } from "../config.js";
import { afterMirrorApplied, type MirrorUpkeepResult } from "../services/mirror-upkeep.js";
import { MirrorConfigError, syncMirror, type SyncResult } from "../services/mirror-apply-service.js";
import { checkRequested, followedSource, noteChecked, trustedKeys } from "../services/mirror-following.js";

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

/** What the upkeep after a sync opened, for the log; null when it opened nothing. */
export function describeUpkeep(upkeep: MirrorUpkeepResult): string | null {
  const parts = [
    upkeep.versions > 0
      ? `${upkeep.versions} ${upkeep.versions === 1 ? "reassessment" : "reassessments"} opened for versions made beside a public judgment that was replaced`
      : null,
    upkeep.merges > 0 ? `${upkeep.merges} opened because the public graph merged a node` : null,
    upkeep.withdrawals > 0 ? `${upkeep.withdrawals} opened because the public graph withdrew a node` : null,
    upkeep.convergence > 0
      ? `the Curator asked about ${upkeep.convergence} of this deployment's nodes that a public node may now state`
      : null,
    upkeep.fromOutside > 0
      ? `${upkeep.fromOutside} ${upkeep.fromOutside === 1 ? "contribution or request" : "contributions or requests"} from the public graph passed to the work they are for`
      : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? `Mirror: ${parts.join("; ")}. Nothing was run: each waits to be funded.` : null;
}

/** How often the applier looks whether Check now was pressed: one small read. */
const CHECK_POLL_MS = 5_000;

export function startMirrorApplier(options: {
  intervalMs?: number;
  checkPollMs?: number;
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
      const source = await followedSource();
      if (!source) return;
      const keys = await trustedKeys();
      if (keys.length === 0) {
        throw new MirrorConfigError(
          "No key for the feed has been accepted, so no batch can be checked. An administrator accepts the feed's key on the Mirror page."
        );
      }
      const result = await syncMirror(source, { trustedKeys: keys });
      await noteChecked(null);
      const { info, error } = describeSync(result);
      if (info) options.logger.info(info);
      // What the batches mean for this deployment's own work: reassessments
      // and requests opened on the ledger, nothing run (mirror-upkeep.ts).
      const upkeep = describeUpkeep(await afterMirrorApplied(result.applied));
      if (upkeep) options.logger.info(upkeep);
      if (error && error !== lastError) options.logger.error(error);
      lastError = error;
    } catch (err) {
      const message =
        err instanceof MirrorConfigError
          ? `Mirror: ${err.message}`
          : `Mirror: the feed could not be read (${err instanceof Error ? err.message : String(err)}); the mirror stays where it is`;
      if (message !== lastError) options.logger.error(message);
      lastError = message;
      await noteChecked(message).catch(() => undefined);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  const checks = setInterval(() => {
    if (busy) return;
    void checkRequested()
      .then((asked) => (asked ? tick() : undefined))
      .catch(() => undefined);
  }, options.checkPollMs ?? CHECK_POLL_MS);
  void tick();
  options.logger.info(`Mirror applier started (checking its feed every ${Math.round(interval / 1000)} seconds)`);
  return {
    stop: () => {
      clearInterval(timer);
      clearInterval(checks);
    },
  };
}
