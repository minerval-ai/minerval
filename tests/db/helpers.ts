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
  /**
   * Who commissioned it. Every run is commissioned, so a seeded placement is
   * a commission unless a test passes null for loose money that funds nothing.
   */
  commissionedBy?: string | null;
}): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO action_allocations
       (exclusion_group, action_id, claim_id, grant_id, user_id,
        amount_micro_usd, spent_micro_usd, released_at, commissioned_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $8 THEN now() ELSE NULL END, $9)
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
      input.commissionedBy === undefined ? "test" : input.commissionedBy,
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
  /** A steady pace of this much per rolling 24 hours; 0 or absent is as needed. */
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
        pace)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [
      input.funderId,
      jobId,
      `DB-test mandate ${randomUUID().slice(0, 8)}`,
      input.policy ?? "agent",
      input.grantStatus ?? "active",
      JSON.stringify(
        (input.dailyBudgetMicroUsd ?? 0) > 0
          ? { kind: "steady", owls: input.dailyBudgetMicroUsd! / 1_000_000, period_hours: 24 }
          : { kind: "as_needed" }
      ),
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

const SQL_TEST_ROLE = "minerval_sql_dbtest";
const SQL_TEST_PASSWORD = "dbtest-sql";

/**
 * Rows of the public_read views as read-only SQL returns them to a reader
 * cleared for `labels`: each row as an object keyed by column. Where a
 * deployment has more than one label the views show a row only at a label
 * the asker reads (src/db/clearance.ts), so a test that looks through a
 * view at rows it wrote at another label says what the asker reads. It runs
 * the service's own path (runReadOnlyQuery), on the login role the SQL
 * tests use, so the query must be one the service allows.
 */
export async function readViewsAs(
  labels: readonly string[],
  sql: string,
  params: unknown[] = []
): Promise<Array<Record<string, unknown>>> {
  const { loadConfig } = await import("../../src/config.js");
  const { runReadOnlyQuery } = await import("../../src/services/sql-service.js");
  const { runWithUsageContext } = await import("../../src/llm/usage-context.js");
  const { TEST_DATABASE_URL } = await import("./urls.js");
  // Made as the tables' owner: a test that has put its own out-of-context
  // work on a cleared connection (setNoContextSessionForTests(null)) may not
  // create a role, and on a cluster that has never run the suite the role
  // is not there yet.
  const { withSystemClearance } = await import("../../src/db/clearance.js");
  await withSystemClearance("A test fixture: the login role the read-only SQL tests connect as.", () =>
    rawQuery(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SQL_TEST_ROLE}') THEN
      CREATE ROLE ${SQL_TEST_ROLE} LOGIN PASSWORD '${SQL_TEST_PASSWORD}' CONNECTION LIMIT 3 IN ROLE minerval_sql;
    END IF; END $$`)
  );
  const config = loadConfig();
  if (!config.sqlAgentDatabaseUrl) {
    const url = new URL(TEST_DATABASE_URL);
    url.username = SQL_TEST_ROLE;
    url.password = SQL_TEST_PASSWORD;
    Object.assign(config, { sqlAgentDatabaseUrl: url.toString() });
  }
  const result = await runWithUsageContext({ clearance: [...labels] }, () =>
    runReadOnlyQuery(sql, params, { audience: "agent", maxRows: 500 })
  );
  return result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])));
}

/**
 * Record `url` as an address the deployment was given from outside, as a
 * search would have, and return it. Where a run reads material that is not
 * public, it records a source only at such an address
 * (src/services/given-addresses.ts), so a test whose stand-in for an agent
 * writes a source at an address the test made up gives the address first.
 * With `label` the row is written at that label, from outside any run;
 * without it, at the label of the work in progress. On a database with one
 * label the row is written and read by nothing.
 */
export async function asGiven(url: string, label?: string): Promise<string> {
  const { normalizePageUrl, pageUrlHash } = await import("../../src/services/page-url.js");
  const hash = pageUrlHash(normalizePageUrl(url) ?? url);
  if (label === undefined) {
    await rawQuery(
      `INSERT INTO given_addresses (page_url_hash, url, given_by) VALUES ($1, $2, 'search') ON CONFLICT DO NOTHING`,
      [hash, url]
    );
    return url;
  }
  const { withSystemClearance } = await import("../../src/db/clearance.js");
  await withSystemClearance("A test gives a run an address, as a search would have.", () =>
    rawQuery(
      `INSERT INTO given_addresses (page_url_hash, url, given_by, sensitivity_label) VALUES ($1, $2, 'search', $3)
       ON CONFLICT DO NOTHING`,
      [hash, url, label]
    )
  );
  return url;
}
