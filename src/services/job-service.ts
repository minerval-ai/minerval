import { eq, sql } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
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
  attribution?: JobAttribution,
  /** The ledger row this job executes, if one is behind it. */
  actionId?: string | null
) {
  const db = getDb();
  const [job] = await db
    .insert(jobs)
    .values({
      type,
      input,
      userId: attribution?.userId ?? null,
      apiKeyId: attribution?.apiKeyId ?? null,
      actionId: actionId ?? null,
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

/**
 * A worker takes a job up: it is 'processing' from now, with its start,
 * its attempt number and its first heartbeat stamped. Null when the job is
 * not to be run: it completed already (a message delivered twice), or the
 * recovery sweep gave up on it and its ledger row has submitted the source
 * again under a new job (result.abandoned). The attempt number is the run's
 * hold on the job (stillHoldsJob).
 */
export async function startJobAttempt(jobId: string): Promise<{ attempt: number } | null> {
  const [row] = await rawQuery<{ attempts: number }>(
    `UPDATE jobs
        SET status = 'processing', attempts = attempts + 1,
            started_at = now(), heartbeat_at = now()
      WHERE id = $1
        AND status <> 'completed'
        AND NOT (status = 'failed' AND COALESCE(result->>'abandoned', '') = 'true')
      RETURNING attempts`,
    [jobId]
  );
  return row ? { attempt: Number(row.attempts) } : null;
}

/**
 * Stamp progress on a job the run still holds, and say whether it does. A
 * run loses its hold when a later attempt took the job up (the lane gave up
 * on this one and the message was delivered again) or the job left
 * 'processing' (the recovery sweep abandoned it).
 */
export async function stillHoldsJob(jobId: string, attempt: number): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE jobs SET heartbeat_at = now()
      WHERE id = $1 AND attempts = $2 AND status = 'processing'
      RETURNING id`,
    [jobId, attempt]
  );
  return rows.length > 0;
}
