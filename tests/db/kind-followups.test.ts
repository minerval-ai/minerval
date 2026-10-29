/**
 * Follow-ups to the kinds against real Postgres: a quantity's argument
 * evaluations dated against its estimates, a question proposed directly
 * through intake, and research a mandate funds submitting what it finds as
 * contributions under the mandate, its reviews paid from a delegated budget.
 */
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.RESEARCHER_ENABLED = "true";
  return { matchKind: null as null | string, reviewCost: 0, reviewFails: false };
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
// The Reviewer bills what the test says to the meter it runs under, and
// fails partway when told to.
vi.mock("../../src/llm/agents/contribution-reviewer.js", async () => {
  const { getUsageContext } = await import("../../src/llm/usage-context.js");
  return {
    runContributionReview: vi.fn(async () => {
      const meter = getUsageContext().meter;
      if (meter) meter.billedMicroUsd += mocks.reviewCost;
      if (mocks.reviewFails) throw new Error("review failed partway");
    }),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { addArgument, getEvaluationStateForClaim, setArgumentEvaluation } from "../../src/services/argument-service.js";
import { createClaimProposal, materializeAcceptedIntake } from "../../src/services/intake-service.js";
import {
  getContributionRecordForClaim,
  mandateContributionBudget,
  reviewCostEstimateMicroUsd,
  submitMandateContribution,
} from "../../src/services/contribution-service.js";
import { applyReviewOutcome } from "../../src/services/reputation-service.js";
import { createResearchTools } from "../../src/llm/tools/research-tools.js";
import { openResearchRun } from "../../src/services/research-run-service.js";
import { handleContributionMessage } from "../../src/workers/contribution-pipeline.js";
import { loadConfig } from "../../src/config.js";
import { owlsToMicroUsd } from "../../src/services/owl.js";

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

async function mandateRun(input: { grantId: string | null; jobId: string | null; budgetMicroUsd: number; requestedBy?: string }) {
  return openResearchRun({
    claimId: null,
    grantId: input.grantId,
    requestedBy: input.requestedBy ?? "grantmaker",
    requesterRunId: null,
    jobId: input.jobId,
    task: "Survey the regional mortality literature for the 1918 pandemic.",
    model: "dbtest",
    modelTier: "cheap",
    effort: null,
    includeConstitution: false,
    ceilingMicroUsd: 1_000_000,
    contributionBudgetMicroUsd: input.budgetMicroUsd,
  });
}

const FINDING = "Table 3 of the registry report gives 2.6 million registered deaths for the fourteen countries.";

describe("contributions from a mandate's research", () => {
  it("are filed under the mandate, metered to its job, shown as a funded mandate, and earn no standing", async () => {
    const funder = await seedUser("funder");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 0 });
    const run = await mandateRun({ grantId, jobId, budgetMicroUsd: 5_000_000 });
    const claim = await seedClaim("node");

    const refused = await submitMandateContribution({
      researchRunId: run.id,
      input: { claim_id: claim, contribution_type: "propose_merge", content: "x".repeat(50) },
    });
    expect(refused.success).toBe(false);

    const out = await submitMandateContribution({
      researchRunId: run.id,
      input: {
        claim_id: claim,
        contribution_type: "support",
        content: FINDING,
        evidence_urls: ["https://example.org/registry", "not a url"],
      },
    });
    expect(out.success).toBe(true);
    const [row] = await rawQuery<{ contributor_id: string; grant_id: string; funded_by_job_id: string; research_run_id: string; evidence_urls: string[] }>(
      `SELECT contributor_id, grant_id, funded_by_job_id, research_run_id, evidence_urls FROM contributions WHERE id = $1`,
      [out.contribution_id]
    );
    expect(row).toEqual({
      contributor_id: funder,
      grant_id: grantId,
      funded_by_job_id: jobId,
      research_run_id: run.id,
      evidence_urls: ["https://example.org/registry"],
    });

    const record = await getContributionRecordForClaim(claim);
    expect(record[0]!.contributorDisplayName).toBe("a funded mandate");

    const before = await rawQuery<{ contributions_accepted: number }>(`SELECT contributions_accepted FROM contributors WHERE id = $1`, [funder]);
    expect(await applyReviewOutcome({ contributionId: out.contribution_id!, reviewId: null, decision: "accept" })).toBeNull();
    expect(await rawQuery(`SELECT contributions_accepted FROM contributors WHERE id = $1`, [funder])).toEqual(before);
  });

  it("come only from research a mandate funds", async () => {
    const steward = await mandateRun({ grantId: null, jobId: null, budgetMicroUsd: 5_000_000, requestedBy: "claim_steward" });
    const out = await submitMandateContribution({
      researchRunId: steward.id,
      input: { claim_id: await seedClaim("node"), contribution_type: "support", content: FINDING },
    });
    expect(out).toMatchObject({ success: false, message: expect.stringContaining("mandate") });
  });

  it("reserve an estimated review cost against the delegated budget, settled at the real cost once reviewed", async () => {
    const funder = await seedUser("funder");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 0 });
    const claim = await seedClaim("node");
    const estimate = await reviewCostEstimateMicroUsd();
    expect(estimate).toBeGreaterThan(0);
    // Room for two reviews at the estimate, not three.
    const run = await mandateRun({ grantId, jobId, budgetMicroUsd: Math.round(estimate * 2.5) });
    const submit = () =>
      submitMandateContribution({ researchRunId: run.id, input: { claim_id: claim, contribution_type: "support", content: FINDING } });

    const first = await submit();
    expect(first).toMatchObject({ success: true, budget_left_usd: expect.any(Number) });
    expect((await submit()).success).toBe(true);
    expect(await mandateContributionBudget(run.id, estimate)).toEqual({ budgetMicroUsd: Math.round(estimate * 2.5), committedMicroUsd: 2 * estimate });
    const third = await submit();
    expect(third).toMatchObject({ success: false, message: expect.stringContaining("spent") });

    // The first review costs far less than estimated: its real cost
    // replaces the reservation, and the budget has room again. The pipeline
    // records the cost even when the review fails partway.
    mocks.reviewCost = 1_000;
    mocks.reviewFails = true;
    await expect(handleContributionMessage({ contributionId: first.contribution_id! })).rejects.toThrow("partway");
    mocks.reviewFails = false;
    const [settled] = await rawQuery<{ review_cost_micro_usd: number }>(
      `SELECT review_cost_micro_usd FROM contributions WHERE id = $1`,
      [first.contribution_id]
    );
    expect(Number(settled!.review_cost_micro_usd)).toBe(1_000);
    expect((await submit()).success).toBe(true);
    mocks.reviewCost = 0;
  });

  it("is offered to the Researcher only with a budget a Grantmaker delegates, capped by the backstop", async () => {
    const funder = await seedUser("funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 0 });
    const seen: Array<{ budget: number | undefined; requestedBy: string }> = [];
    const stub = async (input: { run: { requested_by: string; contribution_budget_micro_usd?: number } }) => {
      seen.push({ budget: input.run.contribution_budget_micro_usd, requestedBy: input.run.requested_by });
      return { status: "completed" as const, report: { outcome: "answered", answer: "a" }, turns: 1, stopReason: "report", servedModels: [], toolNames: [], error: null };
    };
    const brief = "Survey the regional mortality literature for the 1918 pandemic and say which estimates have stated methods.";
    const gm = createResearchTools({ requestedBy: "grantmaker", grantId, runResearcher: stub as never });
    await gm.execute("delegate_research", { task: brief, model_tier: "cheap", budget_usd: 1, contribution_budget_usd: 2.5 });
    await gm.execute("delegate_research", { task: brief, model_tier: "cheap", budget_usd: 1, contribution_budget_usd: 10_000 });
    await gm.execute("delegate_research", { task: brief, model_tier: "cheap", budget_usd: 1 });
    const negative = JSON.parse((await gm.execute("delegate_research", { task: brief, model_tier: "cheap", budget_usd: 1, contribution_budget_usd: -1 }))!);
    expect(negative.success).toBe(false);
    const steward = createResearchTools({ requestedBy: "claim_steward", claimId: await seedClaim("c"), runResearcher: stub as never });
    await steward.execute("delegate_research", { task: brief, model_tier: "cheap", budget_usd: 1, contribution_budget_usd: 5 });
    expect(seen).toEqual([
      { budget: 2_500_000, requestedBy: "grantmaker" },
      { budget: owlsToMicroUsd(loadConfig().researcherMaxContributionBudgetOwls), requestedBy: "grantmaker" },
      { budget: 0, requestedBy: "grantmaker" },
      { budget: 0, requestedBy: "claim_steward" },
    ]);
  });
});
