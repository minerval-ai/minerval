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
 * a retraction, correction or expression of concern is recorded, by either
 * watcher, the Steward of every active node that has the source attached,
 * or rests on it through recorded provenance (a copy or version of the
 * work, or a source drawing on it), gets one `source_event` message naming
 * the notice and the path.
 *
 * A message spends nothing (enqueueSteward): the node becomes a candidate
 * with the message in its inbox, and whether its pass runs is for whoever
 * commissions it, as for any other message. The Steward decides what the
 * notice means for its node; a correction may change nothing.
 */
import { rawQuery } from "../db/client.js";
import { getUsageContext, runAtLabel } from "../llm/usage-context.js";
import { enqueueSteward } from "./queue-service.js";
import { runAtClaimLabel } from "./label-service.js";
import { claimsRestingOnSources, sourcesWithClaims, type RestingClaim } from "./source-watch-service.js";

/**
 * The notices a Steward is told of, as Crossref types them (its
 * `update-type`). The one list both watchers read: the Crossref poll asks
 * for exactly these (workers/lookout-triggers.ts), and the facts fetch,
 * whose DOI check returns every notice against a work, tells of these and
 * no others (isToldNoticeType).
 *
 * Why not every notice a watcher records: a prompt leaves each node resting
 * on the source pending, with open rows nobody has paid for, and the other
 * kinds are common and seldom bear on a verdict. A new version of a
 * preprint is the usual case, and would do that to every node citing it
 * each time one is first seen. Those notices are still recorded on the
 * source, shown on its page and in the document's first window, and counted
 * by `since_assessed`: that is the record, and this is the prompt. Crossref
 * also files some corrections and retractions under other types (erratum,
 * corrigendum, withdrawal). They are recorded as corrections and
 * retractions, and neither watcher tells of them: the poll does not ask
 * for them.
 */
export const TOLD_NOTICE_TYPES = ["retraction", "correction", "expression_of_concern"] as const;

/** Whether a notice of this Crossref type is one a Steward is told of. */
export function isToldNoticeType(type: string | null | undefined): boolean {
  const t = (type ?? "").toLowerCase().replace(/-/g, "_");
  return (TOLD_NOTICE_TYPES as readonly string[]).includes(t);
}

/** A source a notice was recorded against, with the active nodes that have it attached. */
export interface NoticedSource {
  source_id: string;
  url: string | null;
  title: string | null;
  claim_ids: string[];
}

/** The notice as Crossref gives it. */
export interface SourceNotice {
  /** Crossref's update type; one of TOLD_NOTICE_TYPES for a notice that is told. */
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
 *
 * Whoever calls this may have found the sources and the nodes with more in
 * sight than a node's own label reads: the Crossref poll sees every label.
 * So `fresh` and `resting` only say which nodes might be told. What a
 * letter says is read again at the node's own label (pathsSeenFrom): it
 * names a document only where the node's label reads the document and the
 * passage or the edge that ties the node to it. A node tied to a document
 * only by rows its label does not read is not told. Its label could not
 * open the document the letter would point at, and the letter would say
 * that the graph holds it.
 */
export async function tellStewardsOfSourceEvents(
  fresh: FreshSourceEvent[],
  resting: RestingClaim[]
): Promise<number> {
  const letters = new Map<string, { claimId: string; notice: SourceNotice; sourceIds: string[] }>();
  const add = (claimId: string, notice: SourceNotice, sourceId: string) => {
    const which = notice.notice_doi || notice.title || `${notice.type ?? ""}:${notice.updated ?? ""}`;
    const key = `${which}|${claimId}`;
    const letter = letters.get(key) ?? { claimId, notice, sourceIds: [] };
    if (!letter.sourceIds.includes(sourceId)) letter.sourceIds.push(sourceId);
    letters.set(key, letter);
  };
  for (const { source: m, notice } of fresh) {
    for (const claimId of m.claim_ids) add(claimId, notice, m.source_id);
    for (const r of resting.filter((x) => x.source_id === m.source_id)) add(r.claim_id, notice, m.source_id);
  }

  // The event names the document, so it is recorded at the document's own
  // label, whoever found the notice (the poll sees every label), and names
  // the nodes that label reads the document on. A subscriber is told of it
  // only where its label reads that label (subscription-router.ts).
  const { recordEvent } = await import("./event-service.js");
  for (const { source: m, notice } of fresh) {
    const [at] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM sources WHERE id = $1`, [m.source_id]);
    if (!at) continue;
    await runAtLabel(at.label, `source ${m.source_id}`, async () => {
      const readable = await rawQuery<{ id: string }>(
        `SELECT DISTINCT i.claim_id AS id FROM claim_instances i
          WHERE i.source_id = $2 AND i.claim_id = ANY($1::uuid[])`,
        [m.claim_ids, m.source_id]
      );
      await recordEvent({
        kind: "source_event",
        sourceId: m.source_id,
        refs: { claims: readable.map((r) => r.id), notice_doi: notice.notice_doi ?? null },
        summary: `A ${(notice.type ?? "retraction").toLowerCase()} notice was recorded against "${m.title || m.url}" (${m.url}).`,
        payload: { notice },
      });
    }).catch((err) => console.error(`[source-notice] recording the event for ${m.source_id} failed:`, err instanceof Error ? err.message : err));
  }

  let told = 0;
  for (const { claimId, notice, sourceIds } of letters.values()) {
    const kind = (notice.type ?? "retraction").toLowerCase().replace(/[_-]/g, " ");
    const article = /^[aeiou]/i.test(kind) ? "an" : "a";
    const when = notice.updated ? ` dated ${notice.updated.slice(0, 10)}` : "";
    const where = notice.notice_doi ? ` The notice: https://doi.org/${notice.notice_doi}.` : "";
    const title = notice.title ? ` ("${notice.title}")` : "";
    const context = (paths: string[]) =>
      `Crossref records ${article} ${kind} notice${title}${when} against a document this ` +
      `node rests on.${where}\n\n` +
      paths.map((p) => `- ${p}`).join("\n") +
      `\n\nOpen the document with provenance_read_source: its first window lists ` +
      `the event. Decide what it means for your reading of the source and for ` +
      `your assessment. A correction may change nothing, and a notice against a ` +
      `source your verdict does not rest on may not either; say which in your ` +
      `reasoning.`;
    try {
      // Each letter is sent at its node's label (runAtClaimLabel), whoever
      // found the notice: the Crossref poll, which runs outside any run, or
      // a facts fetch, which may be inside the run of some other node's
      // Steward. The letter is the same whichever of them recorded the
      // notice, and it is sent once, so one sent at the label of the run
      // that happened to fetch the document first would not reach a node
      // that run's label does not cover (src/labels.ts). The letter names
      // the source, whose event was recorded at the source's own label; a
      // node and a source it rests on may carry different labels, so how
      // the notice reaches the node is read here, at the node's label.
      const sent = await runAtClaimLabel(claimId, async () => {
        const paths = await pathsSeenFrom(claimId, sourceIds);
        if (paths.length === 0) return false;
        await enqueueSteward({ claimId, trigger: "source_event", context: context(paths) });
        return true;
      });
      if (sent) told++;
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
 * How a notice against these sources reaches a node, as the work in
 * progress reads it: one sentence for each source the node has a passage
 * from, and one for each it rests on through recorded provenance. A source,
 * a passage or an edge this work does not read gives no sentence.
 */
async function pathsSeenFrom(claimId: string, sourceIds: string[]): Promise<string[]> {
  const sources = await sourcesWithClaims(sourceIds);
  const resting = (await claimsRestingOnSources(sourceIds)).filter((r) => r.claim_id === claimId);
  const paths: string[] = [];
  const add = (path: string) => {
    if (!paths.includes(path)) paths.push(path);
  };
  for (const m of sources) {
    const named = `"${m.title || m.url}" (${m.url})`;
    if (m.claim_ids.includes(claimId)) add(`${named} is one of this node's sources.`);
    for (const r of resting.filter((x) => x.source_id === m.source_id)) {
      add(
        r.via === "copy_or_version"
          ? `"${r.through_source_title}", one of this node's sources, is a copy or another version of ${named}.`
          : `"${r.through_source_title}", one of this node's sources, draws on ${named}` +
              (r.relation_type ? ` (recorded as ${r.relation_type}).` : ".")
      );
    }
  }
  return paths;
}

/**
 * The node whose Steward is running now, if this is called from inside a
 * Steward's own run (the run sets the agent and its node on the usage
 * context, llm/agents/claim-steward.ts). Null anywhere else, including a
 * researcher the Steward launched: its reads are not the Steward's.
 */
function nodeOfRunningSteward(): string | null {
  const ctx = getUsageContext();
  return ctx.agent === "steward" && ctx.claimId ? ctx.claimId : null;
}

/**
 * The same, for notices the facts fetch freshly recorded against one
 * source: the nodes are looked up here. The join is the Crossref poll's
 * (source-watch-service sourcesForDois): active nodes with a live instance
 * on the source, then the nodes resting on it through recorded provenance.
 * Notices of a type outside TOLD_NOTICE_TYPES are left out.
 *
 * One node is skipped: the node whose Steward is reading the document right
 * now. The facts fetch runs inside a Steward's run only when its own
 * provenance_read_source fetches the document for the first time, and the
 * result of that read lists the source's events (provenance-tools.ts,
 * executeReadSource: the facts come with the first window and with any read
 * that fetched). So the notice is in what it just read, before it writes
 * its judgment, and a message would only leave the node pending again for a
 * pass with nothing new to weigh. Every other node is told as usual.
 */
export async function tellStewardsOfNoticesOn(
  sourceId: string,
  recorded: SourceNotice[]
): Promise<number> {
  const notices = recorded.filter((n) => isToldNoticeType(n.type));
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
  const reading = nodeOfRunningSteward();
  source.claim_ids = source.claim_ids.filter((id) => id !== reading);
  const resting = (await claimsRestingOnSources([sourceId])).filter((r) => r.claim_id !== reading);
  if (source.claim_ids.length === 0 && resting.length === 0) return 0;
  return tellStewardsOfSourceEvents(
    notices.map((notice) => ({ source, notice })),
    resting
  );
}
