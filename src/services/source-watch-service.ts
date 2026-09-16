/**
 * Source watching — the code side of "did the world move?" (docs/
 * allocation.md, "Lookouts").
 *
 * A Lookout's judgment is whether a happening matters in its scope; this
 * module supplies the happenings it cannot cheaply notice by reading:
 *
 *   - Crossref, which since 2023 carries the Retraction Watch database as
 *     `update-to` relations on retraction, correction, and expression-of-
 *     concern notices. `checkDoi` answers "has this paper been updated?";
 *     `recentRetractions` answers "what was retracted since <date>?", the
 *     daily poll the retraction trigger runs on (workers/lookout-triggers.ts).
 *   - The graph's own sources: which sources sit behind the claims in a
 *     scope, with the DOIs their URLs carry, so a watch knows what to check.
 *   - A bounded, SSRF-guarded page read, HTML reduced to text, for a
 *     Lookout that wants to look at a page rather than a search snippet.
 *
 * Everything fetched here is DATA to the agent that reads it, never
 * instructions; the guard on the network path is url-guard.ts, and every
 * read is capped in size.
 */
import { rawQuery } from "../db/client.js";
import { fetchPublicUrl } from "./url-guard.js";

const CROSSREF = "https://api.crossref.org";
const USER_AGENT = "Minerval/1.0 (lookout; mailto:hello@minerval.ai)";

/** DOIs as they appear in text and URLs (the 10.<registrant>/<suffix> form). */
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>)\]]+/gi;

export function extractDois(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(DOI_RE)) {
    out.add(m[0].replace(/[.,;:]+$/, "").toLowerCase());
  }
  return [...out];
}

export interface CrossrefUpdate {
  doi: string;
  type: string;
  label: string | null;
  updated: string | null;
  source: string | null;
}

export interface DoiCheck {
  doi: string;
  found: boolean;
  title: string | null;
  type: string | null;
  published: string | null;
  cited_by: number | null;
  /** Notices that update THIS work: retractions, corrections, concerns. */
  updates: CrossrefUpdate[];
  /** Works this one updates (set when the DOI is itself a notice). */
  updates_to: CrossrefUpdate[];
}

type CrossrefWork = {
  DOI?: string;
  title?: string[];
  type?: string;
  "update-to"?: Array<{ DOI?: string; type?: string; label?: string; updated?: { "date-time"?: string } }>;
  "is-referenced-by-count"?: number;
  issued?: { "date-parts"?: number[][] };
  published?: { "date-parts"?: number[][] };
  source?: string;
};

function dateOf(w: CrossrefWork): string | null {
  const parts = w.published?.["date-parts"]?.[0] ?? w.issued?.["date-parts"]?.[0];
  if (!parts || parts.length === 0) return null;
  return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, "0"))).join("-");
}

function updatesOf(w: CrossrefWork): CrossrefUpdate[] {
  return (w["update-to"] ?? []).map((u) => ({
    doi: (u.DOI ?? "").toLowerCase(),
    type: u.type ?? "update",
    label: u.label ?? null,
    updated: u.updated?.["date-time"] ?? null,
    source: w.source ?? null,
  }));
}

async function crossrefJson<T>(path: string): Promise<T | null> {
  const body = await fetchPublicUrl(`${CROSSREF}${path}`, { userAgent: USER_AGENT }).catch(
    () => null
  );
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * One DOI's standing on the Crossref record: its metadata, and every
 * notice that updates it (the `updates:` filter is the inverse of
 * `update-to`, and is where a retraction of THIS paper shows up).
 */
export async function checkDoi(rawDoi: string): Promise<DoiCheck> {
  const doi = rawDoi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
  const empty: DoiCheck = {
    doi,
    found: false,
    title: null,
    type: null,
    published: null,
    cited_by: null,
    updates: [],
    updates_to: [],
  };
  if (!/^10\.\d{4,9}\//.test(doi)) return empty;
  const [work, notices] = await Promise.all([
    crossrefJson<{ message?: CrossrefWork }>(`/works/${encodeURIComponent(doi)}`),
    crossrefJson<{ message?: { items?: CrossrefWork[] } }>(
      `/works?filter=updates:${encodeURIComponent(doi)}&rows=10&select=DOI,title,type,update-to,source`
    ),
  ]);
  const w = work?.message;
  const updates: CrossrefUpdate[] = [];
  for (const n of notices?.message?.items ?? []) {
    for (const u of updatesOf(n)) {
      if (u.doi === doi) {
        updates.push({ ...u, doi: (n.DOI ?? "").toLowerCase() });
      }
    }
  }
  if (!w) return { ...empty, updates };
  return {
    doi,
    found: true,
    title: w.title?.[0] ?? null,
    type: w.type ?? null,
    published: dateOf(w),
    cited_by: w["is-referenced-by-count"] ?? null,
    updates,
    updates_to: updatesOf(w),
  };
}

export interface RetractionNotice {
  notice_doi: string;
  retracted_dois: string[];
  type: string;
  title: string | null;
  updated: string | null;
  source: string | null;
}

/**
 * Retraction (and, with `types`, correction / concern) notices added to
 * Crossref since `since`, optionally narrowed by a free-text query. Both
 * publisher-deposited and Retraction Watch entries come back; `source`
 * says which.
 */
export async function recentRetractions(input: {
  since: Date;
  query?: string | null;
  types?: Array<"retraction" | "correction" | "expression_of_concern">;
  rows?: number;
}): Promise<RetractionNotice[]> {
  const since = input.since.toISOString().slice(0, 10);
  const types = input.types?.length ? input.types : ["retraction"];
  const filter = [
    ...types.map((t) => `update-type:${t}`),
    `from-update-date:${since}`,
  ].join(",");
  const q = input.query?.trim() ? `&query=${encodeURIComponent(input.query.trim())}` : "";
  const rows = Math.min(200, Math.max(1, input.rows ?? 50));
  const res = await crossrefJson<{ message?: { items?: CrossrefWork[] } }>(
    `/works?filter=${encodeURIComponent(filter)}${q}&rows=${rows}&sort=updated&order=desc&select=DOI,title,type,update-to,source`
  );
  return (res?.message?.items ?? []).map((n) => {
    const ups = updatesOf(n);
    return {
      notice_doi: (n.DOI ?? "").toLowerCase(),
      retracted_dois: ups.map((u) => u.doi).filter(Boolean),
      type: ups[0]?.type ?? "retraction",
      title: n.title?.[0] ?? null,
      updated: ups[0]?.updated ?? null,
      source: n.source ?? null,
    };
  });
}

export interface ScopeSource {
  source_id: string;
  url: string | null;
  title: string;
  retrieved_at: string;
  dois: string[];
  claim_ids: string[];
  claims: number;
}

/**
 * The sources behind a set of claims (a subtree root, or explicit ids),
 * with the DOIs their URLs carry — what a watch has to check.
 */
export async function scopeSources(input: {
  claimIds?: string[];
  rootClaimId?: string | null;
  limit?: number;
}): Promise<ScopeSource[]> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Model-supplied ids: a malformed one is dropped rather than failing the query.
  const ids = (input.claimIds ?? []).filter((id) => uuid.test(id));
  const root = input.rootClaimId && uuid.test(input.rootClaimId) ? input.rootClaimId : null;
  const rows = await rawQuery<{
    source_id: string;
    url: string | null;
    title: string;
    retrieved_at: Date;
    claim_ids: string[];
  }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM claims WHERE id = $2::uuid
       UNION
       SELECT cr.child_claim_id
         FROM claim_relationships cr JOIN subtree s ON cr.parent_claim_id = s.id
     ),
     wanted AS (
       SELECT id FROM subtree
       UNION
       SELECT unnest($1::uuid[]) AS id
     )
     SELECT s.id AS source_id, s.url, s.title, s.retrieved_at,
            array_agg(DISTINCT ci.claim_id) AS claim_ids
       FROM claim_instances ci
       JOIN sources s ON s.id = ci.source_id
      WHERE ci.claim_id IN (SELECT id FROM wanted)
      GROUP BY s.id
      ORDER BY COUNT(DISTINCT ci.claim_id) DESC, s.retrieved_at DESC
      LIMIT $3`,
    [ids, root, limit]
  );
  return rows.map((r) => ({
    source_id: r.source_id,
    url: r.url,
    title: r.title,
    retrieved_at: new Date(r.retrieved_at).toISOString(),
    dois: extractDois(r.url ?? ""),
    claim_ids: r.claim_ids,
    claims: r.claim_ids.length,
  }));
}

/**
 * Sources in the graph whose URL carries one of `dois`, with the active
 * claims that rest on them: the join the retraction poller makes between
 * a Crossref notice and the graph.
 */
export async function sourcesForDois(dois: string[]): Promise<
  Array<{ doi: string; source_id: string; url: string; title: string; claim_ids: string[] }>
> {
  const clean = [...new Set(dois.map((d) => d.toLowerCase()).filter((d) => /^10\.\d{4,9}\//.test(d)))];
  if (clean.length === 0) return [];
  return rawQuery(
    `SELECT d.doi, s.id AS source_id, s.url, s.title,
            COALESCE(array_agg(DISTINCT ci.claim_id) FILTER (WHERE ci.claim_id IS NOT NULL), '{}') AS claim_ids
       FROM unnest($1::text[]) d(doi)
       JOIN sources s ON s.url IS NOT NULL AND lower(s.url) LIKE '%' || d.doi || '%'
       LEFT JOIN claim_instances ci ON ci.source_id = s.id
       LEFT JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
      GROUP BY d.doi, s.id`,
    [clean]
  );
}

/** Reduce an HTML document to readable text, bounded. */
export function htmlToText(html: string, maxChars = 12_000): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n\n+/g, "\n")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

/** Fetch a public page and return it as bounded text; errors as a message. */
export async function readPage(
  url: string,
  maxChars = 12_000
): Promise<{ ok: true; text: string; chars: number } | { ok: false; problem: string }> {
  try {
    const body = await fetchPublicUrl(url, { userAgent: USER_AGENT });
    const text = /^\s*[{[]/.test(body) ? body.slice(0, maxChars) : htmlToText(body, maxChars);
    return { ok: true, text, chars: text.length };
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
}
