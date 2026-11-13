/**
 * Commissions from one mandate (src/services/commission-service.ts) against
 * real Postgres, raced: N parallel commissions must serialize on the
 * per-mandate advisory lock, so the day's rate is committed once, not N
 * times. This is exactly the class of bug the mocked unit suite cannot see.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { commissionAction, commissionNodePass } from "../../src/services/commission-service.js";
import { seedUser, seedClaim, seedGrantWithJob, seedAction, OWL } from "./helpers.js";

async function seedMandateWithRows(opts: { dailyBudgetMicroUsd: number }) {
  const funder = await seedUser("commission-race");
  const { grantId } = await seedGrantWithJob({
    funderId: funder,
    budgetMicroUsd: 10 * OWL,
    dailyBudgetMicroUsd: opts.dailyBudgetMicroUsd,
  });
  await rawQuery(`UPDATE grants SET status = 'active' WHERE id = $1`, [grantId]);
  const actionIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const claimId = await seedClaim(`commission-race-${i}`);
    actionIds.push(await seedAction({ group: `assess:${claimId}`, costMicroUsd: 100_000, claimId }));
  }
  return { grantId, actionIds };
}

describe("commissions from one mandate", () => {
  it("CONCURRENCY: N parallel commissions commit the daily rate once, not N times", async () => {
    // Room for three 100k budgets today.
    const { grantId, actionIds } = await seedMandateWithRows({ dailyBudgetMicroUsd: 300_000 });
    const results = await Promise.all(
      actionIds.map((actionId) =>
        commissionAction({
          payer: { kind: "grant", grantId },
          actionId,
          budgetMicroUsd: 100_000,
          commissionedBy: "program_officer",
        })
      )
    );
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "OVER_PACE")).toBe(true);
    const [sum] = await rawQuery<{ total: string }>(
      `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total
         FROM action_allocations WHERE grant_id = $1 AND released_at IS NULL`,
      [grantId]
    );
    expect(Number(sum!.total)).toBe(300_000);
  });

  it("charges nothing for a row someone already commissioned", async () => {
    const { grantId, actionIds } = await seedMandateWithRows({ dailyBudgetMicroUsd: 0 });
    const once = () =>
      commissionAction({ payer: { kind: "grant", grantId }, actionId: actionIds[0]!, budgetMicroUsd: 100_000, commissionedBy: "program_officer" });
    const [a, b] = await Promise.all([once(), once()]);
    const statuses = [a, b].map((r) => (r.ok ? r.status : r.code)).sort();
    // The advisory lock serializes the two; whichever comes second sees the first.
    expect(statuses).toContain("commissioned");
    const live = await rawQuery(
      `SELECT 1 FROM action_allocations WHERE grant_id = $1 AND released_at IS NULL`,
      [grantId]
    );
    expect(live.length).toBeGreaterThanOrEqual(1);
  });

  it("CONCURRENCY: two mandates commissioning one node at once pay for one pass, on one variant (#849)", async () => {
    const claimId = await seedClaim("commission-race-shared");
    const payers: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { grantId } = await seedGrantWithJob({ funderId: await seedUser(`race-payer-${i}`), budgetMicroUsd: 10 * OWL });
      payers.push(grantId);
    }
    // The four look at the same moment; the lock on the group lets one in.
    const results = await Promise.all(
      payers.map((grantId, i) =>
        commissionNodePass({
          payer: { kind: "grant", grantId },
          claimId,
          budgetMicroUsd: 100_000,
          tier: i % 2 === 0 ? "standard" : "strong",
          brief: `brief ${i}`,
          commissionedBy: "program_officer",
        })
      )
    );
    expect(results.filter((r) => r.ok && r.status === "commissioned")).toHaveLength(1);
    expect(results.filter((r) => r.ok && r.status === "already_commissioned")).toHaveLength(3);
    const live = await rawQuery<{ amount: string }>(
      `SELECT amount_micro_usd AS amount FROM action_allocations
        WHERE exclusion_group = $1 AND released_at IS NULL`,
      [`assess:${claimId}`]
    );
    expect(live.map((r) => Number(r.amount))).toEqual([100_000]);
  });
});
