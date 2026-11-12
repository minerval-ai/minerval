/**
 * What the direct steward lane used to do besides running passes, now that
 * every pass a mandate pays for is a commission (#849), against real
 * Postgres: a `deepen`-policy mandate's scope ordered within its rate and
 * escrow, a mandate no agent ends finished and refunded, and a spent escrow
 * paused (mandate-lifecycle-service.ts).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import {
  ASSESS_GROUP,
  completeAction,
  ensureAssessActions,
  materializePlanItems,
  materializeStandingOrders,
} from "../../src/services/action-service.js";
import { committedWithinMicroUsd } from "../../src/services/pace-service.js";
import { tendMandates } from "../../src/services/mandate-lifecycle-service.js";
import { PLAN_ORDER_COMMISSIONER } from "../../src/services/standing-order-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { OWL, creditOwls, owlBalance, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

async function setPlan(grantId: string, items: Array<Record<string, unknown>>): Promise<void> {
  await rawQuery(`UPDATE grants SET plan = $2::jsonb, plan_cursor = 0 WHERE id = $1`, [
    grantId,
    JSON.stringify({ strategy: "s", items }),
  ]);
}

/** The mandate's live placements on a node's assess group. */
async function orders(grantId: string, claimId: string) {
  return rawQuery<{ id: string; action_id: string; amount: string; commissioned_by: string | null; variant: string }>(
    `SELECT al.id, al.action_id, al.amount_micro_usd AS amount, al.commissioned_by, a.variant
       FROM action_allocations al JOIN actions a ON a.id = al.action_id
      WHERE al.grant_id = $1 AND al.exclusion_group = $2
        AND al.released_at IS NULL AND al.spent_micro_usd < al.amount_micro_usd`,
    [grantId, ASSESS_GROUP(claimId)]
  );
}

async function claimState(id: string): Promise<string> {
  const [row] = await rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [id]);
  return row!.steward_state;
}

/** Stand in for the executor: the commissioned row runs, meters, and settles. */
async function runPass(claimId: string, meteredMicroUsd: number, jobId: string): Promise<void> {
  const [row] = await rawQuery<{ id: string }>(
    `SELECT a.id FROM actions a
      WHERE a.exclusion_group = $1 AND a.status = 'open'
        AND EXISTS (SELECT 1 FROM action_allocations al
                     WHERE al.action_id = a.id AND al.released_at IS NULL)
      LIMIT 1`,
    [ASSESS_GROUP(claimId)]
  );
  if (!row) throw new Error(`no commissioned open row on ${claimId}`);
  await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [row.id]);
  await completeAction(row.id, meteredMicroUsd, { meteredJobId: jobId });
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claimId]);
}

/** What a pass on the node is estimated at: what an order with no budget of its own is placed at. */
async function estimate(claimId: string): Promise<number> {
  await ensureAssessActions(claimId);
  const [row] = await rawQuery<{ cost: string }>(
    `SELECT cost_est_micro_usd AS cost FROM actions WHERE exclusion_group = $1
      ORDER BY (variant = 'strong') DESC LIMIT 1`,
    [ASSESS_GROUP(claimId)]
  );
  return Number(row!.cost);
}

async function grantStatus(grantId: string): Promise<string> {
  return (await rawQuery<{ status: string }>(`SELECT status FROM grants WHERE id = $1`, [grantId]))[0]!.status;
}

async function mandate(opts: { budget: number; daily?: number; policy?: string }) {
  const funder = await seedUser("order-funder");
  const m = await seedGrantWithJob({
    funderId: funder,
    budgetMicroUsd: opts.budget,
    dailyBudgetMicroUsd: opts.daily ?? 0,
    policy: opts.policy,
  });
  return { ...m, funder };
}

beforeAll(async () => {
  // No platform mandate competes for the rows these tests read.
  await rawQuery(
    `UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  resetAllocationPolicyCache();
});

describe("mandates no agent ends (the direct steward lane's other work)", () => {
  it("a deepen-policy mandate orders passes across its scope within its rate, then completes and refunds", async () => {
    const funder = await seedUser("deepen-policy funder");
    await creditOwls(funder, 20 * OWL);
    const m = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 20 * OWL, policy: "deepen" });
    expect(await owlBalance(funder)).toBe(0);
    const root = await seedClaim("scope root");
    const kid = await seedClaim("scope kid");
    const outside = await seedClaim("outside the scope");
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
       VALUES ($1, $2, 'requires', 'db test')`,
      [root, kid]
    );
    await rawQuery(`UPDATE claims SET steward_state = 'deferred' WHERE id = ANY($1::uuid[])`, [[kid, outside]]);
    // A rate with room for one pass at a time.
    const price = await estimate(root);
    expect(price).toBeLessThan(5 * OWL);
    await rawQuery(`UPDATE grants SET scope_claim_id = $2, pace = (CASE WHEN $3::bigint > 0 THEN jsonb_build_object('kind','steady','owls',$3::bigint / 1000000.0,'period_hours',24) ELSE '{"kind":"as_needed"}'::jsonb END) WHERE id = $1`, [
      m.grantId,
      root,
      Math.round(price * 1.5),
    ]);

    await tendMandates();
    // The queued node first; the rate has no room for the second.
    const placed = await orders(m.grantId, root);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.commissioned_by).toBe(PLAN_ORDER_COMMISSIONER);
    expect(Number(placed[0]!.amount)).toBe(price);
    expect(await orders(m.grantId, kid)).toHaveLength(0);
    expect(await orders(m.grantId, outside)).toHaveLength(0);
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(price);
    expect(await grantStatus(m.grantId)).toBe("active");

    await runPass(root, 0.25 * price, m.jobId);
    await tendMandates();
    expect(await orders(m.grantId, kid)).toHaveLength(1);
    expect(await claimState(kid)).toBe("pending");
    // Not finished while its money is on live work.
    expect(await grantStatus(m.grantId)).toBe("active");

    await runPass(kid, 0.25 * price, m.jobId);
    await tendMandates();
    expect(await grantStatus(m.grantId)).toBe("completed");
    // Half a pass's estimate was spent; the rest is back with the funder.
    expect(await owlBalance(funder)).toBe(20 * OWL - 2 * Math.round(0.25 * price));
    expect(await claimState(outside)).toBe("deferred");
  });

  it("pauses a mandate whose escrow is all spent, but not one whose escrow is only held by live work", async () => {
    const spent = await mandate({ budget: 2 * OWL });
    const claim = await seedClaim("spent on");
    await setPlan(spent.grantId, [{ action: "assess", claim_id: claim, rationale: "x", budget_owls: 2 }]);
    await materializePlanItems(spent.grantId);
    // The whole escrow is held by the pass that is waiting: not the floor.
    await tendMandates();
    const status = async () =>
      (await rawQuery<{ status: string }>(`SELECT status FROM budget_jobs WHERE id = $1`, [spent.jobId]))[0]!.status;
    expect(await status()).toBe("running");
    // It runs and spends all of it: now the floor.
    await runPass(claim, 2 * OWL, spent.jobId);
    await tendMandates();
    expect(await status()).toBe("paused_budget");
  });

  it("completes a decomposition whose share is spent once no plan item is in motion, and not before", async () => {
    const funder = await seedUser("decomposition funder");
    await creditOwls(funder, 10 * OWL);
    const m = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10 * OWL });
    const claim = await seedClaim("decomposed");
    await rawQuery(
      `UPDATE grants SET mandate = '{"origin": "deep_decomposition", "grantmaker_share_owls": 1}'::jsonb WHERE id = $1`,
      [m.grantId]
    );
    // The share is spent on its passes.
    await rawQuery(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status, metered_cost_micro_usd)
       VALUES ('grant_planning', $1, 'standard', $2, 'planned', 1, 'done', $3)`,
      [`plan:${m.grantId}`, m.grantId, 1 * OWL]
    );
    await setPlan(m.grantId, [{ action: "reassess", claim_id: claim, rationale: "the claim itself", budget_owls: 2 }]);
    // Not yet materialized: the item is still to become work.
    await tendMandates();
    expect(await grantStatus(m.grantId)).toBe("active");
    await materializePlanItems(m.grantId);
    expect(await orders(m.grantId, claim)).toHaveLength(1);
    await tendMandates();
    expect(await grantStatus(m.grantId)).toBe("active");

    await runPass(claim, 1.5 * OWL, m.jobId);
    // The pass ran, but the item still reads open until the plan is looked at.
    await tendMandates();
    expect(await grantStatus(m.grantId)).toBe("active");
    await materializeStandingOrders();
    await tendMandates();
    expect(await grantStatus(m.grantId)).toBe("completed");
    // 1.5 owls of passes were spent from the escrow; the rest returns.
    expect(await owlBalance(funder)).toBe(8.5 * OWL);
  });
});
