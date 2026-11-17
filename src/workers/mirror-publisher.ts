/**
 * The mirror feed's publisher: cuts a batch on a cadence
 * (services/mirror-feed-service.ts, docs/mirror.md).
 *
 * Started only on a deployment configured to publish (MIRROR_PUBLISH). A
 * cut holds a lock on the batches table, so every task may run this: a
 * second cut waits for the first and then finds nothing left to publish.
 *
 * It runs inside the API process unless MIRROR_PUBLISHER_WORKER is "true",
 * in which case this file is run on its own (`npm run worker:mirror-publisher`)
 * and the API only serves the feed. Public Minerval runs it on its own: a
 * snapshot cut of the public graph needs more memory than the API's task
 * has to spare (infra/lib/api-stack.ts).
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { closeDb } from "../db/client.js";
import { mirrorConfigProblems, mirrorRoles } from "../services/mirror-roles.js";
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

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  (async () => {
    await import("../load-env.js");
    const config = loadConfig();
    if (!mirrorRoles(config).publisher) {
      console.log("[mirror-publisher] MIRROR_PUBLISH is not true; nothing to do");
      await closeDb();
      process.exit(0);
    }
    // The same check the API makes at start: a publisher with no usable key
    // stops here with the reason, not at its first cut.
    const problems = mirrorConfigProblems(config);
    if (problems.length > 0) {
      console.error(`[mirror-publisher] not starting:\n- ${problems.join("\n- ")}`);
      await closeDb();
      process.exit(1);
    }
    const publisher = startMirrorPublisher({
      logger: { info: (...a) => console.log(...a), error: (...a) => console.error(...a) },
    });
    const shutdown = async () => {
      console.log("[mirror-publisher] shutting down");
      publisher.stop();
      await closeDb();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })().catch((err) => {
    console.error("[mirror-publisher] fatal:", err);
    process.exit(1);
  });
}
