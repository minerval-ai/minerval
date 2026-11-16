/**
 * The review briefing's read-back of a mandate's money against real
 * Postgres: a commissioned run that spent its whole budget keeps
 * released_at NULL (completeAction stamps it only where something returns),
 * and is still a settled run, a run that ran short, and, when it metered
 * past its budget, a run whose spend includes the overage (#1027).
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { ASSESS_GROUP, completeAction } from "../../src/services/action-service.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import { reflectionSections } from "../../src/services/mandate-reflection-service.js";
import { microUsdToOwls } from "../../src/services/owl.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

async function commissionAndRun(grantId: string, jobId: string, claimId: string, budget: number, metered: number) {
  const res = await commissionNodePass({
    payer: { kind: "grant", grantId },
    claimId,
    budgetMicroUsd: budget,
    brief: "Look again.",
    reason: "A node the mandate pays for.",
    commissionedBy: "program_officer",
  });
  expect(res).toMatchObject({ ok: true, status: "commissioned" });
  const [row] = await rawQuery<{ id: string }>(
    `SELECT id FROM actions WHERE exclusion_group = $1 AND variant = 'standard'`,
    [ASSESS_GROUP(claimId)]
  );
  await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [row!.id]);
  await completeAction(row!.id, metered, { meteredJobId: jobId });
}

describe("the review briefing's read-back", () => {
  it("counts a run that spent its whole budget, or went past it, as settled and as running short", async () => {
    const funder = await seedUser("reflection funder");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL, dailyBudgetMicroUsd: 20 * OWL });
    const [{ since }] = await rawQuery<{ since: string }>(`SELECT (now() - interval '1 minute')::text AS since`);
    const under = await seedClaim("spent part of its budget");
    const whole = await seedClaim("spent its whole budget");
    const over = await seedClaim("spent past its budget");
    await commissionAndRun(grantId, jobId, under, 3 * OWL, 1 * OWL);
    await commissionAndRun(grantId, jobId, whole, 3 * OWL, 3 * OWL);
    await commissionAndRun(grantId, jobId, over, 3 * OWL, 4 * OWL);

    // The premise: the fully spent allocations were never stamped released.
    const [unstamped] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM action_allocations
        WHERE grant_id = $1 AND commissioned_by IS NOT NULL AND released_at IS NULL`,
      [grantId]
    );
    expect(unstamped!.n).toBe(2);

    const text = await reflectionSections(grantId, since);
    const o = microUsdToOwls;
    expect(text).toContain(`Spent ${o(8 * OWL)} owls over 3 runs`);
    expect(text).toContain("2 used more than 90%");
    const short = text.split("## Runs that ran short without asking")[1]!.split("## ")[0]!;
    expect(short).toContain("2 run(s)");
    expect(short).toContain(`on ${whole} (${o(3 * OWL)} of ${o(3 * OWL)} owls)`);
    expect(short).toContain(`on ${over} (${o(4 * OWL)} of ${o(3 * OWL)} owls)`);
    expect(short).not.toContain(under);
  });
});
