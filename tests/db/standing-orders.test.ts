/**
 * Plan items as standing orders, against real Postgres (#849): an assess,
 * reassess or deepen item is commissioned from its mandate, whole, within
 * the daily rate and the escrow; what the day cannot cover waits with the
 * figures and is placed when the room is there; what could never fit is
 * blocked; a sweep never pays twice.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import {
  ASSESS_GROUP,
  completeAction,
  materializePlanItems,
  materializeStandingOrders,
  reconcileActions,
  type PlanItemLedger,
} from "../../src/services/action-service.js";
import { commissionNodePass, grantDayUseMicroUsd } from "../../src/services/commission-service.js";
import { grantEscrowBreakdown } from "../../src/services/regrant-service.js";
import { PLAN_ORDER_COMMISSIONER } from "../../src/services/standing-order-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { OWL, creditOwls, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

interface Item {
  action: string;
  claim_id?: string;
  ledger?: PlanItemLedger;
  [k: string]: unknown;
}

async function setPlan(grantId: string, items: Item[]): Promise<void> {
  await rawQuery(`UPDATE grants SET plan = $2::jsonb, plan_cursor = 0 WHERE id = $1`, [
    grantId,
    JSON.stringify({ strategy: "s", items }),
  ]);
}

async function plan(grantId: string): Promise<{ ledgers: Array<PlanItemLedger | undefined>; cursor: number }> {
  const [row] = await rawQuery<{ plan: { items: Item[] }; plan_cursor: number }>(
    `SELECT plan, plan_cursor FROM grants WHERE id = $1`,
    [grantId]
  );
  return { ledgers: row!.plan.items.map((i) => i.ledger), cursor: Number(row!.plan_cursor) };
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

describe("a plan item is a standing order (#849)", () => {
  it("commissions the pass from the mandate, at the item's budget, once however often the plan is materialized", async () => {
    const m = await mandate({ budget: 50 * OWL, daily: 20 * OWL });
    const a = await seedClaim("order a");
    const b = await seedClaim("order b");
    await setPlan(m.grantId, [
      { action: "assess", claim_id: a, rationale: "first", budget_owls: 3 },
      { action: "reassess", claim_id: b, rationale: "second" },
    ]);
    await materializePlanItems(m.grantId);

    const placedA = await orders(m.grantId, a);
    expect(placedA).toHaveLength(1);
    expect(placedA[0]).toMatchObject({ commissioned_by: PLAN_ORDER_COMMISSIONER });
    expect(Number(placedA[0]!.amount)).toBe(3 * OWL);
    // With no budget_owls, the row's own estimate.
    const placedB = await orders(m.grantId, b);
    expect(placedB).toHaveLength(1);
    const [rowB] = await rawQuery<{ cost: string }>(`SELECT cost_est_micro_usd AS cost FROM actions WHERE id = $1`, [
      placedB[0]!.action_id,
    ]);
    expect(Number(placedB[0]!.amount)).toBe(Number(rowB!.cost));

    const first = await plan(m.grantId);
    expect(first.ledgers[0]).toMatchObject({ status: "open", action_id: placedA[0]!.action_id });
    expect(first.ledgers[0]!.order).toMatchObject({ budget_owls: 3 });
    expect(first.ledgers[1]!.order).toBeTruthy();
    // Both items have started, so the cursor is past them.
    expect(first.cursor).toBe(2);
    expect(await claimState(a)).toBe("pending");
    // The day holds what was commissioned.
    expect(await grantDayUseMicroUsd(m.grantId)).toBe(3 * OWL + Number(placedB[0]!.amount));

    // Again, twice, and on the full sweep: no second placement, no second message.
    await materializePlanItems(m.grantId);
    await materializeStandingOrders();
    await reconcileActions();
    expect(await orders(m.grantId, a)).toHaveLength(1);
    expect(Number((await orders(m.grantId, a))[0]!.amount)).toBe(3 * OWL);
    const [msgs] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM node_messages WHERE node_id = $1`, [a]);
    expect(msgs!.n).toBe(1);
    expect((await plan(m.grantId)).ledgers[0]!.order).toMatchObject({ budget_owls: 3 });

    // The pass runs and settles: the item is done, the unspent budget back.
    await runPass(a, 1 * OWL, m.jobId);
    await materializePlanItems(m.grantId);
    expect((await plan(m.grantId)).ledgers[0]).toMatchObject({ status: "done" });
    expect(await orders(m.grantId, a)).toHaveLength(0);
    // And it stays done: the row reopening for someone else's ask is not this item's.
    await commissionNodePass({ payer: { kind: "user", userId: await richUser() }, claimId: a, budgetMicroUsd: OWL, brief: "again", commissionedBy: "person" });
    await materializePlanItems(m.grantId);
    expect((await plan(m.grantId)).ledgers[0]).toMatchObject({ status: "done" });
    expect(await orders(m.grantId, a)).toHaveLength(0);
  });

  it("waits, with the figures, for room in the day's rate, holds later items behind it, and is placed when the room opens", async () => {
    const m = await mandate({ budget: 50 * OWL, daily: 4 * OWL });
    const a = await seedClaim("paced a");
    const b = await seedClaim("paced b");
    const c = await seedClaim("paced c");
    await setPlan(m.grantId, [
      { action: "assess", claim_id: a, rationale: "a", budget_owls: 3 },
      { action: "assess", claim_id: b, rationale: "b", budget_owls: 2 },
      { action: "assess", claim_id: c, rationale: "c", budget_owls: 1 },
    ]);
    await materializePlanItems(m.grantId);
    let p = await plan(m.grantId);
    expect(p.ledgers[0]).toMatchObject({ status: "open" });
    expect(p.ledgers[1]!.status).toBe("waiting");
    // The figures: the budget asked, what the day has left, the rate.
    expect(p.ledgers[1]!.reason).toMatch(/2 owls/);
    expect(p.ledgers[1]!.reason).toMatch(/1 of 4 owls/);
    expect(p.ledgers[1]!.reason).toMatch(/standing order/);
    // c would fit in the owl that is left, but orders are placed in plan order.
    expect(p.ledgers[2]!.status).toBe("waiting");
    expect(p.ledgers[2]!.reason).toMatch(/plan order/);
    expect(await orders(m.grantId, b)).toHaveLength(0);
    expect(await orders(m.grantId, c)).toHaveLength(0);
    // Nothing reached the inbox of a node whose pass is not paid for yet.
    const [unsent] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM node_messages WHERE node_id = $1`, [b]);
    expect(unsent!.n).toBe(0);
    expect(p.cursor).toBe(1);

    // a's pass runs for 1 owl: the day now has 3 left, and the next
    // look places b and c.
    await runPass(a, 1 * OWL, m.jobId);
    await materializeStandingOrders();
    p = await plan(m.grantId);
    expect(p.ledgers.map((l) => l!.status)).toEqual(["done", "open", "open"]);
    expect(Number((await orders(m.grantId, b))[0]!.amount)).toBe(2 * OWL);
    expect(Number((await orders(m.grantId, c))[0]!.amount)).toBe(1 * OWL);
    expect(await grantDayUseMicroUsd(m.grantId)).toBe(4 * OWL);
  });

  it("blocks, with the figures, a budget no day or no escrow could cover, and does not hold the plan behind it", async () => {
    const m = await mandate({ budget: 6 * OWL, daily: 4 * OWL });
    const big = await seedClaim("over the rate");
    const deep = await seedClaim("over the escrow");
    const fine = await seedClaim("fits");
    await setPlan(m.grantId, [
      { action: "assess", claim_id: big, rationale: "x", budget_owls: 5 },
      { action: "assess", claim_id: fine, rationale: "y", budget_owls: 1 },
    ]);
    await materializePlanItems(m.grantId);
    let p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("blocked");
    expect(p.ledgers[0]!.reason).toMatch(/5 owls.*whole daily rate \(4 owls\)/);
    expect(p.ledgers[1]).toMatchObject({ status: "open" });

    // Unpaced, the escrow is the bound: 6 owls, 1 held by `fine`.
    await rawQuery(`UPDATE grants SET daily_budget_micro_usd = 0 WHERE id = $1`, [m.grantId]);
    await setPlan(m.grantId, [
      { action: "assess", claim_id: fine, rationale: "y", budget_owls: 1, ledger: p.ledgers[1] },
      { action: "assess", claim_id: deep, rationale: "z", budget_owls: 5.5 },
      { action: "assess", claim_id: big, rationale: "x", budget_owls: 7 },
    ]);
    await materializePlanItems(m.grantId);
    p = await plan(m.grantId);
    // 5.5 does not fit beside the owl held now, but would once it returns: waiting.
    expect(p.ledgers[1]!.status).toBe("waiting");
    expect(p.ledgers[1]!.reason).toMatch(/uncommitted now \(5 owls\)/);
    expect(p.ledgers[1]!.reason).toMatch(/1 owls held/);
    // 7 is more than the escrow could ever hold: blocked.
    expect(p.ledgers[2]!.status).toBe("blocked");
    expect(p.ledgers[2]!.reason).toMatch(/7 owls.*6 of 6 owls/);
    expect(await orders(m.grantId, deep)).toHaveLength(0);
  });

  it("does not pay for a pass someone already commissioned, and is met by it", async () => {
    const m = await mandate({ budget: 20 * OWL });
    const claim = await seedClaim("already paid");
    const reader = await richUser();
    const theirs = await commissionNodePass({
      payer: { kind: "user", userId: reader },
      claimId: claim,
      budgetMicroUsd: 2 * OWL,
      brief: "a reader's",
      commissionedBy: "person",
    });
    expect(theirs).toMatchObject({ ok: true, status: "commissioned" });
    await setPlan(m.grantId, [{ action: "reassess", claim_id: claim, rationale: "r" }]);
    await materializePlanItems(m.grantId);
    await materializePlanItems(m.grantId);
    const p = await plan(m.grantId);
    expect(p.ledgers[0]).toMatchObject({ status: "open" });
    expect(p.ledgers[0]!.reason).toMatch(/already paid for/);
    expect(p.ledgers[0]!.order).toBeUndefined();
    expect(await orders(m.grantId, claim)).toHaveLength(0);
    // The plan's look posted nothing to the node's inbox.
    const bodies = await rawQuery<{ body: string }>(`SELECT body FROM node_messages WHERE node_id = $1`, [claim]);
    expect(bodies.map((r) => r.body)).toEqual(["a reader's"]);
    await runPass(claim, OWL, m.jobId);
    await materializePlanItems(m.grantId);
    expect((await plan(m.grantId)).ledgers[0]).toMatchObject({ status: "done" });
    expect((await grantEscrowBreakdown({ id: m.grantId, budgetJobId: m.jobId })).committed).toBe(0);
  });

  it("gives the budget back when the Steward parks the node, and when the pass runs on another lane", async () => {
    const m = await mandate({ budget: 20 * OWL });
    const parked = await seedClaim("parked");
    const elsewhere = await seedClaim("ran elsewhere");
    await setPlan(m.grantId, [
      { action: "assess", claim_id: parked, rationale: "p", budget_owls: 2 },
      { action: "reassess", claim_id: elsewhere, rationale: "e", budget_owls: 2 },
    ]);
    await materializePlanItems(m.grantId);
    expect((await grantEscrowBreakdown({ id: m.grantId, budgetJobId: m.jobId })).held).toBe(4 * OWL);

    // The Steward parks the first; the executor retires its group.
    await rawQuery(
      `UPDATE claims SET steward_state = 'error', steward_error = 'boom', steward_attempts = 3 WHERE id = $1`,
      [parked]
    );
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE exclusion_group = $1`, [ASSESS_GROUP(parked)]);
    // The second is assessed by a reader's express order, outside its row.
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [elsewhere]);
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, assessed_at)
       VALUES ($1, 'supported', 0.8, 'db test', true, now() + interval '5 seconds')`,
      [elsewhere]
    );
    await materializePlanItems(m.grantId);
    const p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("cancelled");
    expect(p.ledgers[0]!.reason).toMatch(/parked/);
    expect(p.ledgers[0]!.reason).toMatch(/back in the escrow/);
    expect(p.ledgers[1]!.status).toBe("done");
    expect((await grantEscrowBreakdown({ id: m.grantId, budgetJobId: m.jobId })).held).toBe(0);
  });

  it("deepen: the node's pass, then a pass on each child waiting for one, one level, each once", async () => {
    const m = await mandate({ budget: 50 * OWL });
    const parent = await seedClaim("deepened");
    const stub = await seedClaim("deferred stub");
    const grandchild = await seedClaim("grandchild stub");
    await rawQuery(`UPDATE claims SET steward_state = 'deferred' WHERE id = ANY($1::uuid[])`, [[stub, grandchild]]);
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
       VALUES ($1, $2, 'requires', 'db test'), ($2, $3, 'requires', 'db test')`,
      [parent, stub, grandchild]
    );
    await setPlan(m.grantId, [{ action: "deepen", claim_id: parent, rationale: "d", budget_owls: 2 }]);
    await materializePlanItems(m.grantId);
    let p = await plan(m.grantId);
    expect(p.ledgers[0]).toMatchObject({ status: "open", children: [stub] });
    expect(await orders(m.grantId, parent)).toHaveLength(1);
    expect(Number((await orders(m.grantId, stub))[0]!.amount)).toBe(2 * OWL);
    // One level: the grandchild stays held out, unpaid.
    expect(await claimState(grandchild)).toBe("deferred");
    expect(await orders(m.grantId, grandchild)).toHaveLength(0);

    // The node's pass runs and mints another child, deferred by the brake.
    const minted = await seedClaim("minted stub");
    await rawQuery(`UPDATE claims SET steward_state = 'deferred' WHERE id = $1`, [minted]);
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
       VALUES ($1, $2, 'requires', 'db test')`,
      [parent, minted]
    );
    await runPass(parent, OWL, m.jobId);
    await runPass(stub, OWL, m.jobId);
    await materializePlanItems(m.grantId);
    p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("done");
    expect(p.ledgers[0]!.children).toEqual([stub, minted]);
    expect(await orders(m.grantId, minted)).toHaveLength(1);

    // The first child is queued again later, for its own reasons: the item
    // ordered it once and is done.
    await rawQuery(`UPDATE claims SET steward_state = 'pending' WHERE id = $1`, [stub]);
    await materializePlanItems(m.grantId);
    await materializeStandingOrders();
    expect(await orders(m.grantId, stub)).toHaveLength(0);
  });

  it("deepen: says how many children still wait for the rate once the node's pass has run", async () => {
    const m = await mandate({ budget: 50 * OWL, daily: 3 * OWL });
    const parent = await seedClaim("deepened paced");
    const kid = await seedClaim("paced kid");
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
       VALUES ($1, $2, 'requires', 'db test')`,
      [parent, kid]
    );
    await rawQuery(`UPDATE claims SET steward_state = 'deferred' WHERE id = $1`, [kid]);
    await setPlan(m.grantId, [{ action: "deepen", claim_id: parent, rationale: "d", budget_owls: 2 }]);
    await materializePlanItems(m.grantId);
    let p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("open");
    expect(p.ledgers[0]!.reason).toMatch(/1 of its children/);
    // The node's pass spends 1.5 of the day's 3: the child's 2 still do not fit.
    await runPass(parent, 1.5 * OWL, m.jobId);
    await materializePlanItems(m.grantId);
    p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("waiting");
    expect(p.ledgers[0]!.reason).toMatch(/the pass on the node ran/);
    // The node's row reopens for someone else's ask: the item does not order its pass again.
    await rawQuery(`UPDATE actions SET status = 'open' WHERE exclusion_group = $1`, [ASSESS_GROUP(parent)]);
    await rawQuery(`UPDATE grants SET daily_budget_micro_usd = $2 WHERE id = $1`, [m.grantId, 10 * OWL]);
    await materializePlanItems(m.grantId);
    p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("done");
    expect(await orders(m.grantId, parent)).toHaveLength(0);
    expect(await orders(m.grantId, kid)).toHaveLength(1);
  });
});

async function richUser(): Promise<string> {
  const id = await seedUser("rich reader");
  await creditOwls(id, 100 * OWL);
  return id;
}
