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
 * fact its source page shows to every reader. And the first time a notice
 * is recorded, the Steward of every active node that asserts the source, or
 * rests on it through recorded provenance (a copy or version of the work,
 * or a source drawing on it), gets one `source_event` message naming the
 * notice and the path (services/source-notice-service.ts, which the facts
 * fetch's DOI check sends through too). A message spends nothing: the node
 * becomes a candidate, and whether its pass runs is the ledger's to decide,
 * as for any other message. The Steward decides what the notice means for
 * its node; a correction may change nothing.
 *
 * The poll itself is a scan, not a judgment: it does not decide which
 * lookout cares about which retraction (that is the lookout's, in the
 * brief's words), and it opens no ledger row directly. It reads the whole
 * window, oldest first, page by page (#686); a cap on pending events per
 * lookout and a persisted high-water mark (platform_flags) keep it from
 * re-queueing the same notices after a restart.
 *
 * Period-keyed and idempotent, so every task may run it: the high-water
 * mark is advanced to now only when the whole window was read, and
 * otherwise only as far as the notices actually read, so a failed page or
 * a very busy window is picked up by the next poll rather than skipped. A
 * lookout that already holds an event for a notice is not handed it twice.
 *
 * The second is the feed poll (#305, feedPollTick): every due feed of an
 * active lookout is fetched and its new items recorded in the lookout's
 * inbox; a feed whose wake rule is met queues one `feed` event, and an
 * auto_ingest feed raises its new items as valued candidate ingests
 * (services/feed-service.ts).
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import {
  claimsRestingOnSources,
  retractionNoticesSince,
  sourcesForDois,
  sourcesWithClaims,
} from "../services/source-watch-service.js";
import { queueLookoutEvent } from "../services/lookout-service.js";
import { runAtLabel } from "../llm/usage-context.js";
import { eventKindForCrossref, recordSourceEvent } from "../services/source-facts-service.js";
import {
  TOLD_NOTICE_TYPES,
  tellStewardsOfSourceEvents,
  type FreshSourceEvent,
} from "../services/source-notice-service.js";
import { expireItems, pollFeed, type FeedRow } from "../services/feed-service.js";
import { withSystemClearance } from "../db/clearance.js";

const FLAG_KEY = "lookout_retraction_poll";
/** First poll looks back this far; later polls resume from the mark. */
const INITIAL_LOOKBACK_DAYS = 30;
/** Never re-scan more than this, whatever the mark says (a long outage). */
const MAX_LOOKBACK_DAYS = 90;
/**
 * Crossref pages (of 1,000 notices) one poll reads before stopping. A poll
 * has to end; one that stops here advances its mark only as far as it read
 * and the next poll carries on from there, so nothing is skipped.
 */
const MAX_PAGES_PER_POLL = 20;
/** DOIs per join against the graph's sources, to keep each query small. */
const DOI_CHUNK = 500;

export interface RetractionPollResult {
  skipped: boolean;
  notices: number;
  /** False when the poll stopped before the end of its window (see the header). */
  complete: boolean;
  matchedSources: number;
  /** Source events this poll recorded for the first time. */
  sourceEvents: number;
  /** Steward messages sent about those events: one per node per notice. */
  stewardsTold: number;
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

/**
 * `polledAt` null leaves the cadence where it was, so a poll that stopped
 * before the end of its window carries on at the next tick.
 */
async function writeMark(since: Date, polledAt: Date | null): Promise<void> {
  await rawQuery(
    `INSERT INTO platform_flags (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [
      FLAG_KEY,
      JSON.stringify({ since: since.toISOString(), polled_at: polledAt?.toISOString() ?? null }),
    ]
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
    skipped: true, notices: 0, complete: true, matchedSources: 0, sourceEvents: 0, stewardsTold: 0, eventsQueued: 0,
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
  const window = await retractionNoticesSince({
    since: from,
    // The notices Stewards are told of: the list the facts fetch tells by too.
    types: [...TOLD_NOTICE_TYPES],
    maxPages: MAX_PAGES_PER_POLL,
  });
  const notices = window.notices;
  result.notices = notices.length;
  result.complete = window.complete;

  const dois = [...new Set(notices.flatMap((n) => n.retracted_dois))];
  const matches: Awaited<ReturnType<typeof sourcesForDois>> = [];
  for (let i = 0; i < dois.length; i += DOI_CHUNK) {
    matches.push(...(await sourcesForDois(dois.slice(i, i + DOI_CHUNK))));
  }
  result.matchedSources = matches.length;
  // Beyond the claims that assert a matched source, the claims whose
  // recorded provenance runs through it (#507): a copy or another version
  // of the work, or a source that draws on it by a provenance edge.
  const fresh: FreshSourceEvent[] = [];
  for (const m of matches) {
    const notice = notices.find((n) => n.retracted_dois.includes(m.doi));
    if (!notice) continue;
    // Each event is written at the label of the source the notice is
    // against, by recordSourceEvent itself: a notice against a restricted
    // document says the graph holds it, and is not written as public.
    const { recorded } = await recordSourceEvent({
      sourceId: m.source_id,
      kind: eventKindForCrossref(notice.type),
      occurredAt: notice.updated,
      noticeUrl: notice.notice_doi ? `https://doi.org/${notice.notice_doi}` : null,
      note: notice.title,
      detectedBy: "crossref_poll",
    });
    if (recorded) {
      result.sourceEvents++;
      fresh.push({ source: m, notice });
    }
  }

  // Stewards are told of a fresh event. The poll has every label in sight,
  // so who might be told is found here, and what each is told is read again
  // at that node's own label (tellStewardsOfSourceEvents).
  const resting = fresh.length > 0 ? await claimsRestingOnSources(fresh.map((f) => f.source.source_id)) : [];
  result.stewardsTold = await tellStewardsOfSourceEvents(fresh, resting);

  // Lookouts that watch for retractions. Each is handed the matched sources
  // its own label reads, with the nodes its label reads on them, and
  // nothing of the others: its input is put together at its label, from
  // what the database shows a connection at that label (db/clearance.ts).
  // A lookout whose label reads none of the matched sources is not told.
  const noticeFor = new Map<string, { doi: string; notice: (typeof notices)[number] }>();
  for (const m of matches) {
    const notice = notices.find((n) => n.retracted_dois.includes(m.doi));
    if (notice) noticeFor.set(m.source_id, { doi: m.doi, notice });
  }
  const subscribers = noticeFor.size > 0
    ? await rawQuery<{ id: string; sensitivity_label: string }>(
        `SELECT l.id, l.sensitivity_label FROM lookouts l JOIN grants g ON g.id = l.grant_id
          WHERE l.status = 'active' AND g.status = 'active' AND l.triggers ? 'retraction'`
      )
    : [];
  for (const lookout of subscribers) {
    result.eventsQueued += await runAtLabel(lookout.sensitivity_label, `lookout ${lookout.id}`, () =>
      queueRetractionsFor(lookout.id, noticeFor)
    );
  }

  // Read to the end: the next window starts now, after the usual cadence.
  // Stopped early: it starts from the newest notice read, and the cadence
  // is left as it was so the next tick carries on. Read nothing: the mark
  // stays and the next tick tries again.
  if (window.complete) await writeMark(new Date(now), new Date(now));
  else if (window.readThrough) await writeMark(window.readThrough, polledAt);
  return result;
}

/** Unconsumed events a lookout may hold before further ones are dropped. */
const MAX_PENDING_EVENTS = 50;

/**
 * Queue one lookout's retraction events, at its label: one for each matched
 * source it reads that a node it reads has a passage from or rests on. The
 * sources and the nodes are read here, so the payload holds what this
 * lookout's label reads and nothing else. A lookout already holding an
 * event for a notice is not handed it again (the overlap window and a
 * re-run would otherwise duplicate), and a full queue takes no more.
 */
async function queueRetractionsFor(
  lookoutId: string,
  noticeFor: Map<string, { doi: string; notice: Awaited<ReturnType<typeof retractionNoticesSince>>["notices"][number] }>
): Promise<number> {
  const sources = await sourcesWithClaims([...noticeFor.keys()]);
  if (sources.length === 0) return 0;
  const resting = await claimsRestingOnSources(sources.map((m) => m.source_id));
  let queued = 0;
  for (const m of sources) {
    const through = resting.filter((r) => r.source_id === m.source_id);
    if (m.claim_ids.length === 0 && through.length === 0) continue;
    const { doi, notice } = noticeFor.get(m.source_id)!;
    const [held] = await rawQuery<{ dup: number; pending: number }>(
      `SELECT COUNT(*) FILTER (WHERE kind = 'retraction' AND payload->>'notice_doi' = $2
                                 AND payload->>'source_id' = $3)::int AS dup,
              COUNT(*)::int AS pending
         FROM lookout_events
        WHERE lookout_id = $1 AND consumed_at IS NULL`,
      [lookoutId, notice.notice_doi ?? "", m.source_id]
    );
    if (Number(held?.dup ?? 0) > 0 || Number(held?.pending ?? 0) >= MAX_PENDING_EVENTS) continue;
    const res = await queueLookoutEvent({
      lookoutId,
      kind: "retraction",
      payload: {
        doi,
        notice_doi: notice.notice_doi ?? null,
        notice_type: notice.type ?? "retraction",
        notice_title: notice.title ?? null,
        notice_source: notice.source ?? null,
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
          `Crossref records a ${notice.type ?? "retraction"} notice against a source ` +
          `in the graph. claim_ids assert it directly; resting_claims rest on it through ` +
          `recorded provenance (a copy or version of the work, or a source that draws on ` +
          `it). Check whether any of them should be looked at again.`,
      },
    });
    if (res.queued) queued++;
  }
  return queued;
}

/**
 * One feed poll tick (#305): poll every due feed of an active lookout on an
 * active mandate, at most `maxFeeds` of them, most overdue first, and
 * expire untriaged items past their retention. Each feed records its own
 * failures and backs off (feed-service pollFeed); one bad feed never stops
 * the rest. Polling is code: no ledger row, no model call. What it can
 * cause is a `feed` event on a lookout whose wake rule is met, or, for an
 * auto_ingest feed, candidate ingests valued at the lookout's ceiling.
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
            f.ingest_focus, f.seeded_at, f.last_polled_at, f.next_poll_at,
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
          const r = await withSystemClearance(
            "The retraction poll matches notices against sources at every label and queues each lookout's input at that lookout's label.",
            () => retractionPollTick()
          );
          if (!r.skipped) {
            options.logger.info(
              `Lookout retraction poll: ${r.notices} notices, ${r.matchedSources} matched ` +
                `sources, ${r.sourceEvents} source events recorded, ${r.eventsQueued} events queued` +
                (r.complete ? "" : " (window not finished; the next tick carries on)")
            );
          }
        } catch (err) {
          options.logger.error(
            "Lookout retraction poll error",
            err instanceof Error ? err.message : err
          );
        }
      }
      try {
        const g = await withSystemClearance(
          "The graph feed wakes every lookout that watches the graph, whatever its label; each then runs at its own.",
          () => graphFeedTick()
        );
        if (g.woke > 0) options.logger.info(`Lookout graph feed: ${g.woke} lookouts woken`);
      } catch (err) {
        options.logger.error("Lookout graph feed error", err instanceof Error ? err.message : err);
      }
      if (feeds) {
        try {
          const f = await withSystemClearance(
            "The feed poll finds every due feed, whatever its lookout's label, and polls each at that label.",
            () => feedPollTick()
          );
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

/**
 * The graph feed: wake each active lookout that follows the change stream
 * when its territory has entries it hasn't read. Code, not judgment: it
 * queues one `graph` event and the lookout decides what matters. A lookout
 * that ran in the last 15 minutes waits, so a burst of changes is read
 * together rather than one run per change.
 */
export async function graphFeedTick(): Promise<{ woke: number }> {
  const { listGraphChanges, GRAPH_CHANGE_KINDS } = await import("../services/graph-change-service.js");
  const rows = await rawQuery<{
    id: string;
    changes_cursor: string | null;
    last_run_at: Date | null;
    territory_claim_ids: string[];
    territory_tag_ids: string[];
    sensitivity_label: string;
  }>(
    `SELECT l.id, l.changes_cursor, l.last_run_at, l.territory_claim_ids, l.territory_tag_ids, l.sensitivity_label
       FROM lookouts l JOIN grants g ON g.id = l.grant_id
      WHERE l.status = 'active' AND g.status = 'active'
        AND l.triggers ? 'graph'
        AND (l.last_run_at IS NULL OR l.last_run_at < now() - interval '15 minutes')
        AND NOT EXISTS (SELECT 1 FROM lookout_events e
                         WHERE e.lookout_id = l.id AND e.kind = 'graph' AND e.consumed_at IS NULL)
      LIMIT 200`
  );
  let woke = 0;
  for (const l of rows) {
    // Whether there is anything for this lookout is asked at its own label:
    // a change it does not read is not one it can be woken for. Its run
    // could not read that change, so it would move no cursor past it and be
    // woken for it again at every tick. The wake is queued at its label too.
    const queued = await runAtLabel(l.sensitivity_label, `lookout ${l.id}`, async () => {
      const page = await listGraphChanges({
        after: l.changes_cursor,
        since: l.changes_cursor ? null : l.last_run_at ?? new Date(Date.now() - 86_400_000),
        scope: { under: l.territory_claim_ids ?? [], tagIds: l.territory_tag_ids ?? [] },
        kinds: [...GRAPH_CHANGE_KINDS],
        limit: 1,
      });
      if (page.changes.length === 0) return false;
      const q = await queueLookoutEvent({ lookoutId: l.id, kind: "graph", payload: { first_change: page.changes[0]!.kind } });
      return q.queued;
    });
    if (queued) woke++;
  }
  return { woke };
}
