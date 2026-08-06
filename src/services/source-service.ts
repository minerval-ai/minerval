import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sources } from "../db/schema.js";
import { createJob, type JobAttribution } from "./job-service.js";
import { enqueueUrlExtraction } from "./queue-service.js";

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
  if (existing) return existing;

  const [source] = await db
    .insert(sources)
    .values({
      url: input.url,
      title: input.title ?? input.url,
      rawContent: input.content,
    })
    .returning();
  return source!;
}

export async function submitSource(
  input: {
    url: string;
    title?: string;
    content?: string;
  },
  attribution?: JobAttribution & { meterJobId?: string }
) {
  const source = await getOrCreateSource(input);

  const job = await createJob(
    "url_extraction",
    {
      sourceId: source.id,
      url: input.url,
    },
    attribution
  );

  await enqueueUrlExtraction({
    sourceId: source.id,
    jobId: job.id,
    url: input.url,
    ...(attribution?.meterJobId ? { meterJobId: attribution.meterJobId } : {}),
  });

  return { sourceId: source.id, jobId: job.id };
}
