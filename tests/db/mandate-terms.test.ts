/**
 * A mandate's terms and leaving one (mandate-terms-service.ts), and the
 * operations view its page renders (mandate-service.ts), against real
 * Postgres: an amended objective is applied, versioned and told to the
 * mandates that regranted to it; a platform mandate's waits for approval;
 * a funder takes back their share of the uncommitted money, a person to
 * their balance and a mandate to its escrow.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { amendObjective, withdrawFromMandate } from "../../src/services/mandate-terms-service.js";
import { getMandateAllocationView } from "../../src/services/mandate-service.js";
import { commissionAction } from "../../src/services/commission-service.js";
import { cancelGrant } from "../../src/services/grant-service.js";
import { OWL, owlBalance, seedAction, seedClaim, seedGrantWithJob, seedUser, jobBudget } from "./helpers.js";

async function mandateWithTerms(funderId: string, budget: number) {
  const m = await seedGrantWithJob({ funderId, budgetMicroUsd: budget });
  await rawQuery(
    `UPDATE grants SET mandate = jsonb_build_object('title', 'Ocean heat', 'objective', 'Map what is known about ocean heat uptake.')
      WHERE id = $1`,
    [m.grantId]
  );
  return m;
}

describe("amendObjective", () => {
  it("applies the new objective, keeps the old one, and tells a regranting mandate", async () => {
    const funder = await seedUser("terms-funder");
    const target = await mandateWithTerms(funder, 10 * OWL);
    const source = await seedGrantWithJob({ funderId: await seedUser("terms-regranter"), budgetMicroUsd: 20 * OWL });
    await rawQuery(
      `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd) VALUES ($1, $2, $3)`,
      [source.grantId, target.grantId, 4 * OWL]
    );
    const r = await amendObjective({
      grantId: target.grantId,
      objective: "Map what is known about ocean heat uptake below 2,000 metres.",
      note: "The funder wants the deep ocean.",
      author: "grantmaker",
    });
    expect(r).toMatchObject({ ok: true, status: "applied", notified: 1 });
    const [g] = await rawQuery<{ objective: string; title: string }>(
      `SELECT mandate->>'objective' AS objective, mandate->>'title' AS title FROM grants WHERE id = $1`,
      [target.grantId]
    );
    expect(g!.objective).toContain("below 2,000 metres");
    expect(g!.title).toBe("Ocean heat");
    const [v] = await rawQuery<{ content: { before: { objective: string } } }>(
      `SELECT content FROM mandate_policy_versions WHERE grant_id = $1 AND part = 'terms'`,
      [target.grantId]
    );
    expect(v!.content.before.objective).toBe("Map what is known about ocean heat uptake.");
    const notices = await rawQuery<{ kind: string; summary: string }>(
      `SELECT kind, summary FROM mandate_inbox WHERE grant_id = $1`,
      [source.grantId]
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe("notice");
    expect(notices[0]!.summary).toContain("withdraw_regrant");
  });

  it("holds a platform mandate's amendment for approval", async () => {
    const m = await mandateWithTerms(await seedUser("terms-platform"), 10 * OWL);
    await rawQuery(`UPDATE grants SET is_platform = true WHERE id = $1`, [m.grantId]);
    const r = await amendObjective({ grantId: m.grantId, title: "Ocean heat, deep", note: "x", author: "grantmaker" });
    expect(r).toEqual({ ok: true, status: "awaiting_approval" });
    const [g] = await rawQuery<{ title: string }>(`SELECT mandate->>'title' AS title FROM grants WHERE id = $1`, [m.grantId]);
    expect(g!.title).toBe("Ocean heat");
    await rawQuery(`UPDATE grants SET is_platform = false WHERE id = $1`, [m.grantId]);
  });

  it("refuses an amendment without a note", async () => {
    const m = await mandateWithTerms(await seedUser("terms-note"), 10 * OWL);
    expect(await amendObjective({ grantId: m.grantId, objective: "y", note: " ", author: "grantmaker" })).toMatchObject({ ok: false });
  });
});

describe("withdrawFromMandate", () => {
  it("returns a person's share of the uncommitted money to their balance", async () => {
    const funder = await seedUser("withdraw-person");
    const m = await mandateWithTerms(funder, 10 * OWL);
    // 4 owls committed to a running commission: 6 uncommitted, all the funder's.
    const claimId = await seedClaim("withdraw-held");
    const actionId = await seedAction({ group: `assess:${claimId}`, claimId, costMicroUsd: OWL });
    expect(
      await commissionAction({ payer: { kind: "grant", grantId: m.grantId }, actionId, budgetMicroUsd: 4 * OWL, commissionedBy: "program_officer" })
    ).toMatchObject({ ok: true });
    const before = await owlBalance(funder);
    const r = await withdrawFromMandate({ grantId: m.grantId, funder: { userId: funder } });
    expect(r).toEqual({ ok: true, withdrawnOwls: 6 });
    expect((await owlBalance(funder)) - before).toBe(6 * OWL);
    expect(await jobBudget(m.jobId)).toBe(4 * OWL);
    // Nothing uncommitted is left to take.
    expect(await withdrawFromMandate({ grantId: m.grantId, funder: { userId: funder } })).toMatchObject({ ok: false });
  });

  it("refuses a withdrawal once the mandate has settled, so a share is never paid twice", async () => {
    const funder = await seedUser("withdraw-settled");
    const m = await mandateWithTerms(funder, 10 * OWL);
    await rawQuery(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id) VALUES ($1, $2, 'escrow_hold', $3)`,
      [funder, -10 * OWL, m.jobId]
    );
    expect(await cancelGrant({ grantId: m.grantId, funderUserId: funder })).toMatchObject({ ok: true });
    const settled = await owlBalance(funder);
    expect(await withdrawFromMandate({ grantId: m.grantId, funder: { userId: funder } })).toMatchObject({ ok: false });
    expect(await owlBalance(funder)).toBe(settled);

    // A mandate that completed is settled the same way.
    const done = await mandateWithTerms(await seedUser("withdraw-completed"), 10 * OWL);
    await rawQuery(`UPDATE budget_jobs SET status = 'completed' WHERE id = $1`, [done.jobId]);
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [done.grantId]);
    const source = await seedGrantWithJob({ funderId: await seedUser("withdraw-completed-src"), budgetMicroUsd: 20 * OWL });
    await rawQuery(
      `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd) VALUES ($1, $2, $3)`,
      [source.grantId, done.grantId, 4 * OWL]
    );
    expect(await withdrawFromMandate({ grantId: done.grantId, funder: { grantId: source.grantId } })).toMatchObject({ ok: false });
    const [r] = await rawQuery<{ amount: string }>(`SELECT amount_micro_usd AS amount FROM regrants WHERE to_grant_id = $1`, [done.grantId]);
    expect(Number(r!.amount)).toBe(4 * OWL);
  });

  it("takes a regranting mandate's share back to its escrow, whole or in part", async () => {
    const owner = await seedUser("withdraw-owner");
    const target = await mandateWithTerms(owner, 6 * OWL);
    const source = await seedGrantWithJob({ funderId: await seedUser("withdraw-source"), budgetMicroUsd: 20 * OWL });
    // The regrant's 4 owls joined the target's escrow: 10 in all, 4 of them the source's.
    await rawQuery(`UPDATE budget_jobs SET budget_micro_usd = budget_micro_usd + $2 WHERE id = $1`, [target.jobId, 4 * OWL]);
    await rawQuery(
      `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd) VALUES ($1, $2, $3)`,
      [source.grantId, target.grantId, 4 * OWL]
    );
    const part = await withdrawFromMandate({ grantId: target.grantId, funder: { grantId: source.grantId }, owls: 1 });
    expect(part).toEqual({ ok: true, withdrawnOwls: 1 });
    const [left] = await rawQuery<{ amount: string }>(
      `SELECT amount_micro_usd AS amount FROM regrants WHERE to_grant_id = $1`,
      [target.grantId]
    );
    expect(Number(left!.amount)).toBe(3 * OWL);
    // The rest of its share: 3 of the 9 now uncommitted.
    const rest = await withdrawFromMandate({ grantId: target.grantId, funder: { grantId: source.grantId } });
    expect(rest).toEqual({ ok: true, withdrawnOwls: 3 });
    expect(await rawQuery(`SELECT 1 FROM regrants WHERE to_grant_id = $1`, [target.grantId])).toHaveLength(0);
    expect(await jobBudget(target.jobId)).toBe(6 * OWL);
  });
});

describe("the operations view", () => {
  it("shows the policy, the day's use, the commissions and the decisions", async () => {
    const m = await mandateWithTerms(await seedUser("ops-view"), 10 * OWL);
    await rawQuery(
      `UPDATE grants SET daily_budget_micro_usd = $2,
              mandate = mandate || jsonb_build_object('operating_policy', jsonb_build_object('mission', 'Fund the deep-ocean questions first.'))
        WHERE id = $1`,
      [m.grantId, 5 * OWL]
    );
    const claimId = await seedClaim("ops-claim");
    const actionId = await seedAction({ group: `assess:${claimId}`, claimId, costMicroUsd: OWL });
    await commissionAction({
      payer: { kind: "grant", grantId: m.grantId }, actionId, budgetMicroUsd: 2 * OWL,
      commissionedBy: "program_officer", reason: "A contested premise.",
    });
    await rawQuery(
      `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, owls_micro_usd, reason)
       VALUES ($1, 'program_officer', 'raised', 'commissioned', $2, 'A contested premise.')`,
      [m.grantId, 2 * OWL]
    );
    const view = (await getMandateAllocationView(m.grantId))!;
    expect(view.operating_policy).toContain("Fund the deep-ocean questions first.");
    expect(view.budget).toMatchObject({ daily_rate_owls: 5, used_today_owls: 2, held_owls: 2 });
    expect(view.kinds).toEqual([{ kind: "assess", runs: 1, running: 1, budget_owls: 2, spent_owls: 0 }]);
    expect(view.commissions[0]).toMatchObject({ action_id: actionId, budget_owls: 2, state: "waiting", reason: "A contested premise." });
    expect(view.decisions[0]).toMatchObject({ decided_by: "program_officer", decision: "commissioned", owls: 2 });
  });
});
