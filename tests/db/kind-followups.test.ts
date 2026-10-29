/**
 * Follow-ups to the kinds against real Postgres: a quantity's argument
 * evaluations dated against its estimates, a question proposed directly
 * through intake, and research a mandate funds submitting what it finds as
 * contributions under the mandate.
 */
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.RESEARCHER_ENABLED = "true";
  return { matchKind: null as null | string };
});

vi.mock("../../src/llm/agents/matcher.js", () => ({
  matchClaim: vi.fn(async () => ({
    outcome: "new",
    is_match: false,
    matched_claim_id: null,
    new_canonical_form: null,
    instance_stance: "affirms",
    kind: mocks.matchKind,
    confidence: 0.9,
    reasoning: "dbtest",
    alternative_matches: [],
    relationship_notes: null,
  })),
}));
vi.mock("../../src/llm/agents/domain-prior.js", () => ({
  inferDomainPrior: vi.fn(async () => []),
}));

import { rawQuery } from "../../src/db/client.js";
import { seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { addArgument, getEvaluationStateForClaim, setArgumentEvaluation } from "../../src/services/argument-service.js";
import { createClaimProposal, materializeAcceptedIntake } from "../../src/services/intake-service.js";
import {
  getContributionRecordForClaim,
  submitMandateContribution,
} from "../../src/services/contribution-service.js";
import { applyReviewOutcome } from "../../src/services/reputation-service.js";
import { createResearchTools } from "../../src/llm/tools/research-tools.js";

const DEF = { measures: "Deaths", unit: { kind: "count" as const } };

describe("argument evaluations on a quantity", () => {
  it("are current under the estimate they were made under, and stale after a new one", async () => {
    const q = await seedClaim("quantity");
    await defineQuantity({ claimId: q, definition: DEF, createdBy: "dbtest" });
    const first = await recordEstimate({ claimId: q, estimate: { form: "point", central: 4 }, work: "w" });
    const arg = await addArgument({ claimId: q, stance: "neutral", content: "c", name: "Extrapolation", description: "c", createdBy: "dbtest" });
    await setArgumentEvaluation({ argumentId: arg.id, verdict: "likely", content: "c", estimateId: first.id });
    expect((await getEvaluationStateForClaim(q))[0]).toMatchObject({ verdict: "likely", stale: false });

    await recordEstimate({ claimId: q, estimate: { form: "point", central: 5 }, work: "w2" });
    expect((await getEvaluationStateForClaim(q))[0]).toMatchObject({ stale: true });
  });

  it("leaves a claim's evaluations dated against its assessment", async () => {
    const c = await seedClaim("claim");
    const [a] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace) VALUES ($1, 'supported', 0.7, 't') RETURNING id`,
      [c]
    );
    const arg = await addArgument({ claimId: c, stance: "for", content: "c", name: "A", description: "c", createdBy: "dbtest" });
    await setArgumentEvaluation({ argumentId: arg.id, verdict: "likely", content: "c", assessmentId: a!.id });
    expect((await getEvaluationStateForClaim(c))[0]).toMatchObject({ stale: false });
  });
});

describe("propose_question", () => {
  it("materializes a question with no argument, or the claim it asks about", async () => {
    const user = await seedUser("asker");
    mocks.matchKind = null;
    const asked = await createClaimProposal({
      claimText: "Where did the 1918 influenza pandemic begin?",
      argumentText: "Every account of its spread turns on where it started.",
      contributorId: user,
      kind: "question",
    });
    expect(asked.contributionType).toBe("propose_question");
    const made = await materializeAcceptedIntake(asked.id);
    expect(made).toMatchObject({ action: expect.any(String) });
    const [row] = await rawQuery<{ claim_id: string }>(`SELECT claim_id FROM contributions WHERE id = $1`, [asked.id]);
    expect(await rawQuery(`SELECT kind FROM claims WHERE id = $1`, [row!.claim_id])).toEqual([{ kind: "question" }]);
    expect(await rawQuery(`SELECT 1 FROM arguments WHERE claim_id = $1`, [row!.claim_id])).toEqual([]);

    // A question that asks whether something is so enters as the claim.
    mocks.matchKind = "claim";
    const whether = await createClaimProposal({
      claimText: "Did the 1918 pandemic begin in Kansas?",
      argumentText: "It is the most cited origin.",
      contributorId: user,
      kind: "question",
    });
    await materializeAcceptedIntake(whether.id);
    const [w] = await rawQuery<{ claim_id: string }>(`SELECT claim_id FROM contributions WHERE id = $1`, [whether.id]);
    expect(await rawQuery(`SELECT kind FROM claims WHERE id = $1`, [w!.claim_id])).toEqual([{ kind: "claim" }]);
    expect(await rawQuery(`SELECT 1 FROM arguments WHERE claim_id = $1`, [w!.claim_id])).toEqual([]);
    mocks.matchKind = null;
  });
});

describe("contributions from a mandate's research", () => {
  it("are filed under the mandate, metered to its job, shown as a funded mandate, and earn no standing", async () => {
    const funder = await seedUser("funder");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 0 });
    const claim = await seedClaim("node");

    const refused = await submitMandateContribution({ grantId, jobId, input: { claim_id: claim, contribution_type: "propose_merge", content: "x".repeat(50) } });
    expect(refused.success).toBe(false);

    const out = await submitMandateContribution({
      grantId,
      jobId,
      input: {
        claim_id: claim,
        contribution_type: "support",
        content: "Table 3 of the registry report gives 2.6 million registered deaths for the fourteen countries.",
        evidence_urls: ["https://example.org/registry", "not a url"],
      },
    });
    expect(out.success).toBe(true);
    const [row] = await rawQuery<{ contributor_id: string; grant_id: string; funded_by_job_id: string; evidence_urls: string[] }>(
      `SELECT contributor_id, grant_id, funded_by_job_id, evidence_urls FROM contributions WHERE id = $1`,
      [out.contribution_id]
    );
    expect(row).toEqual({ contributor_id: funder, grant_id: grantId, funded_by_job_id: jobId, evidence_urls: ["https://example.org/registry"] });

    const record = await getContributionRecordForClaim(claim);
    expect(record[0]!.contributorDisplayName).toBe("a funded mandate");

    const before = await rawQuery<{ contributions_accepted: number }>(`SELECT contributions_accepted FROM contributors WHERE id = $1`, [funder]);
    expect(await applyReviewOutcome({ contributionId: out.contribution_id!, reviewId: null, decision: "accept" })).toBeNull();
    expect(await rawQuery(`SELECT contributions_accepted FROM contributors WHERE id = $1`, [funder])).toEqual(before);
  });

  it("is offered to the Researcher only up to the allowance a Grantmaker delegates", async () => {
    const funder = await seedUser("funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 0 });
    const seen: Array<{ allowance: number | undefined; requestedBy: string }> = [];
    const stub = async (input: { contributionAllowance?: number; run: { requested_by: string } }) => {
      seen.push({ allowance: input.contributionAllowance, requestedBy: input.run.requested_by });
      return { status: "completed" as const, report: { outcome: "answered", answer: "a" }, turns: 1, stopReason: "report", servedModels: [], toolNames: [], error: null };
    };
    const brief = "Survey the regional mortality literature for the 1918 pandemic and say which estimates have stated methods.";
    const gm = createResearchTools({ requestedBy: "grantmaker", grantId, runResearcher: stub as never });
    await gm.execute("delegate_research", { task: brief, model_tier: "cheap", budget_usd: 1, max_contributions: 50 });
    await gm.execute("delegate_research", { task: brief, model_tier: "cheap", budget_usd: 1 });
    const steward = createResearchTools({ requestedBy: "claim_steward", claimId: await seedClaim("c"), runResearcher: stub as never });
    await steward.execute("delegate_research", { task: brief, model_tier: "cheap", budget_usd: 1, max_contributions: 5 });
    expect(seen).toEqual([
      { allowance: 10, requestedBy: "grantmaker" },
      { allowance: 0, requestedBy: "grantmaker" },
      { allowance: 0, requestedBy: "claim_steward" },
    ]);
  });
});
