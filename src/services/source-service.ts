import { eq } from "drizzle-orm";
import { rawQuery } from "../db/client.js";
import { normalizePageUrl, pageUrlHash } from "./page-url.js";
import { getDb } from "../db/client.js";
import { sources } from "../db/schema.js";
import { createJob, type JobAttribution } from "./job-service.js";
import { sourceContentHash } from "./source-content.js";
import { enqueueUrlExtraction } from "./queue-service.js";
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
      `SELECT id, url FROM sources
        WHERE url IS NOT NULL AND page_url_hash IS NULL
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
  /** A scoped ingest's focus and ledger group, and the mandate behind it. */
  scope?: { focus?: string | null; ingestGroup?: string; grantId?: string }
) {
  const source = await getOrCreateSource(input);

  const job = await createJob(
    "url_extraction",
    {
      sourceId: source.id,
      url: input.url,
      ...(scope?.focus ? { focus: scope.focus } : {}),
    },
    attribution
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
