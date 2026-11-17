/**
 * The sources a deployment holds, as a list for the people who bring
 * material in (GET /sources; web/app/sources).
 *
 * Each row is what a list needs to tell one source from another and to see
 * where it stands: its title and address, its label, whose material it is,
 * where its admission and reading have got, who added it and when. Nothing
 * of the document's own text is returned, so the list needs no permission
 * to open sources (src/raw-sources.ts).
 *
 * Where a source stands is read from what the data records, never guessed:
 *
 *  - pending_review: its latest submission waits for the reviewer (or for
 *    an arbitrator, or a person the review was escalated to).
 *  - not_admitted: its latest submission was rejected. Nothing was read
 *    from it.
 *  - queued: admitted, or submitted by the deployment's own service, and
 *    its reading waits in the extraction lane.
 *  - reading: the Extractor is reading it now.
 *  - extracted: read for what the graph should hold.
 *  - failed: its reading stopped with an error.
 *  - recorded: no submission and no reading: an agent kept it (a reading
 *    from a connection, a file or a command of a file set, a shown page) or
 *    the system wrote it.
 *
 * A read is held to the reader's clearance: a source at a label the caller
 * may not read is not listed, and is not counted. The database holds that
 * too (db/clearance.ts); the label is also named in the query, as the file
 * sets' list does (services/file-set-service.ts), so the count and the page
 * agree whoever runs it. Only the deployment's own rows are listed: on a
 * deployment that mirrors the public graph, the mirror's sources are the
 * public graph's, and are found there.
 */
import { rawQuery } from "../db/client.js";

export const SOURCE_LIST_STATUSES = [
  "pending_review",
  "not_admitted",
  "queued",
  "reading",
  "extracted",
  "failed",
  "recorded",
] as const;
export type SourceListStatus = (typeof SOURCE_LIST_STATUSES)[number];

export interface SourceListItem {
  id: string;
  title: string;
  url: string | null;
  kind: string;
  label: string;
  party: { id: string; name: string } | null;
  status: SourceListStatus;
  /** The submission the status is read from, where there is one: the latest. */
  contribution_id: string | null;
  /** The display name of whoever first submitted it; null where no person did. */
  added_by: string | null;
  /** When it was first submitted, or, with no submission, when its row was recorded. */
  added_at: string;
}

export interface SourceList {
  sources: SourceListItem[];
  /** Over every source the caller may read, before `label` and `party` narrow the page. */
  counts: { sources: number; with_no_party: number; pending_review: number };
  /** How many match `label` and `party`: the length of the whole list being paged. */
  total: number;
}

export const SOURCE_LIST_MAX_LIMIT = 100;

/** A party filter: one party's id, or "none" for sources no party is recorded for. */
export type PartyFilter = string | "none";

const REVIEW_WAITING = ["pending", "escalated", "human_review", "checking"];

export async function listSources(
  clearance: readonly string[],
  opts: { limit?: number; offset?: number; label?: string; party?: PartyFilter } = {}
): Promise<SourceList> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), SOURCE_LIST_MAX_LIMIT);
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const labels = [...clearance];

  // The submissions of a source: the first says who added it and when, the
  // latest where its review stands.
  const submissions = `
    first_sub AS (
      SELECT DISTINCT ON (source_id) source_id, contributor_id, submitted_at
        FROM contributions
       WHERE contribution_type = 'propose_source' AND source_id IS NOT NULL
       ORDER BY source_id, submitted_at ASC, id ASC
    ),
    last_sub AS (
      SELECT DISTINCT ON (source_id) source_id, id, review_status
        FROM contributions
       WHERE contribution_type = 'propose_source' AND source_id IS NOT NULL
       ORDER BY source_id, submitted_at DESC, id DESC
    )`;

  const filters: string[] = [`s.origin = 'local'`, `s.sensitivity_label = ANY($1::text[])`];
  const params: unknown[] = [labels];
  if (opts.label) {
    params.push(opts.label);
    filters.push(`s.sensitivity_label = $${params.length}`);
  }
  if (opts.party === "none") filters.push(`s.party_id IS NULL`);
  else if (opts.party) {
    params.push(opts.party);
    filters.push(`s.party_id = $${params.length}::uuid`);
  }

  const [counted] = await rawQuery<{ sources: number; with_no_party: number; pending_review: number }>(
    `WITH ${submissions}
     SELECT count(*)::int AS sources,
            count(*) FILTER (WHERE s.party_id IS NULL)::int AS with_no_party,
            count(*) FILTER (WHERE l.review_status = ANY($2::text[]))::int AS pending_review
       FROM sources s
       LEFT JOIN last_sub l ON l.source_id = s.id
      WHERE s.origin = 'local' AND s.sensitivity_label = ANY($1::text[])`,
    [labels, REVIEW_WAITING]
  );

  const [{ total } = { total: 0 }] = await rawQuery<{ total: number }>(
    `SELECT count(*)::int AS total FROM sources s WHERE ${filters.join(" AND ")}`,
    params
  );

  params.push(limit, offset);
  const rows = await rawQuery<{
    id: string;
    title: string;
    url: string | null;
    source_type: string;
    label: string;
    party_id: string | null;
    party_name: string | null;
    contribution_id: string | null;
    review_status: string | null;
    added_by: string | null;
    added_at: Date | string;
  }>(
    `WITH ${submissions}
     SELECT s.id, s.title, s.url, s.source_type, s.sensitivity_label AS label,
            p.id AS party_id, p.name AS party_name,
            l.id AS contribution_id, l.review_status,
            c.display_name AS added_by,
            COALESCE(f.submitted_at, s.retrieved_at) AS added_at
       FROM sources s
       LEFT JOIN parties p ON p.id = s.party_id
       LEFT JOIN first_sub f ON f.source_id = s.id
       LEFT JOIN last_sub l ON l.source_id = s.id
       LEFT JOIN contributors c ON c.id = f.contributor_id
      WHERE ${filters.join(" AND ")}
      ORDER BY COALESCE(f.submitted_at, s.retrieved_at) DESC, s.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // The latest reading of each source on the page, and who asked for it
  // where no submission says who added the source.
  const ids = rows.map((r) => r.id);
  const jobs = ids.length
    ? await rawQuery<{ source_id: string; status: string; user_name: string | null }>(
        `SELECT DISTINCT ON (j.input->>'sourceId') j.input->>'sourceId' AS source_id, j.status,
                c.display_name AS user_name
           FROM jobs j
           LEFT JOIN contributors c ON c.id = j.user_id
          WHERE j.type = 'url_extraction' AND j.input->>'sourceId' = ANY($1::text[])
          ORDER BY j.input->>'sourceId', j.created_at DESC`,
        [ids]
      )
    : [];
  const jobOf = new Map(jobs.map((j) => [j.source_id, j]));

  return {
    sources: rows.map((r) => {
      const job = jobOf.get(r.id);
      return {
        id: r.id,
        title: r.title,
        url: r.url,
        kind: r.source_type,
        label: r.label,
        party: r.party_id ? { id: r.party_id, name: r.party_name ?? "" } : null,
        status: statusOf(r.review_status, job?.status ?? null),
        contribution_id: r.contribution_id,
        added_by: r.added_by ?? (r.contribution_id ? null : job?.user_name ?? null),
        added_at: new Date(r.added_at).toISOString(),
      };
    }),
    counts: counted ?? { sources: 0, with_no_party: 0, pending_review: 0 },
    total,
  };
}

/** Where a source stands, from its latest submission's review and its latest reading. */
export function statusOf(reviewStatus: string | null, jobStatus: string | null): SourceListStatus {
  if (reviewStatus !== null && REVIEW_WAITING.includes(reviewStatus)) return "pending_review";
  if (reviewStatus === "rejected") return "not_admitted";
  switch (jobStatus) {
    case "pending":
      return "queued";
    case "processing":
    case "running":
      return "reading";
    case "completed":
      return "extracted";
    case "failed":
    case "cancelled":
      return "failed";
  }
  // Admitted, with its reading not yet made a job of.
  if (reviewStatus === "accepted") return "queued";
  return "recorded";
}
