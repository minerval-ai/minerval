/**
 * Budget jobs — escrowed owl budgets funding open-ended work.
 *
 * Flat prices fit bounded operations; anything whose cost can't be known up
 * front (deep decomposition today, grantor agents later) is funded with a
 * budget the user chooses. Funding escrows the owls immediately (an
 * owl_ledger escrow_hold behind the same balance guard as a charge), real
 * spend accrues via llm_usage rows attributed with job_id = the budget job's
 * id, and settlement returns the unspent remainder (escrow_refund). At the
 * budget floor the job PAUSES with a progress checkpoint and waits for a
 * top-up — it never silently dies mid-run (src/workers/budget-job-pipeline.ts).
 */
import { desc, eq } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { budgetJobs, type BudgetJob } from "../db/schema.js";
import { owlsToMicroUsd, microUsdToOwls } from "./owl.js";
import { recordOwlEntry, OWL_REASONS } from "./owl-ledger-service.js";

/**
 * Escrow owls into a job behind the balance guard: the hold is written only
 * if the spendable balance covers it (same single-statement race posture as
 * chargeOwls). Returns false when the balance was insufficient.
 */
async function holdOwls(input: {
  userId: string;
  amountMicroUsd: number;
  jobId: string;
}): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
     SELECT $1, $2, 'escrow_hold', $3
      WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0)
               FROM owl_ledger WHERE user_id = $1) >= $4
     RETURNING id`,
    [input.userId, -input.amountMicroUsd, input.jobId, input.amountMicroUsd]
  );
  return rows.length > 0;
}

export type FundJobResult =
  | { ok: true; job: BudgetJob }
  | { ok: false; code: "INSUFFICIENT_OWLS" | "CLAIM_NOT_FOUND"; message: string };

/** Create and fund a deep-decomposition job on a claim. */
export async function createDeepDecompositionJob(input: {
  userId: string;
  claimId: string;
  budgetOwls: number;
}): Promise<FundJobResult> {
  const [claim] = await rawQuery<{ id: string }>(
    `SELECT id FROM claims WHERE id = $1 AND state = 'active'`,
    [input.claimId]
  );
  if (!claim) {
    return {
      ok: false,
      code: "CLAIM_NOT_FOUND",
      message: "Claim not found or not active",
    };
  }

  const db = getDb();
  const budgetMicro = owlsToMicroUsd(input.budgetOwls);
  const [job] = await db
    .insert(budgetJobs)
    .values({
      userId: input.userId,
      kind: "deep_decomposition",
      claimId: input.claimId,
      budgetMicroUsd: 0, // set by the hold below, so a failed hold leaves 0
      status: "running",
    })
    .returning();

  const held = await holdOwls({
    userId: input.userId,
    amountMicroUsd: budgetMicro,
    jobId: job!.id,
  });
  if (!held) {
    await db.delete(budgetJobs).where(eq(budgetJobs.id, job!.id));
    return {
      ok: false,
      code: "INSUFFICIENT_OWLS",
      message: `Funding this job takes ${input.budgetOwls} owls and your balance can't cover it`,
    };
  }
  const [funded] = await db
    .update(budgetJobs)
    .set({ budgetMicroUsd: budgetMicro })
    .where(eq(budgetJobs.id, job!.id))
    .returning();
  return { ok: true, job: funded! };
}

export type TopUpResult =
  | { ok: true; job: BudgetJob }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_TOPPABLE" | "INSUFFICIENT_OWLS";
      message: string;
    };

/**
 * Add owls to a job's budget; a paused job resumes. The owner path
 * (topUpBudgetJob) requires the job to be the caller's; the contribution
 * path (contributeToBudgetJob) lets ANY signed-in user add owls — mandates
 * are public things people can put their owls behind. Every hold is a
 * per-user escrow row, so settlement can refund contributors pro rata.
 */
async function addBudget(input: {
  job: BudgetJob;
  userId: string;
  owls: number;
}): Promise<TopUpResult> {
  const db = getDb();
  const { job } = input;
  if (job.status !== "running" && job.status !== "paused_budget") {
    return {
      ok: false,
      code: "NOT_TOPPABLE",
      message: `Job is ${job.status}; only running or paused jobs can be topped up`,
    };
  }
  const amountMicro = owlsToMicroUsd(input.owls);
  const held = await holdOwls({
    userId: input.userId,
    amountMicroUsd: amountMicro,
    jobId: job.id,
  });
  if (!held) {
    return {
      ok: false,
      code: "INSUFFICIENT_OWLS",
      message: `Adding ${input.owls} owls exceeds your balance`,
    };
  }
  const [updated] = await db
    .update(budgetJobs)
    .set({
      budgetMicroUsd: Number(job.budgetMicroUsd) + amountMicro,
      status: "running",
      updatedAt: new Date(),
    })
    .where(eq(budgetJobs.id, job.id))
    .returning();
  return { ok: true, job: updated! };
}

export async function topUpBudgetJob(input: {
  jobId: string;
  userId: string;
  owls: number;
}): Promise<TopUpResult> {
  const db = getDb();
  const [job] = await db
    .select()
    .from(budgetJobs)
    .where(eq(budgetJobs.id, input.jobId))
    .limit(1);
  if (!job || job.userId !== input.userId) {
    return { ok: false, code: "NOT_FOUND", message: "Job not found" };
  }
  return addBudget({ job, userId: input.userId, owls: input.owls });
}

/** A public contribution: anyone's owls, into any running/paused job. */
export async function contributeToBudgetJob(input: {
  jobId: string;
  userId: string;
  owls: number;
}): Promise<TopUpResult> {
  const db = getDb();
  const [job] = await db
    .select()
    .from(budgetJobs)
    .where(eq(budgetJobs.id, input.jobId))
    .limit(1);
  if (!job) {
    return { ok: false, code: "NOT_FOUND", message: "Job not found" };
  }
  return addBudget({ job, userId: input.userId, owls: input.owls });
}

/** Per-contributor escrowed totals for a job (positive micro-USD). */
export async function getJobContributions(
  jobId: string
): Promise<Array<{ userId: string; heldMicroUsd: number }>> {
  const rows = await rawQuery<{ user_id: string; held: number }>(
    `SELECT user_id, -SUM(amount_micro_usd)::bigint AS held
       FROM owl_ledger
      WHERE job_id = $1 AND reason = 'escrow_hold'
      GROUP BY user_id
      ORDER BY held DESC`,
    [jobId]
  );
  return rows.map((r) => ({
    userId: r.user_id,
    heldMicroUsd: Number(r.held),
  }));
}

/** Metered cost attributed to this job so far, in micro-USD. */
export async function getJobSpentMicroUsd(jobId: string): Promise<number> {
  const [row] = await rawQuery<{ total: number }>(
    `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS total
       FROM llm_usage WHERE job_id = $1`,
    [jobId]
  );
  return Number(row?.total ?? 0);
}

/**
 * This job's metered cost today (UTC), in micro-USD — the shared
 * daily-rate accounting every paced mandate uses (grants.
 * daily_budget_micro_usd), Minerval's General assessment mandate included.
 */
export async function jobSpentTodayMicroUsd(jobId: string): Promise<number> {
  const [row] = await rawQuery<{ total: number }>(
    `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS total
       FROM llm_usage
      WHERE job_id = $1 AND created_at >= date_trunc('day', now())`,
    [jobId]
  );
  return Number(row?.total ?? 0);
}

/**
 * Refund a settled job's unspent budget, exactly once per contributor.
 * A job can carry several people's escrow (public mandates), so the
 * unspent remainder is split pro rata by what each contributed; rounding
 * dust goes to the job's owner. Idempotent per job × contributor.
 */
export async function refundUnspentBudget(job: {
  id: string;
  userId: string;
  budgetMicroUsd: number;
}): Promise<number> {
  const spent = await getJobSpentMicroUsd(job.id);
  const unspent = Math.max(0, Number(job.budgetMicroUsd) - spent);
  if (unspent <= 0) return 0;

  const contributions = await getJobContributions(job.id);
  const totalHeld = contributions.reduce((s, c) => s + c.heldMicroUsd, 0);
  // No escrow rows (shouldn't happen) → refund the owner in full, as before.
  const shares =
    totalHeld > 0
      ? contributions.map((c) => ({
          userId: c.userId,
          amount: Math.floor((unspent * c.heldMicroUsd) / totalHeld),
        }))
      : [{ userId: job.userId, amount: unspent }];
  const distributed = shares.reduce((s, c) => s + c.amount, 0);
  const dust = unspent - distributed;
  if (dust > 0) {
    const owner = shares.find((s) => s.userId === job.userId);
    if (owner) owner.amount += dust;
    else shares.push({ userId: job.userId, amount: dust });
  }

  let refunded = 0;
  for (const share of shares) {
    if (share.amount <= 0) continue;
    const inserted = await recordOwlEntry({
      userId: share.userId,
      amountMicroUsd: share.amount,
      reason: OWL_REASONS.escrowRefund,
      jobId: job.id,
      idempotencyKey: `escrow_refund:${job.id}:${share.userId}`,
    });
    if (inserted) refunded += share.amount;
  }
  return refunded;
}

export type CancelJobResult =
  | { ok: true; refundedMicroUsd: number }
  | { ok: false; code: "NOT_FOUND" | "NOT_CANCELLABLE"; message: string };

/** Stop a job and return its unspent budget. */
export async function cancelBudgetJob(input: {
  jobId: string;
  userId: string;
}): Promise<CancelJobResult> {
  const rows = await rawQuery<{
    id: string;
    user_id: string;
    budget_micro_usd: number;
  }>(
    `UPDATE budget_jobs
        SET status = 'cancelled', completed_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2
        AND status IN ('running', 'paused_budget')
      RETURNING id, user_id, budget_micro_usd`,
    [input.jobId, input.userId]
  );
  if (rows.length === 0) {
    const [existing] = await rawQuery<{ status: string }>(
      `SELECT status FROM budget_jobs WHERE id = $1 AND user_id = $2`,
      [input.jobId, input.userId]
    );
    if (!existing) {
      return { ok: false, code: "NOT_FOUND", message: "Job not found" };
    }
    return {
      ok: false,
      code: "NOT_CANCELLABLE",
      message: `Job is ${existing.status}`,
    };
  }
  const row = rows[0]!;
  const refunded = await refundUnspentBudget({
    id: row.id,
    userId: row.user_id,
    budgetMicroUsd: Number(row.budget_micro_usd),
  });
  return { ok: true, refundedMicroUsd: refunded };
}

export async function listBudgetJobs(
  userId: string,
  limit = 50
): Promise<BudgetJob[]> {
  const db = getDb();
  return db
    .select()
    .from(budgetJobs)
    .where(eq(budgetJobs.userId, userId))
    .orderBy(desc(budgetJobs.createdAt))
    .limit(limit);
}

export async function getBudgetJob(jobId: string): Promise<BudgetJob | null> {
  const db = getDb();
  const [job] = await db
    .select()
    .from(budgetJobs)
    .where(eq(budgetJobs.id, jobId))
    .limit(1);
  return job ?? null;
}

export async function serializeBudgetJob(job: BudgetJob) {
  const spent = await getJobSpentMicroUsd(job.id);
  return {
    id: job.id,
    kind: job.kind,
    claim_id: job.claimId,
    status: job.status,
    budget_owls: microUsdToOwls(Number(job.budgetMicroUsd)),
    spent_owls: microUsdToOwls(Math.min(spent, Number(job.budgetMicroUsd))),
    checkpoint: job.checkpoint ?? null,
    error: job.error,
    created_at: job.createdAt?.toISOString(),
    updated_at: job.updatedAt?.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
  };
}
