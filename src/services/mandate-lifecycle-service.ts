/**
 * What becomes of a mandate that has no agent left to end it.
 *
 * Most mandates are ended by their Grantmaker (complete_mandate). Two kinds
 * cannot be: a decomposition whose Grantmaker share is spent (no review pass
 * opens once it is, claim-mandate-service.ts), and a mandate under the
 * mechanical `deepen` policy, which has no plan and whose work is simply the
 * stubs in its scope. Both used to be finished, and the second kind run, by
 * the direct steward lane (workers/grant-pipeline.ts), which ran passes off
 * the ledger, metered to the mandate's job with no allocation and no regard
 * for its pace (#849). That lane is gone: every pass a mandate pays
 * for is a commission (standing-order-service.ts), and this module keeps
 * the three things the lane did besides running passes.
 *
 *  - A `deepen` mandate's standing order: a pass, commissioned from the
 *    mandate within its rate and escrow, on each node in its scope that
 *    carries no judgment and is waiting for one (the stubs the policy
 *    exists for; a judged node that something queued for a fresh look is
 *    not bought one here, as a plan's deepen item does not, #961), the
 *    queued before the deferred, the most important first.
 *  - Finishing: a `deepen` mandate with nothing left in scope, or a
 *    decomposition whose share is spent and whose plan has no item still in
 *    motion, completes once none of its work is live on the ledger, and its
 *    unspent budget refunds. Never while a bounty is held against the
 *    escrow (docs/mathematics.md §8.1).
 *  - Pausing at the floor: a mandate whose escrow is all spent, regranted
 *    or held for prizes pauses until it is topped up. Budgets held by work
 *    that is waiting or running do not count: they return what they do not
 *    spend, and a mandate paused on them would stay paused.
 *
 * Called by the allocation scheduler with the standing orders
 * (allocation-scheduler.ts). Every step is idempotent.
 */
import { rawQuery } from "../db/client.js";
import { slotColumnSql } from "./steward-lease.js";
import { grantmakerShareLeftMicroUsd } from "./action-service.js";
import { refundUnspentBudget } from "./budget-job-service.js";
import { mandateClosureBlockers } from "./bounty-service.js";
import { grantEscrowBreakdown } from "./regrant-service.js";
import { PLAN_ORDER_COMMISSIONER, placeStandingOrder } from "./standing-order-service.js";
import { importanceSql } from "./overlay-service.js";

interface LifecycleGrant {
  id: string;
  funder_user_id: string;
  budget_job_id: string;
  policy: string;
  scope_claim_id: string | null;
  scope_query: string | null;
  budget_micro_usd: string;
  mandate: { grantmaker_share_owls?: number | null } | null;
}

/** A `deepen` mandate's scope: a claim's subtree and/or a text match. */
const SCOPE_SQL = `
  WITH RECURSIVE subtree AS (
    SELECT id FROM claims WHERE id = $1
    UNION
    SELECT cr.child_claim_id
      FROM claim_relationships cr JOIN subtree s ON cr.parent_claim_id = s.id
  ),
  scope AS (
    SELECT c.id FROM claims c
     WHERE c.state = 'active'
       AND (($1::uuid IS NOT NULL AND c.id IN (SELECT id FROM subtree))
            OR ($2::text IS NOT NULL
                AND c.text_search @@ websearch_to_tsquery('english', $2)))
  )`;

/**
 * Whether the mandate has work open or running on the ledger: a row its
 * money is on, or (`ownRows`) a pass of its own, funded or not. A `deepen`
 * mandate is asked only about its money: a review row that its remaining
 * escrow cannot fund would otherwise hold it open, and its remainder
 * unrefunded, for good.
 */
async function hasLiveLedgerWork(grantId: string, ownRows: boolean): Promise<boolean> {
  const [live] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM actions a
      WHERE a.status IN ('open', 'running')
        AND (($2::boolean AND a.target_ref = $1::text)
             OR EXISTS (SELECT 1 FROM minerval_whole.allocation_money al
                         WHERE al.exclusion_group = a.exclusion_group
                           AND al.grant_id = $1::uuid AND al.released_at IS NULL
                           AND al.spent_micro_usd < al.amount_micro_usd))`,
    [grantId, ownRows]
  );
  return Number(live?.n ?? 0) > 0;
}

/**
 * Take back the mandate's standing orders on nodes the Steward has parked:
 * a parked node is out of every queue, so the pass will not run, and the
 * budget would stay held against the escrow.
 */
async function releaseOrdersOnParkedNodes(grantId: string): Promise<void> {
  await rawQuery(
    `UPDATE minerval_whole.allocation_money al SET released_at = now()
      WHERE al.grant_id = $1 AND al.commissioned_by = $2
        AND al.released_at IS NULL AND al.spent_micro_usd = 0
        AND EXISTS (SELECT 1 FROM claims c
                     WHERE c.id = al.claim_id AND ${slotColumnSql("steward_state", "c")} = 'error')
        AND NOT EXISTS (SELECT 1 FROM actions a
                         WHERE a.exclusion_group = al.exclusion_group AND a.status = 'running')`,
    [grantId, PLAN_ORDER_COMMISSIONER]
  );
}

/**
 * Order passes across a `deepen` mandate's scope. Returns whether the scope
 * still has nodes waiting for one.
 */
async function orderDeepenScope(g: LifecycleGrant): Promise<boolean> {
  await releaseOrdersOnParkedNodes(g.id);
  const waiting = await rawQuery<{ id: string }>(
    `${SCOPE_SQL}
     SELECT c.id FROM claims c JOIN scope ON scope.id = c.id
      WHERE ${slotColumnSql("steward_state", "c")} IN ('pending', 'deferred')
        AND NOT EXISTS (SELECT 1 FROM assessments_in_force x WHERE x.claim_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM quantity_estimates_in_force q WHERE q.claim_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM question_assessments_in_force qa WHERE qa.claim_id = c.id)
      ORDER BY (${slotColumnSql("steward_state", "c")} = 'pending') DESC, ${importanceSql("c")} DESC NULLS LAST
      LIMIT 100`,
    [g.scope_claim_id, g.scope_query]
  );
  for (const node of waiting) {
    const res = await placeStandingOrder({
      grantId: g.id,
      claimId: node.id,
      // The funder is buying the depth the brake held out: the strong model,
      // as this policy has always run.
      tier: "strong",
      brief:
        "A funded mandate scheduled a pass on this claim. Steward it under the ordinary " +
        "standards; funding buys attention, never conclusions.",
    });
    // Out of room for now (the rate, or the escrow). Every order here is
    // the same tier at the same estimate, so none of the rest would fit
    // either: nothing is held back that the room could have covered.
    if (res.state === "waiting" || res.state === "blocked") break;
  }
  return waiting.length > 0;
}

/** Whether a share mandate's plan has an item still in motion (or not yet materialized). */
async function planInMotion(grantId: string): Promise<boolean> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM grants g, jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) it
      WHERE g.id = $1
        AND COALESCE(it->'ledger'->>'status', '') NOT IN ('done', 'cancelled', 'blocked')`,
    [grantId]
  );
  return Number(row?.n ?? 0) > 0;
}

async function complete(g: LifecycleGrant): Promise<void> {
  await refundUnspentBudget({
    id: g.budget_job_id,
    userId: g.funder_user_id,
    budgetMicroUsd: Number(g.budget_micro_usd),
  });
  await rawQuery(
    `UPDATE budget_jobs SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`,
    [g.budget_job_id]
  );
  await rawQuery(`UPDATE grants SET status = 'completed', updated_at = now() WHERE id = $1`, [g.id]);
}

export interface MandateUpkeepResult {
  paused: number;
  completed: number;
}

/** One pass over the mandates no agent ends: order, pause at the floor, finish. */
export async function tendMandates(): Promise<MandateUpkeepResult> {
  const result: MandateUpkeepResult = { paused: 0, completed: 0 };
  const grants = await rawQuery<LifecycleGrant>(
    `SELECT g.id, g.funder_user_id, g.budget_job_id, g.policy, g.scope_claim_id,
            g.scope_query, j.budget_micro_usd, g.mandate
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.status = 'active' AND g.policy IN ('agent', 'deepen')
        AND j.status = 'running'
      ORDER BY g.updated_at ASC`
  );
  for (const g of grants) {
    try {
      // The floor: everything the escrow holds is spent, regranted or held
      // for prizes. Budgets held by live work are not counted (see above).
      const money = await grantEscrowBreakdown({ id: g.id, budgetJobId: g.budget_job_id });
      if (money.committed - money.held >= Number(g.budget_micro_usd)) {
        await rawQuery(
          `UPDATE budget_jobs SET status = 'paused_budget', updated_at = now()
            WHERE id = $1 AND status = 'running'`,
          [g.budget_job_id]
        );
        result.paused++;
        continue;
      }

      let finished = false;
      if (g.policy === "deepen") {
        finished = !(await orderDeepenScope(g));
      } else {
        // A mandate whose Grantmaker passes had a share of their own (a
        // decomposition) has no review left to extend its plan or close it
        // once the share is spent. Any other agent mandate is closed by its
        // Grantmaker: an exhausted plan is a waypoint of a live mission.
        const share = await grantmakerShareLeftMicroUsd(g);
        finished = Boolean(share) && share!.leftMicroUsd <= 0 && !(await planInMotion(g.id));
      }
      if (!finished || (await hasLiveLedgerWork(g.id, g.policy !== "deepen"))) continue;

      // The escrow that backs a public offer is never refunded from under it.
      const blockers = await mandateClosureBlockers(g.id);
      if (blockers.live_bounties > 0) {
        console.log(
          `[mandates] ${g.id} is finished but holds ${blockers.live_bounties} live ` +
            `bount${blockers.live_bounties === 1 ? "y" : "ies"} against its escrow; leaving it live`
        );
        continue;
      }
      await complete(g);
      result.completed++;
    } catch (err) {
      console.error(
        `[mandates] upkeep of mandate ${g.id} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return result;
}
