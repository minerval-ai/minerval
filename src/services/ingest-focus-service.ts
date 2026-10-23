/**
 * Scoped ingest: reading a document for one subject, not for everything in
 * it.
 *
 * A mandate that wants one author's claims about one subject does not want
 * every anecdote and aside those articles carry: extracting and matching
 * them costs the mandate's escrow and mints claims nobody asked for. An
 * ingest may therefore carry a FOCUS, in the mandate's own words. The
 * extractor still reads the whole document (it needs the context) but
 * proposes only the claims bearing on the focus. The premises such a claim
 * rests on are not chased here: when its Steward decomposes it, the ones
 * the argument actually turns on become its subclaims.
 *
 * Every extraction is recorded against its source with what it was read
 * for (source_extractions), so the source page can say how much of the
 * document the graph holds, and so a later ingest of the same URL — with
 * another focus, or none — is not refused as a duplicate: it extracts what
 * the earlier reading left out, and the Matcher links what is already
 * there.
 */
import { createHash } from "node:crypto";
import { rawQuery } from "../db/client.js";

export const FOCUS_MAX_CHARS = 1_000;

/** A focus as stored and compared: trimmed, one space between words; null when empty. */
export function normalizeFocus(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const f = raw.replace(/\s+/g, " ").trim();
  return f ? f.slice(0, FOCUS_MAX_CHARS) : null;
}

/**
 * The ledger exclusion group of an ingest. A whole-document ingest keeps
 * the original key; a scoped one is keyed by its focus too, so the same URL
 * can be ingested for different subjects without the groups colliding.
 */
export function ingestGroup(url: string, focus?: string | null): string {
  const f = normalizeFocus(focus);
  if (!f) return `ingest:${url}`;
  const hash = createHash("sha256").update(f).digest("hex").slice(0, 16);
  return `ingest:${url}#focus:${hash}`;
}

/** Record the focus behind a scoped ingest group, for the executor to read. */
export async function recordIngestFocus(group: string, url: string, focus: string): Promise<void> {
  await rawQuery(
    `INSERT INTO ingest_focuses (exclusion_group, url, focus)
     VALUES ($1, $2, $3)
     ON CONFLICT (exclusion_group) DO NOTHING`,
    [group, url, focus]
  );
}

/** The focus of an ingest group, or null for a whole-document ingest. */
export async function focusForGroup(group: string): Promise<string | null> {
  if (!group.includes("#focus:")) return null;
  const [row] = await rawQuery<{ focus: string }>(
    `SELECT focus FROM ingest_focuses WHERE exclusion_group = $1`,
    [group]
  );
  return row?.focus ?? null;
}

export interface ExtractionRecord {
  focus: string | null;
  grant_id: string | null;
  grant_name: string | null;
  claims_extracted: number;
  claims_created: number;
  claims_matched: number;
  created_at: string;
}

export async function recordExtraction(input: {
  sourceId: string;
  focus: string | null;
  grantId?: string | null;
  jobId?: string | null;
  claimsExtracted: number;
  claimsCreated: number;
  claimsMatched: number;
}): Promise<void> {
  await rawQuery(
    `INSERT INTO source_extractions
       (source_id, focus, grant_id, job_id, claims_extracted, claims_created, claims_matched)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.sourceId,
      normalizeFocus(input.focus),
      input.grantId ?? null,
      input.jobId ?? null,
      input.claimsExtracted,
      input.claimsCreated,
      input.claimsMatched,
    ]
  );
}

/** What a source has been read for, oldest first: the source page's record. */
export async function sourceExtractions(sourceId: string): Promise<ExtractionRecord[]> {
  const rows = await rawQuery<{
    focus: string | null; grant_id: string | null; grant_name: string | null;
    claims_extracted: number; claims_created: number; claims_matched: number; created_at: Date;
  }>(
    `SELECT e.focus, e.grant_id, COALESCE(g.mandate->>'title', g.name) AS grant_name,
            e.claims_extracted, e.claims_created, e.claims_matched, e.created_at
       FROM source_extractions e LEFT JOIN grants g ON g.id = e.grant_id
      WHERE e.source_id = $1
      ORDER BY e.created_at ASC`,
    [sourceId]
  );
  return rows.map((r) => ({
    focus: r.focus,
    grant_id: r.grant_id,
    grant_name: r.grant_name,
    claims_extracted: Number(r.claims_extracted),
    claims_created: Number(r.claims_created),
    claims_matched: Number(r.claims_matched),
    created_at: new Date(r.created_at).toISOString(),
  }));
}

export type IngestCoverage =
  | { covered: false }
  | { covered: true; sourceId: string; title: string; by: "whole" | "same_focus" | "legacy" };

/**
 * Whether ingesting `url` (for `focus`, or the whole document) would only
 * repeat an extraction already done. Covered: a whole-document extraction
 * on record, or one for the same focus; or, for a source with no
 * extraction records at all, any existing source row (the rule before
 * scoped ingest: a source in the graph was not ingested twice). A scoped
 * ingest of a source with no records is not covered when nothing was ever
 * extracted from it.
 */
export async function ingestCoverage(url: string, focus: string | null): Promise<IngestCoverage> {
  const [source] = await rawQuery<{ id: string; title: string }>(
    `SELECT id, title FROM sources WHERE url = $1`,
    [url]
  );
  if (!source) return { covered: false };
  const records = await rawQuery<{ focus: string | null }>(
    `SELECT focus FROM source_extractions WHERE source_id = $1`,
    [source.id]
  );
  const f = normalizeFocus(focus);
  if (records.some((r) => r.focus === null)) return { covered: true, sourceId: source.id, title: source.title, by: "whole" };
  if (f && records.some((r) => r.focus === f)) {
    return { covered: true, sourceId: source.id, title: source.title, by: "same_focus" };
  }
  if (records.length > 0) return { covered: false };
  if (f) {
    // No records: covered only when something was extracted from it before.
    const [extracted] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM claim_instances
        WHERE source_id = $1 AND created_by = 'extractor'`,
      [source.id]
    );
    return Number(extracted?.n ?? 0) > 0
      ? { covered: true, sourceId: source.id, title: source.title, by: "legacy" }
      : { covered: false };
  }
  return { covered: true, sourceId: source.id, title: source.title, by: "legacy" };
}
