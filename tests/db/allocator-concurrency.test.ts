/**
 * runMandateAllocator (src/services/allocation-service.ts) against real
 * Postgres, raced: N parallel passes for one grant must serialize on the
 * per-mandate advisory lock so the day's rate is committed once, not N
 * times, and the live-placement index holds one row per (group, pin).
 * This is exactly the class of bug the mocked unit suite cannot see.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { runMandateAllocator } from "../../src/services/allocation-service.js";
import {
  seedUser,
  seedClaim,
  seedGrantWithJob,
  seedAction,
  seedValuation,
  OWL,
} from "./helpers.js";

async function seedValuedMandate(opts: { dailyBudgetMicroUsd: number }) {
  const funder = await seedUser("allocator");
  const { grantId, jobId } = await seedGrantWithJob({
    funderId: funder,
    budgetMicroUsd: 10 * OWL,
    dailyBudgetMicroUsd: opts.dailyBudgetMicroUsd,
  });
  // Six open single-variant groups, each costing 100k, valued descending.
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    const claimId = await seedClaim(`allocator-${i}`);
    const group = `assess:${claimId}`;
    const actionId = await seedAction({
      group,
      costMicroUsd: 100_000,
      claimId,
    });
    await seedValuation({ grantId, actionId, valueEst: 60 - i * 10 });
    groups.push(group);
  }
  return { grantId, jobId, groups };
}

async function grantPlacements(grantId: string) {
  return rawQuery<{
    exclusion_group: string;
    action_id: string | null;
    amount_micro_usd: string;
  }>(
    `SELECT exclusion_group, action_id, amount_micro_usd
       FROM action_allocations WHERE grant_id = $1`,
    [grantId]
  );
}

describe("runMandateAllocator", () => {
  it("a single pass funds best-first within the daily rate", async () => {
    const { grantId } = await seedValuedMandate({
      dailyBudgetMicroUsd: 250_000,
    });
    const result = await runMandateAllocator(grantId);
    // 250k of room buys two 100k placements; the third doesn't fit.
    expect(result.allocated).toBe(2);
    expect(result.allocatedMicroUsd).toBe(200_000);
    const rows = await grantPlacements(grantId);
    expect(rows).toHaveLength(2);
  });

  it("a second sequential pass places nothing more (idempotent within the day)", async () => {
    const { grantId } = await seedValuedMandate({
      dailyBudgetMicroUsd: 250_000,
    });
    await runMandateAllocator(grantId);
    const second = await runMandateAllocator(grantId);
    expect(second.allocated).toBe(0);
    expect((await grantPlacements(grantId)).length).toBe(2);
  });

  it("CONCURRENCY: N parallel passes commit the daily rate once, not N times", async () => {
    const { grantId } = await seedValuedMandate({
      dailyBudgetMicroUsd: 250_000,
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runMandateAllocator(grantId))
    );
    const totalPlaced = results.reduce((s, r) => s + r.allocatedMicroUsd, 0);
    // The advisory lock serializes the passes: total placed stays within
    // ONE day's rate (and equals the single-pass outcome).
    expect(totalPlaced).toBeLessThanOrEqual(250_000);
    expect(totalPlaced).toBe(200_000);

    const rows = await grantPlacements(grantId);
    expect(rows).toHaveLength(2);
    const placedTotal = rows.reduce(
      (s, r) => s + Number(r.amount_micro_usd),
      0
    );
    expect(placedTotal).toBe(200_000);
    // No duplicate live placement per (group, pin).
    const keys = rows.map((r) => `${r.exclusion_group}|${r.action_id ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("runMandateAllocator top-up of its own placement (#451)", () => {
  it("replaces a short live placement with one covering row when the cost rose", async () => {
    const funder = await seedUser("allocator-topup");
    const { grantId } = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 10 * OWL,
      dailyBudgetMicroUsd: 1_000_000,
    });
    const claimId = await seedClaim("allocator-topup");
    const group = `assess:${claimId}`;
    const actionId = await seedAction({ group, costMicroUsd: 100_000, claimId });
    await seedValuation({ grantId, actionId, valueEst: 5 });

    // Yesterday's placement covered yesterday's estimate; the estimate has
    // since risen to 140k.
    await rawQuery(
      `INSERT INTO action_allocations
         (exclusion_group, claim_id, grant_id, amount_micro_usd, created_at)
       VALUES ($1, $2, $3, 100000, now() - interval '2 days')`,
      [group, claimId, grantId]
    );
    await rawQuery(
      `UPDATE actions SET cost_est_micro_usd = 140000 WHERE id = $1`,
      [actionId]
    );

    const result = await runMandateAllocator(grantId);
    expect(result.allocated).toBe(1);
    // New money is the increment; the live row carries the whole cost.
    expect(result.allocatedMicroUsd).toBe(40_000);

    const live = await rawQuery<{ amount_micro_usd: string }>(
      `SELECT amount_micro_usd FROM action_allocations
        WHERE grant_id = $1 AND released_at IS NULL`,
      [grantId]
    );
    expect(live.map((r) => Number(r.amount_micro_usd))).toEqual([140_000]);

    // Covered now, and a second pass leaves it alone.
    const again = await runMandateAllocator(grantId);
    expect(again.allocated).toBe(0);
  });
});
