/**
 * The Audit's read of the ledger and plan surface against a real database
 * (#433): every row in scope in every status with its allocation history,
 * every plan item targeting those rows with its recorded standing checked
 * against the row it names, and the "removed" case — a plan item whose
 * action_id resolves to no row once its claim left the graph. The jsonb
 * plan unnesting, the NULL-parameter scoping, and the cascade are exactly
 * what the mocked unit suite cannot see.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { inspectLedger } from "../../src/services/ledger-inspection-service.js";
import { materializePlanItems } from "../../src/services/action-service.js";
import {
  seedClaim,
  seedUser,
  seedGrantWithJob,
  seedAction,
  seedAllocation,
  creditOwls,
  OWL,
} from "./helpers.js";

async function setPlan(grantId: string, items: unknown[]): Promise<void> {
  await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
    grantId,
    JSON.stringify({ strategy: "s", items }),
  ]);
}

describe("inspectLedger (#433)", () => {
  it("refuses an empty scope and a non-uuid id without touching the database", async () => {
    expect(await inspectLedger({})).toMatchObject({ ok: false, code: "SCOPE_REQUIRED" });
    expect(await inspectLedger({ claimId: "not-a-uuid" })).toMatchObject({ ok: false, code: "BAD_ID" });
  });

  it("by claim: every row in every status, its backing and allocation history, and the plan items on any mandate that target it", async () => {
    const funder = await seedUser("ledger-funder");
    await creditOwls(funder, 1000 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 500 * OWL });
    const { grantId: otherGrant } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100 * OWL });
    const claim = await seedClaim("inspected");
    const unrelated = await seedClaim("unrelated");

    // A finished assess group: the standard variant won, strong was superseded.
    const won = await seedAction({ group: `assess:${claim}`, variant: "standard", costMicroUsd: 2 * OWL, status: "done", claimId: claim });
    const lost = await seedAction({ group: `assess:${claim}`, variant: "strong", costMicroUsd: 6 * OWL, status: "superseded", claimId: claim });
    // An open formalize row, half backed by the mandate, plus a released pin on the loser.
    const formalize = await seedAction({ group: `formalize:${claim}`, costMicroUsd: 10 * OWL, kind: "formalize", claimId: claim });
    await seedAllocation({ group: `formalize:${claim}`, grantId, claimId: claim, amountMicroUsd: 4 * OWL });
    await seedAllocation({ group: `assess:${claim}`, actionId: lost, grantId, claimId: claim, amountMicroUsd: 6 * OWL, released: true });
    await seedAllocation({ group: `assess:${claim}`, grantId, claimId: claim, amountMicroUsd: 2 * OWL, spentMicroUsd: 2 * OWL });
    // Noise: a row and a plan item on another claim.
    await seedAction({ group: `assess:${unrelated}`, costMicroUsd: OWL, claimId: unrelated });

    // Two mandates target the claim; one of them records a standing that
    // is now stale against the row (done, but the item still says open).
    await setPlan(grantId, [
      { action: "assess", claim_id: unrelated, rationale: "noise" },
      {
        action: "assess",
        claim_id: claim,
        rationale: "first pass",
        ledger: { status: "open", action_id: won, exclusion_group: `assess:${claim}`, checked_at: new Date().toISOString() },
      },
    ]);
    await setPlan(otherGrant, [
      {
        action: "formalize",
        claim_id: claim,
        rationale: "state it",
        ledger: { status: "open", action_id: formalize, exclusion_group: `formalize:${claim}`, checked_at: new Date().toISOString() },
      },
    ]);

    const res = await inspectLedger({ claimId: claim });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { inspection } = res;
    expect(inspection.claim).toMatchObject({ id: claim, state: "active" });
    expect(inspection.mandate).toBeNull();
    expect(inspection.notes).toEqual([]);

    // Every status, nothing from the other claim.
    expect(inspection.actions_total).toBe(3);
    const byId = new Map(inspection.actions.map((a) => [a.action_id, a]));
    expect([...byId.keys()].sort()).toEqual([won, lost, formalize].sort());
    expect(byId.get(won)!.status).toBe("done");
    expect(byId.get(lost)!.status).toBe("superseded");

    // Backing counts only live money; history keeps the released pin and the spent row.
    const f = byId.get(formalize)!;
    expect(f.backing_owls).toBe(4);
    expect(f.covered).toBe(false);
    expect(f.allocations).toHaveLength(1);
    expect(f.allocations[0]).toMatchObject({ funder: { kind: "mandate", mandate_id: grantId }, amount_owls: 4, spent_owls: 0, live: true, released_at: null });
    const w = byId.get(won)!;
    expect(w.backing_owls).toBe(0);
    // The unpinned spent allocation applies to the winner; the pin on the loser does not.
    expect(w.allocations.map((a) => a.live)).toEqual([false]);
    expect(w.allocations[0]).toMatchObject({ pinned_action_id: null, spent_owls: 2 });
    const l = byId.get(lost)!;
    expect(l.allocations).toHaveLength(2);
    expect(l.allocations.find((a) => a.pinned_action_id === lost)).toMatchObject({ live: false });
    expect(l.allocations.find((a) => a.pinned_action_id === lost)!.released_at).toBeTruthy();

    // Plan items from both mandates, only the ones targeting this claim,
    // each checked against its row.
    expect(inspection.plan_items).toHaveLength(2);
    const stale = inspection.plan_items.find((p) => p.mandate_id === grantId)!;
    expect(stale).toMatchObject({
      index: 1,
      action: "assess",
      claim_id: claim,
      state: "queued",
      action_on_ledger: true,
      action_status: "done",
      standing_matches_action: false,
    });
    const fresh = inspection.plan_items.find((p) => p.mandate_id === otherGrant)!;
    expect(fresh).toMatchObject({ index: 0, action: "formalize", action_on_ledger: true, action_status: "open", standing_matches_action: true });
  });

  it("by mandate: its plan items, the rows they name, its own review row, and rows its money backed; a removed row reads as action_on_ledger false", async () => {
    const funder = await seedUser("mandate-funder");
    await creditOwls(funder, 1000 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 500 * OWL });
    const kept = await seedClaim("kept");
    const doomed = await seedClaim("doomed");
    const backedOnly = await seedClaim("backed only");

    await setPlan(grantId, [
      { action: "assess", claim_id: kept, rationale: "keep" },
      { action: "assess", claim_id: doomed, rationale: "will vanish" },
      { action: "formalize", claim_id: kept, rationale: "no domain: blocked" },
    ]);
    await materializePlanItems(grantId);
    const review = await seedAction({ group: `mandate_review:${grantId}`, kind: "mandate_review", costMicroUsd: OWL, targetRef: grantId, status: "done" });
    const backed = await seedAction({ group: `assess:${backedOnly}`, costMicroUsd: OWL, claimId: backedOnly });
    await seedAllocation({ group: `assess:${backedOnly}`, grantId, claimId: backedOnly, amountMicroUsd: OWL });

    // The doomed claim leaves the graph; its row cascades away, the plan
    // item still names it.
    const before = await inspectLedger({ mandateId: grantId });
    if (!before.ok) throw new Error(before.message);
    const doomedItem = before.inspection.plan_items[1]!;
    expect(doomedItem).toMatchObject({ action_on_ledger: true, action_status: "open", standing_matches_action: true });
    const doomedActionId = doomedItem.ledger!.action_id!;
    await rawQuery(`DELETE FROM claims WHERE id = $1`, [doomed]);

    const res = await inspectLedger({ mandateId: grantId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { inspection } = res;
    expect(inspection.mandate).toMatchObject({ id: grantId, status: "active", plan_items: 3, budget_status: "running" });
    expect(inspection.claim).toBeNull();

    expect(inspection.plan_items.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(inspection.plan_items[0]).toMatchObject({ state: "queued", action_on_ledger: true, action_status: "open", standing_matches_action: true });
    // Removed: the standing still names a row, and the row is gone.
    expect(inspection.plan_items[1]).toMatchObject({ state: "queued", action_on_ledger: false, action_status: null, standing_matches_action: null });
    expect(inspection.plan_items[1]!.ledger!.action_id).toBe(doomedActionId);
    // Blocked: no row to name at all.
    expect(inspection.plan_items[2]).toMatchObject({ state: "blocked", action_on_ledger: null, action_status: null, standing_matches_action: null });
    expect(inspection.plan_items[2]!.ledger!.reason).toContain("publish_formalization");

    const ids = inspection.actions.map((a) => a.action_id);
    expect(ids).toContain(inspection.plan_items[0]!.ledger!.action_id);
    expect(ids).toContain(review);
    expect(ids).toContain(backed);
    expect(ids).not.toContain(doomedActionId);
    expect(inspection.actions.find((a) => a.action_id === backed)).toMatchObject({ backing_owls: 1, covered: true });
  });

  it("by action: the row, its siblings, the plan items naming it, and a note when the id is not on the ledger", async () => {
    const claim = await seedClaim("by action");
    const standard = await seedAction({ group: `assess:${claim}`, variant: "standard", costMicroUsd: OWL, claimId: claim });
    const strong = await seedAction({ group: `assess:${claim}`, variant: "strong", costMicroUsd: 3 * OWL, claimId: claim });
    await seedAction({ group: `formalize:${claim}`, kind: "formalize", costMicroUsd: OWL, claimId: claim });

    const res = await inspectLedger({ actionId: strong });
    if (!res.ok) throw new Error(res.message);
    expect(res.inspection.actions.map((a) => a.action_id).sort()).toEqual([standard, strong].sort());
    expect(res.inspection.plan_items).toEqual([]);
    expect(res.inspection.notes).toEqual([]);

    const gone = await inspectLedger({ actionId: randomUUID() });
    if (!gone.ok) throw new Error(gone.message);
    expect(gone.inspection.actions).toEqual([]);
    expect(gone.inspection.notes[0]).toMatch(/not on the ledger/);
  });
});
