/**
 * Facts about a source that need no judgment (#507, phase 3): who wrote it,
 * who published it, when, its DOI, an archived copy, and what has happened
 * to it since (corrections, retractions, concerns). The first section of the
 * source page, and the identity a reader checks before anything else.
 *
 * Three places supply them, in order of trust:
 *  - Crossref, for a document with a DOI: the registry the publisher itself
 *    deposits to, which also carries the update notices.
 *  - The page's own metadata: the `citation_*` tags scholarly publishers
 *    emit for indexers, then Dublin Core and Open Graph.
 *  - The Internet Archive's availability API, for an archived copy.
 *
 * Every fact is filled once and never overwritten: a column already set
 * stays as it is, so a later and worse guess cannot replace an earlier and
 * better one. A source's kind is set only when nothing more specific than
 * the default was recorded. Nothing here throws to its caller; a fetch that
 * fails leaves the fact null, and the page says it was not found.
 */
import { rawQuery } from "../db/client.js";
import { fetchPublicUrl } from "./url-guard.js";
import { checkDoi, extractDois, type DoiCheck } from "./source-watch-service.js";
import { decodeEntities, looksLikeHtml } from "./source-map-service.js";
import { SOURCE_EVENT_KINDS, type SourceEventKind } from "../schemas/common.js";

export interface PageFacts {
  title: string | null;
  authors: string[];
  publisher: string | null;
  published_date: string | null;
  doi: string | null;
}

/** Kinds no more specific than "we fetched it": a fact may replace these. */
const GENERIC_KINDS = new Set(["unknown", "webpage"]);

/**
 * Crossref work types onto the graph's source kinds. Only the types whose
 * kind a reader would want named; anything else leaves the kind alone.
 */
const CROSSREF_KINDS: Record<string, string> = {
  "journal-article": "journal_article",
  "posted-content": "preprint",
  "proceedings-article": "conference_paper",
  "book-chapter": "book_chapter",
  book: "book",
  monograph: "book",
  report: "report",
  dataset: "dataset",
  dissertation: "thesis",
  standard: "standard",
};

/** Crossref update types onto event kinds; types outside this map are recorded as updates. */
const CROSSREF_EVENT_KINDS: Record<string, SourceEventKind> = {
  retraction: "retraction",
  withdrawal: "retraction",
  removal: "removal",
  correction: "correction",
  erratum: "correction",
  corrigendum: "correction",
  expression_of_concern: "expression_of_concern",
  "expression-of-concern": "expression_of_concern",
};

export function eventKindForCrossref(type: string | null | undefined): SourceEventKind {
  return CROSSREF_EVENT_KINDS[(type ?? "").toLowerCase()] ?? "update";
}

/** Reduce a date string to ISO-8601 at the precision it states, or null. */
export function isoDatePrefix(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const m = v.match(/^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = mo ? Number(mo) : null;
  const day = d ? Number(d) : null;
  if (month !== null && (month < 1 || month > 12)) return y!;
  if (month === null) return y!;
  const mm = String(month).padStart(2, "0");
  if (day === null || day < 1 || day > 31) return `${y}-${mm}`;
  return `${y}-${mm}-${String(day).padStart(2, "0")}`;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/** Every <meta> tag's name (or property) and content, in document order. */
function metaTags(html: string): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = [];
  const head = html.slice(0, 200_000);
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], "name") ?? attr(m[0], "property") ?? "").toLowerCase();
    const content = attr(m[0], "content");
    if (name && content) out.push({ name, content: decodeEntities(content).replace(/\s+/g, " ").trim() });
  }
  return out;
}

/**
 * What a page says about itself in its metadata. Scholarly `citation_*`
 * tags first, then Dublin Core, then Open Graph and article tags; the first
 * present wins. Authors only from tags that name people one per tag, never
 * split out of a byline string, which would mangle "Smith, J. and Jones, K.".
 */
export function parsePageFacts(content: string | null | undefined): PageFacts {
  const empty: PageFacts = { title: null, authors: [], publisher: null, published_date: null, doi: null };
  if (!content || !looksLikeHtml(content)) return empty;
  const tags = metaTags(content);
  const first = (...names: string[]) => {
    for (const n of names) {
      const hit = tags.find((t) => t.name === n && t.content);
      if (hit) return hit.content;
    }
    return null;
  };
  const all = (name: string) => tags.filter((t) => t.name === name).map((t) => t.content).filter(Boolean);

  let authors = all("citation_author");
  if (authors.length === 0) authors = all("dc.creator");
  if (authors.length === 0) authors = all("dcterms.creator");
  if (authors.length === 0) authors = all("article:author").filter((a) => !/^https?:\/\//i.test(a));
  if (authors.length === 0) {
    const author = first("author");
    if (author) authors = [author];
  }

  const doiTag = first("citation_doi", "dc.identifier", "dcterms.identifier", "prism.doi");
  const doi = doiTag ? extractDois(doiTag)[0] ?? null : null;

  return {
    title: first("citation_title", "dc.title", "dcterms.title", "og:title"),
    authors: [...new Set(authors)].slice(0, 100),
    publisher: first("citation_publisher", "dc.publisher", "dcterms.publisher", "citation_journal_title", "og:site_name"),
    published_date: isoDatePrefix(
      first(
        "citation_publication_date",
        "citation_date",
        "citation_online_date",
        "dc.date",
        "dcterms.issued",
        "dcterms.date",
        "article:published_time",
        "date"
      )
    ),
    doi,
  };
}

/** The Internet Archive's closest snapshot of a URL, or null. */
export async function findArchivedCopy(
  url: string,
  fetch: (url: string) => Promise<string> = (u) => fetchPublicUrl(u)
): Promise<string | null> {
  try {
    const body = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
    const parsed = JSON.parse(body) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string; status?: string } };
    };
    const closest = parsed.archived_snapshots?.closest;
    if (!closest?.available || !closest.url) return null;
    if (closest.status && !/^2\d\d$/.test(closest.status)) return null;
    return closest.url.replace(/^http:\/\//i, "https://");
  } catch {
    return null;
  }
}

export interface RecordSourceEventInput {
  sourceId: string;
  kind: string;
  occurredAt?: string | Date | null;
  noticeUrl?: string | null;
  note?: string | null;
  detectedBy: string;
}

/**
 * Record what happened to a document, once: the same kind of event with the
 * same notice is the same event, however many times a watcher sees it.
 * Returns whether this call recorded it.
 */
export async function recordSourceEvent(input: RecordSourceEventInput): Promise<{ recorded: boolean }> {
  if (!(SOURCE_EVENT_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`Unknown source event kind "${input.kind}"`);
  }
  const occurred = input.occurredAt ? new Date(input.occurredAt) : null;
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO source_events (source_id, kind, occurred_at, notice_url, note, detected_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id, kind, notice_url) DO NOTHING
     RETURNING id`,
    [
      input.sourceId,
      input.kind,
      occurred && !Number.isNaN(occurred.getTime()) ? occurred : null,
      (input.noticeUrl ?? "").trim(),
      input.note ?? null,
      input.detectedBy,
    ]
  );
  return { recorded: rows.length > 0 };
}

export interface RefreshSourceFactsResult {
  source_id: string;
  /** The facts this call filled in; facts already set are not listed. */
  filled: string[];
  events_recorded: number;
  doi: string | null;
}

interface FactsRow {
  id: string;
  url: string | null;
  title: string;
  raw_content: string | null;
  source_type: string;
  authors: string[] | null;
  publisher: string | null;
  published_date: string | null;
  doi: string | null;
  archived_url: string | null;
}

/**
 * Look up and record what can be known about a source without judgment.
 * Idempotent and fill-only. `checkDoi` and `fetch` are seams for tests.
 */
export async function refreshSourceFacts(
  sourceId: string,
  deps: {
    checkDoi?: (doi: string) => Promise<DoiCheck>;
    fetch?: (url: string) => Promise<string>;
    archive?: boolean;
  } = {}
): Promise<RefreshSourceFactsResult> {
  const [row] = await rawQuery<FactsRow>(
    `SELECT id, url, title, raw_content, source_type, authors, publisher, published_date, doi, archived_url
       FROM sources WHERE id = $1`,
    [sourceId]
  );
  if (!row) return { source_id: sourceId, filled: [], events_recorded: 0, doi: null };

  const page = parsePageFacts(row.raw_content);
  const doi = row.doi ?? page.doi ?? extractDois(row.url ?? "")[0] ?? null;

  let work: DoiCheck | null = null;
  if (doi) {
    work = await (deps.checkDoi ?? checkDoi)(doi).catch(() => null);
    if (work && !work.found && work.updates.length === 0) work = null;
  }

  const archived =
    !row.archived_url && row.url && deps.archive !== false
      ? await findArchivedCopy(row.url, deps.fetch)
      : null;

  const next = {
    authors: work?.authors.length ? work.authors : page.authors.length ? page.authors : null,
    publisher: work?.container ?? work?.publisher ?? page.publisher,
    published_date: isoDatePrefix(work?.published) ?? page.published_date,
    doi,
    archived_url: archived,
    source_type: work?.type ? CROSSREF_KINDS[work.type] ?? null : null,
    title: work?.title ?? page.title,
  };

  const filled: string[] = [];
  if (!row.authors?.length && next.authors) filled.push("authors");
  if (!row.publisher && next.publisher) filled.push("publisher");
  if (!row.published_date && next.published_date) filled.push("published_date");
  if (!row.doi && next.doi) filled.push("doi");
  if (!row.archived_url && next.archived_url) filled.push("archived_url");
  if (GENERIC_KINDS.has(row.source_type) && next.source_type) filled.push("source_type");
  // A title is replaced only where none was ever given: the row's title is
  // its URL, the placeholder getOrCreateSource writes.
  const placeholderTitle = !row.title || row.title === row.url;
  if (placeholderTitle && next.title) filled.push("title");

  await rawQuery(
    `UPDATE sources SET
       authors = CASE WHEN authors IS NULL OR cardinality(authors) = 0 THEN COALESCE($2::text[], authors) ELSE authors END,
       publisher = COALESCE(publisher, $3),
       published_date = COALESCE(published_date, $4),
       doi = COALESCE(doi, $5),
       archived_url = COALESCE(archived_url, $6),
       source_type = CASE WHEN source_type IN ('unknown', 'webpage') AND $7::text IS NOT NULL THEN $7 ELSE source_type END,
       title = CASE WHEN $8::boolean AND $9::text IS NOT NULL THEN $9 ELSE title END,
       facts_checked_at = now()
     WHERE id = $1`,
    [
      sourceId,
      next.authors,
      next.publisher,
      next.published_date,
      next.doi,
      next.archived_url,
      next.source_type,
      placeholderTitle,
      next.title,
    ]
  );

  let eventsRecorded = 0;
  for (const u of work?.updates ?? []) {
    const { recorded } = await recordSourceEvent({
      sourceId,
      kind: eventKindForCrossref(u.type),
      occurredAt: u.updated,
      noticeUrl: u.doi ? `https://doi.org/${u.doi}` : null,
      note: u.label,
      detectedBy: "facts_fetch",
    }).catch(() => ({ recorded: false }));
    if (recorded) eventsRecorded++;
  }

  return { source_id: sourceId, filled, events_recorded: eventsRecorded, doi };
}

/**
 * Refresh a source's facts if nobody has yet, swallowing every failure: the
 * hook the fetch paths call after storing a document, where losing the facts
 * must never lose the document.
 */
export async function refreshSourceFactsOnce(sourceId: string): Promise<void> {
  try {
    const [row] = await rawQuery<{ facts_checked_at: Date | null }>(
      `SELECT facts_checked_at FROM sources WHERE id = $1`,
      [sourceId]
    );
    if (!row || row.facts_checked_at) return;
    await refreshSourceFacts(sourceId);
  } catch (err) {
    console.error(
      `[source-facts] refresh failed for ${sourceId}: ${err instanceof Error ? err.message : err}`
    );
  }
}

export interface SourceFactsView {
  source: {
    id: string;
    url: string | null;
    title: string;
    source_type: string;
    authors: string[];
    publisher: string | null;
    published_date: string | null;
    doi: string | null;
    archived_url: string | null;
    retrieved_at: string;
    facts_checked_at: string | null;
  };
  /** Other versions of the same work; `later` says which way the relation runs. */
  versions: Array<{ id: string; title: string; url: string | null; later: boolean }>;
  /** Republished copies of this document. */
  copies: Array<{ id: string; title: string; url: string | null }>;
  /** Documents this one is a republished copy of. */
  copy_of: Array<{ id: string; title: string; url: string | null }>;
  events: Array<{
    kind: string;
    occurred_at: string | null;
    detected_at: string;
    notice_url: string | null;
    note: string | null;
    detected_by: string;
  }>;
}

/** The facts section of a source page: identity, versions, copies, and events. */
export async function getSourceFacts(sourceId: string): Promise<SourceFactsView | null> {
  const [row] = await rawQuery<{
    id: string;
    url: string | null;
    title: string;
    source_type: string;
    authors: string[] | null;
    publisher: string | null;
    published_date: string | null;
    doi: string | null;
    archived_url: string | null;
    retrieved_at: Date;
    facts_checked_at: Date | null;
  }>(
    `SELECT id, url, title, source_type, authors, publisher, published_date, doi, archived_url,
            retrieved_at, facts_checked_at
       FROM sources WHERE id = $1`,
    [sourceId]
  );
  if (!row) return null;
  const [relations, events] = await Promise.all([
    rawQuery<{
      relation_type: string;
      this_is_parent: boolean;
      other_id: string;
      other_title: string;
      other_url: string | null;
    }>(
      `SELECT sr.relation_type, sr.parent_source_id = $1 AS this_is_parent,
              o.id AS other_id, o.title AS other_title, o.url AS other_url
         FROM source_relationships sr
         JOIN sources o ON o.id = CASE WHEN sr.parent_source_id = $1 THEN sr.child_source_id ELSE sr.parent_source_id END
        WHERE (sr.parent_source_id = $1 OR sr.child_source_id = $1)
          AND sr.relation_type IN ('version_of', 'republishes')
        ORDER BY sr.created_at`,
      [sourceId]
    ),
    rawQuery<{
      kind: string;
      occurred_at: Date | null;
      detected_at: Date;
      notice_url: string;
      note: string | null;
      detected_by: string;
    }>(
      `SELECT kind, occurred_at, detected_at, notice_url, note, detected_by
         FROM source_events WHERE source_id = $1
        ORDER BY COALESCE(occurred_at, detected_at)`,
      [sourceId]
    ),
  ]);
  const other = (r: (typeof relations)[number]) => ({ id: r.other_id, title: r.other_title, url: r.other_url });
  return {
    source: {
      id: row.id,
      url: row.url,
      title: row.title,
      source_type: row.source_type,
      authors: row.authors ?? [],
      publisher: row.publisher,
      published_date: row.published_date,
      doi: row.doi,
      archived_url: row.archived_url,
      retrieved_at: new Date(row.retrieved_at).toISOString(),
      facts_checked_at: row.facts_checked_at ? new Date(row.facts_checked_at).toISOString() : null,
    },
    // version_of records the LATER document as the parent.
    versions: relations
      .filter((r) => r.relation_type === "version_of")
      .map((r) => ({ ...other(r), later: !r.this_is_parent })),
    copies: relations.filter((r) => r.relation_type === "republishes" && r.this_is_parent).map(other),
    copy_of: relations.filter((r) => r.relation_type === "republishes" && !r.this_is_parent).map(other),
    events: events.map((e) => ({
      kind: e.kind,
      occurred_at: e.occurred_at ? new Date(e.occurred_at).toISOString() : null,
      detected_at: new Date(e.detected_at).toISOString(),
      notice_url: e.notice_url || null,
      note: e.note,
      detected_by: e.detected_by,
    })),
  };
}
