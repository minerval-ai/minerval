/**
 * Closing a ledger row settles its money (#1045), against real Postgres:
 * a cancelled run pays for what it metered and returns the rest, a reader's
 * owls come back to their balance, the row says why it closed and forgets
 * it when reopened, the sweep returns money a path left on a closed row and
 * leaves a lookout's fund alone, and a mandate's direct commissions are its
 * Grantmaker's to change until the row is running.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { completeAction } from "../../src/services/action-service.js";
import { cancelActions, settleDeadGroups } from "../../src/services/action-settlement.js";
import { amendCommissions } from "../../src/services/commission-amend-service.js";
import {
  seedUser,
  seedClaim,
  seedGrantWithJob,
  seedAction,
  seedAllocation,
  getAction,
  getAllocation,
  owlBalance,
  OWL,
} from "./helpers.js";

async function mandate(label: string, owls = 10) {
  const funder = await seedUser(`settle-${label}`);
  return seedGrantWithJob({ funderId: funder, budgetMicroUsd: owls * OWL });
}

/** Move a row's close and its money's placement past the sweep's grace. */
async function age(group: string): Promise<void> {
  await rawQuery(`UPDATE actions SET updated_at = now() - interval '1 hour' WHERE exclusion_group = $1`, [group]);
  await rawQuery(
    `UPDATE action_allocations SET created_at = now() - interval '1 hour' WHERE exclusion_group = $1`,
    [group]
  );
}

describe("cancelActions", () => {
  it("a failed ingest pays for what it metered from its commission and returns the rest", async () => {
    const { grantId, jobId } = await mandate("ingest");
    const group = `ingest:https://example.org/${Math.random()}`;
    const row = await seedAction({ group, kind: "ingest", costMicroUsd: OWL, status: "running" });
    const al = await seedAllocation({ group, actionId: row, grantId, amountMicroUsd: OWL, commissionedBy: "grantmaker" });

    const res = await cancelActions({
      group,
      reason: "the source could not be fetched: the site answered 403",
      includeRunning: true,
      ranId: row,
      meteredMicroUsd: 120_000,
      meteredJobId: jobId,
    });
    expect(res.cancelled).toEqual([row]);
    expect(res.releasedMicroUsd).toBe(OWL - 120_000);

    const a = await getAction(row);
    expect(a!.status).toBe("cancelled");
    expect(Number(a!.metered_cost_micro_usd)).toBe(120_000);
    const [why] = await rawQuery<{ closed_reason: string }>(`SELECT closed_reason FROM actions WHERE id = $1`, [row]);
    expect(why!.closed_reason).toBe("the source could not be fetched: the site answered 403");

    const settled = await getAllocation(al);
    expect(Number(settled.spent_micro_usd)).toBe(120_000);
    expect(settled.released_at).not.toBeNull();
  });

  it("returns a reader's commission to their balance when the row closes unrun", async () => {
    const reader = await seedUser("settle-reader");
    const claimId = await seedClaim("settle-reader");
    const group = `assess:${claimId}`;
    const row = await seedAction({ group, claimId, costMicroUsd: 300_000 });
    const al = await seedAllocation({ group, claimId, actionId: row, userId: reader, amountMicroUsd: 300_000, commissionedBy: "person" });
    const before = await owlBalance(reader);

    await cancelActions({ group, reason: "the node left the Steward's queue" });

    expect((await getAllocation(al)).released_at).not.toBeNull();
    expect((await owlBalance(reader)) - before).toBe(300_000);
  });

  it("leaves the money of a group whose other row is still running", async () => {
    const { grantId } = await mandate("sibling");
    const claimId = await seedClaim("settle-sibling");
    const group = `assess:${claimId}`;
    await seedAction({ group, claimId, variant: "standard", costMicroUsd: 100_000, status: "running" });
    const strong = await seedAction({ group, claimId, variant: "strong", costMicroUsd: 300_000 });
    const onGroup = await seedAllocation({ group, claimId, grantId, amountMicroUsd: 100_000, commissionedBy: "grantmaker" });
    const onStrong = await seedAllocation({ group, claimId, actionId: strong, grantId, amountMicroUsd: 300_000, commissionedBy: "plan" });

    await cancelActions({ group, ids: [strong], reason: "withdrawn" });

    expect((await getAllocation(onStrong)).released_at).not.toBeNull();
    // The running pass is still paid for by the money on the group.
    expect((await getAllocation(onGroup)).released_at).toBeNull();
  });

  it("forgets why a row closed when the group's next work reopens it", async () => {
    const group = `curate:${Math.random()}`;
    const row = await seedAction({ group, kind: "curate", costMicroUsd: 100_000 });
    await cancelActions({ group, reason: "nothing is left for the Curator to read there" });
    await rawQuery(`UPDATE actions SET status = 'open' WHERE id = $1`, [row]);
    const [r] = await rawQuery<{ closed_reason: string | null }>(`SELECT closed_reason FROM actions WHERE id = $1`, [row]);
    expect(r!.closed_reason).toBeNull();
  });
});

describe("completeAction", () => {
  it("releases a commission the run spent whole, so it no longer reads as live", async () => {
    const { grantId } = await mandate("whole");
    const group = `ingest:https://example.org/${Math.random()}`;
    const row = await seedAction({ group, kind: "ingest", costMicroUsd: OWL, status: "running" });
    const al = await seedAllocation({ group, actionId: row, grantId, amountMicroUsd: OWL, commissionedBy: "grantmaker" });
    await completeAction(row, OWL);
    const a = await getAllocation(al);
    expect(Number(a.spent_micro_usd)).toBe(OWL);
    expect(a.released_at).not.toBeNull();
  });
});

describe("settleDeadGroups", () => {
  it("returns money a path left on a closed row, past the grace", async () => {
    const { grantId } = await mandate("dead");
    const group = `ingest:https://example.org/${Math.random()}`;
    const row = await seedAction({ group, kind: "ingest", costMicroUsd: OWL, status: "running" });
    const al = await seedAllocation({ group, actionId: row, grantId, amountMicroUsd: OWL, commissionedBy: "grantmaker" });
    // The old way of failing an ingest: the row closed, the money left held.
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE id = $1`, [row]);

    await settleDeadGroups();
    expect((await getAllocation(al)).released_at).toBeNull(); // within the grace

    await age(group);
    const res = await settleDeadGroups();
    expect(res.groups).toBeGreaterThanOrEqual(1);
    expect((await getAllocation(al)).released_at).not.toBeNull();
  });

  it("leaves a lookout's fund, which is money on a group with no rows", async () => {
    const { grantId } = await mandate("fund");
    const group = `lookout-fund:${Math.random()}`;
    const al = await seedAllocation({ group, grantId, amountMicroUsd: OWL, commissionedBy: "steward" });
    await age(group);
    await settleDeadGroups();
    expect((await getAllocation(al)).released_at).toBeNull();
  });

  it("leaves money on a row that is still open", async () => {
    const { grantId } = await mandate("open");
    const claimId = await seedClaim("settle-open");
    const group = `assess:${claimId}`;
    const row = await seedAction({ group, claimId, costMicroUsd: OWL });
    const al = await seedAllocation({ group, claimId, actionId: row, grantId, amountMicroUsd: OWL, commissionedBy: "grantmaker" });
    await age(group);
    await settleDeadGroups();
    expect((await getAllocation(al)).released_at).toBeNull();
  });
});

describe("amendCommissions", () => {
  async function commissioned(label: string, commissionedBy = "grantmaker", status = "open") {
    const { grantId } = await mandate(label);
    const claimId = await seedClaim(`amend-${label}`);
    const group = `assess:${claimId}`;
    const row = await seedAction({ group, claimId, costMicroUsd: 2 * OWL, status });
    const al = await seedAllocation({ group, claimId, actionId: row, grantId, amountMicroUsd: 2 * OWL, commissionedBy });
    return { grantId, row, al };
  }

  it("withdraws a commission whose row has not started, and records the decision", async () => {
    const c = await commissioned("withdraw");
    const res = await amendCommissions({ grantId: c.grantId, changes: [{ action_id: c.row, withdraw: true }], note: "no longer needed" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changes[0]).toMatchObject({ change: "withdrawn", returned_owls: 2 });
    expect((await getAllocation(c.al)).released_at).not.toBeNull();
    const [d] = await rawQuery<{ decision: string }>(
      `SELECT decision FROM mandate_decisions WHERE grant_id = $1 AND target = $2`,
      [c.grantId, c.row]
    );
    expect(d!.decision).toBe("withdrew a commission");
  });

  it("lowers and raises a commission within the escrow", async () => {
    const c = await commissioned("budget");
    const lowered = await amendCommissions({ grantId: c.grantId, changes: [{ action_id: c.row, budget_owls: 1 }], note: "smaller" });
    expect(lowered.ok).toBe(true);
    expect(Number((await getAllocation(c.al)).amount_micro_usd)).toBe(OWL);
    const raised = await amendCommissions({ grantId: c.grantId, changes: [{ action_id: c.row, budget_owls: 3 }], note: "larger" });
    expect(raised.ok).toBe(true);
    expect(Number((await getAllocation(c.al)).amount_micro_usd)).toBe(3 * OWL);
  });

  it("refuses a running row, a plan order and the mandate's own upkeep, changing nothing", async () => {
    const running = await commissioned("running", "grantmaker", "running");
    const r1 = await amendCommissions({ grantId: running.grantId, changes: [{ action_id: running.row, withdraw: true }], note: "x" });
    expect(r1.ok).toBe(false);
    expect((await getAllocation(running.al)).released_at).toBeNull();

    const plan = await commissioned("plan", "plan");
    const r2 = await amendCommissions({ grantId: plan.grantId, changes: [{ action_id: plan.row, withdraw: true }], note: "x" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.problem).toContain("amend_plan_items");

    const upkeep = await commissioned("upkeep", "mandate");
    const r3 = await amendCommissions({ grantId: upkeep.grantId, changes: [{ action_id: upkeep.row, withdraw: true }], note: "x" });
    expect(r3.ok).toBe(false);
  });
});
