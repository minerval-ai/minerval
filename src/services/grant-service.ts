/**
 * Grants — grantmaker mandates over the budget-job escrow machinery.
 *
 * A grant is an escrowed owl budget (budget_jobs, kind 'grant') + a mandate:
 * WHERE to spend attention (a claim's subtree and/or a topic query), HOW
 * (policy: deepen | cover | maintain | agent), and WHO to credit (the public
 * mandate name stamped on funded assessments via funded_by_job_id).
 *
 * Zero ceremony for small funders: pick a claim, a policy, and a budget —
 * three inputs — and the grant worker does the rest. Large funders use the
 * 'agent' policy: a grantor agent surveys the scope, proposes an allocation
 * plan, and NOTHING runs until the funder approves it (grant-pipeline.ts).
 *
 * Money buys position and coverage, never epistemic standing: grant runs
 * are ordinary Steward runs under the same constitution, their funding is
 * disclosed on the assessments they produce, and grant stakes feed queue
 * priority only (§19, "Queue Priority and Paid Attention").
 */
import { desc, eq } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { budgetJobs, grants, type Grant } from "../db/schema.js";
import { owlsToMicroUsd, microUsdToOwls } from "./owl.js";
import {
  getJobSpentMicroUsd,
  refundUnspentBudget,
} from "./budget-job-service.js";

export const GRANT_POLICIES = ["deepen", "cover", "maintain", "agent"] as const;
export type GrantPolicy = (typeof GRANT_POLICIES)[number];

export interface PlanItem {
  claim_id: string;
  action: "assess" | "deepen";
  rationale: string;
}

export type CreateGrantResult =
  | { ok: true; grant: Grant }
  | {
      ok: false;
      code: "INSUFFICIENT_OWLS" | "SCOPE_REQUIRED" | "CLAIM_NOT_FOUND" | "BAD_POLICY";
      message: string;
    };

/** Create and fund a grant. The escrow happens here — funding is the act. */
export async function createGrant(input: {
  funderUserId: string;
  name: string;
  policy: string;
  budgetOwls: number;
  scopeClaimId?: string | null;
  scopeQuery?: string | null;
}): Promise<CreateGrantResult> {
  if (!GRANT_POLICIES.includes(input.policy as GrantPolicy)) {
    return {
      ok: false,
      code: "BAD_POLICY",
      message: `Policy must be one of: ${GRANT_POLICIES.join(", ")}`,
    };
  }
  if (!input.scopeClaimId && !input.scopeQuery?.trim()) {
    return {
      ok: false,
      code: "SCOPE_REQUIRED",
      message: "A grant needs a scope: a claim (subtree) and/or a topic query",
    };
  }
  if (input.scopeClaimId) {
    const [claim] = await rawQuery<{ id: string }>(
      `SELECT id FROM claims WHERE id = $1 AND state = 'active'`,
      [input.scopeClaimId]
    );
    if (!claim) {
      return {
        ok: false,
        code: "CLAIM_NOT_FOUND",
        message: "Scope claim not found or not active",
      };
    }
  }

  const db = getDb();
  const budgetMicro = owlsToMicroUsd(input.budgetOwls);
  const [job] = await db
    .insert(budgetJobs)
    .values({
      userId: input.funderUserId,
      kind: "grant",
      claimId: input.scopeClaimId ?? null,
      budgetMicroUsd: 0,
      status: "running",
    })
    .returning();

  // Escrow behind the balance guard (same shape as chargeOwls).
  const held = await rawQuery<{ id: string }>(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
     SELECT $1, $2, 'escrow_hold', $3
      WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0)
               FROM owl_ledger WHERE user_id = $1) >= $4
     RETURNING id`,
    [input.funderUserId, -budgetMicro, job!.id, budgetMicro]
  );
  if (held.length === 0) {
    await db.delete(budgetJobs).where(eq(budgetJobs.id, job!.id));
    return {
      ok: false,
      code: "INSUFFICIENT_OWLS",
      message: `Funding this grant takes ${input.budgetOwls} owls and your balance can't cover it`,
    };
  }
  await db
    .update(budgetJobs)
    .set({ budgetMicroUsd: budgetMicro })
    .where(eq(budgetJobs.id, job!.id));

  const [grant] = await db
    .insert(grants)
    .values({
      funderUserId: input.funderUserId,
      budgetJobId: job!.id,
      name: input.name,
      scopeClaimId: input.scopeClaimId ?? null,
      scopeQuery: input.scopeQuery?.trim() || null,
      policy: input.policy,
      // The agent policy plans first and spends nothing until approval.
      status: input.policy === "agent" ? "planning" : "active",
    })
    .returning();
  return { ok: true, grant: grant! };
}

/** Approve a grantor agent's proposed plan; execution starts next tick. */
export async function approveGrantPlan(input: {
  grantId: string;
  funderUserId: string;
}): Promise<
  | { ok: true; grant: Grant }
  | { ok: false; code: "NOT_FOUND" | "NOT_PENDING"; message: string }
> {
  const db = getDb();
  const [grant] = await db
    .select()
    .from(grants)
    .where(eq(grants.id, input.grantId))
    .limit(1);
  if (!grant || grant.funderUserId !== input.funderUserId) {
    return { ok: false, code: "NOT_FOUND", message: "Grant not found" };
  }
  if (grant.status !== "pending_approval") {
    return {
      ok: false,
      code: "NOT_PENDING",
      message: `Grant is ${grant.status}; only a proposed plan can be approved`,
    };
  }
  const [updated] = await db
    .update(grants)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(grants.id, grant.id))
    .returning();
  return { ok: true, grant: updated! };
}

/** Cancel a grant: stop the mandate and refund the unspent budget. */
export async function cancelGrant(input: {
  grantId: string;
  funderUserId: string;
}): Promise<
  | { ok: true; refundedMicroUsd: number }
  | { ok: false; code: "NOT_FOUND" | "NOT_CANCELLABLE"; message: string }
> {
  const db = getDb();
  const [grant] = await db
    .select()
    .from(grants)
    .where(eq(grants.id, input.grantId))
    .limit(1);
  if (!grant || grant.funderUserId !== input.funderUserId) {
    return { ok: false, code: "NOT_FOUND", message: "Grant not found" };
  }
  if (grant.status === "completed" || grant.status === "cancelled") {
    return {
      ok: false,
      code: "NOT_CANCELLABLE",
      message: `Grant is ${grant.status}`,
    };
  }
  await db
    .update(grants)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(grants.id, grant.id));
  const [job] = await db
    .select()
    .from(budgetJobs)
    .where(eq(budgetJobs.id, grant.budgetJobId))
    .limit(1);
  let refunded = 0;
  if (job) {
    await db
      .update(budgetJobs)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(budgetJobs.id, job.id));
    refunded = await refundUnspentBudget({
      id: job.id,
      userId: job.userId,
      budgetMicroUsd: Number(job.budgetMicroUsd),
    });
  }
  return { ok: true, refundedMicroUsd: refunded };
}

export async function listGrants(
  funderUserId: string,
  limit = 50
): Promise<Grant[]> {
  const db = getDb();
  return db
    .select()
    .from(grants)
    .where(eq(grants.funderUserId, funderUserId))
    .orderBy(desc(grants.createdAt))
    .limit(limit);
}

export async function getGrant(grantId: string): Promise<Grant | null> {
  const db = getDb();
  const [grant] = await db
    .select()
    .from(grants)
    .where(eq(grants.id, grantId))
    .limit(1);
  return grant ?? null;
}

/** The mandate name behind a funded assessment, for the §19 disclosure. */
export async function getFundingLabelForJob(
  jobId: string
): Promise<{ type: "grant" | "user_order" | "job"; label: string } | null> {
  const [grant] = await rawQuery<{ name: string }>(
    `SELECT name FROM grants WHERE budget_job_id = $1`,
    [jobId]
  );
  if (grant) return { type: "grant", label: grant.name };
  const [order] = await rawQuery<{ id: string }>(
    `SELECT id FROM assessment_orders WHERE id = $1`,
    [jobId]
  );
  if (order) return { type: "user_order", label: "a user's assessment order" };
  const [job] = await rawQuery<{ kind: string }>(
    `SELECT kind FROM budget_jobs WHERE id = $1`,
    [jobId]
  );
  if (job) return { type: "job", label: `a funded ${job.kind.replace(/_/g, " ")} job` };
  return null;
}

/** Dashboard payload: live spend, progress, and the claims this grant touched. */
export async function serializeGrant(grant: Grant) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(budgetJobs)
    .where(eq(budgetJobs.id, grant.budgetJobId))
    .limit(1);
  const spent = job ? await getJobSpentMicroUsd(job.id) : 0;
  const budget = job ? Number(job.budgetMicroUsd) : 0;

  // What the grant actually bought: assessments stamped with its job id.
  const funded = await rawQuery<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: Date;
  }>(
    `SELECT a.claim_id, c.text, a.status, a.assessed_at
       FROM assessments a JOIN claims c ON c.id = a.claim_id
      WHERE a.funded_by_job_id = $1
      ORDER BY a.assessed_at DESC
      LIMIT 50`,
    [grant.budgetJobId]
  );

  return {
    id: grant.id,
    name: grant.name,
    policy: grant.policy,
    status: grant.status,
    scope_claim_id: grant.scopeClaimId,
    scope_query: grant.scopeQuery,
    budget_owls: microUsdToOwls(budget),
    spent_owls: microUsdToOwls(Math.min(spent, budget)),
    budget_status: job?.status ?? null,
    budget_job_id: grant.budgetJobId,
    plan: grant.plan ?? null,
    plan_cursor: grant.planCursor,
    funded_assessments: funded.map((f) => ({
      claim_id: f.claim_id,
      text: f.text,
      status: f.status,
      assessed_at: f.assessed_at?.toISOString(),
    })),
    created_at: grant.createdAt?.toISOString(),
    updated_at: grant.updatedAt?.toISOString(),
  };
}
