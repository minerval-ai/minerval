/**
 * The reads that serve a list of mandates in a few statements (the list of
 * mandates, GET /grants) against real Postgres: each mandate's money,
 * backers and bought assessments come out exactly as the one-mandate reads
 * give them, so batching a list changes how long it takes and nothing else.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { creditOwls, seedAllocation, seedClaim, seedGrantWithJob, seedLlmUsage, seedUser, OWL } from "./helpers.js";
import { grantEscrowBreakdown, grantEscrowBreakdowns } from "../../src/services/regrant-service.js";
import { getJobContributions, getJobContributorCounts } from "../../src/services/budget-job-service.js";
import { getGrant, listGrants, serializeGrant, serializeGrants } from "../../src/services/grant-service.js";
import { getPublicMandate, listMandatesPage } from "../../src/services/mandate-service.js";

async function mandateWithMoney(funder: string, n: number) {
  const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100 * OWL });
  // Shares spent and held, metered spend beyond the shares, a regrant out,
  // and a second backer: every term of the escrow, different per mandate.
  await seedAllocation({ group: `b-${grantId}-1`, grantId, amountMicroUsd: 5 * OWL, spentMicroUsd: n * OWL, released: true });
  await seedAllocation({ group: `b-${grantId}-2`, grantId, amountMicroUsd: (n + 2) * OWL, spentMicroUsd: OWL });
  await seedLlmUsage({ jobId, costMicroUsd: (2 * n + 7) * OWL });
  if (n % 2 === 0) {
    const { grantId: other } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: OWL });
    await rawQuery(
      `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd, refunded_micro_usd) VALUES ($1, $2, $3, $4)`,
      [grantId, other, 3 * OWL, OWL]
    );
  }
  const backer = await seedUser(`batched-backer-${n}`);
  await creditOwls(backer, 10 * OWL);
  await rawQuery(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id) VALUES ($1, $2, 'escrow_hold', $3)`,
    [backer, -n * OWL, jobId]
  );
  for (let i = 0; i < n; i++) {
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, funded_by_job_id, assessed_at)
       VALUES ($1, 'supported', 0.7, 't', $2, now() - make_interval(mins => $3))`,
      [await seedClaim(`batched ${n}.${i}`), jobId, i]
    );
  }
  return { grantId, jobId };
}

describe("a list of mandates read in a few statements", () => {
  it("counts each mandate's escrow and backers as its own reads do", async () => {
    const funder = await seedUser("batched-funder");
    const mandates = [];
    for (const n of [1, 2, 3, 4]) mandates.push(await mandateWithMoney(funder, n));
    const refs = mandates.map((m) => ({ id: m.grantId, budgetJobId: m.jobId }));

    const batched = await grantEscrowBreakdowns(refs);
    const counts = await getJobContributorCounts(mandates.map((m) => m.jobId));
    expect(batched.size).toBe(4);
    for (const ref of refs) {
      const one = await grantEscrowBreakdown(ref);
      expect(batched.get(ref.id)).toEqual(one);
      expect(counts.get(ref.budgetJobId)).toBe((await getJobContributions(ref.budgetJobId)).length);
    }
    // The terms are not all zero: the comparison means something.
    const first = batched.get(mandates[1]!.grantId)!;
    expect(first.spent).toBeGreaterThan(0);
    expect(first.held).toBeGreaterThan(0);
    expect(first.regrants).toBe(2 * OWL);
    expect(first.outsideLedger).toBeGreaterThan(0);
  });

  it("serves GET /grants as the one-grant read serves each", async () => {
    const funder = await seedUser("batched-grants");
    for (const n of [1, 3]) await mandateWithMoney(funder, n);
    const rows = await listGrants(funder);
    const many = await serializeGrants(rows);
    const each = await Promise.all(rows.map(serializeGrant));
    expect(many).toEqual(each);
    expect(many.some((g) => g.funded_assessments.length === 3)).toBe(true);
    expect(await serializeGrants([])).toEqual([]);
  });

  it("lists mandates with the money and backers their pages show", async () => {
    const funder = await seedUser("batched-list");
    for (const n of [1, 2]) await mandateWithMoney(funder, n);
    const page = await listMandatesPage({ scope: "mine", viewerUserId: funder, state: "any", limit: 100 });
    expect(page.mandates.length).toBeGreaterThanOrEqual(2);
    for (const row of page.mandates) {
      const full = await getPublicMandate(row.id, funder);
      expect(row.spent_owls).toBe(full!.spent_owls);
      expect(row.contributor_count).toBe(full!.contributor_count);
      expect(row.contributor_count).toBe(full!.contributors.length);
    }
    expect(page.mandates.some((m) => m.contributor_count === 2 && m.assessments > 0)).toBe(true);
    // A grant still reads whole on its own.
    expect((await serializeGrant((await getGrant(page.mandates[0]!.id))!)).id).toBe(page.mandates[0]!.id);
  });
});
