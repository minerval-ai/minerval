/**
 * Seed helpers for the DB-backed suite. Every helper mints fresh rows with
 * unique identities, so tests never couple through shared state even
 * though they share one scratch database.
 *
 * All inserts go through the app's own pool (src/db/client.ts), which the
 * per-worker setup pointed at the scratch DB.
 */
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";

/** One owl of face value, in micro-USD (config default owlCostMicroUsd). */
export const OWL = 1_000_000;

export async function seedUser(label = "user"): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO contributors (display_name, external_id)
     VALUES ($1, $2) RETURNING id`,
    [`dbtest ${label}`, `dbtest:${label}:${randomUUID()}`]
  );
  return rows[0]!.id;
}

/** Credit a user's owl balance with a purchase row. */
export async function creditOwls(
  userId: string,
  amountMicroUsd: number
): Promise<void> {
  await rawQuery(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason)
     VALUES ($1, $2, 'purchase')`,
    [userId, amountMicroUsd]
  );
}

export async function owlBalance(userId: string): Promise<number> {
  const rows = await rawQuery<{ total: string }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0) AS total FROM owl_ledger
      WHERE user_id = $1`,
    [userId]
  );
  return Number(rows[0]!.total);
}

export async function ledgerRows(userId: string) {
  return rawQuery<{
    id: string;
    amount_micro_usd: string;
    reason: string;
    idempotency_key: string | null;
  }>(
    `SELECT id, amount_micro_usd, reason, idempotency_key
       FROM owl_ledger WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    [userId]
  );
}

export async function seedClaim(label = "claim"): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claims (text) VALUES ($1) RETURNING id`,
    [`DB-test claim (${label} ${randomUUID()})`]
  );
  return rows[0]!.id;
}

export async function seedAction(input: {
  group: string;
  variant?: string;
  costMicroUsd: number;
  status?: string;
  claimId?: string | null;
  kind?: string;
  targetRef?: string | null;
}): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO actions
       (kind, exclusion_group, variant, claim_id, target_ref, label,
        cost_est_micro_usd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      input.kind ?? "assess",
      input.group,
      input.variant ?? "standard",
      input.claimId ?? null,
      input.targetRef ?? null,
      `DB-test action ${input.group}/${input.variant ?? "standard"}`,
      input.costMicroUsd,
      input.status ?? "open",
    ]
  );
  return rows[0]!.id;
}

export async function getAction(id: string) {
  const rows = await rawQuery<{
    id: string;
    status: string;
    metered_cost_micro_usd: string | null;
    metered_job_id: string | null;
  }>(
    `SELECT id, status, metered_cost_micro_usd, metered_job_id
       FROM actions WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function seedAllocation(input: {
  group: string;
  actionId?: string | null;
  claimId?: string | null;
  grantId?: string | null;
  userId?: string | null;
  amountMicroUsd: number;
  spentMicroUsd?: number;
  released?: boolean;
}): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO action_allocations
       (exclusion_group, action_id, claim_id, grant_id, user_id,
        amount_micro_usd, spent_micro_usd, released_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $8 THEN now() ELSE NULL END)
     RETURNING id`,
    [
      input.group,
      input.actionId ?? null,
      input.claimId ?? null,
      input.grantId ?? null,
      input.userId ?? null,
      input.amountMicroUsd,
      input.spentMicroUsd ?? 0,
      input.released ?? false,
    ]
  );
  return rows[0]!.id;
}

export async function getAllocation(id: string) {
  const rows = await rawQuery<{
    id: string;
    amount_micro_usd: string;
    spent_micro_usd: string;
    released_at: Date | null;
  }>(
    `SELECT id, amount_micro_usd, spent_micro_usd, released_at
       FROM action_allocations WHERE id = $1`,
    [id]
  );
  return rows[0]!;
}

/**
 * A grant with its backing budget job. The escrowed budget is also written
 * as the funder's escrow_hold ledger row (as the real funding path does),
 * so refund pro-rating sees a contribution basis.
 */
export async function seedGrantWithJob(input: {
  funderId: string;
  budgetMicroUsd: number;
  grantStatus?: string;
  jobStatus?: string;
  dailyBudgetMicroUsd?: number;
  policy?: string;
  withEscrowHold?: boolean;
}): Promise<{ grantId: string; jobId: string }> {
  const jobRows = await rawQuery<{ id: string }>(
    `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status)
     VALUES ($1, 'grant', $2, $3) RETURNING id`,
    [input.funderId, input.budgetMicroUsd, input.jobStatus ?? "running"]
  );
  const jobId = jobRows[0]!.id;
  if (input.withEscrowHold !== false && input.budgetMicroUsd > 0) {
    await rawQuery(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
       VALUES ($1, $2, 'escrow_hold', $3)`,
      [input.funderId, -input.budgetMicroUsd, jobId]
    );
  }
  const grantRows = await rawQuery<{ id: string }>(
    `INSERT INTO grants
       (funder_user_id, budget_job_id, name, policy, status,
        daily_budget_micro_usd)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.funderId,
      jobId,
      `DB-test mandate ${randomUUID().slice(0, 8)}`,
      input.policy ?? "agent",
      input.grantStatus ?? "active",
      input.dailyBudgetMicroUsd ?? 0,
    ]
  );
  return { grantId: grantRows[0]!.id, jobId };
}

export async function jobBudget(jobId: string): Promise<number> {
  const rows = await rawQuery<{ budget_micro_usd: string; status: string }>(
    `SELECT budget_micro_usd, status FROM budget_jobs WHERE id = $1`,
    [jobId]
  );
  return Number(rows[0]!.budget_micro_usd);
}

export async function seedLlmUsage(input: {
  jobId: string;
  costMicroUsd: number;
}): Promise<void> {
  await rawQuery(
    `INSERT INTO llm_usage (model, agent, cost_micro_usd, job_id)
     VALUES ('dbtest-model', 'dbtest', $1, $2)`,
    [input.costMicroUsd, input.jobId]
  );
}

export async function seedValuation(input: {
  grantId: string;
  actionId: string;
  valueEst: number;
}): Promise<void> {
  await rawQuery(
    `INSERT INTO mandate_valuations (grant_id, action_id, value_est)
     VALUES ($1, $2, $3)`,
    [input.grantId, input.actionId, input.valueEst]
  );
}

/** Is a pg error (or one wrapping it) the given SQLSTATE? */
export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}
