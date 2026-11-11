/**
 * Telling Stewards what happened to a document (#507, #566).
 *
 * A watcher records a notice against a source as a dated `source_events`
 * row (source-facts-service.ts, recordSourceEvent). Two watchers do: the
 * Crossref poll (workers/lookout-triggers.ts), which finds notices added
 * since its last run, and the facts fetch (refreshSourceFacts), which asks
 * Crossref about a document's DOI when the document is first fetched. A
 * judgment made against the source before the notice was recorded reads as
 * out of date from then on (judgment-inputs-service.ts, `source_events`).
 *
 * This module is what makes the same fact a reason to look: the first time
 * a notice is recorded, by either watcher, the Steward of every active node
 * that has the source attached, or rests on it through recorded provenance
 * (a copy or version of the work, or a source drawing on it), gets one
 * `source_event` message naming the notice and the path.
 *
 * A message spends nothing (enqueueSteward): the node becomes a candidate
 * with the message in its inbox, and whether its pass runs is for whoever
 * commissions it, as for any other message. The Steward decides what the
 * notice means for its node; a correction may change nothing.
 */
import { rawQuery } from "../db/client.js";
import { enqueueSteward } from "./queue-service.js";
import { claimsRestingOnSources, type RestingClaim } from "./source-watch-service.js";

/** A source a notice was recorded against, with the active nodes that have it attached. */
export interface NoticedSource {
  source_id: string;
  url: string | null;
  title: string | null;
  claim_ids: string[];
}

/** The notice as Crossref gives it. */
export interface SourceNotice {
  /** Crossref's update type: retraction, correction, expression_of_concern, new_version, ... */
  type: string | null;
  title: string | null;
  updated: string | null;
  notice_doi: string | null;
}

export interface FreshSourceEvent {
  source: NoticedSource;
  notice: SourceNotice;
}

/**
 * Tell the Steward of every active node that has a source with a freshly
 * recorded notice attached, or rests on it through recorded provenance,
 * what happened and how the notice reaches the node: one message per node
 * per notice, however many of its sources the notice touches. Pass only
 * events recorded for the first time, so a watcher that sees a notice again
 * never repeats a message. One failed send is logged and the rest still go,
 * since the event is already recorded and will not come round again.
 * Returns how many messages were sent.
 */
export async function tellStewardsOfSourceEvents(
  fresh: FreshSourceEvent[],
  resting: RestingClaim[]
): Promise<number> {
  const letters = new Map<string, { claimId: string; notice: SourceNotice; paths: string[] }>();
  const add = (claimId: string, notice: SourceNotice, path: string) => {
    const which = notice.notice_doi || notice.title || `${notice.type ?? ""}:${notice.updated ?? ""}`;
    const key = `${which}|${claimId}`;
    const letter = letters.get(key) ?? { claimId, notice, paths: [] };
    if (!letter.paths.includes(path)) letter.paths.push(path);
    letters.set(key, letter);
  };
  for (const { source: m, notice } of fresh) {
    const named = `"${m.title || m.url}" (${m.url})`;
    for (const claimId of m.claim_ids) {
      add(claimId, notice, `${named} is one of this node's sources.`);
    }
    for (const r of resting.filter((x) => x.source_id === m.source_id)) {
      add(
        r.claim_id,
        notice,
        r.via === "copy_or_version"
          ? `"${r.through_source_title}", one of this node's sources, is a copy or another version of ${named}.`
          : `"${r.through_source_title}", one of this node's sources, draws on ${named}` +
              (r.relation_type ? ` (recorded as ${r.relation_type}).` : ".")
      );
    }
  }

  let told = 0;
  for (const { claimId, notice, paths } of letters.values()) {
    const kind = (notice.type ?? "retraction").replace(/_/g, " ");
    const article = /^[aeiou]/i.test(kind) ? "an" : "a";
    const when = notice.updated ? ` dated ${notice.updated.slice(0, 10)}` : "";
    const where = notice.notice_doi ? ` The notice: https://doi.org/${notice.notice_doi}.` : "";
    const title = notice.title ? ` ("${notice.title}")` : "";
    const context =
      `Crossref records ${article} ${kind} notice${title}${when} against a document this ` +
      `node rests on.${where}\n\n` +
      paths.map((p) => `- ${p}`).join("\n") +
      `\n\nOpen the document with provenance_read_source: its first window lists ` +
      `the event. Decide what it means for your reading of the source and for ` +
      `your assessment. A correction may change nothing, and a notice against a ` +
      `source your verdict does not rest on may not either; say which in your ` +
      `reasoning.`;
    try {
      await enqueueSteward({ claimId, trigger: "source_event", context });
      told++;
    } catch (err) {
      console.warn(
        `[source-notice] could not tell the Steward of ${claimId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return told;
}

/**
 * The same, for notices freshly recorded against one source: the nodes are
 * looked up here. The join is the Crossref poll's (source-watch-service
 * sourcesForDois): active nodes with a live instance on the source, then
 * the nodes resting on it through recorded provenance.
 */
export async function tellStewardsOfNoticesOn(
  sourceId: string,
  notices: SourceNotice[]
): Promise<number> {
  if (notices.length === 0) return 0;
  const [source] = await rawQuery<NoticedSource>(
    `SELECT s.id AS source_id, s.url, s.title,
            COALESCE(array_agg(DISTINCT ci.claim_id) FILTER (WHERE c.id IS NOT NULL), '{}') AS claim_ids
       FROM sources s
       LEFT JOIN claim_instances ci ON ci.source_id = s.id AND ci.detached_at IS NULL
       LEFT JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
      WHERE s.id = $1
      GROUP BY s.id`,
    [sourceId]
  );
  if (!source) return 0;
  const resting = await claimsRestingOnSources([sourceId]);
  if (source.claim_ids.length === 0 && resting.length === 0) return 0;
  return tellStewardsOfSourceEvents(
    notices.map((notice) => ({ source, notice })),
    resting
  );
}
