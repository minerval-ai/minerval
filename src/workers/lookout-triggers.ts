/**
 * Lookout triggers — the code-side inputs that wake a mandate's standing
 * watches (docs/allocation.md, "Lookouts").
 *
 * A lookout's judgment is whether a happening matters; the happenings it
 * cannot cheaply notice by reading are produced here and queued as
 * `lookout_events`, which make the lookout due (action-service
 * reconcileActions) for a run the ledger funds like any other. The first
 * and most valuable of these is the retraction poll:
 *
 *   once a day (LOOKOUT_RETRACTION_POLL_HOURS), ask Crossref for every
 *   retraction, correction, and expression-of-concern notice added since
 *   the last poll (the Retraction Watch database rides in Crossref since
 *   2023), join the updated DOIs against the graph's sources, and for
 *   each source that has claims resting on it, queue a `retraction` event
 *   on every active lookout that watches for retractions.
 *
 * It is also the correction watcher (#507): every notice that matches a
 * source in the graph is recorded as a dated `source_events` row, whether
 * or not any lookout is watching, because what happened to a document is a
 * fact its source page shows to every reader.
 *
 * The poll itself is a scan, not a judgment: it does not decide which
 * lookout cares about which retraction (that is the lookout's, in the
 * brief's words), and it opens no ledger row directly. Bounded producers
 * throughout: one Crossref page per poll per type, a cap on pending
 * events per lookout, and a persisted high-water mark (platform_flags)
 * so a restart never re-queues the same notices.
 *
 * Period-keyed and idempotent, so every task may run it: the high-water
 * mark is advanced only after a successful poll, and a lookout that
 * already holds an event for a notice is not handed it twice.
 *
 * The second is the feed poll (#305, feedPollTick): every due feed of an
 * active lookout is fetched and its new items recorded in the lookout's
 * inbox; a feed whose wake rule is met queues one `feed` event, and an
 * auto_ingest feed puts its new items on the plan (services/feed-service.ts).
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { recentRetractions } from "../services/source-watch-service.js";
import { claimsRestingOnSources, sourcesForDois } from "../services/source-watch-service.js";
import { queueLookoutEventsByTrigger } from "../services/lookout-service.js";
import { eventKindForCrossref, recordSourceEvent } from "../services/source-facts-service.js";
import { expireItems, pollFeed, type FeedRow } from "../services/feed-service.js";

const FLAG_KEY = "lookout_retraction_poll";
/** First poll looks back this far; later polls resume from the mark. */
const INITIAL_LOOKBACK_DAYS = 30;
/** Never re-scan more than this, whatever the mark says (a long outage). */
const MAX_LOOKBACK_DAYS = 90;

export interface RetractionPollResult {
  skipped: boolean;
  notices: number;
  matchedSources: number;
  /** Source events this poll recorded for the first time. */
  sourceEvents: number;
  eventsQueued: number;
}

async function readMark(): Promise<{ since: Date; polledAt: Date | null }> {
  const [row] = await rawQuery<{ value: { since?: string; polled_at?: string } }>(
    `SELECT value FROM platform_flags WHERE key = $1`,
    [FLAG_KEY]
  );
  const now = Date.now();
  const floor = new Date(now - MAX_LOOKBACK_DAYS * 86_400_000);
  const since = row?.value?.since ? new Date(row.value.since) : new Date(now - INITIAL_LOOKBACK_DAYS * 86_400_000);
  return {
    since: since < floor ? floor : since,
    polledAt: row?.value?.polled_at ? new Date(row.value.polled_at) : null,
  };
}

async function writeMark(since: Date): Promise<void> {
  await rawQuery(
    `INSERT INTO platform_flags (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [FLAG_KEY, JSON.stringify({ since: since.toISOString(), polled_at: new Date().toISOString() })]
  );
}

/**
 * One retraction poll. Exported so tests and an operator can drive it;
 * `force` ignores the cadence (not the high-water mark).
 */
export async function retractionPollTick(
  opts: { now?: number; force?: boolean } = {}
): Promise<RetractionPollResult> {
  const config = loadConfig();
  const result: RetractionPollResult = {
    skipped: true, notices: 0, matchedSources: 0, sourceEvents: 0, eventsQueued: 0,
  };
  if (config.lookoutRetractionPollHours <= 0 && !opts.force) return result;

  const now = opts.now ?? Date.now();
  const { since, polledAt } = await readMark();
  if (!opts.force && polledAt && now - polledAt.getTime() < config.lookoutRetractionPollHours * 3_600_000) {
    return result;
  }
  result.skipped = false;

  // Overlap the window by a day: Crossref's update dates are day-grained.
  const from = new Date(since.getTime() - 86_400_000);
  const notices = await recentRetractions({
    since: from,
    types: ["retraction", "correction", "expression_of_concern"],
    rows: 200,
  });
  result.notices = notices.length;

  const dois = [...new Set(notices.flatMap((n) => n.retracted_dois))];
  const matches = dois.length > 0 ? await sourcesForDois(dois) : [];
  result.matchedSources = matches.length;
  // Beyond the claims that assert a matched source, the claims whose
  // recorded provenance runs through it (#507): a copy or another version
  // of the work, or a source that draws on it by a provenance edge.
  for (const m of matches) {
    const notice = notices.find((n) => n.retracted_dois.includes(m.doi));
    if (!notice) continue;
    const { recorded } = await recordSourceEvent({
      sourceId: m.source_id,
      kind: eventKindForCrossref(notice.type),
      occurredAt: notice.updated,
      noticeUrl: notice.notice_doi ? `https://doi.org/${notice.notice_doi}` : null,
      note: notice.title,
      detectedBy: "crossref_poll",
    });
    if (recorded) result.sourceEvents++;
  }

  // Waking lookouts is only worth the joins when one is watching.
  const [subscribed] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM lookouts l JOIN grants g ON g.id = l.grant_id
      WHERE l.status = 'active' AND g.status = 'active' AND l.triggers ? 'retraction'`
  );
  const watched = Number(subscribed?.n ?? 0) > 0;
  const resting = watched && matches.length > 0
    ? await claimsRestingOnSources(matches.map((m) => m.source_id))
    : [];

  for (const m of watched ? matches : []) {
    const through = resting.filter((r) => r.source_id === m.source_id);
    if (m.claim_ids.length === 0 && through.length === 0) continue;
    const notice = notices.find((n) => n.retracted_dois.includes(m.doi));
    // A lookout already holding an event for this notice is not handed it
    // again (the overlap window and a re-run would otherwise duplicate).
    const [dup] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM lookout_events
        WHERE kind = 'retraction' AND consumed_at IS NULL
          AND payload->>'notice_doi' = $1 AND payload->>'source_id' = $2`,
      [notice?.notice_doi ?? "", m.source_id]
    );
    if (Number(dup?.n ?? 0) > 0) continue;
    const { queued } = await queueLookoutEventsByTrigger({
      kind: "retraction",
      payload: {
        doi: m.doi,
        notice_doi: notice?.notice_doi ?? null,
        notice_type: notice?.type ?? "retraction",
        notice_title: notice?.title ?? null,
        notice_source: notice?.source ?? null,
        source_id: m.source_id,
        source_url: m.url,
        source_title: m.title,
        claim_ids: m.claim_ids.slice(0, 50),
        resting_claims: through.slice(0, 50).map((r) => ({
          claim_id: r.claim_id,
          via: r.via,
          through_source_id: r.through_source_id,
          through_source_title: r.through_source_title,
          relation_type: r.relation_type,
        })),
        note:
          `Crossref records a ${notice?.type ?? "retraction"} notice against a source ` +
          `in the graph. claim_ids assert it directly; resting_claims rest on it through ` +
          `recorded provenance (a copy or version of the work, or a source that draws on ` +
          `it). Check whether any of them should be looked at again.`,
      },
    });
    result.eventsQueued += queued;
  }

  await writeMark(new Date(now));
  return result;
}

/**
 * One feed poll tick (#305): poll every due feed of an active lookout on an
 * active mandate, at most `maxFeeds` of them, most overdue first, and
 * expire untriaged items past their retention. Each feed records its own
 * failures and backs off (feed-service pollFeed); one bad feed never stops
 * the rest. Polling is code: no ledger row, no model call. What it can
 * cause is a `feed` event on a lookout whose wake rule is met, or, for an
 * auto_ingest feed, ingest items on the mandate's plan.
 */
export async function feedPollTick(
  opts: { now?: Date; maxFeeds?: number } = {}
): Promise<FeedPollTickResult> {
  const config = loadConfig();
  const maxFeeds = opts.maxFeeds ?? config.lookoutFeedPollMaxFeeds;
  const result: FeedPollTickResult = { polled: 0, failed: 0, newItems: 0, autoIngested: 0, woke: 0, expired: 0 };
  if (maxFeeds <= 0) return result;
  const now = opts.now ?? new Date();
  const due = await rawQuery<FeedRow>(
    `SELECT f.id, f.lookout_id, f.url, f.site_url, f.title, f.status, f.wake, f.batch_size,
            f.max_wait_hours, f.min_wake_hours, f.poll_hours, f.retain_days,
            f.daily_ingest_cap, f.seeded_at, f.last_polled_at, f.next_poll_at,
            f.last_woke_at, f.consecutive_failures, f.last_error, f.created_by, f.created_at
       FROM lookout_feeds f
       JOIN lookouts l ON l.id = f.lookout_id
       JOIN grants g ON g.id = l.grant_id
      WHERE f.status = 'active' AND l.status = 'active' AND g.status = 'active'
        AND f.next_poll_at <= $1
      ORDER BY f.next_poll_at ASC
      LIMIT $2`,
    [now, maxFeeds]
  );
  for (const feed of due) {
    const r = await pollFeed(feed, { now }).catch((err) => ({
      ok: false, newItems: 0, autoIngested: 0, woke: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    result.polled++;
    if (!r.ok) result.failed++;
    result.newItems += r.newItems;
    result.autoIngested += r.autoIngested;
    if (r.woke) result.woke++;
  }
  // Feeds that are broken or removed, or whose lookout is paused, still
  // age their inbox.
  result.expired = await expireItems({ now });
  return result;
}

export interface FeedPollTickResult {
  polled: number;
  failed: number;
  newItems: number;
  autoIngested: number;
  woke: number;
  expired: number;
}

export function startLookoutTriggers(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const config = loadConfig();
  const retractions = config.lookoutRetractionPollHours > 0;
  const feeds = config.lookoutFeedPollMaxFeeds > 0;
  if (!retractions && !feeds && options.intervalMs === undefined) {
    options.logger.info(
      "Lookout triggers disabled (LOOKOUT_RETRACTION_POLL_HOURS=0, LOOKOUT_FEED_POLL_MAX_FEEDS=0)"
    );
    return { stop: () => {} };
  }
  // Check every quarter hour; the retraction poll's own mark and each
  // feed's next_poll_at decide what is actually due.
  const interval = options.intervalMs ?? 15 * 60_000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (retractions) {
        try {
          const r = await retractionPollTick();
          if (!r.skipped) {
            options.logger.info(
              `Lookout retraction poll: ${r.notices} notices, ${r.matchedSources} matched ` +
                `sources, ${r.sourceEvents} source events recorded, ${r.eventsQueued} events queued`
            );
          }
        } catch (err) {
          options.logger.error(
            "Lookout retraction poll error",
            err instanceof Error ? err.message : err
          );
        }
      }
      if (feeds) {
        try {
          const f = await feedPollTick();
          if (f.polled > 0 || f.expired > 0) {
            options.logger.info(
              `Lookout feed poll: ${f.polled} feeds (${f.failed} failed), ${f.newItems} new items, ` +
                `${f.woke} lookouts woken, ${f.autoIngested} auto-ingested, ${f.expired} expired`
            );
          }
        } catch (err) {
          options.logger.error("Lookout feed poll error", err instanceof Error ? err.message : err);
        }
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, interval);
  void tick();
  return { stop: () => clearInterval(timer) };
}
