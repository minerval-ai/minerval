/**
 * A source in the graph as a whole (#507): the source page's Lineage,
 * Prominence, and History. The claim page reads provenance one claim at a
 * time; these read it across every claim a document bears on.
 *
 * - Lineage: the documents this one draws on and the documents that draw on
 *   it, each with how (relation and fidelity) and on how many claims, plus
 *   its copies and other versions.
 * - Prominence: what the record shows about how much this document matters.
 *   Reach (republications), structure (where it stands in each claim's
 *   story), and evidence (what the claims' Stewards found on reading it, and
 *   which of them cite examinations of it). Numbers are given as they are:
 *   inputs to a reader's judgment and the Stewards', never a verdict, and
 *   nothing here moves any claim's status.
 * - Reviews: what has been asked and done about the document as a whole
 *   (#865): the reviews of it for its own sake, with what each covered, the
 *   examinations commissioned for a claim, and the requests bearing on it.
 *   What an agent weighs, with the rest of this, in deciding whether a
 *   review is worth asking for; there is no threshold.
 * - History: a dated log of what has been done to and about the document.
 */
import { oneReadingForInstanceSql } from "./layer-service.js";
import { rawQuery } from "../db/client.js";
import { getProvenanceStory } from "./provenance-story-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cards shown per direction before the rest is summarized by kind. */
const LINEAGE_CARDS = 12;
/** Claims read for the structure figures; beyond this the figures say they are partial. */
const STRUCTURE_CLAIMS = 200;
const HISTORY_LIMIT = 200;

export interface LineageRelation {
  relation_type: string;
  fidelity: string;
  claims: number;
}

export interface LineageEntry {
  source: { id: string; title: string; url: string | null; source_type: string; published_date: string | null };
  relations: LineageRelation[];
  /** Distinct claims on which the relation is recorded. */
  claims: number;
  /** One of the relations departs from what the upstream document supports. */
  diverges: boolean;
}

export interface LineageSummary {
  source_type: string;
  sources: number;
  /** Count of edges by fidelity across the summarized sources. */
  fidelity: Record<string, number>;
}

export interface SourceLineage {
  draws_on: { total: number; entries: LineageEntry[]; rest: LineageSummary[] };
  drawn_on_by: { total: number; entries: LineageEntry[]; rest: LineageSummary[] };
}

export interface SourceProminence {
  reach: {
    /** Republished copies, following copies of copies. */
    copies: number;
    /** Copies made directly from this document. */
    direct_copies: number;
  };
  structure: {
    /** Active claims whose map this document is in. */
    claims: number;
    /** Of those read, the claims where it is an origin, and on whose say-so. */
    origin_on: number;
    origin_by_steward: number;
    /** Claims where it is drawn on without stating the claim. */
    underlying_on: number;
    /** Sources resting on it, directly or not, summed over the claims read. */
    downstream: number;
    /** Claims read for these figures; less than `claims` for a very widely used document. */
    claims_read: number;
  };
  evidence: {
    /** Readings of this document's instances, by what the Steward found. */
    readings_by_support: Record<string, number>;
    /** Readings made from the whole document rather than the excerpt. */
    read_whole: number;
    /** Claims whose readings cite a finding from an examination of it. */
    claims_citing_findings: number;
    /** The Stewards' own words on it, most recent first. */
    notes: Array<{ claim: { id: string; text: string }; support: string; note: string; read_at: string }>;
  };
}

export interface SourceHistoryEntry {
  at: string;
  /** What happened: retrieved, facts, segmented, event, reading, examination, finding, audit_note, citation, watch. */
  kind: string;
  /** Who did it: an agent key, or a watcher. */
  by: string;
  text: string;
  claim: { id: string; text: string } | null;
}

export interface SourceReviews {
  /** Reviews of the document for its own sake, oldest first. */
  document_reviews: Array<{
    examination_id: string;
    created_at: string;
    /** The request it was asked for in, where one was. */
    request: { id: string; ask: string; state: string } | null;
    facets: string[];
    /** Segments examined for at least one facet. */
    segments_covered: number;
    findings: number;
  }>;
  /** Examinations commissioned while assessing a claim. */
  claim_examinations: number;
  /** The parts the document is divided into, for reading coverage against; 0 when undivided. */
  segments: number;
  /** Requests bearing on the document, live first, then newest. */
  requests: Array<{ id: string; ask: string; state: string; filed_at: string; live: boolean }>;
}

export interface SourceContext {
  lineage: SourceLineage;
  prominence: SourceProminence;
  reviews: SourceReviews;
  history: SourceHistoryEntry[];
}

const DIVERGENT = new Set(["strengthened", "weakened", "distorted", "misattributed"]);

interface EdgeRow {
  other_id: string;
  title: string;
  url: string | null;
  source_type: string;
  published_date: string | null;
  relation_type: string;
  fidelity: string;
  claim_id: string;
}

function lineageSide(rows: EdgeRow[]): SourceLineage["draws_on"] {
  const bySource = new Map<string, { row: EdgeRow; rel: Map<string, Set<string>>; claims: Set<string> }>();
  for (const r of rows) {
    const entry = bySource.get(r.other_id) ?? { row: r, rel: new Map(), claims: new Set<string>() };
    const key = `${r.relation_type}|${r.fidelity}`;
    const set = entry.rel.get(key) ?? new Set<string>();
    set.add(r.claim_id);
    entry.rel.set(key, set);
    entry.claims.add(r.claim_id);
    bySource.set(r.other_id, entry);
  }
  const entries: LineageEntry[] = [...bySource.values()].map(({ row, rel, claims }) => {
    const relations = [...rel.entries()]
      .map(([key, set]) => {
        const [relation_type, fidelity] = key.split("|") as [string, string];
        return { relation_type, fidelity, claims: set.size };
      })
      .sort((a, b) => b.claims - a.claims);
    return {
      source: {
        id: row.other_id,
        title: row.title,
        url: row.url,
        source_type: row.source_type,
        published_date: row.published_date,
      },
      relations,
      claims: claims.size,
      diverges: relations.some((r) => DIVERGENT.has(r.fidelity)),
    };
  });
  // Divergence first, then the documents that bear on the most claims.
  entries.sort(
    (a, b) =>
      Number(b.diverges) - Number(a.diverges) ||
      b.claims - a.claims ||
      a.source.title.localeCompare(b.source.title)
  );
  const shown = entries.slice(0, LINEAGE_CARDS);
  const restByKind = new Map<string, LineageSummary>();
  for (const e of entries.slice(LINEAGE_CARDS)) {
    const kind = e.source.source_type;
    const summary = restByKind.get(kind) ?? { source_type: kind, sources: 0, fidelity: {} };
    summary.sources++;
    for (const r of e.relations) summary.fidelity[r.fidelity] = (summary.fidelity[r.fidelity] ?? 0) + 1;
    restByKind.set(kind, summary);
  }
  return {
    total: entries.length,
    entries: shown,
    rest: [...restByKind.values()].sort((a, b) => b.sources - a.sources),
  };
}

/** The documents this one draws on and the documents that draw on it, across every active claim. */
export async function getSourceLineage(sourceId: string): Promise<SourceLineage> {
  const [up, down] = await Promise.all([
    rawQuery<EdgeRow>(
      `SELECT t.id AS other_id, t.title, t.url, t.source_type, t.published_date,
              e.relation_type, e.fidelity, ci.claim_id
         FROM claim_provenance_edges e
         JOIN claim_instances ci ON ci.id = e.from_instance_id AND ci.detached_at IS NULL
         JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
         JOIN sources t ON t.id = e.to_source_id
        WHERE ci.source_id = $1`,
      [sourceId]
    ),
    rawQuery<EdgeRow>(
      `SELECT f.id AS other_id, f.title, f.url, f.source_type, f.published_date,
              e.relation_type, e.fidelity, ci.claim_id
         FROM claim_provenance_edges e
         JOIN claim_instances ci ON ci.id = e.from_instance_id AND ci.detached_at IS NULL
         JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
         JOIN sources f ON f.id = ci.source_id
        WHERE e.to_source_id = $1`,
      [sourceId]
    ),
  ]);
  return { draws_on: lineageSide(up), drawn_on_by: lineageSide(down) };
}

/** What the record shows about how much this document matters, across the graph. */
export async function getSourceProminence(sourceId: string): Promise<SourceProminence> {
  const [reach] = await rawQuery<{ copies: string; direct_copies: string }>(
    `WITH RECURSIVE copies AS (
       SELECT child_source_id AS id, 1 AS depth FROM source_relationships
        WHERE parent_source_id = $1 AND relation_type = 'republishes'
       UNION
       SELECT sr.child_source_id, c.depth + 1 FROM source_relationships sr
         JOIN copies c ON sr.parent_source_id = c.id
        WHERE sr.relation_type = 'republishes' AND c.depth < 10
     )
     SELECT (SELECT COUNT(DISTINCT id) FROM copies WHERE id <> $1) AS copies,
            (SELECT COUNT(DISTINCT id) FROM copies WHERE depth = 1) AS direct_copies`,
    [sourceId]
  );

  const claimRows = await rawQuery<{ claim_id: string }>(
    `SELECT DISTINCT claim_id FROM (
       SELECT ci.claim_id FROM claim_instances ci
        WHERE ci.source_id = $1 AND ci.detached_at IS NULL
       UNION
       SELECT ci.claim_id FROM claim_provenance_edges e
         JOIN claim_instances ci ON ci.id = e.from_instance_id
        WHERE e.to_source_id = $1 AND ci.detached_at IS NULL
     ) x JOIN claims c ON c.id = x.claim_id AND c.state = 'active'`,
    [sourceId]
  );
  const read = claimRows.slice(0, STRUCTURE_CLAIMS);
  let originOn = 0;
  let originBySteward = 0;
  let underlyingOn = 0;
  let downstream = 0;
  for (const { claim_id } of read) {
    const story = await getProvenanceStory(claim_id);
    const node = story.nodes.find((n) => n.source.id === sourceId);
    if (!node) continue;
    if (node.standing === "origin") {
      originOn++;
      if (node.basis === "steward") originBySteward++;
    }
    if (node.underlying) underlyingOn++;
    downstream += node.downstream_total;
  }

  const [readings, citing, notes] = await Promise.all([
    rawQuery<{ support: string; n: string; whole: string }>(
      `SELECT r.support, COUNT(*) AS n, COUNT(*) FILTER (WHERE r.source_read) AS whole
         FROM claim_instance_readings r
         JOIN claim_instances ci ON ci.id = r.instance_id AND ci.detached_at IS NULL
         JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
        WHERE ci.source_id = $1${oneReadingForInstanceSql("r")}
        GROUP BY r.support`,
      [sourceId]
    ),
    rawQuery<{ n: string }>(
      `SELECT COUNT(DISTINCT ci.claim_id) AS n
         FROM reading_citations rc
         JOIN examination_findings f ON f.id = rc.finding_id
         JOIN examinations x ON x.id = f.examination_id
         JOIN claim_instance_readings r ON r.id = rc.reading_id
         JOIN claim_instances ci ON ci.id = r.instance_id AND ci.detached_at IS NULL
         JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
        WHERE x.source_id = $1`,
      [sourceId]
    ),
    rawQuery<{ claim_id: string; claim_text: string; support: string; note: string; updated_at: Date }>(
      `SELECT ci.claim_id, c.text AS claim_text, r.support, r.note, r.updated_at
         FROM claim_instance_readings r
         JOIN claim_instances ci ON ci.id = r.instance_id AND ci.detached_at IS NULL
         JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
        WHERE ci.source_id = $1 AND r.note IS NOT NULL AND r.note <> ''${oneReadingForInstanceSql("r")}
        ORDER BY r.updated_at DESC
        LIMIT 20`,
      [sourceId]
    ),
  ]);

  return {
    reach: { copies: Number(reach?.copies ?? 0), direct_copies: Number(reach?.direct_copies ?? 0) },
    structure: {
      claims: claimRows.length,
      origin_on: originOn,
      origin_by_steward: originBySteward,
      underlying_on: underlyingOn,
      downstream,
      claims_read: read.length,
    },
    evidence: {
      readings_by_support: Object.fromEntries(readings.map((r) => [r.support, Number(r.n)])),
      read_whole: readings.reduce((sum, r) => sum + Number(r.whole), 0),
      claims_citing_findings: Number(citing[0]?.n ?? 0),
      notes: notes.map((n) => ({
        claim: { id: n.claim_id, text: n.claim_text },
        support: n.support,
        note: n.note,
        read_at: new Date(n.updated_at).toISOString(),
      })),
    },
  };
}

const iso = (d: Date | string) => new Date(d).toISOString();

/** A dated log of what has been done to and about the document, newest first. */
export async function getSourceHistory(sourceId: string): Promise<SourceHistoryEntry[]> {
  const [source, segmented, events, readings, exams, findings, notes, citations, watch] = await Promise.all([
    rawQuery<{ retrieved_at: Date; facts_checked_at: Date | null; doi: string | null; has_text: boolean }>(
      `SELECT retrieved_at, facts_checked_at, doi, (raw_content IS NOT NULL AND raw_content <> '') AS has_text
         FROM sources WHERE id = $1`,
      [sourceId]
    ),
    rawQuery<{ at: Date | null; n: string }>(
      `SELECT MIN(created_at) AS at, COUNT(*) AS n FROM source_segments WHERE source_id = $1`,
      [sourceId]
    ),
    rawQuery<{ kind: string; occurred_at: Date | null; detected_at: Date; note: string | null; detected_by: string }>(
      `SELECT kind, occurred_at, detected_at, note, detected_by FROM source_events WHERE source_id = $1`,
      [sourceId]
    ),
    rawQuery<{ created_at: Date; support: string; source_read: boolean; created_by: string; claim_id: string; claim_text: string }>(
      `SELECT l.created_at, l.support, l.source_read, l.created_by, ci.claim_id, c.text AS claim_text
         FROM claim_instance_reading_log l
         JOIN claim_instances ci ON ci.id = l.instance_id
         JOIN claims c ON c.id = ci.claim_id
        WHERE ci.source_id = $1
        ORDER BY l.created_at DESC LIMIT $2`,
      [sourceId, HISTORY_LIMIT]
    ),
    rawQuery<{ id: string; created_at: Date; scope: string; requested_by: string; claim_id: string | null; claim_text: string | null; facets: string[]; spent: string | null }>(
      `SELECT x.id, x.created_at, x.scope, x.requested_by, x.claim_id, c.text AS claim_text, x.facets,
              (SELECT SUM(spent_micro_usd) FROM research_runs WHERE examination_id = x.id) AS spent
         FROM examinations x LEFT JOIN claims c ON c.id = x.claim_id
        WHERE x.source_id = $1`,
      [sourceId]
    ),
    rawQuery<{ examination_id: string; at: Date; n: string; created_by: string }>(
      `SELECT f.examination_id, MAX(f.created_at) AS at, COUNT(*) AS n, MIN(f.created_by) AS created_by
         FROM examination_findings f JOIN examinations x ON x.id = f.examination_id
        WHERE x.source_id = $1 GROUP BY f.examination_id`,
      [sourceId]
    ),
    rawQuery<{ created_at: Date; created_by: string; statement: string }>(
      `SELECT n.created_at, n.created_by, f.statement
         FROM audit_notes n JOIN examination_findings f ON f.id = n.finding_id
         JOIN examinations x ON x.id = f.examination_id
        WHERE x.source_id = $1`,
      [sourceId]
    ),
    rawQuery<{ at: Date; n: string; created_by: string; claim_id: string; claim_text: string }>(
      `SELECT MAX(rc.created_at) AS at, COUNT(*) AS n, MIN(rc.created_by) AS created_by, ci.claim_id, c.text AS claim_text
         FROM reading_citations rc
         JOIN examination_findings f ON f.id = rc.finding_id
         JOIN examinations x ON x.id = f.examination_id
         JOIN claim_instance_readings r ON r.id = rc.reading_id
         JOIN claim_instances ci ON ci.id = r.instance_id
         JOIN claims c ON c.id = ci.claim_id
        WHERE x.source_id = $1
        GROUP BY ci.claim_id, c.text, date_trunc('day', rc.created_at)`,
      [sourceId]
    ),
    rawQuery<{ value: { polled_at?: string } }>(
      `SELECT value FROM platform_flags WHERE key = 'lookout_retraction_poll'`
    ),
  ]);
  const s = source[0];
  if (!s) return [];
  const out: SourceHistoryEntry[] = [];
  const push = (at: Date | string | null | undefined, kind: string, by: string, text: string, claim: SourceHistoryEntry["claim"] = null) => {
    if (at) out.push({ at: iso(at), kind, by, text, claim });
  };

  // The correction watch reads Crossref for every DOI in the graph, so for a
  // document with a DOI its last poll is the last time anyone looked.
  if (s.doi && watch[0]?.value?.polled_at) {
    const found = events.length;
    push(watch[0].value.polled_at, "watch", "correction_watcher",
      found ? `Watched by DOI; ${found} notice${found === 1 ? "" : "s"} on record` : "Watched by DOI; no notice found");
  }
  push(s.facts_checked_at, "facts", "facts_fetcher", "Facts looked up");
  if (segmented[0]?.at) {
    push(segmented[0].at, "segmented", "segmenter", `Divided into ${segmented[0].n} parts by its own structure`);
  }
  push(s.retrieved_at, "retrieved", "graph", s.has_text ? "Entered the graph; copy stored" : "Entered the graph; no copy stored");
  for (const e of events) {
    push(e.detected_at, "event", e.detected_by, `${e.kind.replace(/_/g, " ")}${e.note ? `: ${e.note}` : ""}`);
  }
  for (const r of readings) {
    push(r.created_at, "reading", r.created_by,
      `${r.support.replace(/_/g, " ")}${r.source_read ? ", read whole" : ", from the excerpt"}`,
      { id: r.claim_id, text: r.claim_text });
  }
  const findingsByExam = new Map(findings.map((f) => [f.examination_id, f]));
  for (const x of exams) {
    const spent = x.spent ? ` · $${(Number(x.spent) / 1_000_000).toFixed(2)}` : "";
    push(x.created_at, "examination", x.requested_by,
      `${x.scope === "document" ? "Document review" : "Examination commissioned"}${x.facets.length ? ` · ${x.facets.join(", ")}` : ""}${spent}`,
      x.claim_id && x.claim_text ? { id: x.claim_id, text: x.claim_text } : null);
    const f = findingsByExam.get(x.id);
    if (f) push(f.at, "finding", f.created_by, `${f.n} finding${Number(f.n) === 1 ? "" : "s"} recorded`);
  }
  for (const n of notes) push(n.created_at, "audit_note", n.created_by, `Note on a finding: ${n.statement}`);
  for (const c of citations) {
    push(c.at, "citation", c.created_by, `Reading cites ${c.n} finding${Number(c.n) === 1 ? "" : "s"}`,
      { id: c.claim_id, text: c.claim_text });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, HISTORY_LIMIT);
}

const REVIEW_REQUESTS = 20;
const LIVE_STATES = ["open", "addressed", "in_progress"];

/** What has been asked and done about the document as a whole (#865). */
export async function getSourceReviews(sourceId: string): Promise<SourceReviews> {
  const [reviews, claimExams, segments, requests] = await Promise.all([
    rawQuery<{
      id: string;
      created_at: Date;
      request_id: string | null;
      ask: string | null;
      state: string | null;
      facets: string[];
      covered: string;
      findings: string;
    }>(
      `SELECT x.id, x.created_at, x.request_id, q.ask, q.state, x.facets,
              (SELECT COUNT(DISTINCT segment_id) FROM examination_coverage WHERE examination_id = x.id) AS covered,
              (SELECT COUNT(*) FROM examination_findings WHERE examination_id = x.id) AS findings
         FROM examinations x LEFT JOIN requests q ON q.id = x.request_id
        WHERE x.source_id = $1 AND x.scope = 'document'
        ORDER BY x.created_at`,
      [sourceId]
    ),
    rawQuery<{ n: string }>(
      `SELECT COUNT(*) AS n FROM examinations WHERE source_id = $1 AND scope = 'claim'`,
      [sourceId]
    ),
    rawQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM source_segments WHERE source_id = $1`, [sourceId]),
    rawQuery<{ id: string; ask: string; state: string; created_at: Date }>(
      `SELECT r.id, r.ask, r.state, r.created_at
         FROM requests r
        WHERE EXISTS (SELECT 1 FROM request_targets t WHERE t.request_id = r.id AND t.source_id = $1)
        ORDER BY (r.state = ANY($2::text[])) DESC, r.created_at DESC
        LIMIT $3`,
      [sourceId, LIVE_STATES, REVIEW_REQUESTS]
    ),
  ]);
  return {
    document_reviews: reviews.map((r) => ({
      examination_id: r.id,
      created_at: iso(r.created_at),
      request: r.request_id && r.ask ? { id: r.request_id, ask: r.ask, state: r.state ?? "open" } : null,
      facets: r.facets,
      segments_covered: Number(r.covered),
      findings: Number(r.findings),
    })),
    claim_examinations: Number(claimExams[0]?.n ?? 0),
    segments: Number(segments[0]?.n ?? 0),
    requests: requests.map((r) => ({
      id: r.id,
      ask: r.ask,
      state: r.state,
      filed_at: iso(r.created_at),
      live: LIVE_STATES.includes(r.state),
    })),
  };
}

/** Lineage, prominence, reviews, and history together, for the source page. Null when the source does not exist. */
export async function getSourceContext(sourceId: string): Promise<SourceContext | null> {
  if (!UUID_RE.test(sourceId)) return null;
  const [exists] = await rawQuery<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [sourceId]);
  if (!exists) return null;
  const [lineage, prominence, reviews, history] = await Promise.all([
    getSourceLineage(sourceId),
    getSourceProminence(sourceId),
    getSourceReviews(sourceId),
    getSourceHistory(sourceId),
  ]);
  return { lineage, prominence, reviews, history };
}

/** The orders listDocumentsForReview offers: each a different reason a document may matter. */
export const DOCUMENT_REVIEW_ORDERS = ["drawn_on", "divergent_uses", "copies", "claims", "readings"] as const;
export type DocumentReviewOrder = (typeof DOCUMENT_REVIEW_ORDERS)[number];

export interface DocumentForReview {
  source: { id: string; title: string; url: string | null; source_type: string };
  /** Characters of stored text; null when the graph holds no copy. */
  chars: number | null;
  /** Distinct documents recorded as drawing on it. */
  drawn_on_by: number;
  /** Uses of it that strengthen, weaken, distort or misattribute what it says. */
  divergent_uses: number;
  /** Republished copies made directly from it. */
  copies: number;
  /** Active claims whose map it is in. */
  claims: number;
  readings: number;
  /** Distinct findings the readings reached (supports, overstates, ...): above one, they differ. */
  reading_kinds: number;
  read_whole: number;
  /** Reviews of it for its own sake so far, and when the latest was opened. */
  reviews: number;
  latest_review_at: string | null;
  /** A live request bearing on it, to join rather than file another. */
  live_request_id: string | null;
}

const ORDER_SQL: Record<DocumentReviewOrder, string> = {
  drawn_on: "drawn_on_by DESC, divergent_uses DESC, claims DESC",
  divergent_uses: "divergent_uses DESC, drawn_on_by DESC, claims DESC",
  copies: "copies DESC, drawn_on_by DESC, claims DESC",
  claims: "claims DESC, drawn_on_by DESC, copies DESC",
  readings: "reading_kinds DESC, readings DESC, claims DESC",
};

/**
 * Documents the graph uses, with the figures a reader would weigh in
 * deciding whether one deserves a review for its own sake (#865), ordered by
 * whichever the caller chooses. Information for the Curator's judgment, not a
 * queue: nothing here files a request or ranks a document as needing one.
 * Only documents something in the graph rests on are listed.
 */
export async function listDocumentsForReview(opts: {
  order?: DocumentReviewOrder;
  unreviewed?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ documents: DocumentForReview[] }> {
  const order = ORDER_SQL[opts.order ?? "drawn_on"] ?? ORDER_SQL.drawn_on;
  const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 20)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const rows = await rawQuery<{
    id: string;
    title: string;
    url: string | null;
    source_type: string;
    chars: number | null;
    drawn_on_by: number;
    divergent_uses: number;
    copies: number;
    claims: number;
    readings: number;
    reading_kinds: number;
    read_whole: number;
    reviews: number;
    latest_review_at: Date | null;
    live_request_id: string | null;
  }>(
    `WITH live_instances AS (
       SELECT ci.id, ci.source_id, ci.claim_id FROM claim_instances ci
         JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
        WHERE ci.detached_at IS NULL
     ),
     in_map AS (
       SELECT source_id, claim_id FROM live_instances
       UNION
       SELECT e.to_source_id, li.claim_id FROM claim_provenance_edges e JOIN live_instances li ON li.id = e.from_instance_id
     ),
     claims_n AS (SELECT source_id, COUNT(DISTINCT claim_id)::int AS n FROM in_map GROUP BY source_id),
     drawn AS (
       SELECT e.to_source_id AS source_id, COUNT(DISTINCT li.source_id)::int AS n,
              COUNT(*) FILTER (WHERE e.fidelity = ANY($1::text[]))::int AS divergent
         FROM claim_provenance_edges e JOIN live_instances li ON li.id = e.from_instance_id
        GROUP BY e.to_source_id
     ),
     copies AS (
       SELECT parent_source_id AS source_id, COUNT(*)::int AS n FROM source_relationships
        WHERE relation_type = 'republishes' GROUP BY parent_source_id
     ),
     readings AS (
       SELECT li.source_id, COUNT(*)::int AS n, COUNT(DISTINCT r.support)::int AS kinds,
              COUNT(*) FILTER (WHERE r.source_read)::int AS whole
         FROM claim_instance_readings r JOIN live_instances li ON li.id = r.instance_id${oneReadingForInstanceSql("r")}
        GROUP BY li.source_id
     ),
     reviews AS (
       SELECT source_id, COUNT(*)::int AS n, MAX(created_at) AS latest FROM examinations
        WHERE scope = 'document' GROUP BY source_id
     ),
     live AS (
       SELECT t.source_id, (array_agg(q.id ORDER BY q.created_at DESC))[1] AS id
         FROM request_targets t JOIN requests q ON q.id = t.request_id
        WHERE t.source_id IS NOT NULL AND q.state IN ('open', 'addressed', 'in_progress')
        GROUP BY t.source_id
     ),
     docs AS (
       SELECT s.id, s.title, s.url, s.source_type,
              CASE WHEN s.raw_content IS NULL OR s.raw_content = '' THEN NULL ELSE length(s.raw_content) END AS chars,
              COALESCE(d.n, 0) AS drawn_on_by, COALESCE(d.divergent, 0) AS divergent_uses,
              COALESCE(cp.n, 0) AS copies, COALESCE(cn.n, 0) AS claims,
              COALESCE(rd.n, 0) AS readings, COALESCE(rd.kinds, 0) AS reading_kinds, COALESCE(rd.whole, 0) AS read_whole,
              COALESCE(rv.n, 0) AS reviews, rv.latest AS latest_review_at, lv.id AS live_request_id
         FROM sources s
         LEFT JOIN claims_n cn ON cn.source_id = s.id
         LEFT JOIN drawn d ON d.source_id = s.id
         LEFT JOIN copies cp ON cp.source_id = s.id
         LEFT JOIN readings rd ON rd.source_id = s.id
         LEFT JOIN reviews rv ON rv.source_id = s.id
         LEFT JOIN live lv ON lv.source_id = s.id
        WHERE cn.n IS NOT NULL OR d.n IS NOT NULL OR cp.n IS NOT NULL
     )
     SELECT * FROM docs
      ${opts.unreviewed ? "WHERE reviews = 0" : ""}
      ORDER BY ${order}, id
      LIMIT $2 OFFSET $3`,
    [[...DIVERGENT], limit, offset]
  );
  return {
    documents: rows.map((r) => ({
      source: { id: r.id, title: r.title, url: r.url, source_type: r.source_type },
      chars: r.chars === null ? null : Number(r.chars),
      drawn_on_by: r.drawn_on_by,
      divergent_uses: r.divergent_uses,
      copies: r.copies,
      claims: r.claims,
      readings: r.readings,
      reading_kinds: r.reading_kinds,
      read_whole: r.read_whole,
      reviews: r.reviews,
      latest_review_at: r.latest_review_at ? iso(r.latest_review_at) : null,
      live_request_id: r.live_request_id,
    })),
  };
}
