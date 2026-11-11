import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { currentLabel } from "../llm/usage-context.js";

/**
 * Attribution for per-token metering (#70): which account/key requested this
 * job. Workers restore it into the LLM usage context so background agent
 * work is billed to the requester. Omitted = system-initiated.
 */
export interface JobAttribution {
  userId?: string | null;
  apiKeyId?: string | null;
}

export async function createJob(
  type: string,
  input: Record<string, unknown>,
  attribution?: JobAttribution
) {
  const db = getDb();
  const [job] = await db
    .insert(jobs)
    .values({
      type,
      input,
      userId: attribution?.userId ?? null,
      apiKeyId: attribution?.apiKeyId ?? null,
      // The worker that picks the job up runs at this (src/labels.ts).
      sensitivityLabel: currentLabel(),
    })
    .returning();
  return job!;
}

export async function getJobById(jobId: string) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  return job ?? null;
}

export async function updateJob(
  jobId: string,
  updates: {
    status?: string;
    result?: Record<string, unknown>;
    error?: string;
  }
) {
  const db = getDb();
  const [updated] = await db
    .update(jobs)
    .set({
      ...updates,
      // The database's clock, not the worker's: a mandate's event scan reads
      // completed_at against its own watermark (mandate-event-service.ts).
      ...(updates.status === "completed" || updates.status === "failed"
        ? { completedAt: sql`now()` }
        : {}),
    })
    .where(eq(jobs.id, jobId))
    .returning();
  return updated ?? null;
}
