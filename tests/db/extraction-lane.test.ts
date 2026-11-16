/**
 * The extraction lane over real SQL (docs/infrastructure.md, "The extraction
 * lane"): a job is taken up with an attempt number that is the run's hold on
 * it; the public ledger and a mandate's pipeline tell an extraction waiting
 * its turn from one being read, with roughly how many are ahead of it; and
 * the recovery sweep gives up on an extraction that stopped and puts its
 * ledger row back in line, without touching one that is moving or queued.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { seedGrantWithJob, seedUser } from "./helpers.js";
import { createJob, startJobAttempt, stillHoldsJob } from "../../src/services/job-service.js";
import { sweepStalledIngests, ingestStallMinutes } from "../../src/workers/recovery-sweep.js";
import { getMandatePipeline } from "../../src/services/mandate-service.js";
import { recordGrantSource } from "../../src/services/action-service.js";

/** A running ingest row and the extraction job behind it. */
async function runningIngest(opts: {
  jobStatus?: string;
  /** Minutes since the job last made progress (heartbeat). */
  idleMinutes?: number;
  /** Minutes since the job was created. */
  ageMinutes?: number;
}): Promise<{ actionId: string; jobId: string; url: string }> {
  const url = `https://example.org/${randomUUID()}`;
  const [action] = await rawQuery<{ id: string }>(
    `INSERT INTO actions (kind, exclusion_group, target_ref, label, cost_est_micro_usd, status)
     VALUES ('ingest', $1, $2, 'Ingest a page', 100000, 'running') RETURNING id`,
    [`ingest:${url}`, url]
  );
  const job = await createJob("url_extraction", { sourceId: randomUUID(), url }, undefined, action!.id);
  const status = opts.jobStatus ?? "processing";
  await rawQuery(
    `UPDATE jobs
        SET status = $2,
            created_at = now() - make_interval(mins => $3::int),
            started_at = CASE WHEN $2 = 'processing' THEN now() - make_interval(mins => $4::int) END,
            heartbeat_at = CASE WHEN $2 = 'processing' THEN now() - make_interval(mins => $4::int) END,
            attempts = CASE WHEN $2 = 'processing' THEN 1 ELSE 0 END
      WHERE id = $1`,
    [job.id, status, opts.ageMinutes ?? (opts.idleMinutes ?? 0) + 1, opts.idleMinutes ?? 0]
  );
  return { actionId: action!.id, jobId: job.id, url };
}

async function actionStatus(id: string): Promise<string> {
  const [row] = await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE id = $1`, [id]);
  return row!.status;
}

async function job(id: string) {
  const [row] = await rawQuery<{ status: string; result: Record<string, unknown> | null; error: string | null }>(
    `SELECT status, result, error FROM jobs WHERE id = $1`,
    [id]
  );
  return row!;
}

const config = loadConfig();
const sqsBefore = config.sqsUrlExtractionQueue;
afterEach(() => {
  config.sqsUrlExtractionQueue = sqsBefore;
});

describe("a run's hold on its job", () => {
  it("is its attempt number, lost when a later attempt takes the job up", async () => {
    const job1 = await createJob("url_extraction", { url: "https://example.org/x" });
    const first = await startJobAttempt(job1.id);
    expect(first).toEqual({ attempt: 1 });
    expect(await stillHoldsJob(job1.id, 1)).toBe(true);
    const second = await startJobAttempt(job1.id);
    expect(second).toEqual({ attempt: 2 });
    expect(await stillHoldsJob(job1.id, 1)).toBe(false);
    expect(await stillHoldsJob(job1.id, 2)).toBe(true);
    const [row] = await rawQuery<{ status: string; started_at: Date | null }>(
      `SELECT status, started_at FROM jobs WHERE id = $1`,
      [job1.id]
    );
    expect(row).toMatchObject({ status: "processing" });
    expect(row!.started_at).not.toBeNull();
  });

  it("is never given for a job that completed or that the sweep abandoned", async () => {
    const done = await createJob("url_extraction", { url: "https://example.org/done" });
    await rawQuery(`UPDATE jobs SET status = 'completed' WHERE id = $1`, [done.id]);
    expect(await startJobAttempt(done.id)).toBeNull();
    const abandoned = await createJob("url_extraction", { url: "https://example.org/gone" });
    await rawQuery(`UPDATE jobs SET status = 'failed', result = '{"abandoned": true}' WHERE id = $1`, [abandoned.id]);
    expect(await startJobAttempt(abandoned.id)).toBeNull();
    // A job that failed for its own reasons is run again when its message is.
    const failed = await createJob("url_extraction", { url: "https://example.org/failed" });
    await rawQuery(`UPDATE jobs SET status = 'failed', error = 'boom' WHERE id = $1`, [failed.id]);
    expect(await startJobAttempt(failed.id)).toEqual({ attempt: 1 });
  });
});

describe("the recovery sweep's ingest pass", () => {
  it("gives up on an extraction that stopped and reopens its row, once", async () => {
    const stalled = await runningIngest({ idleMinutes: ingestStallMinutes() + 5 });
    const stats = await sweepStalledIngests();
    expect(stats.reopened).toBeGreaterThanOrEqual(1);
    expect(await actionStatus(stalled.actionId)).toBe("open");
    const j = await job(stalled.jobId);
    expect(j.status).toBe("failed");
    expect(j.result).toMatchObject({ abandoned: true, retried_by_platform: true });
    expect(j.error).toMatch(/submits it again/);
    // The run that held it has lost its hold, and the job is not run again.
    expect(await stillHoldsJob(stalled.jobId, 1)).toBe(false);
    expect(await startJobAttempt(stalled.jobId)).toBeNull();
    // A second sweep finds nothing more to do with it.
    await sweepStalledIngests();
    expect(await actionStatus(stalled.actionId)).toBe("open");
  });

  it("leaves an extraction that is moving, and one waiting in a durable queue", async () => {
    const moving = await runningIngest({ idleMinutes: 2, ageMinutes: 300 });
    config.sqsUrlExtractionQueue = "https://sqs.example/queue";
    const queued = await runningIngest({ jobStatus: "pending", ageMinutes: 600 });
    await sweepStalledIngests();
    expect(await actionStatus(moving.actionId)).toBe("running");
    expect((await job(moving.jobId)).status).toBe("processing");
    expect(await actionStatus(queued.actionId)).toBe("running");
    expect((await job(queued.jobId)).status).toBe("pending");
  });

  it("with in-memory queues, gives up on a queued job a restart lost", async () => {
    config.sqsUrlExtractionQueue = "";
    const lost = await runningIngest({ jobStatus: "pending", ageMinutes: ingestStallMinutes() + 5 });
    const fresh = await runningIngest({ jobStatus: "pending", ageMinutes: 1 });
    await sweepStalledIngests();
    expect(await actionStatus(lost.actionId)).toBe("open");
    expect((await job(lost.jobId)).result).toMatchObject({ abandoned: true });
    expect(await actionStatus(fresh.actionId)).toBe("running");
  });

  it("cancels the row instead after it has given up on its extraction three times", async () => {
    const first = await runningIngest({ idleMinutes: ingestStallMinutes() + 5 });
    // Two earlier extractions of the same row were abandoned already.
    for (let i = 0; i < 2; i++) {
      const old = await createJob("url_extraction", { url: first.url }, undefined, first.actionId);
      await rawQuery(`UPDATE jobs SET status = 'failed', result = '{"abandoned": true}' WHERE id = $1`, [old.id]);
    }
    const stats = await sweepStalledIngests();
    expect(stats.cancelled).toBeGreaterThanOrEqual(1);
    expect(await actionStatus(first.actionId)).toBe("cancelled");
    const j = await job(first.jobId);
    expect(j.error).toMatch(/does not submit it again/);
    expect(j.result).not.toHaveProperty("retried_by_platform");
  });
});

describe("queued or being read", () => {
  it("the public ledger says which, and about how many wait ahead of a queued one", async () => {
    const reading = await runningIngest({ idleMinutes: 1 });
    const earlier = await runningIngest({ jobStatus: "pending", ageMinutes: 20 });
    const later = await runningIngest({ jobStatus: "pending", ageMinutes: 10 });
    const rows = await rawQuery<{
      action_id: string;
      extraction: string | null;
      extraction_started_at: Date | null;
      queued_ahead: string | null;
    }>(
      `SELECT action_id, extraction, extraction_started_at, queued_ahead
         FROM public_read.ledger WHERE action_id = ANY($1::uuid[])`,
      [[reading.actionId, earlier.actionId, later.actionId]]
    );
    const by = new Map(rows.map((r) => [r.action_id, r]));
    expect(by.get(reading.actionId)).toMatchObject({ extraction: "extracting", queued_ahead: null });
    expect(by.get(reading.actionId)!.extraction_started_at).not.toBeNull();
    expect(by.get(earlier.actionId)).toMatchObject({ extraction: "queued", extraction_started_at: null });
    expect(by.get(later.actionId)!.extraction).toBe("queued");
    expect(Number(by.get(later.actionId)!.queued_ahead) - Number(by.get(earlier.actionId)!.queued_ahead)).toBe(1);
  });

  it("says nothing of extraction on rows that are not running ingests", async () => {
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO actions (kind, exclusion_group, label, cost_est_micro_usd, status)
       VALUES ('curate', $1, 'Curate', 100000, 'running') RETURNING id`,
      [`curate:${randomUUID()}`]
    );
    const [view] = await rawQuery<{ extraction: string | null; queued_ahead: string | null }>(
      `SELECT extraction, queued_ahead FROM public_read.ledger WHERE action_id = $1`,
      [row!.id]
    );
    expect(view).toEqual({ extraction: null, queued_ahead: null });
  });

  it("a mandate's pipeline gives each source's stage, its start, and its place in line", async () => {
    const funder = await seedUser("lane");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10_000_000 });
    const make = async (status: string, ageMinutes: number) => {
      const url = `https://example.org/${randomUUID()}`;
      const [source] = await rawQuery<{ id: string }>(`INSERT INTO sources (url, title, source_type) VALUES ($1, 'A page', 'journal_article') RETURNING id`, [url]);
      const j = await createJob("url_extraction", { sourceId: source!.id, url });
      await rawQuery(
        `UPDATE jobs SET status = $2, created_at = now() - make_interval(mins => $3::int),
                started_at = CASE WHEN $2 <> 'pending' THEN now() END
          WHERE id = $1`,
        [j.id, status, ageMinutes]
      );
      await recordGrantSource(grantId, source!.id, url, j.id);
      return source!.id;
    };
    const first = await make("pending", 2000);
    const second = await make("pending", 1990);
    const reading = await make("processing", 40);
    const done = await make("completed", 50);
    const rows = new Map((await getMandatePipeline(grantId)).map((r) => [r.source_id, r]));
    expect(rows.get(first)).toMatchObject({ extraction_stage: "queued", extraction_started_at: null });
    expect(rows.get(second)!.extraction_queued_ahead! - rows.get(first)!.extraction_queued_ahead!).toBe(1);
    expect(rows.get(reading)).toMatchObject({ extraction_stage: "extracting", extraction_queued_ahead: null });
    expect(rows.get(reading)!.extraction_started_at).not.toBeNull();
    expect(rows.get(done)).toMatchObject({ extraction_stage: "done", extraction_status: "completed" });
  });
});
