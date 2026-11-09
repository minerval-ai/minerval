/**
 * Source backfill (#507): the source facts and segments a source stored
 * before they existed never got.
 *
 * Facts (authors, publisher, date, DOI, archived copy, and the notices
 * Crossref holds against the work) and segments (the document's sections
 * and passages, with each instance anchored to its passage) are filled on
 * ingest and when provenance_read_source first fetches a document. A source
 * stored before #510/#511 had neither, and got them only if it was ingested
 * again or examined, so its source page showed no facts and "not yet
 * divided".
 *
 * This worker makes one pass over those sources, in id order, a bounded
 * batch per tick, and fills each the way ingest would (refreshSourceFactsOnce,
 * segmentSourceOnce), each step at most once and never failing the source.
 * It is a cursor, not a "still missing" query: a document whose text yields
 * no passages, or whose facts lookup failed, is passed over once rather than
 * retaken every tick ahead of the rest. The cursor lives in platform_flags;
 * a tick claims its batch by moving it under a row lock, so two tasks never
 * take the same sources. When the pass reaches the end it marks itself done
 * and every later tick is one read. Deleting the flag row starts a new pass
 * at the next restart.
 *
 * No model is called and nothing is metered: the cost is the outside
 * lookups, which the per-tick size bounds (SOURCE_BACKFILL_PER_TICK).
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { refreshSourceFactsOnce } from "../services/source-facts-service.js";
import { segmentSourceOnce } from "../services/source-segment-service.js";

export const SOURCE_BACKFILL_FLAG = "source_backfill";

export interface SourceBackfillTickResult {
  /** Sources this tick took from the cursor. */
  taken: number;
  /** Of those, how many now have facts checked and how many have segments. */
  facts: number;
  segmented: number;
  /** True once the pass has reached the last source. */
  done: boolean;
}

interface Mark {
  after: string | null;
  done: boolean;
}

/**
 * Claim the next batch: the sources after the cursor still missing facts or
 * (with text) segments, and move the cursor past them, in one transaction
 * holding the flag row, so a concurrent tick waits and then takes the next
 * batch. A short batch means the pass has reached the end.
 */
export async function claimSourceBatch(limit: number): Promise<{ ids: string[]; done: boolean }> {
  return withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO platform_flags (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [SOURCE_BACKFILL_FLAG, JSON.stringify({ after: null, done: false })]
    );
    const [flag] = await tx.query<{ value: Mark }>(
      `SELECT value FROM platform_flags WHERE key = $1 FOR UPDATE`,
      [SOURCE_BACKFILL_FLAG]
    );
    const mark: Mark = { after: flag?.value?.after ?? null, done: flag?.value?.done === true };
    if (mark.done) return { ids: [], done: true };

    const rows = await tx.query<{ id: string }>(
      `SELECT s.id FROM sources s
        WHERE ($1::uuid IS NULL OR s.id > $1::uuid)
          AND (s.facts_checked_at IS NULL
               OR (s.raw_content IS NOT NULL AND s.raw_content <> ''
                   AND NOT EXISTS (SELECT 1 FROM source_segments g WHERE g.source_id = s.id)))
        ORDER BY s.id
        LIMIT $2`,
      [mark.after, limit]
    );
    const ids = rows.map((r) => r.id);
    const done = ids.length < limit;
    await tx.query(
      `UPDATE platform_flags SET value = $2::jsonb, updated_at = now() WHERE key = $1`,
      [SOURCE_BACKFILL_FLAG, JSON.stringify({ after: ids.at(-1) ?? mark.after, done })]
    );
    return { ids, done };
  });
}

/** One tick; exported so tests and an operator can drive it. */
export async function sourceBackfillTick(): Promise<SourceBackfillTickResult> {
  const config = loadConfig();
  if (config.sourceBackfillPerTick <= 0) return { taken: 0, facts: 0, segmented: 0, done: false };
  const { ids, done } = await claimSourceBatch(config.sourceBackfillPerTick);
  // One at a time: each source may make two outside lookups.
  for (const id of ids) {
    await refreshSourceFactsOnce(id);
    await segmentSourceOnce(id);
  }
  if (ids.length === 0) return { taken: 0, facts: 0, segmented: 0, done };
  const [counts] = await rawQuery<{ facts: number; segmented: number }>(
    `SELECT COUNT(*) FILTER (WHERE s.facts_checked_at IS NOT NULL)::int AS facts,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM source_segments g WHERE g.source_id = s.id))::int AS segmented
       FROM sources s WHERE s.id = ANY($1::uuid[])`,
    [ids]
  );
  return { taken: ids.length, facts: counts?.facts ?? 0, segmented: counts?.segmented ?? 0, done };
}

/**
 * Run the backfill on an interval. A tick that took nothing is silent; one
 * that took sources says what it filled, and the tick that finishes the
 * pass says so once.
 */
export function startSourceBackfill(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const config = loadConfig();
  if (config.sourceBackfillPerTick <= 0) {
    options.logger.info("Source backfill disabled (SOURCE_BACKFILL_PER_TICK=0)");
    return { stop: () => {} };
  }
  const interval = options.intervalMs ?? Math.max(30, config.sourceBackfillIntervalSeconds) * 1000;
  let busy = false;
  let finished = false;

  const tick = async () => {
    if (busy || finished) return;
    busy = true;
    try {
      const result = await sourceBackfillTick();
      if (result.taken > 0) {
        options.logger.info(
          `Source backfill: took ${result.taken} source(s); ${result.facts} have facts, ` +
            `${result.segmented} are segmented`
        );
      }
      if (result.done) {
        finished = true;
        if (result.taken > 0) options.logger.info("Source backfill: pass complete");
      }
    } catch (err) {
      options.logger.error("Source backfill error", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info(`Source backfill started (${config.sourceBackfillPerTick}/tick)`);
  return { stop: () => clearInterval(timer) };
}
