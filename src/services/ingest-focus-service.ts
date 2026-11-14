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
import { oneSourceForAddressSql } from "./layer-service.js";
import { createHash } from "node:crypto";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { currentLabel } from "../llm/usage-context.js";

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
export function ingestGroup(url: string, focus?: string | null, label: string = currentLabel()): string {
  const f = normalizeFocus(focus);
  if (!f) return groupAtLabel(`ingest:${url}`, label);
  const hash = createHash("sha256").update(f).digest("hex").slice(0, 16);
  return groupAtLabel(`ingest:${url}#focus:${hash}`, label);
}

/**
 * The ledger key of work at a label on something several labels can work
 * on: a node, a document, a partition of the graph. Work at `public` keeps
 * the key it always had, and work at another label has a key of its own,
 * so that one label's work neither waits on another's row nor reopens it,
 * and a row's label never changes. A space cannot occur in a node's id, an
 * address as it is stored, or a label's name, so the two never collide.
 * The database's minerval_group_at says the same for SQL.
 */
export function groupAtLabel(base: string, label: string = currentLabel()): string {
  return label === PUBLIC_LABEL ? base : `${base} @${label}`;
}

/** The address an ingest group is for, whatever its focus and its label. */
export function urlOfIngestGroup(group: string): string {
  const at = group.lastIndexOf(" @");
  const bare = at === -1 ? group : group.slice(0, at);
  const focus = bare.indexOf("#focus:");
  return (focus === -1 ? bare : bare.slice(0, focus)).replace(/^ingest:/, "");
}

/** Record the focus behind a scoped ingest group, for the executor to read. */
export async function recordIngestFocus(group: string, url: string, focus: string): Promise<void> {
  await rawQuery(
    `INSERT INTO ingest_focuses (exclusion_group, url, focus, sensitivity_label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (exclusion_group) DO NOTHING`,
    [group, url, focus, currentLabel()]
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
  /** Proposals the Matcher could not decide on, kept rather than dropped (#738). */
  claims_undecided: number;
  undecided: UndecidedProposal[];
  /** What the Extractor reported about the document itself, if anything (#740). */
  document_problem: { kind: string; note: string | null } | null;
  created_at: string;
}

/** A proposal kept on the extraction record because no verdict was reached. */
export interface UndecidedProposal {
  verbatim_text: string;
  proposed_canonical_form: string;
  kind: string;
  context: string | null;
}

export async function recordExtraction(input: {
  sourceId: string;
  focus: string | null;
  grantId?: string | null;
  jobId?: string | null;
  claimsExtracted: number;
  claimsCreated: number;
  claimsMatched: number;
  undecided?: UndecidedProposal[];
  documentProblem?: { kind: string; note: string } | null;
}): Promise<void> {
  const undecided = input.undecided ?? [];
  await rawQuery(
    `INSERT INTO source_extractions
       (source_id, focus, grant_id, job_id, claims_extracted, claims_created, claims_matched,
        claims_undecided, undecided, document_problem, document_problem_note, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.sourceId,
      normalizeFocus(input.focus),
      input.grantId ?? null,
      input.jobId ?? null,
      input.claimsExtracted,
      input.claimsCreated,
      input.claimsMatched,
      undecided.length,
      undecided.length > 0 ? JSON.stringify(undecided) : null,
      input.documentProblem?.kind ?? null,
      input.documentProblem?.note ?? null,
      // The extraction runs at its job's label, and this is its record: it
      // carries that label, whatever the document's (src/labels.ts).
      currentLabel(),
    ]
  );
}

/** What a source has been read for, oldest first: the source page's record. */
export async function sourceExtractions(sourceId: string): Promise<ExtractionRecord[]> {
  const rows = await rawQuery<{
    focus: string | null; grant_id: string | null; grant_name: string | null;
    claims_extracted: number; claims_created: number; claims_matched: number;
    claims_undecided: number | null; undecided: UndecidedProposal[] | null;
    document_problem: string | null; document_problem_note: string | null; created_at: Date;
  }>(
    `SELECT e.focus, e.grant_id, COALESCE(g.mandate->>'title', g.name) AS grant_name,
            e.claims_extracted, e.claims_created, e.claims_matched,
            e.claims_undecided, e.undecided, e.document_problem, e.document_problem_note,
            e.created_at
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
    claims_undecided: Number(r.claims_undecided ?? 0),
    undecided: Array.isArray(r.undecided) ? r.undecided : [],
    document_problem: r.document_problem
      ? { kind: r.document_problem, note: r.document_problem_note }
      : null,
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
 * extracted from it. Only a complete reading covers: one that left no
 * proposal undecided and reported no problem with the document.
 */
export async function ingestCoverage(url: string, focus: string | null): Promise<IngestCoverage> {
  const [source] = await rawQuery<{ id: string; title: string }>(
    `SELECT id, title FROM sources WHERE url = $1${oneSourceForAddressSql()}`,
    [url]
  );
  if (!source) return { covered: false };
  // A reading that left proposals undecided or could not read the document
  // is on record but does not cover it (#738, #740): the next ingest reads
  // it again, and the Matcher links what is already there.
  const records = await rawQuery<{ focus: string | null; complete: boolean }>(
    `SELECT focus, (claims_undecided = 0 AND document_problem IS NULL) AS complete
       FROM source_extractions WHERE source_id = $1`,
    [source.id]
  );
  const complete = records.filter((r) => r.complete);
  const f = normalizeFocus(focus);
  if (complete.some((r) => r.focus === null)) return { covered: true, sourceId: source.id, title: source.title, by: "whole" };
  if (f && complete.some((r) => r.focus === f)) {
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
