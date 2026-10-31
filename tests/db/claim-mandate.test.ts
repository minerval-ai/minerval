/**
 * Deep decomposition as a mandate, against real Postgres: funding it (the
 * 5-owl floor, the balance guard, the escrow), its fixed neutral words and
 * "a reader" on its page, the planning pass priced at half the Grantmaker's
 * tenth, the plan running at once with the claim's own pass first, no
 * review once the tenth is spent, and completion with a refund when the
 * work is done. Plus the funder disclosure and the claim page's link to the
 * mandate that paid.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

// The Grantmaker's planning stands in: a plan that does not start with
// the claim itself, so the opening pass has to be put first.
const planner = vi.hoisted(() => ({ items: [] as Array<Record<string, unknown>> }));
vi.mock("../../src/llm/agents/grantor.js", () => ({
  runGrantor: vi.fn(async () => ({ strategy: "Subclaims first.", items: planner.items })),
}));

import { rawQuery } from "../../src/db/client.js";
import { OWL, creditOwls, owlBalance, seedClaim, seedUser } from "./helpers.js";
import { claimMandateText, createClaimMandate } from "../../src/services/claim-mandate-service.js";
import {
  PLANNING_GROUP,
  REVIEW_GROUP,
  grantmakerShareLeftMicroUsd,
  reconcileActions,
} from "../../src/services/action-service.js";
import { funderDisclosure, getPublicMandate } from "../../src/services/mandate-service.js";
import { getFundingLabelForJob } from "../../src/services/grant-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { processNextEngineAction } from "../../src/workers/engine-executor.js";
import { processNextGrantTask } from "../../src/workers/grant-pipeline.js";

async function grant(id: string) {
  const [g] = await rawQuery<{
    status: string;
    name: string;
    policy: string;
    scope_claim_id: string;
    mandate: Record<string, unknown>;
    plan: { items: Array<{ action: string; claim_id?: string }> } | null;
    budget_job_id: string;
  }>(`SELECT status, name, policy, scope_claim_id, mandate, plan, budget_job_id FROM grants WHERE id = $1`, [id]);
  return g!;
}

async function row(group: string) {
  const [a] = await rawQuery<{ id: string; status: string; cost_est_micro_usd: string }>(
    `SELECT id, status, cost_est_micro_usd FROM actions WHERE exclusion_group = $1`,
    [group]
  );
  return a ?? null;
}

/** Leave only this mandate live, so the workers pick it. */
async function only(grantId: string) {
  await rawQuery(
    `UPDATE grants SET status = 'completed' WHERE id <> $1 AND status IN ('active', 'planning', 'pending_approval')`,
    [grantId]
  );
  await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND target_ref <> $1`, [grantId]);
}

beforeAll(async () => {
  await rawQuery(
    `UPDATE grants SET status = 'completed'
      WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  resetAllocationPolicyCache();
});

describe("funding a decomposition", () => {
  it("takes at least 5 owls, and only what the balance covers", async () => {
    const reader = await seedUser("decomposer");
    const claimId = await seedClaim("decomposed");
    expect(await createClaimMandate({ userId: reader, claimId, budgetOwls: 4 })).toMatchObject({
      ok: false,
      code: "BUDGET_TOO_SMALL",
    });
    expect(await createClaimMandate({ userId: reader, claimId, budgetOwls: 5 })).toMatchObject({
      ok: false,
      code: "INSUFFICIENT_OWLS",
    });
    expect(await owlBalance(reader)).toBe(0);
  });

  it("escrows the budget and opens a mandate on the claim, in fixed words, its funder a reader", async () => {
    const reader = await seedUser("decomposer");
    await creditOwls(reader, 30 * OWL);
    const claimId = await seedClaim("Minimum wage rises reduce teen employment");
    const funded = await createClaimMandate({ userId: reader, claimId, budgetOwls: 20 });
    expect(funded.ok).toBe(true);
    if (!funded.ok) return;
    expect(await owlBalance(reader)).toBe(10 * OWL);
    const g = await grant(funded.grantId);
    expect(g).toMatchObject({ status: "planning", policy: "agent", scope_claim_id: claimId });
    const [c] = await rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [claimId]);
    expect(g.name).toBe(claimMandateText(c!.text, 20).title);
    expect(g.name.startsWith('Decompose and assess: "')).toBe(true);
    expect(g.mandate).toMatchObject({
      origin: "deep_decomposition",
      grantmaker_share_owls: 2,
      funder_named: false,
      funder_stake: null,
    });

    // Public while it plans, its funder shown as a reader.
    const page = await getPublicMandate(funded.grantId);
    expect(page).not.toBeNull();
    expect(page!.manager).toBe("a reader");
    expect(page!.funder).toEqual({ shown_as: "a reader", named: false, declared: true, stake: null });
    expect(page!.contributors.find((c) => c.is_manager)?.name).toBe("a reader");
  });
});

describe("the Grantmaker's tenth", () => {
  it("prices the planning pass at half of it, runs the plan at once with the claim first, and stops reviewing once it is spent", async () => {
    const reader = await seedUser("decomposer");
    await creditOwls(reader, 10 * OWL);
    const claimId = await seedClaim("decomposed claim");
    const sub = await seedClaim("a subclaim");
    const funded = await createClaimMandate({ userId: reader, claimId, budgetOwls: 10 });
    if (!funded.ok) throw new Error(funded.message);
    await only(funded.grantId);

    await reconcileActions();
    const planning = await row(PLANNING_GROUP(funded.grantId));
    // A tenth of 10 owls is 1 owl; planning takes half.
    expect(Number(planning!.cost_est_micro_usd)).toBe(0.5 * OWL);

    planner.items = [{ action: "assess", claim_id: sub, rationale: "the crux" }];
    const ran = await processNextEngineAction();
    expect(ran).toMatchObject({ status: "processed", kind: "grant_planning", ok: true });
    const g = await grant(funded.grantId);
    expect(g.status).toBe("active");
    expect(g.plan!.items.map((i) => [i.action, i.claim_id])).toEqual([
      ["reassess", claimId],
      ["assess", sub],
    ]);

    // With the tenth unspent, a review row opens, priced at what is left.
    await reconcileActions();
    const review = await row(REVIEW_GROUP(funded.grantId));
    expect(review).not.toBeNull();
    const left = await grantmakerShareLeftMicroUsd({ id: funded.grantId, mandate: g.mandate as never });
    expect(Number(review!.cost_est_micro_usd)).toBe(Math.max(1, Math.round(left!.leftMicroUsd)));

    // Spend the rest of the tenth: no review stays open.
    await rawQuery(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status, metered_cost_micro_usd)
       VALUES ('mandate_review', $1, 'spent', $2, 'spent', 1, 'done', $3)`,
      [REVIEW_GROUP(funded.grantId), funded.grantId, OWL]
    );
    await reconcileActions();
    expect((await row(REVIEW_GROUP(funded.grantId)))!.status).not.toBe("open");
  });

  it("completes and refunds once the tenth is spent and none of its work is live", async () => {
    const reader = await seedUser("decomposer");
    await creditOwls(reader, 5 * OWL);
    const claimId = await seedClaim("finished claim");
    const funded = await createClaimMandate({ userId: reader, claimId, budgetOwls: 5 });
    if (!funded.ok) throw new Error(funded.message);
    await only(funded.grantId);
    // The plan is done and the whole half-owl tenth went on passes.
    await rawQuery(
      `UPDATE grants SET status = 'active', plan = '{"strategy": "done", "items": []}'::jsonb, plan_cursor = 0
        WHERE id = $1`,
      [funded.grantId]
    );
    await rawQuery(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status, metered_cost_micro_usd)
       VALUES ('grant_planning', $1, 'standard', $2, 'planned', 1, 'done', $3)`,
      [PLANNING_GROUP(funded.grantId), funded.grantId, 0.5 * OWL]
    );
    const result = await processNextGrantTask();
    expect(result).toMatchObject({ status: "completed", grantId: funded.grantId });
    expect((await grant(funded.grantId)).status).toBe("completed");
    // Nothing was metered to the job itself, so the whole escrow returns.
    expect(await owlBalance(reader)).toBe(5 * OWL);
  });
});

describe("who funds a mandate", () => {
  it("shows a named funder by name, an anonymous one as such, and a declared stake either way", () => {
    const base = { is_platform: false, manager_name: "Ada" };
    expect(funderDisclosure({ ...base, mandate: null })).toEqual({
      shown_as: "Ada",
      named: true,
      declared: false,
      stake: null,
    });
    expect(
      funderDisclosure({ ...base, mandate: { funder_named: false, funder_stake: "sells the product" } as never })
    ).toEqual({ shown_as: "an anonymous funder", named: false, declared: true, stake: "sells the product" });
    expect(funderDisclosure({ ...base, mandate: { funder_named: true, funder_stake: null } as never })).toEqual({
      shown_as: "Ada",
      named: true,
      declared: true,
      stake: null,
    });
    expect(funderDisclosure({ ...base, is_platform: true, mandate: null }).shown_as).toBe("Minerval");
  });

  it("gives the claim page the mandate that paid, by title, once it is public", async () => {
    const reader = await seedUser("decomposer");
    await creditOwls(reader, 5 * OWL);
    const claimId = await seedClaim("linked claim");
    const funded = await createClaimMandate({ userId: reader, claimId, budgetOwls: 5 });
    if (!funded.ok) throw new Error(funded.message);
    const label = await getFundingLabelForJob(funded.budgetJobId);
    expect(label).toEqual({
      type: "grant",
      label: "a funded mandate",
      mandate: { id: funded.grantId, title: (await grant(funded.grantId)).name },
    });
  });
});
