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
import { lastPassOutcome, reportUnconcludedPass } from "../../src/services/pass-outcome-service.js";
import type { PassOutcome } from "../../src/llm/agents/pass-outcome.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

async function commissionAndRun(
  grantId: string,
  jobId: string,
  claimId: string,
  budget: number,
  metered: number,
  outcome?: PassOutcome
): Promise<string> {
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
  await completeAction(row!.id, metered, { meteredJobId: jobId, ...(outcome ? { outcome } : {}) });
  return row!.id;
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

  it("reads back what each pass concluded, and never lists a pass that concluded as short (#1027)", async () => {
    const funder = await seedUser("outcome funder");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL, dailyBudgetMicroUsd: 20 * OWL });
    const [{ since }] = await rawQuery<{ since: string }>(`SELECT (now() - interval '1 minute')::text AS since`);
    const before = { id: "00000000-0000-4000-8000-000000000001", status: "supported", at: "2026-11-12T00:00:00.000Z" };
    const changed = await seedClaim("changed status");
    const stood = await seedClaim("stood, spending everything");
    const unconcluded = await seedClaim("ended without a conclusion");
    await commissionAndRun(grantId, jobId, changed, 3 * OWL, 1 * OWL, {
      kind: "recorded",
      tool: "update_claim_assessment",
      status_after: "doubtful",
      before,
    });
    await commissionAndRun(grantId, jobId, stood, 3 * OWL, 3 * OWL, {
      kind: "stood",
      logged: "no_action_needed",
      audit_log_id: null,
      before,
    });
    const unconcludedOutcome: PassOutcome = {
      kind: "unconcluded",
      ended_by: "turn_guard",
      spent_all: false,
      platform_side: false,
      wrote: [{ tool: "add_decomposition_edge", n: 3 }],
      before,
    };
    const actionId = await commissionAndRun(grantId, jobId, unconcluded, 3 * OWL, 1 * OWL, unconcludedOutcome);

    // The ledger row carries what came of the run, and run_settled says it.
    const [row] = await rawQuery<{ outcome: PassOutcome }>(`SELECT outcome FROM actions WHERE id = $1`, [actionId]);
    expect(row!.outcome).toMatchObject({ kind: "unconcluded", ended_by: "turn_guard" });
    const [settled] = await rawQuery<{ summary: string; payload: { outcome?: PassOutcome } }>(
      `SELECT summary, payload FROM events WHERE kind = 'run_settled' AND action_id = $1`,
      [actionId]
    );
    expect(settled!.summary).toContain(
      "ended without recording a conclusion (it reached the turn guard; it wrote add_decomposition_edge ×3). " +
        "The assessment of 2026-11-12 is unchanged by this pass."
    );
    expect(settled!.payload.outcome).toMatchObject({ kind: "unconcluded" });

    const text = await reflectionSections(grantId, since);
    expect(text).toContain(
      "What the passes you paid for concluded: 1 recorded an assessment that changed status, 0 recorded one at the same status, " +
        "1 concluded by a logged decision that the assessment stands, 1 ended without a conclusion."
    );
    const none = text.split("## Passes that ended without a conclusion")[1]!.split("## ")[0]!;
    expect(none).toContain(`on ${unconcluded}`);
    expect(none).toContain("it reached the turn guard");
    expect(none).not.toContain(stood);
    // The decision that the assessment stands spent its whole budget, and is not a shortfall.
    const short = text.split("## Runs that ran short without asking")[1]!.split("## ")[0]!;
    expect(short).toContain("None.");

    // The officers are told once per node: a second pass that ends the same
    // way folds into the item still waiting.
    expect(await reportUnconcludedPass(actionId, unconcluded, unconcludedOutcome)).toBe(1);
    expect(await reportUnconcludedPass(actionId, unconcluded, unconcludedOutcome)).toBe(1);
    const items = await rawQuery<{ kind: string; summary: string; detail: { passes: number } }>(
      `SELECT kind, summary, detail FROM mandate_inbox WHERE grant_id = $1 AND target_node_id = $2`,
      [grantId, unconcluded]
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("outcome");
    expect(items[0]!.detail.passes).toBe(2);
    expect(items[0]!.summary).toContain("nothing has been re-queued");

    // The node view says what the last pass concluded, beside stewarded_at.
    expect(await lastPassOutcome(stood)).toMatchObject({
      kind: "stood",
      summary: "concluded the assessment stands (logged: no_action_needed).",
    });
    expect(await lastPassOutcome(await seedClaim("never passed"))).toBeNull();
  });
});
