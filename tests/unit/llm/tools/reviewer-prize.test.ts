/**
 * The Reviewer's claim_prize branch (docs/mathematics.md §8.4): accept
 * admits without credit (no applyReviewOutcome, no review row written by
 * the ordinary path), reject is the ordinary path plus the prize claim's
 * stage, and a challenge against a prize claim that the Reviewer accepts
 * is escalated mechanically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  insertedReviews: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  applyReviewOutcome: vi.fn(async () => ({ contributorId: "c-1", previousScore: 50, newScore: 49, standing: "good", suspended: false, owlsAwarded: 0 })),
  admitPrizeClaim: vi.fn(async () => ({ ok: true, prize_claim_id: "pc-1", review_id: "r-1" })),
  rejectPrizeClaimAtReview: vi.fn(async () => true),
  prizeClaimReviewBlock: vi.fn(async () => ({ prize_claim_id: "pc-1", lean_excerpt: "theorem", duplicate_of: [] })),
  enqueueArbitration: vi.fn(async () => {}),
  contribution: { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", contributionType: "claim_prize", challengedPrizeClaimId: null as string | null },
}));
const CONTRIBUTION_ID = mocks.id;

vi.mock("../../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        mocks.insertedReviews.push(v);
        return { returning: async () => [{ id: "review-1", ...v }] };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        mocks.updateSets.push(v);
        return { where: async () => undefined };
      },
    }),
  }),
  rawQuery: vi.fn(async () => []),
}));
vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueArbitration: mocks.enqueueArbitration,
  enqueueSteward: vi.fn(async () => {}),
  requestAudit: vi.fn(async () => "run-1"),
}));
vi.mock("../../../../src/services/reputation-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/services/reputation-service.js")>();
  return { ...original, applyReviewOutcome: mocks.applyReviewOutcome };
});
vi.mock("../../../../src/services/contribution-service.js", () => ({
  getContributionById: vi.fn(async () => mocks.contribution),
}));
vi.mock("../../../../src/services/intake-service.js", () => ({
  isIntakeContributionType: (t: string) => t === "propose_claim" || t === "propose_source",
  materializeAcceptedIntake: vi.fn(),
}));
vi.mock("../../../../src/services/prize-claim-service.js", () => ({
  admitPrizeClaim: mocks.admitPrizeClaim,
  rejectPrizeClaimAtReview: mocks.rejectPrizeClaimAtReview,
  prizeClaimReviewBlock: mocks.prizeClaimReviewBlock,
}));

import { executeReviewerTool, getReviewerToolDefinitions } from "../../../../src/llm/tools/reviewer-tools.js";

beforeEach(() => {
  mocks.insertedReviews.length = 0;
  mocks.updateSets.length = 0;
  mocks.applyReviewOutcome.mockClear();
  mocks.admitPrizeClaim.mockClear();
  mocks.rejectPrizeClaimAtReview.mockClear();
  mocks.enqueueArbitration.mockClear();
  mocks.contribution = { id: CONTRIBUTION_ID, contributionType: "claim_prize", challengedPrizeClaimId: null };
});

describe("record_review_decision on a claim_prize contribution", () => {
  it("accept admits through the prize service and applies no credit", async () => {
    const out = JSON.parse(
      await executeReviewerTool("record_review_decision", {
        contribution_id: CONTRIBUTION_ID,
        decision: "accept",
        reasoning: "form, good faith, identity, and duplicates in order",
        confidence: 0.9,
        policy_citations: ["GF"],
      })
    );
    expect(out).toMatchObject({ success: true, prize_claim_id: "pc-1" });
    expect(mocks.admitPrizeClaim).toHaveBeenCalledWith({
      contributionId: CONTRIBUTION_ID,
      review: { reasoning: "form, good faith, identity, and duplicates in order", confidence: 0.9, policyCitations: ["GF"] },
      actor: "contribution_reviewer",
    });
    expect(mocks.applyReviewOutcome).not.toHaveBeenCalled();
    expect(mocks.insertedReviews).toHaveLength(0);
    expect(mocks.updateSets).toHaveLength(0);
    expect(out.message).toMatch(/do not call notify_claim_steward/);
  });

  it("reject takes the ordinary path and marks the prize claim rejected at stage review", async () => {
    const out = JSON.parse(
      await executeReviewerTool("record_review_decision", {
        contribution_id: CONTRIBUTION_ID,
        decision: "reject",
        reasoning: "the account is a duplicate",
        confidence: 0.8,
        policy_citations: ["ND"],
      })
    );
    expect(out.success).toBe(true);
    expect(mocks.rejectPrizeClaimAtReview).toHaveBeenCalledWith(CONTRIBUTION_ID, "contribution_reviewer", "the account is a duplicate");
    expect(mocks.applyReviewOutcome).toHaveBeenCalledWith(expect.objectContaining({ decision: "reject" }));
    expect(mocks.insertedReviews).toHaveLength(1);
    expect(mocks.admitPrizeClaim).not.toHaveBeenCalled();
  });

  it("escalate is the ordinary path (the Arbitrator's overturn admits)", async () => {
    const out = JSON.parse(
      await executeReviewerTool("record_review_decision", {
        contribution_id: CONTRIBUTION_ID,
        decision: "escalate",
        reasoning: "identity unclear",
        confidence: 0.5,
        policy_citations: [],
      })
    );
    expect(out.success).toBe(true);
    expect(mocks.admitPrizeClaim).not.toHaveBeenCalled();
    expect(mocks.updateSets[0]).toMatchObject({ reviewStatus: "escalated" });
  });

  it("surfaces an admission failure instead of recording a review", async () => {
    mocks.admitPrizeClaim.mockResolvedValueOnce({ ok: false, message: "prize claim is queued; only a checked claim is admitted" } as never);
    const out = JSON.parse(
      await executeReviewerTool("record_review_decision", { contribution_id: CONTRIBUTION_ID, decision: "accept", reasoning: "x", confidence: 0.9, policy_citations: [] })
    );
    expect(out).toMatchObject({ success: false, error: /only a checked claim/ });
    expect(mocks.insertedReviews).toHaveLength(0);
  });
});

describe("a challenge against an accepted prize claim", () => {
  it("is escalated mechanically when the Reviewer accepts it, and the window pauses", async () => {
    mocks.contribution = { id: CONTRIBUTION_ID, contributionType: "challenge", challengedPrizeClaimId: "pc-1" };
    const out = JSON.parse(
      await executeReviewerTool("record_review_decision", { contribution_id: CONTRIBUTION_ID, decision: "accept", reasoning: "the ground is followable", confidence: 0.7, policy_citations: ["V"] })
    );
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/escalated to the Dispute Arbitrator/);
    expect(mocks.insertedReviews[0]).toMatchObject({ decision: "accept" });
    expect(mocks.updateSets[0]).toMatchObject({ reviewStatus: "escalated" });
    expect(mocks.enqueueArbitration).toHaveBeenCalledWith({ contributionId: CONTRIBUTION_ID, trigger: "escalated_review" });
    expect(mocks.applyReviewOutcome).not.toHaveBeenCalled();
  });
});

describe("get_prize_claim_details", () => {
  it("is declared and returns the prize_claim block", async () => {
    expect(getReviewerToolDefinitions().map((t) => t.name)).toContain("get_prize_claim_details");
    const out = JSON.parse(await executeReviewerTool("get_prize_claim_details", { contribution_id: CONTRIBUTION_ID }));
    expect(out.prize_claim.lean_excerpt).toBe("theorem");
    mocks.prizeClaimReviewBlock.mockResolvedValueOnce(null as never);
    expect(JSON.parse(await executeReviewerTool("get_prize_claim_details", { contribution_id: "x" })).success).toBe(false);
  });
});
