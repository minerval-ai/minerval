/**
 * Commissions against real Postgres: a run paid for whole at its payer's
 * budget runs whatever the row's estimate, its unspent budget returns at
 * settlement, a mandate's day counts what is spent or still held, and an
 * agent paying from its own budget moves money without changing who paid.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import {
  ASSESS_GROUP,
  actionBudgetMicroUsd,
  completeAction,
  reconcileActions,
} from "../../src/services/action-service.js";
import { commissionAction, commissionNodePass } from "../../src/services/commission-service.js";
import { committedWithinMicroUsd } from "../../src/services/pace-service.js";
import { grantCommittedMicroUsd } from "../../src/services/regrant-service.js";
import { executeNotifySteward } from "../../src/llm/tools/notify-steward.js";
import { withPassBudget } from "../../src/llm/usage-context.js";
import { OWL, creditOwls, owlBalance, seedAction, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

async function standardRow(claimId: string): Promise<{ id: string; cost: number }> {
  const [r] = await rawQuery<{ id: string; cost: string }>(
    `SELECT id, cost_est_micro_usd AS cost FROM actions WHERE exclusion_group = $1 AND variant = 'standard'`,
    [ASSESS_GROUP(claimId)]
  );
  return { id: r!.id, cost: Number(r!.cost) };
}

describe("commissions", () => {
  it("pays for a pass whole, below the row's estimate if the payer chose so, and runs at exactly that budget", async () => {
    const funder = await seedUser("commission funder");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL, dailyBudgetMicroUsd: 20 * OWL });
    const claim = await seedClaim("commissioned");
    await rawQuery(`UPDATE actions SET cost_est_micro_usd = $2 WHERE exclusion_group = $1`, [ASSESS_GROUP(claim), 10 * OWL]);
    const res = await commissionNodePass({
      payer: { kind: "grant", grantId },
      claimId: claim,
      budgetMicroUsd: 3 * OWL,
      brief: "Look again at the 2023 replication.",
      reason: "A dispute is waiting on an important node.",
      commissionedBy: "program_officer",
    });
    expect(res).toMatchObject({ ok: true, status: "commissioned", budgetMicroUsd: 3 * OWL, tier: "standard" });
    const row = await standardRow(claim);
    await rawQuery(`UPDATE actions SET cost_est_micro_usd = $2 WHERE id = $1`, [row.id, 10 * OWL]);

    const [runnable] = await rawQuery<{ coverage: string; commissioned: boolean }>(
      `SELECT (SELECT SUM(amount_micro_usd - spent_micro_usd) FROM action_allocations al
                WHERE al.exclusion_group = a.exclusion_group AND al.released_at IS NULL) AS coverage,
              EXISTS (SELECT 1 FROM action_allocations al WHERE al.exclusion_group = a.exclusion_group
                        AND al.commissioned_by IS NOT NULL AND al.released_at IS NULL) AS commissioned
         FROM actions a WHERE a.id = $1`,
      [row.id]
    );
    expect(runnable!.commissioned).toBe(true);
    expect(actionBudgetMicroUsd({ cost_est_micro_usd: 10 * OWL, coverage_micro_usd: Number(runnable!.coverage), commissioned: true })).toBe(3 * OWL);

    // The brief reached the node's inbox, marked paid, and the node is pending.
    const [m] = await rawQuery<{ body: string; paid: boolean }>(
      `SELECT body, paid FROM node_messages WHERE node_id = $1`,
      [claim]
    );
    expect(m).toEqual({ body: "Look again at the 2023 replication.", paid: true });

    // The day counts the held budget; settlement returns what the run didn't spend.
    expect(await committedWithinMicroUsd(grantId, 24)).toBe(3 * OWL);
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [row.id]);
    await completeAction(row.id, 1.2 * OWL, { meteredJobId: jobId });
    expect(await committedWithinMicroUsd(grantId, 24)).toBe(1.2 * OWL);
    expect(await grantCommittedMicroUsd({ id: grantId, budgetJobId: jobId })).toBe(1.2 * OWL);
  });

  it("refuses a budget past what today's rate has left, counting spend and held budgets", async () => {
    const funder = await seedUser("paced funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL, dailyBudgetMicroUsd: 4 * OWL });
    const a = await seedClaim("paced a");
    const b = await seedClaim("paced b");
    const first = await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: a, budgetMicroUsd: 3 * OWL, brief: "a", commissionedBy: "program_officer" });
    expect(first.ok).toBe(true);
    const second = await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: b, budgetMicroUsd: 2 * OWL, brief: "b", commissionedBy: "program_officer" });
    expect(second).toMatchObject({ ok: false, code: "OVER_PACE" });
  });

  it("adds a brief to the inbox at no cost when the node's pass is already commissioned", async () => {
    const funder = await seedUser("dup funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const claim = await seedClaim("dup");
    await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: claim, budgetMicroUsd: 2 * OWL, brief: "first", commissionedBy: "program_officer" });
    const again = await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: claim, budgetMicroUsd: 2 * OWL, brief: "second", commissionedBy: "steward" });
    expect(again).toMatchObject({ ok: true, status: "already_commissioned" });
    const [n] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM action_allocations WHERE exclusion_group = $1 AND commissioned_by IS NOT NULL`,
      [ASSESS_GROUP(claim)]
    );
    expect(n!.n).toBe(1);
    const bodies = await rawQuery<{ body: string }>(`SELECT body FROM node_messages WHERE node_id = $1 ORDER BY created_at`, [claim]);
    expect(bodies.map((r) => r.body)).toEqual(["first", "second"]);
  });

  it("queues the node when a pass is commissioned by its row's id, so the money is never left on a row nothing runs (#849)", async () => {
    const funder = await seedUser("by-id funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    // An assessed node that is not queued: its row stands open until the
    // sweep retires it, and an officer may be handed its id meanwhile.
    const claim = await seedClaim("by id");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
    const row = await seedAction({ group: ASSESS_GROUP(claim), claimId: claim, costMicroUsd: OWL });
    const res = await commissionAction({
      payer: { kind: "grant", grantId },
      actionId: row,
      budgetMicroUsd: 2 * OWL,
      brief: "The 2023 replication.",
      commissionedBy: "program_officer",
    });
    expect(res).toMatchObject({ ok: true, status: "commissioned", kind: "assess" });
    const [c] = await rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [claim]);
    expect(c!.steward_state).toBe("pending");
    const [m] = await rawQuery<{ body: string; paid: boolean }>(`SELECT body, paid FROM node_messages WHERE node_id = $1`, [claim]);
    expect(m).toEqual({ body: "The 2023 replication.", paid: true });
    // The sweep that used to retire the row and strand the money leaves it.
    await reconcileActions();
    const [a] = await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE id = $1`, [row]);
    expect(a!.status).toBe("open");

    // A row the sweep already retired is the same ask.
    const stale = await seedClaim("by id, retired");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [stale]);
    const retired = await seedAction({ group: ASSESS_GROUP(stale), claimId: stale, costMicroUsd: OWL, status: "cancelled" });
    const second = await commissionAction({ payer: { kind: "grant", grantId }, actionId: retired, budgetMicroUsd: OWL, commissionedBy: "program_officer" });
    expect(second).toMatchObject({ ok: true, status: "commissioned" });
    const [a2] = await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE id = $1`, [retired]);
    expect(a2!.status).toBe("open");

    // A commission stranded on a retired group (placed before this fix)
    // pays for the node's next pass: asking again queues the node, at no cost.
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [stale]);
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE exclusion_group = $1`, [ASSESS_GROUP(stale)]);
    const third = await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: stale, budgetMicroUsd: OWL, brief: "again", commissionedBy: "program_officer" });
    expect(third).toMatchObject({ ok: true, status: "already_commissioned" });
    const [c3] = await rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [stale]);
    expect(c3!.steward_state).toBe("pending");
    const live = await rawQuery(`SELECT 1 FROM action_allocations WHERE exclusion_group = $1 AND released_at IS NULL`, [ASSESS_GROUP(stale)]);
    expect(live).toHaveLength(1);
  });

  it("lets a running agent pay from its own budget, keeping the mandate as payer and recording the chain", async () => {
    const funder = await seedUser("chain funder");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const parentClaim = await seedClaim("chain parent");
    const childClaim = await seedClaim("chain child");
    await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: parentClaim, budgetMicroUsd: 5 * OWL, brief: "parent", commissionedBy: "program_officer" });
    const parent = await standardRow(parentClaim);
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [parent.id]);
    const before = await grantCommittedMicroUsd({ id: grantId, budgetJobId: jobId });

    const child = await commissionNodePass({
      payer: { kind: "run", actionId: parent.id },
      claimId: childClaim,
      budgetMicroUsd: 2 * OWL,
      brief: "Your premise looks wrong: see the 2023 revision.",
      commissionedBy: "steward",
      message: { trigger: "dependent_note", sender: { kind: "steward", nodeId: parentClaim } },
    });
    expect(child).toMatchObject({ ok: true, status: "commissioned" });
    const [moved] = await rawQuery<{ grant_id: string; amount: string; parent_action_id: string }>(
      `SELECT grant_id, amount_micro_usd AS amount, parent_action_id FROM action_allocations
        WHERE exclusion_group = $1 AND commissioned_by = 'steward'`,
      [ASSESS_GROUP(childClaim)]
    );
    expect(moved).toEqual({ grant_id: grantId, amount: String(2 * OWL), parent_action_id: parent.id });
    // The mandate's committed total is unchanged: the money moved, it was not added.
    expect(await grantCommittedMicroUsd({ id: grantId, budgetJobId: jobId })).toBe(before);
    const [left] = await rawQuery<{ unspent: string }>(
      `SELECT SUM(amount_micro_usd - spent_micro_usd) AS unspent FROM action_allocations
        WHERE exclusion_group = $1 AND released_at IS NULL`,
      [ASSESS_GROUP(parentClaim)]
    );
    expect(Number(left!.unspent)).toBe(3 * OWL);

    const tooMuch = await commissionNodePass({
      payer: { kind: "run", actionId: parent.id },
      claimId: await seedClaim("chain too much"),
      budgetMicroUsd: 4 * OWL,
      brief: "x",
      commissionedBy: "steward",
    });
    expect(tooMuch).toMatchObject({ ok: false, code: "OVER_RUN_BUDGET" });
  });

  it("debits a person's owls for a commission and refunds what the run leaves", async () => {
    const user = await seedUser("paying reader");
    await creditOwls(user, 5 * OWL);
    const claim = await seedClaim("reader-paid");
    const res = await commissionNodePass({ payer: { kind: "user", userId: user }, claimId: claim, budgetMicroUsd: 4 * OWL, brief: "Please assess this.", commissionedBy: "person", message: { trigger: "user_order" } });
    expect(res.ok).toBe(true);
    expect(await owlBalance(user)).toBe(1 * OWL);
    const row = await standardRow(claim);
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [row.id]);
    await completeAction(row.id, 1.5 * OWL);
    expect(await owlBalance(user)).toBe(3.5 * OWL);
    const over = await commissionNodePass({ payer: { kind: "user", userId: user }, claimId: await seedClaim("too dear"), budgetMicroUsd: 10 * OWL, brief: "x", commissionedBy: "person" });
    expect(over).toMatchObject({ ok: false, code: "INSUFFICIENT_OWLS" });
  });

  it("pays for a target's pass from notify_steward's budget_owls, lowering the sender's ceiling", async () => {
    const funder = await seedUser("notify funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const sender = await seedClaim("notify sender");
    const target = await seedClaim("notify target");
    await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: sender, budgetMicroUsd: 6 * OWL, brief: "sender pass", commissionedBy: "program_officer" });
    const senderRow = await standardRow(sender);
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [senderRow.id]);

    let ceiling = 0;
    const { value } = await withPassBudget(
      { microUsd: 6 * OWL, source: "a commission", funding: { actionId: senderRow.id } },
      async () => {
        const out = JSON.parse(
          await executeNotifySteward(
            { role: "steward", claimId: sender },
            { target_ids: [target], message: "Your verdict rests on a retracted trial.", budget_owls: 2 }
          )
        );
        const { getUsageContext } = await import("../../src/llm/usage-context.js");
        ceiling = getUsageContext().passBudget!.microUsd;
        return out;
      }
    );
    expect(value.success).toBe(true);
    expect(value.notified[0]).toMatchObject({ id: target, paid_owls: 2 });
    expect(ceiling).toBe(4 * OWL);
    const [m] = await rawQuery<{ body: string; paid: boolean; sender_node_id: string }>(
      `SELECT body, paid, sender_node_id FROM node_messages WHERE node_id = $1`,
      [target]
    );
    expect(m).toEqual({ body: "Your verdict rests on a retracted trial.", paid: true, sender_node_id: sender });
  });
});
