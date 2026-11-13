import { eq } from "drizzle-orm";
import { rawQuery } from "../db/client.js";
import { normalizePageUrl, pageUrlHash } from "./page-url.js";
import { getDb } from "../db/client.js";
import { sources } from "../db/schema.js";
import { createJob, type JobAttribution } from "./job-service.js";
import { sourceContentHash } from "./source-content.js";
import { enqueueUrlExtraction } from "./queue-service.js";
import { GENERIC_SOURCE_KINDS, type SourceKind } from "../schemas/common.js";
import { currentLabel } from "../llm/usage-context.js";

/**
 * Find or create the source row for a URL, without enqueueing extraction.
 * The row is inert on its own (no read path reaches a source except through
 * claim instances), so intake review (#157) can store a submission verbatim
 * before deciding whether to process it.
 */
export async function getOrCreateSource(input: {
  url: string;
  title?: string;
  content?: string;
}) {
  const db = getDb();

  const [existing] = await db
    .select()
    .from(sources)
    .where(eq(sources.url, input.url))
    .limit(1);
  if (existing) {
    // A row can exist with no content before anyone submits the document:
    // the Steward records the URLs it cites as sources. A later submission
    // that carries the text fills it in (and a placeholder title), or the
    // extraction worker re-fetches a URL the caller already had the text
    // for — arxiv answered that fetch with a 403 and a corpus post was lost.
    if (!existing.rawContent && input.content) {
      const [updated] = await db
        .update(sources)
        .set({
          rawContent: input.content,
          contentHash: sourceContentHash(input.content),
          ...(input.title && existing.title === existing.url ? { title: input.title } : {}),
        })
        .where(eq(sources.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }

  const [source] = await db
    .insert(sources)
    .values({
      url: input.url,
      title: input.title ?? input.url,
      rawContent: input.content,
      contentHash: sourceContentHash(input.content),
      pageUrlHash: pageHashOf(input.url),
      // The label of the run recording it (src/labels.ts); a plain request
      // outside any run records it as public.
      sensitivityLabel: currentLabel(),
    })
    .returning();
  return source!;
}

export interface SourceKindOutcome {
  /** The source's kind after the call. */
  source_kind: string;
  /** Present when the kind stated was not taken, saying why and what to do. */
  source_kind_note?: string;
}

/**
 * Record what kind of document a source is, as an agent says it
 * (SOURCE_KIND_DESCRIPTIONS). A citing agent fills the kind only where none
 * more specific is recorded: "unknown", or "webpage" giving way to a
 * specific kind. An agent that read the document (`read`) corrects it,
 * since it has seen what the first to cite it may only have assumed. The
 * outcome says what the source's kind now is, so an agent whose kind was not
 * taken is told so rather than left to think it was.
 */
export async function recordSourceKind(
  sourceId: string,
  kind: SourceKind,
  opts: { read?: boolean } = {}
): Promise<SourceKindOutcome> {
  const [row] = await rawQuery<{ before: string; after: string }>(
    `WITH prior AS (SELECT source_type FROM sources WHERE id = $1 FOR UPDATE),
          changed AS (
            UPDATE sources s SET source_type = $2
              FROM prior
             WHERE s.id = $1 AND prior.source_type <> $2
               AND ($3::boolean OR prior.source_type = 'unknown'
                    OR (prior.source_type = 'webpage' AND NOT $2 = ANY($4::text[])))
            RETURNING s.source_type)
     SELECT prior.source_type AS before,
            COALESCE((SELECT source_type FROM changed), prior.source_type) AS after
       FROM prior`,
    [sourceId, kind, opts.read === true, [...GENERIC_SOURCE_KINDS]]
  );
  if (!row) return { source_kind: kind };
  if (row.after === kind) return { source_kind: kind };
  return {
    source_kind: row.after,
    source_kind_note:
      `This source is already recorded as "${row.after}", so "${kind}" was not taken. ` +
      `If "${row.after}" is wrong, open the document (provenance_read_source) and state its kind ` +
      `on a reading of it (provenance_record_reading with source_read true), which corrects it.`,
  };
}

/** A source URL's page hash (sources.page_url_hash); '' when it is not a web page. */
export function pageHashOf(url: string): string {
  const normalized = normalizePageUrl(url);
  return normalized ? pageUrlHash(normalized) : "";
}

/**
 * Give a page hash to every source that has a URL and no hash yet: the rows
 * from before the column existed, and any written by a path that does not
 * set it. Run at startup. The update lands only where the hash is still
 * null, so every task may run it.
 */
export async function fillSourcePageHashes(batch = 500): Promise<number> {
  let filled = 0;
  for (;;) {
    const rows = await rawQuery<{ id: string; url: string }>(
      // A mirrored source's hash comes with its row from the public graph.
      `SELECT id, url FROM sources
        WHERE url IS NOT NULL AND page_url_hash IS NULL AND origin = 'local'
        ORDER BY id LIMIT $1`,
      [batch]
    );
    if (rows.length === 0) return filled;
    await rawQuery(
      `UPDATE sources s SET page_url_hash = v.hash
         FROM unnest($1::uuid[], $2::text[]) AS v(id, hash)
        WHERE s.id = v.id AND s.page_url_hash IS NULL`,
      [rows.map((r) => r.id), rows.map((r) => pageHashOf(r.url))]
    );
    filled += rows.length;
  }
}

export async function submitSource(
  input: {
    url: string;
    title?: string;
    content?: string;
  },
  attribution?: JobAttribution & { meterJobId?: string },
  /**
   * A scoped ingest's focus and ledger group, the mandate behind it, and
   * the ledger row the extraction executes (stamped on the job, so the row
   * can say whether its extraction is queued or being read).
   */
  scope?: { focus?: string | null; ingestGroup?: string; grantId?: string; actionId?: string }
) {
  const source = await getOrCreateSource(input);

  const job = await createJob(
    "url_extraction",
    {
      sourceId: source.id,
      url: input.url,
      ...(scope?.focus ? { focus: scope.focus } : {}),
    },
    attribution,
    scope?.actionId ?? null
  );

  await enqueueUrlExtraction({
    sourceId: source.id,
    jobId: job.id,
    url: input.url,
    ...(attribution?.meterJobId ? { meterJobId: attribution.meterJobId } : {}),
    ...(scope?.focus ? { focus: scope.focus } : {}),
    ...(scope?.ingestGroup ? { ingestGroup: scope.ingestGroup } : {}),
    ...(scope?.grantId ? { grantId: scope.grantId } : {}),
  });

  return { sourceId: source.id, jobId: job.id };
}
