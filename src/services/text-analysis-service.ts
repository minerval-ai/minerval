/**
 * Text analyses run in the background: the MCP tools extract_claims and
 * assess_text run an Extractor pass and, for assess_text, a Matcher loop per
 * claim, which together take minutes, longer than an MCP tool call should
 * be held open. The tool starts the analysis and returns a job id at once;
 * get_text_analysis reads it until it is complete.
 *
 * An analysis is a row in `jobs` (type extract_claims | assess_text),
 * attributed to the account that asked. Its result is that account's alone:
 * the text was theirs, so these jobs are readable only through
 * getTextAnalysis, never through the public GET /jobs/:id. The text itself
 * is not stored, only the parameters.
 *
 * A running analysis refreshes a heartbeat in its result, and saves its
 * progress as it goes (assess_text, one judgment at a time), so a caller
 * reading it sees the work arrive. One whose heartbeat has gone stale lost
 * its process (a deploy, a crash) and reads as failed.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { jobs, type Job } from "../db/schema.js";

export const TEXT_ANALYSIS_TYPES = ["extract_claims", "assess_text"] as const;
export type TextAnalysisType = (typeof TEXT_ANALYSIS_TYPES)[number];

export function isTextAnalysisType(type: string): type is TextAnalysisType {
  return (TEXT_ANALYSIS_TYPES as readonly string[]).includes(type);
}

/** How often a running analysis refreshes its heartbeat. */
const HEARTBEAT_MS = 30_000;
/**
 * A heartbeat older than this means the analysis lost its process. A
 * liveness check, not a limit on the work: an analysis that is still running
 * refreshes its heartbeat however long it takes.
 */
const LOST_AFTER_MS = 120_000;

// In-flight analyses, so tests (and a graceful shutdown) can wait for them.
const pending = new Set<Promise<void>>();

/** Test hook: resolves once every analysis started so far has finished. */
export async function settleTextAnalyses(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

export interface TextAnalysisOwner {
  userId: string | null;
  apiKeyId: string | null;
}

/** Progress the work reports as it goes; merged into the job's result. */
export type ReportProgress = (progress: Record<string, unknown>) => Promise<void>;

/**
 * Record a new analysis and run `work` in the background. `work` returns
 * the finished result; it may call `progress` with partial results first.
 * Returns the job at once, before any work has run.
 */
export async function startTextAnalysis(
  type: TextAnalysisType,
  params: Record<string, unknown>,
  owner: TextAnalysisOwner,
  work: (progress: ReportProgress) => Promise<Record<string, unknown>>
): Promise<Job> {
  const db = getDb();
  const [job] = await db
    .insert(jobs)
    .values({
      type,
      status: "processing",
      input: params,
      result: { heartbeat_at: new Date().toISOString() },
      userId: owner.userId,
      apiKeyId: owner.apiKeyId,
    })
    .returning();
  const id = job!.id;
  const running = eq(jobs.id, id);
  const stillRunning = and(running, eq(jobs.status, "processing"));

  // Merge into result while the job is still processing; a job already
  // settled (or marked lost) is never written over.
  const merge = (fields: Record<string, unknown>) =>
    db
      .update(jobs)
      .set({ result: sql`COALESCE(${jobs.result}, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb` })
      .where(stillRunning);

  const run = (async () => {
    const heartbeat = setInterval(() => {
      void merge({ heartbeat_at: new Date().toISOString() }).catch((err) =>
        console.error(`[text-analysis] heartbeat failed on ${id}:`, err)
      );
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      const result = await work(async (progress) => {
        await merge({ ...progress, heartbeat_at: new Date().toISOString() });
      });
      await db
        .update(jobs)
        .set({ status: "complete", result, completedAt: new Date() })
        .where(stillRunning);
    } catch (err) {
      console.error(`[text-analysis] ${type} ${id} failed:`, err);
      await db
        .update(jobs)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          completedAt: new Date(),
        })
        .where(stillRunning)
        .catch((e) => console.error(`[text-analysis] recording the failure on ${id} failed:`, e));
    } finally {
      clearInterval(heartbeat);
    }
  })().finally(() => pending.delete(run));
  pending.add(run);
  return job!;
}

export interface TextAnalysisView {
  job_id: string;
  type: TextAnalysisType;
  status: "processing" | "complete" | "failed";
  /** The finished result, or the progress so far while processing. */
  result: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

/**
 * One analysis, for the account that asked for it; null for anyone else,
 * or for an id that is not a text analysis.
 */
export async function getTextAnalysis(
  jobId: string,
  owner: TextAnalysisOwner,
  now = Date.now()
): Promise<TextAnalysisView | null> {
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job || !isTextAnalysisType(job.type)) return null;
  const mine = job.userId ? job.userId === owner.userId : !!job.apiKeyId && job.apiKeyId === owner.apiKeyId;
  if (!mine) return null;

  const { heartbeat_at, ...result } = (job.result ?? {}) as Record<string, unknown>;
  const lost =
    job.status === "processing" &&
    typeof heartbeat_at === "string" &&
    Date.parse(heartbeat_at) < now - LOST_AFTER_MS;
  return {
    job_id: job.id,
    type: job.type,
    status: lost ? "failed" : (job.status as TextAnalysisView["status"]),
    result: Object.keys(result).length > 0 ? result : null,
    error: lost
      ? "The analysis was interrupted (the server restarted) before it finished; start it again"
      : job.error,
    started_at: job.createdAt.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
  };
}
