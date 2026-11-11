/**
 * Source backfill (#507): the facts and segments a source should have and
 * does not.
 *
 * Facts (authors, publisher, date, DOI, archived copy, and the notices
 * Crossref holds against the work) and segments (the document's sections
 * and passages, with each instance anchored to its passage) are filled on
 * ingest and when provenance_read_source first fetches a document. Two kinds
 * of source miss both:
 *
 *  - A source stored before #510/#511 existed.
 *  - A source an agent cited by URL without opening it through
 *    provenance_read_source: recording an instance, an argument passage, a
 *    reading or an upstream edge creates a row with a URL and a title and no
 *    text. Most of a page's facts are in its own metadata, so a lookup with
 *    no text finds almost nothing; such a source needs its page fetched
 *    first.
 *
 * So this worker fetches as well as looks up. A source with a URL and no
 * stored text, which something in the graph cites, has its page fetched and
 * stored exactly as provenance_read_source would (fetchAndStoreSource), and
 * its facts and segments follow from the text. A source nothing cites is
 * never fetched: a submission awaiting intake review stays inert until the
 * review decides.
 *
 * It works in two stages.
 *
 * The pass covers what already exists: one pass over the sources missing
 * facts, segments or (cited) text, in id order, a bounded batch per tick. It
 * is a cursor, not a "still missing" query: a document whose text yields no
 * passages, or whose page cannot be fetched, is passed over once rather than
 * retaken every tick ahead of the rest. The cursor lives in platform_flags;
 * a tick claims its batch by moving it under a row lock, so two tasks never
 * take the same sources. Deleting the flag row starts a new pass at the next
 * tick.
 *
 * The sweep covers what arrives afterwards: once the pass is done, each tick
 * takes the cited sources whose facts were never checked. Every source it
 * takes leaves with facts_checked_at set, whatever the fetch and the lookups
 * found, so each is taken once. A lease in platform_flags lets one task
 * sweep at a time; a task that dies mid-sweep leaves its sources unchecked
 * and the lease to expire, so the next sweep takes them again.
 *
 * No model is called and nothing is metered: the cost is the outside
 * requests (the page, Crossref for a DOI, the Wayback Machine), which the
 * per-tick size bounds (SOURCE_BACKFILL_PER_TICK) and which go out one
 * source at a time.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { refreshSourceFactsOnce } from "../services/source-facts-service.js";
import { segmentSourceOnce } from "../services/source-segment-service.js";
import { fetchAndStoreSource } from "../services/source-map-service.js";

/**
 * The pass's cursor. The key carries a version because the pass now fetches:
 * the pass under the old key ("source_backfill") finished having only looked
 * up facts, and sources cited without text need taking again.
 */
export const SOURCE_BACKFILL_FLAG = "source_backfill_fetch";

/** The sweep's lease: which task is sweeping, until when. */
export const SOURCE_SWEEP_LEASE_FLAG = "source_sweep_lease";

/**
 * How long a sweep may hold the lease before another task may take over. A
 * tick releases it when it finishes; this only bounds how long a task that
 * died holds the sweep up. Longer than a full batch of slow fetches.
 */
const SWEEP_LEASE_SECONDS = 30 * 60;

/** Something in the graph cites source `s`: an instance, a passage, a reading, or an edge that draws on it. */
const CITED = `(
  EXISTS (SELECT 1 FROM claim_instances ci WHERE ci.source_id = s.id)
  OR EXISTS (SELECT 1 FROM argument_instances ai WHERE ai.source_id = s.id)
  OR EXISTS (SELECT 1 FROM quantity_readings qr WHERE qr.source_id = s.id)
  OR EXISTS (SELECT 1 FROM claim_provenance_edges e WHERE e.to_source_id = s.id)
)`;

/** Source `s` has a web address and no stored text. */
const FETCHABLE = `((s.raw_content IS NULL OR s.raw_content = '') AND s.url ~* '^https?://')`;

export interface SourceBackfillTickResult {
  /** Sources this tick took, from the pass or the sweep. */
  taken: number;
  /** Of those, how many had their page fetched and stored this tick. */
  fetched: number;
  /** Of those, how many now have facts checked and how many have segments. */
  facts: number;
  segmented: number;
  /** True once the pass has reached the last source; the sweep goes on after it. */
  done: boolean;
}

interface Mark {
  after: string | null;
  done: boolean;
}

/**
 * Claim the pass's next batch: the sources after the cursor still missing
 * facts, (with text) segments, or (cited, with a URL) text, and move the
 * cursor past them, in one transaction holding the flag row, so a concurrent
 * tick waits and then takes the next batch. A short batch means the pass has
 * reached the end.
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
                   AND NOT EXISTS (SELECT 1 FROM source_segments g WHERE g.source_id = s.id))
               OR (${FETCHABLE} AND ${CITED}))
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

/** Take the sweep's lease if nobody holds a live one. */
async function takeSweepLease(): Promise<boolean> {
  const rows = await rawQuery<{ key: string }>(
    `INSERT INTO platform_flags (key, value)
     VALUES ($1, jsonb_build_object('until', now() + make_interval(secs => $2)))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE (platform_flags.value->>'until')::timestamptz <= now()
     RETURNING key`,
    [SOURCE_SWEEP_LEASE_FLAG, SWEEP_LEASE_SECONDS]
  );
  return rows.length > 0;
}

async function releaseSweepLease(): Promise<void> {
  await rawQuery(
    `UPDATE platform_flags SET value = jsonb_build_object('until', now()), updated_at = now() WHERE key = $1`,
    [SOURCE_SWEEP_LEASE_FLAG]
  );
}

/** The sweep's batch: cited sources whose facts nobody has checked. */
async function uncheckedCitedSources(limit: number): Promise<string[]> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT s.id FROM sources s
      WHERE s.facts_checked_at IS NULL AND ${CITED}
      ORDER BY s.id
      LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.id);
}

/**
 * Fill one source: fetch its page when it is cited and has none stored, then
 * its facts and segments. Never throws, and always leaves the source marked
 * as checked, so neither stage takes it twice. Returns whether the page was
 * fetched.
 */
export async function fillSource(
  sourceId: string,
  deps: { fetch?: (url: string) => Promise<string> } = {}
): Promise<boolean> {
  let fetched = false;
  try {
    const [row] = await rawQuery<{ url: string | null; fetch: boolean }>(
      `SELECT s.url, (${FETCHABLE} AND ${CITED}) AS fetch FROM sources s WHERE s.id = $1`,
      [sourceId]
    );
    if (row?.fetch && row.url) {
      try {
        // Stores the text, then looks up the facts and segments from it.
        await fetchAndStoreSource({ id: sourceId, url: row.url }, deps.fetch);
        fetched = true;
      } catch (err) {
        console.error(
          `[source-backfill] fetch failed for ${sourceId}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
    if (!fetched) {
      await refreshSourceFactsOnce(sourceId);
      await segmentSourceOnce(sourceId);
    }
    await rawQuery(
      `UPDATE sources SET facts_checked_at = now() WHERE id = $1 AND facts_checked_at IS NULL`,
      [sourceId]
    );
  } catch (err) {
    console.error(
      `[source-backfill] fill failed for ${sourceId}: ${err instanceof Error ? err.message : err}`
    );
  }
  return fetched;
}

/** One tick; exported so tests and an operator can drive it. */
export async function sourceBackfillTick(
  deps: { fetch?: (url: string) => Promise<string> } = {}
): Promise<SourceBackfillTickResult> {
  const config = loadConfig();
  const limit = config.sourceBackfillPerTick;
  if (limit <= 0) return { taken: 0, fetched: 0, facts: 0, segmented: 0, done: false };

  let { ids, done } = await claimSourceBatch(limit);
  let fetched = 0;
  // One at a time: each source may make three outside requests.
  for (const id of ids) {
    if (await fillSource(id, deps)) fetched++;
  }

  // The pass is over (or just ended on a short batch): sweep what has been
  // cited since, up to what is left of this tick's size.
  if (done && ids.length < limit && (await takeSweepLease())) {
    try {
      const swept = await uncheckedCitedSources(limit - ids.length);
      for (const id of swept) {
        if (await fillSource(id, deps)) fetched++;
      }
      ids = [...ids, ...swept];
    } finally {
      await releaseSweepLease();
    }
  }

  if (ids.length === 0) return { taken: 0, fetched: 0, facts: 0, segmented: 0, done };
  const [counts] = await rawQuery<{ facts: number; segmented: number }>(
    `SELECT COUNT(*) FILTER (WHERE s.facts_checked_at IS NOT NULL)::int AS facts,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM source_segments g WHERE g.source_id = s.id))::int AS segmented
       FROM sources s WHERE s.id = ANY($1::uuid[])`,
    [ids]
  );
  return { taken: ids.length, fetched, facts: counts?.facts ?? 0, segmented: counts?.segmented ?? 0, done };
}

/**
 * Run the backfill on an interval, for as long as the process runs: the pass
 * first, then the sweep. A tick that took nothing is silent; one that took
 * sources says what it filled, and the tick that finishes the pass says so
 * once.
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
  let passDone = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await sourceBackfillTick();
      if (result.taken > 0) {
        options.logger.info(
          `Source backfill: took ${result.taken} source(s); fetched ${result.fetched}, ` +
            `${result.facts} have facts, ${result.segmented} are segmented`
        );
      }
      if (result.done && !passDone) {
        passDone = true;
        if (result.taken > 0) options.logger.info("Source backfill: pass complete; sweeping newly cited sources");
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
