/**
 * Plan items as standing orders, against real Postgres (#849): an assess,
 * reassess or deepen item is commissioned from its mandate, whole, within
 * the pace and the escrow; what the pace cannot cover waits with the
 * figures and is placed when the room is there; what could never fit is
 * blocked; a sweep never pays twice. And what its first day showed (#956,
 * #961): an item names its tier or commissions nothing, an order that does
 * not fit holds nothing behind it, an order can be changed or withdrawn
 * until its pass is running, and a deepen item orders only the children
 * that carry no judgment.
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
import { commissionNodePass } from "../../src/services/commission-service.js";
import { committedWithinMicroUsd } from "../../src/services/pace-service.js";
import { grantEscrowBreakdown } from "../../src/services/regrant-service.js";
import { PLAN_ORDER_COMMISSIONER, previewPlanOrders } from "../../src/services/standing-order-service.js";
import { amendPlanItems, releaseUnstartedOrders } from "../../src/services/plan-amend-service.js";
import { executeMandateOperationsTool } from "../../src/llm/agents/program-officer.js";
import { stewardTierCostEstimates } from "../../src/services/cost-estimate-service.js";
import { microUsdToOwls } from "../../src/services/owl.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { OWL, creditOwls, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

interface Item {
  action: string;
  claim_id?: string;
  ledger?: PlanItemLedger;
  [k: string]: unknown;
}

/**
 * Write a plan as stored. A stewarding item is stored with its tier, so one
 * a test writes without a `variant` key gets standard, as normalizePlanItems
 * gives it; `variant: undefined` writes an item from before that rule.
 */
async function setPlan(grantId: string, items: Item[]): Promise<void> {
  const stored = items.map((i) =>
    ["assess", "reassess", "deepen"].includes(i.action) && !("variant" in i) ? { ...i, variant: "standard" } : i
  );
  await rawQuery(`UPDATE grants SET plan = $2::jsonb, plan_cursor = 0 WHERE id = $1`, [
    grantId,
    JSON.stringify({ strategy: "s", items: stored }),
  ]);
}

async function items(grantId: string): Promise<Item[]> {
  const [row] = await rawQuery<{ plan: { items: Item[] } }>(`SELECT plan FROM grants WHERE id = $1`, [grantId]);
  return row!.plan.items;
}

/** Mark a node judged, as a finished pass leaves it. */
async function assess(claimId: string): Promise<void> {
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, assessed_at)
     VALUES ($1, 'supported', 0.8, 'db test', true, now() - interval '9 days')`,
    [claimId]
  );
}

async function child(parent: string, label: string, state: "pending" | "deferred"): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(`UPDATE claims SET steward_state = $2 WHERE id = $1`, [id, state]);
  await rawQuery(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
     VALUES ($1, $2, 'requires', 'db test')`,
    [parent, id]
  );
  return id;
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
    // Commissioned and waiting their turn: neither has started, so the
    // cursor has not moved and either can still be amended or withdrawn.
    expect(first.cursor).toBe(0);
    expect(await claimState(a)).toBe("pending");
    // The day holds what was commissioned.
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(3 * OWL + Number(placedB[0]!.amount));

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

  it("waits, with the figures, for room in the pace without holding later items that fit, and is placed when the room opens", async () => {
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
    // It says its tier, that it holds nothing behind it, and what changes it.
    expect(p.ledgers[1]!.reason).toMatch(/standard tier/);
    expect(p.ledgers[1]!.reason).toMatch(/does not hold the items after it/);
    expect(p.ledgers[1]!.reason).toMatch(/amend_plan_items/);
    // c fits in the owl that is left, and is placed past b (#956).
    expect(p.ledgers[2]).toMatchObject({ status: "open" });
    expect(await orders(m.grantId, b)).toHaveLength(0);
    expect(Number((await orders(m.grantId, c))[0]!.amount)).toBe(1 * OWL);
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(4 * OWL);
    // Nothing reached the inbox of a node whose pass is not paid for yet.
    const [unsent] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM node_messages WHERE node_id = $1`, [b]);
    expect(unsent!.n).toBe(0);
    expect(p.cursor).toBe(0);

    // a's pass runs for 1 owl: the day now has 2 left, and the next look
    // places b.
    await runPass(a, 1 * OWL, m.jobId);
    await materializeStandingOrders();
    p = await plan(m.grantId);
    expect(p.ledgers.map((l) => l!.status)).toEqual(["done", "open", "open"]);
    expect(Number((await orders(m.grantId, b))[0]!.amount)).toBe(2 * OWL);
    expect(Number((await orders(m.grantId, c))[0]!.amount)).toBe(1 * OWL);
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(4 * OWL);
    // The one item whose work has run is the plan's started prefix.
    expect(p.cursor).toBe(1);
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
    expect(p.ledgers[0]!.reason).toMatch(/5 owls.*whole pace window \(4 owls per 24 hours\)/);
    expect(p.ledgers[1]).toMatchObject({ status: "open" });

    // Unpaced, the escrow is the bound: 6 owls, 1 held by `fine`.
    await rawQuery(`UPDATE grants SET pace = '{"kind":"as_needed"}'::jsonb WHERE id = $1`, [m.grantId]);
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
    expect(p.ledgers[0]!.reason).toMatch(/1 of its unassessed children is not commissioned yet/);
    expect(p.ledgers[0]!.reason).toContain(kid);
    expect(p.ledgers[0]!.children_waiting).toEqual([kid]);
    // The node's pass spends 1.5 of the window's 3: the child's 2 still do not fit.
    await runPass(parent, 1.5 * OWL, m.jobId);
    await materializePlanItems(m.grantId);
    p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("waiting");
    expect(p.ledgers[0]!.reason).toMatch(/the pass on the node ran/);
    // The node's row reopens for someone else's ask: the item does not order its pass again.
    await rawQuery(`UPDATE actions SET status = 'open' WHERE exclusion_group = $1`, [ASSESS_GROUP(parent)]);
    await rawQuery(`UPDATE grants SET pace = (CASE WHEN $2::bigint > 0 THEN jsonb_build_object('kind','steady','owls',$2::bigint / 1000000.0,'period_hours',24) ELSE '{"kind":"as_needed"}'::jsonb END) WHERE id = $1`, [m.grantId, 10 * OWL]);
    await materializePlanItems(m.grantId);
    p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("done");
    expect(await orders(m.grantId, parent)).toHaveLength(0);
    expect(await orders(m.grantId, kid)).toHaveLength(1);
  });
});

/** amend_plan_items as the Grantmaker's tool returns it, in a review pass. */
async function amend(grantId: string, changes: unknown[], note = "db test"): Promise<Record<string, any>> {
  const out = await executeMandateOperationsTool(grantId, "amend_plan_items", { changes, note }, { chat: false });
  return JSON.parse(out!);
}

describe("what the first day of standing orders showed (#956)", () => {
  it("an item written without a tier commissions nothing, says why with both estimates, and holds nothing behind it", async () => {
    // The report: deepen items appended before items named a tier became
    // strong orders at the estimate, took most of a 25-owl day, and the one
    // that did not fit held nine 0.8-owl items behind it.
    const m = await mandate({ budget: 100 * OWL, daily: 25 * OWL });
    const old1 = await seedClaim("legacy deepen");
    const stub = await child(old1, "legacy stub", "deferred");
    const old2 = await seedClaim("legacy reassess");
    const later = [await seedClaim("later 1"), await seedClaim("later 2"), await seedClaim("later 3")];
    await setPlan(m.grantId, [
      { action: "deepen", claim_id: old1, rationale: "appended before #914", variant: undefined },
      { action: "reassess", claim_id: old2, rationale: "appended before #914", variant: undefined },
      ...later.map((c) => ({ action: "assess", claim_id: c, rationale: "new", budget_owls: 0.8 })),
    ]);
    await materializePlanItems(m.grantId);
    let p = await plan(m.grantId);
    const est = await stewardTierCostEstimates();
    for (const i of [0, 1]) {
      expect(p.ledgers[i]!.status).toBe("blocked");
      expect(p.ledgers[i]!.reason).toMatch(/names no variant/);
      expect(p.ledgers[i]!.reason).toMatch(/amend_plan_items/);
      // Both tiers' current estimates, so the choice can be made from the reason.
      expect(p.ledgers[i]!.reason).toContain(`${microUsdToOwls(est.standardMicroUsd)} owls`);
      expect(p.ledgers[i]!.reason).toContain(`${microUsdToOwls(est.strongMicroUsd)} owls`);
    }
    expect(p.ledgers[0]!.reason).toMatch(/same holds for its 1 unassessed children/);
    expect(p.ledgers[0]!.children_waiting).toEqual([stub]);
    // Nothing was placed, queued or released on their account.
    expect(await orders(m.grantId, old1)).toHaveLength(0);
    expect(await orders(m.grantId, old2)).toHaveLength(0);
    expect(await claimState(stub)).toBe("deferred");
    // The items after them are placed.
    for (const c of later) expect(Number((await orders(m.grantId, c))[0]!.amount)).toBe(0.8 * OWL);
    expect(p.ledgers.slice(2).map((l) => l!.status)).toEqual(["open", "open", "open"]);
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(2.4 * OWL);
    // And stay so on every later look.
    await materializeStandingOrders();
    await reconcileActions();
    expect(await orders(m.grantId, old1)).toHaveLength(0);

    // The Grantmaker gives one its tier and withdraws the other, in one call.
    const res = await amend(
      m.grantId,
      [
        { index: 0, claim_id: old1, variant: "standard", budget_owls: 1 },
        { index: 1, claim_id: old2, withdraw: true },
      ],
      "near-settled premises: standard is enough"
    );
    expect(res.success).toBe(true);
    expect(res.items[0]).toMatchObject({ index: 0, variant: "standard", budget_owls: 1 });
    expect(res.items[0].ledger).toMatchObject({ status: "open", order: { budget_owls: 1 }, children: [stub] });
    expect(res.items[1].ledger.status).toBe("cancelled");
    expect(res.items[1].ledger.reason).toMatch(/withdrawn by the mandate's Grantmaker/);
    expect(res.items[1].ledger.reason).toMatch(/near-settled premises/);
    expect(res.items[1].ledger.reason).toMatch(/It held no money/);
    expect(Number((await orders(m.grantId, old1))[0]!.amount)).toBe(1 * OWL);
    expect(Number((await orders(m.grantId, stub))[0]!.amount)).toBe(1 * OWL);
    expect(await orders(m.grantId, old2)).toHaveLength(0);
    const stored = await items(m.grantId);
    expect(stored[0]).toMatchObject({ variant: "standard", budget_owls: 1, amended: { note: "near-settled premises: standard is enough" } });
    expect(stored[1]!.withdrawn).toMatchObject({ note: "near-settled premises: standard is enough" });
    // A withdrawn item is never asked for again.
    await materializeStandingOrders();
    await reconcileActions();
    p = await plan(m.grantId);
    expect(p.ledgers[1]!.status).toBe("cancelled");
    expect(await orders(m.grantId, old2)).toHaveLength(0);
  });

  it("an order the pace cannot cover is passed by every later order that fits, and the pace's room is used", async () => {
    const m = await mandate({ budget: 200 * OWL, daily: 25 * OWL });
    const big = [await seedClaim("big 1"), await seedClaim("big 2"), await seedClaim("big 3"), await seedClaim("big 4")];
    const small: string[] = [];
    for (let i = 0; i < 9; i++) small.push(await seedClaim(`small ${i}`));
    await setPlan(m.grantId, [
      ...big.map((c) => ({ action: "reassess", claim_id: c, rationale: "big", variant: "strong", budget_owls: 7 })),
      ...small.map((c) => ({ action: "assess", claim_id: c, rationale: "small", budget_owls: 0.8 })),
    ]);
    await materializePlanItems(m.grantId);
    const p = await plan(m.grantId);
    // Three big orders take 21 of the window's 25; the fourth cannot fit in 4.
    expect(p.ledgers.slice(0, 3).map((l) => l!.status)).toEqual(["open", "open", "open"]);
    expect(p.ledgers[3]!.status).toBe("waiting");
    expect(p.ledgers[3]!.reason).toMatch(/7 owls \(strong tier\)/);
    expect(p.ledgers[3]!.reason).toMatch(/4 of 25 owls/);
    expect(p.ledgers[3]!.reason).toMatch(/does not hold the items after it/);
    // Five small orders fit in the 4 owls it left; the other four wait for
    // room of their own, each told what the day has left.
    expect(p.ledgers.slice(4, 9).map((l) => l!.status)).toEqual(["open", "open", "open", "open", "open"]);
    expect(p.ledgers.slice(9).map((l) => l!.status)).toEqual(["waiting", "waiting", "waiting", "waiting"]);
    expect(p.ledgers[9]!.reason).toMatch(/0\.8 owls \(standard tier\)/);
    expect(p.ledgers[9]!.reason).toMatch(/0 of 25 owls/);
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(25 * OWL);
    expect(await orders(m.grantId, big[3]!)).toHaveLength(0);
    expect(await orders(m.grantId, small[5]!)).toHaveLength(0);

    // The Grantmaker re-tiers the big one that waits: it is placed at once.
    const res = await amend(m.grantId, [{ index: 3, claim_id: big[3], variant: "standard", budget_owls: null }]);
    expect(res.success).toBe(true);
    // Nothing was held, so nothing came back; the day is full, so it still waits, on its new terms.
    expect(res.returned_owls).toBe(0);
    expect(res.items[0].ledger.status).toBe("waiting");
    expect(res.items[0].ledger.reason).toMatch(/standard pass's estimate/);
    expect((await items(m.grantId))[3]).not.toHaveProperty("budget_owls");
  });

  it("an order placed and not yet running is re-tiered in place: the old budget comes back and the new one is placed", async () => {
    const m = await mandate({ budget: 50 * OWL, daily: 10 * OWL });
    const x = await seedClaim("re-tiered");
    const y = await seedClaim("was waiting behind the room");
    await setPlan(m.grantId, [
      { action: "reassess", claim_id: x, rationale: "x", variant: "strong", budget_owls: 6 },
      { action: "assess", claim_id: y, rationale: "y", budget_owls: 5 },
    ]);
    await materializePlanItems(m.grantId);
    expect(Number((await orders(m.grantId, x))[0]!.amount)).toBe(6 * OWL);
    expect((await plan(m.grantId)).ledgers[1]!.status).toBe("waiting");

    const res = await amend(m.grantId, [{ index: 0, claim_id: x, variant: "standard", budget_owls: 1 }], "week-old verdict");
    expect(res).toMatchObject({ success: true, returned_owls: 6 });
    expect(res.items[0].change).toMatch(/now standard, 1 owls a pass/);
    expect(res.items[0].ledger).toMatchObject({ status: "open", order: { budget_owls: 1, tier: "standard" } });
    const placed = await orders(m.grantId, x);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ variant: "standard" });
    expect(Number(placed[0]!.amount)).toBe(1 * OWL);
    // The room it gave back is used in the same call: y is placed.
    expect(Number((await orders(m.grantId, y))[0]!.amount)).toBe(5 * OWL);
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(6 * OWL);
    expect((await grantEscrowBreakdown({ id: m.grantId, budgetJobId: m.jobId })).held).toBe(6 * OWL);
  });

  it("a waiting order before a started item, and a placed one, can be withdrawn; the money comes back and neither is asked for again", async () => {
    const m = await mandate({ budget: 50 * OWL, daily: 4 * OWL });
    const a = await seedClaim("placed, to be withdrawn");
    const b = await seedClaim("waiting before a started item");
    const c = await seedClaim("runs");
    await setPlan(m.grantId, [
      { action: "assess", claim_id: a, rationale: "a", budget_owls: 3 },
      { action: "assess", claim_id: b, rationale: "b", budget_owls: 3 },
      { action: "assess", claim_id: c, rationale: "c", budget_owls: 1 },
    ]);
    await materializePlanItems(m.grantId);
    await runPass(c, 0.5 * OWL, m.jobId);
    await materializePlanItems(m.grantId);
    let p = await plan(m.grantId);
    expect(p.ledgers.map((l) => l!.status)).toEqual(["open", "waiting", "done"]);
    // The started prefix reaches past the waiting order: adjust_plan could never drop it.
    expect(p.cursor).toBe(3);

    const res = await amend(
      m.grantId,
      [
        { index: 0, claim_id: a, withdraw: true },
        { index: 1, claim_id: b, withdraw: true },
      ],
      "covered by the officers' commissions"
    );
    expect(res).toMatchObject({ success: true, returned_owls: 3 });
    expect(res.items[0].ledger.status).toBe("cancelled");
    expect(res.items[0].ledger.reason).toMatch(/before its pass began/);
    expect(res.items[0].ledger.reason).toMatch(/3 owls it held are back in the escrow and in the pace's room/);
    expect(res.items[1].ledger.status).toBe("cancelled");
    expect(res.items[1].ledger.reason).toMatch(/It held no money/);
    expect(await orders(m.grantId, a)).toHaveLength(0);
    expect((await grantEscrowBreakdown({ id: m.grantId, budgetJobId: m.jobId })).held).toBe(0);
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(0.5 * OWL);

    // Room opens: neither is placed, on the scheduler's look or the full sweep.
    await rawQuery(`UPDATE grants SET pace = $2::jsonb WHERE id = $1`, [
      m.grantId,
      JSON.stringify({ kind: "steady", owls: 40, period_hours: 24, reason: "db test" }),
    ]);
    await materializeStandingOrders();
    await reconcileActions();
    p = await plan(m.grantId);
    expect(p.ledgers.map((l) => l!.status)).toEqual(["cancelled", "cancelled", "done"]);
    expect(await orders(m.grantId, a)).toHaveLength(0);
    expect(await orders(m.grantId, b)).toHaveLength(0);
    // They read cancelled to every reader of the plan, the SQL view included.
    const view = await rawQuery<{ ledger_status: string }>(
      `SELECT ledger_status FROM public_read.plan_items WHERE mandate_id = $1 ORDER BY item_index`,
      [m.grantId]
    );
    expect(view.map((r) => r.ledger_status)).toEqual(["cancelled", "cancelled", "done"]);
  });

  it("refuses, whole and with the reason, a change to work that has started, to another kind of item, or to the wrong node", async () => {
    const m = await mandate({ budget: 50 * OWL });
    const running = await seedClaim("running");
    const done = await seedClaim("done");
    const open = await seedClaim("open");
    await setPlan(m.grantId, [
      { action: "assess", claim_id: running, rationale: "r", budget_owls: 1 },
      { action: "assess", claim_id: done, rationale: "d", budget_owls: 1 },
      { action: "assess", claim_id: open, rationale: "o", budget_owls: 1 },
      { action: "attempt_proof", claim_id: open, rationale: "s", variant: "standard" },
    ]);
    await materializePlanItems(m.grantId);
    await runPass(done, 0.5 * OWL, m.jobId);
    await rawQuery(
      `UPDATE actions a SET status = 'running' WHERE a.exclusion_group = $1
          AND EXISTS (SELECT 1 FROM action_allocations al WHERE al.action_id = a.id AND al.released_at IS NULL)`,
      [ASSESS_GROUP(running)]
    );
    await materializePlanItems(m.grantId);
    expect((await plan(m.grantId)).ledgers.slice(0, 3).map((l) => l!.status)).toEqual(["running", "done", "open"]);

    let res = await amend(m.grantId, [{ index: 0, claim_id: running, variant: "strong" }]);
    expect(res.success).toBe(false);
    expect(res.problem).toMatch(/its pass is running, so its work has started/);
    res = await amend(m.grantId, [{ index: 1, claim_id: done, withdraw: true }]);
    expect(res.problem).toMatch(/item 1 is done: its pass has run/);
    res = await amend(m.grantId, [{ index: 3, claim_id: open, withdraw: true }]);
    expect(res.problem).toMatch(/item 3 is an attempt_proof item/);
    expect(res.problem).toMatch(/assess, reassess, deepen/);
    res = await amend(m.grantId, [{ index: 2, claim_id: done, withdraw: true }]);
    expect(res.problem).toMatch(new RegExp(`item 2 is an assess item on node ${open}, not ${done}`));
    res = await amend(m.grantId, [{ index: 2, withdraw: true }]);
    expect(res.problem).toMatch(/give its claim_id with the index/);
    res = await amend(m.grantId, [{ index: 9, claim_id: open, withdraw: true }]);
    expect(res.problem).toMatch(/the plan has 4 items/);
    res = await amend(m.grantId, [{ index: 2, claim_id: open, variant: "max" }]);
    expect(res.problem).toMatch(/variant is standard or strong/);
    res = await amend(m.grantId, [{ index: 2, claim_id: open, budget_owls: 0 }]);
    expect(res.problem).toMatch(/budget_owls is a number of owls above zero, or null/);
    res = await amend(m.grantId, [{ index: 2, claim_id: open }]);
    expect(res.problem).toMatch(/say what to change/);
    res = await amend(m.grantId, [{ index: 2, claim_id: open, withdraw: true }], " ");
    expect(res.problem).toMatch(/note required/);
    // One refusal refuses the call: the change that could have been made was not.
    res = await amend(m.grantId, [
      { index: 2, claim_id: open, variant: "strong" },
      { index: 0, claim_id: running, withdraw: true },
    ]);
    expect(res.success).toBe(false);
    expect(res.problem).toMatch(/nothing was changed/);
    expect((await items(m.grantId))[2]).toMatchObject({ variant: "standard" });
    expect(Number((await orders(m.grantId, open))[0]!.amount)).toBe(1 * OWL);
    // The running pass kept its money throughout.
    expect(await orders(m.grantId, running)).toHaveLength(1);
  });

  it("releases what an item placed and has not started, and nothing of a pass that is running", async () => {
    // What adjust_plan does for each item it replaces.
    const m = await mandate({ budget: 50 * OWL });
    const queued = await seedClaim("queued order");
    const running = await seedClaim("running order");
    await setPlan(m.grantId, [
      { action: "assess", claim_id: queued, rationale: "q", budget_owls: 2 },
      { action: "assess", claim_id: running, rationale: "r", budget_owls: 2 },
    ]);
    await materializePlanItems(m.grantId);
    await rawQuery(
      `UPDATE actions a SET status = 'running' WHERE a.exclusion_group = $1
          AND EXISTS (SELECT 1 FROM action_allocations al WHERE al.action_id = a.id AND al.released_at IS NULL)`,
      [ASSESS_GROUP(running)]
    );
    const old = await items(m.grantId);
    expect((await releaseUnstartedOrders(m.grantId, 0, old as never)).releasedMicroUsd).toBe(2 * OWL);
    expect((await releaseUnstartedOrders(m.grantId, 1, old as never)).releasedMicroUsd).toBe(0);
    expect(await orders(m.grantId, queued)).toHaveLength(0);
    expect(await orders(m.grantId, running)).toHaveLength(1);
  });
});

describe("a deepen item orders first assessments, not fresh passes on judged children (#961)", () => {
  it("orders the children that carry no judgment and leaves the judged ones that are merely queued", async () => {
    // The report: a parent with assessed children, each with an open
    // reassess row from early November, was bought a strong re-pass on one
    // and had two more "not commissioned yet".
    const m = await mandate({ budget: 100 * OWL });
    const parent = await seedClaim("deepened parent");
    const stub = await child(parent, "unjudged stub", "deferred");
    const queued = await child(parent, "unjudged, queued", "pending");
    const judged1 = await child(parent, "judged 3 Nov, queued for a fresh look", "pending");
    const judged2 = await child(parent, "judged, queued", "pending");
    await assess(judged1);
    await assess(judged2);
    await setPlan(m.grantId, [{ action: "deepen", claim_id: parent, rationale: "d", budget_owls: 2 }]);
    await materializePlanItems(m.grantId);
    let p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("open");
    expect([...p.ledgers[0]!.children!].sort()).toEqual([stub, queued].sort());
    expect(p.ledgers[0]!.children_waiting).toBeUndefined();
    expect(p.ledgers[0]!.reason).toMatch(/2 of its children already carry an assessment/);
    expect(p.ledgers[0]!.reason).toMatch(/a reassess item on a child is the ask/);
    expect(Number((await orders(m.grantId, stub))[0]!.amount)).toBe(2 * OWL);
    expect(Number((await orders(m.grantId, queued))[0]!.amount)).toBe(2 * OWL);
    expect(await orders(m.grantId, judged1)).toHaveLength(0);
    expect(await orders(m.grantId, judged2)).toHaveLength(0);
    // The node and its two unjudged children: three passes, not five.
    expect((await grantEscrowBreakdown({ id: m.grantId, budgetJobId: m.jobId })).held).toBe(6 * OWL);

    // The passes run. The item is done; the judged children were never ordered.
    await runPass(parent, OWL, m.jobId);
    await runPass(stub, OWL, m.jobId);
    await runPass(queued, OWL, m.jobId);
    await materializePlanItems(m.grantId);
    await materializeStandingOrders();
    p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("done");
    expect(await orders(m.grantId, judged1)).toHaveLength(0);
    expect(await claimState(judged1)).toBe("pending");
    // A reassess item on the child is the ask for a fresh pass on it.
    await setPlan(m.grantId, [
      { action: "deepen", claim_id: parent, rationale: "d", budget_owls: 2, ledger: p.ledgers[0] },
      { action: "reassess", claim_id: judged1, rationale: "new evidence", budget_owls: 1 },
    ]);
    await materializePlanItems(m.grantId);
    expect(Number((await orders(m.grantId, judged1))[0]!.amount)).toBe(1 * OWL);
  });

  it("names the children it could not commission yet, asks for every one, and takes new terms for those not started", async () => {
    const m = await mandate({ budget: 100 * OWL, daily: 5 * OWL });
    const parent = await seedClaim("deepened under a rate");
    const first = await child(parent, "first stub", "deferred");
    const second = await child(parent, "second stub", "deferred");
    await setPlan(m.grantId, [{ action: "deepen", claim_id: parent, rationale: "d", budget_owls: 2 }]);
    await materializePlanItems(m.grantId);
    let p = await plan(m.grantId);
    // 5 owls a day: the node and one child at 2 each; the other child waits.
    expect(p.ledgers[0]!.status).toBe("open");
    expect(p.ledgers[0]!.children).toHaveLength(1);
    const waitingChild = p.ledgers[0]!.children![0] === first ? second : first;
    expect(p.ledgers[0]!.children_waiting).toEqual([waitingChild]);
    expect(p.ledgers[0]!.reason).toMatch(/1 of its unassessed children is not commissioned yet/);
    expect(p.ledgers[0]!.reason).toContain(waitingChild);
    expect(p.ledgers[0]!.reason).toMatch(/1 of 5 owls/);

    // One owl a pass instead: the two orders placed come back (4 owls) and
    // all three passes are placed on the new terms.
    const res = await amend(m.grantId, [{ index: 0, claim_id: parent, budget_owls: 1 }], "stubs are small");
    expect(res).toMatchObject({ success: true, returned_owls: 4 });
    expect(res.items[0].ledger.status).toBe("open");
    expect(res.items[0].ledger.children_waiting).toBeUndefined();
    for (const id of [parent, first, second]) {
      const placed = await orders(m.grantId, id);
      expect(placed).toHaveLength(1);
      expect(Number(placed[0]!.amount)).toBe(1 * OWL);
    }
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(3 * OWL);

    // Once the node's pass has run and every child is ordered, the item is
    // done: there is nothing left of it to withdraw, and the tool says so.
    await runPass(parent, 0.5 * OWL, m.jobId);
    await materializePlanItems(m.grantId);
    const out = await amend(m.grantId, [{ index: 0, claim_id: parent, withdraw: true }], "enough depth");
    expect(out.success).toBe(false);
    expect(out.problem).toMatch(/item 0 is done/);
    p = await plan(m.grantId);
    expect(p.ledgers[0]!.status).toBe("done");
  });

  it("previews what items would commission, by tier, budget and child, without writing or placing anything", async () => {
    const m = await mandate({ budget: 100 * OWL, daily: 20 * OWL });
    const parent = await seedClaim("previewed parent");
    const stub = await child(parent, "previewed stub", "deferred");
    const judged = await child(parent, "previewed judged", "pending");
    await assess(judged);
    const before = await items(m.grantId).catch(() => []);
    const preview = await previewPlanOrders(m.grantId, [
      { action: "deepen", claim_id: parent, variant: "strong", budget_owls: 4 },
      { action: "assess", claim_id: judged, variant: "standard" },
      { action: "reassess", claim_id: judged },
    ]);
    expect(preview.items[0]).toMatchObject({
      action: "deepen",
      tier: "strong",
      budget_owls_per_pass: 4,
      budget_from: "budget_owls",
      children: { would_order: [stub], assessed_left_alone: 1 },
      would_hold_owls: 8,
    });
    expect(preview.items[1]!.node).toMatch(/already carries an assessment/);
    expect(preview.items[1]!.would_hold_owls).toBe(0);
    // An item that names no tier is previewed as it would be stored: standard, at the estimate.
    const est = await stewardTierCostEstimates();
    expect(preview.items[2]).toMatchObject({
      tier: "standard",
      budget_from: "estimate",
      budget_owls_per_pass: microUsdToOwls(est.standardMicroUsd),
    });
    expect(preview.pace).toEqual({ pace: expect.stringMatching(/20 owls/), room_owls: 20 });
    expect(preview.escrow_uncommitted_owls).toBe(100);
    expect(preview.note).toMatch(/nothing was added to the plan or commissioned/);
    // Nothing happened.
    expect(await orders(m.grantId, parent)).toHaveLength(0);
    expect(await orders(m.grantId, stub)).toHaveLength(0);
    expect(await claimState(stub)).toBe("deferred");
    expect(await items(m.grantId).catch(() => [])).toEqual(before);
    expect(await committedWithinMicroUsd(m.grantId, 24)).toBe(0);
  });
});

async function richUser(): Promise<string> {
  const id = await seedUser("rich reader");
  await creditOwls(id, 100 * OWL);
  return id;
}
