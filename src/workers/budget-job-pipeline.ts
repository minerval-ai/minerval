/**
 * Budget-job worker — drains funded open-ended work one Steward run per tick.
 *
 * First (and so far only) product: DEEP DECOMPOSITION. "Decompose this
 * claim, N owls deep": the job walks the claim's decomposition subtree and
 * stewards every claim the background lane wouldn't reach — 'pending' ones
 * ahead of their queue turn and, crucially, 'deferred' ones the economic
 * brake (#98, stewardEnqueueMinImportance) intentionally held out. The brake
 * stays honest for system spend; a user funding the subtree is exactly the
 * economics that justify going deeper. Each run mints subclaims that become
 * new targets, so depth grows until the subtree is exhausted or the budget
 * floor is hit.
 *
 * Every run is attributed with jobId = the budget job's id, so spend is
 * SUM(llm_usage.cost_micro_usd WHERE job_id) — checked before each run. At
 * the floor the job pauses (status 'paused_budget') with a progress
 * checkpoint and waits for a top-up; when the subtree is exhausted it
 * completes and refunds the unspent budget.
 */
import { rawQuery } from "../db/client.js";
import { runClaimSteward } from "../llm/agents/claim-steward.js";
import { runWithUsageContext } from "../llm/usage-context.js";
import { loadConfig } from "../config.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import {
  getJobSpentMicroUsd,
  refundUnspentBudget,
} from "../services/budget-job-service.js";

export type BudgetJobDrainStatus =
  | "processed"
  | "empty"
  | "budget"
  | "transient"
  | "paused"
  | "completed";

export interface BudgetJobProcessResult {
  status: BudgetJobDrainStatus;
  jobId?: string;
  claimId?: string;
  ok?: boolean;
  error?: string;
}

interface JobRow {
  id: string;
  user_id: string;
  claim_id: string | null;
  budget_micro_usd: number;
  checkpoint: Record<string, unknown> | null;
}

/** Subtree progress counts for the checkpoint / job page. */
async function subtreeCounts(
  rootClaimId: string
): Promise<{ pending: number; deferred: number; done: number }> {
  const [row] = await rawQuery<{
    pending: number;
    deferred: number;
    done: number;
  }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM claims WHERE id = $1
       UNION
       SELECT cr.child_claim_id
         FROM claim_relationships cr
         JOIN subtree s ON cr.parent_claim_id = s.id
     )
     SELECT
       count(*) FILTER (WHERE c.steward_state = 'pending')::int  AS pending,
       count(*) FILTER (WHERE c.steward_state = 'deferred')::int AS deferred,
       count(*) FILTER (WHERE c.steward_state = 'done')::int     AS done
     FROM claims c JOIN subtree s ON c.id = s.id
     WHERE c.state = 'active'`,
    [rootClaimId]
  );
  return row ?? { pending: 0, deferred: 0, done: 0 };
}

/**
 * Claim the next steward target in the job's subtree: pending claims first
 * (they're queued anyway — the job just runs them now, on its own dime),
 * then deferred stubs (the depth the background lane never buys), highest
 * importance first within each class.
 */
async function claimNextTarget(
  rootClaimId: string
): Promise<{
  id: string;
  prior_state: string;
  decomposition_status: string;
  steward_trigger: string | null;
  steward_context: string | null;
} | null> {
  const rows = await rawQuery<{
    id: string;
    prior_state: string;
    decomposition_status: string;
    steward_trigger: string | null;
    steward_context: string | null;
  }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM claims WHERE id = $1
       UNION
       SELECT cr.child_claim_id
         FROM claim_relationships cr
         JOIN subtree s ON cr.parent_claim_id = s.id
     ),
     target AS (
       SELECT c.id, c.steward_state AS prior_state
         FROM claims c JOIN subtree s ON c.id = s.id
        WHERE c.state = 'active'
          AND c.steward_state IN ('pending', 'deferred')
        ORDER BY (c.steward_state = 'pending') DESC, c.importance DESC
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE claims c
        SET steward_state = 'running', stewarded_at = now()
       FROM target
      WHERE c.id = target.id
      RETURNING c.id, target.prior_state, c.decomposition_status,
                c.steward_trigger, c.steward_context`,
    [rootClaimId]
  );
  return rows[0] ?? null;
}

/**
 * Advance one running budget job by one Steward run. Pauses at the budget
 * floor, completes (with refund) when the subtree has no targets left.
 */
export async function processNextBudgetJobTask(
  opts: { model?: string } = {}
): Promise<BudgetJobProcessResult> {
  const model = opts.model ?? loadConfig().stewardModel;

  try {
    checkBudget();
  } catch {
    return { status: "budget" };
  }

  // Oldest-updated running job first, so concurrent jobs round-robin.
  const jobs = await rawQuery<JobRow>(
    `SELECT id, user_id, claim_id, budget_micro_usd, checkpoint
       FROM budget_jobs
      WHERE status = 'running' AND kind = 'deep_decomposition'
      ORDER BY updated_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`
  );
  if (jobs.length === 0 || !jobs[0]!.claim_id) return { status: "empty" };
  const job = jobs[0]!;
  const rootClaimId = job.claim_id!;

  const spent = await getJobSpentMicroUsd(job.id);
  const counts = await subtreeCounts(rootClaimId);
  const assessedSoFar = Number(job.checkpoint?.assessed ?? 0);

  if (spent >= Number(job.budget_micro_usd)) {
    await rawQuery(
      `UPDATE budget_jobs
          SET status = 'paused_budget', updated_at = now(),
              checkpoint = $2::jsonb
        WHERE id = $1`,
      [
        job.id,
        JSON.stringify({
          ...job.checkpoint,
          assessed: assessedSoFar,
          subtree: counts,
          note:
            `Budget exhausted after ${assessedSoFar} assessment(s); ` +
            `${counts.pending + counts.deferred} claim(s) still waiting in ` +
            `the subtree. Top up to continue.`,
        }),
      ]
    );
    return { status: "paused", jobId: job.id };
  }

  const target = await claimNextTarget(rootClaimId);
  if (!target) {
    // Subtree exhausted: the job is done. Return whatever budget is left.
    await refundUnspentBudget({
      id: job.id,
      userId: job.user_id,
      budgetMicroUsd: Number(job.budget_micro_usd),
    });
    await rawQuery(
      `UPDATE budget_jobs
          SET status = 'completed', completed_at = now(), updated_at = now(),
              checkpoint = $2::jsonb
        WHERE id = $1`,
      [
        job.id,
        JSON.stringify({
          ...job.checkpoint,
          assessed: assessedSoFar,
          subtree: counts,
          note: `Subtree fully stewarded after ${assessedSoFar} assessment(s).`,
        }),
      ]
    );
    return { status: "completed", jobId: job.id };
  }

  // A deferred stub gets its first full pass; a pending claim keeps whatever
  // trigger/context its queue slot carries (this run just jumps its turn).
  const virgin = target.decomposition_status === "pending";
  const trigger = virgin
    ? "structure_and_assess"
    : (target.steward_trigger ?? "subclaim_change");
  const context =
    (target.steward_context ? `${target.steward_context}\n\n` : "") +
    "This run is funded by a user's deep-decomposition budget on an " +
    "ancestor claim: steward this claim now" +
    (target.prior_state === "deferred"
      ? " (it was deferred as low-importance; the funder is buying the depth)"
      : "") +
    ".";

  try {
    await runWithUsageContext({ userId: job.user_id, jobId: job.id }, () =>
      runClaimSteward({ trigger, claimId: target.id, context, model })
    );
    await rawQuery(
      `UPDATE claims
          SET steward_state = CASE
                WHEN steward_state = 'running' THEN 'done'
                ELSE steward_state
              END,
              steward_error = NULL, steward_attempts = 0
        WHERE id = $1`,
      [target.id]
    );
    await rawQuery(
      `UPDATE budget_jobs
          SET updated_at = now(), checkpoint = $2::jsonb
        WHERE id = $1`,
      [
        job.id,
        JSON.stringify({
          ...job.checkpoint,
          assessed: assessedSoFar + 1,
          last_claim_id: target.id,
          subtree: await subtreeCounts(rootClaimId),
        }),
      ]
    );
    return { status: "processed", jobId: job.id, claimId: target.id, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Put the target back exactly as found; classify like the other lanes.
    await rawQuery(
      `UPDATE claims
          SET steward_state = CASE
                WHEN steward_state = 'running' THEN $2
                ELSE steward_state
              END,
              updated_at = now()
        WHERE id = $1`,
      [target.id, target.prior_state]
    );
    if (err instanceof LlmBudgetExceededError || isTransientApiError(err)) {
      return {
        status: err instanceof LlmBudgetExceededError ? "budget" : "transient",
        jobId: job.id,
        claimId: target.id,
        ok: false,
        error: msg,
      };
    }
    // Genuine failure on one target: skip it this pass (it stays in the
    // subtree; the background drain's attempt accounting owns poison claims)
    // and let the job continue with the next target next tick.
    await rawQuery(
      `UPDATE budget_jobs SET updated_at = now(), error = $2 WHERE id = $1`,
      [job.id, msg]
    );
    return {
      status: "processed",
      jobId: job.id,
      claimId: target.id,
      ok: false,
      error: msg,
    };
  }
}

/** Are any budget jobs currently runnable? */
export async function runnableBudgetJobCount(): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM budget_jobs WHERE status = 'running'`
  );
  return row?.n ?? 0;
}
