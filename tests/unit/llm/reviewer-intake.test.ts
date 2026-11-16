/**
 * record_review_decision applies accepted intake contributions (#157): the
 * reviewer's accept is the admission judgment; materialization is mechanical
 * and runs BEFORE the review is recorded, so a failure surfaces to the agent
 * instead of stranding an "accepted" contribution that never went live.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  updateWhere: vi.fn(),
  applyReviewOutcome: vi.fn(async () => null),
  materializeAcceptedIntake: vi.fn(),
  getContributionById: vi.fn(),
  isIntakeContributionType: (t: string) =>
    t === "propose_claim" || t === "propose_source",
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({
      values: (v: unknown) => {
        mocks.insertValues(v);
        return { returning: async () => [{ id: "review-1" }] };
      },
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: async () => {
          mocks.updateWhere(v);
        },
      }),
    }),
  }),
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueArbitration: vi.fn(),
  enqueueSteward: vi.fn(),
}));
vi.mock("../../../src/services/reputation-service.js", () => ({
  applyReviewOutcome: mocks.applyReviewOutcome,
  BAD_FAITH_CATEGORIES: ["spam", "vandalism", "sybil", "misinformation"],
}));
vi.mock("../../../src/services/intake-service.js", () => ({
  materializeAcceptedIntake: mocks.materializeAcceptedIntake,
  isIntakeContributionType: mocks.isIntakeContributionType,
}));
vi.mock("../../../src/services/contribution-service.js", () => ({
  getContributionById: mocks.getContributionById,
}));

import { executeReviewerTool } from "../../../src/llm/tools/reviewer-tools.js";

const DECISION_INPUT = {
  contribution_id: "contrib-1",
  decision: "accept",
  reasoning: "Well-formed, good-faith proposal.",
  confidence: 0.9,
  policy_citations: ["CLAIM_BAR"],
};

beforeEach(() => {
  mocks.insertValues.mockReset();
  mocks.updateWhere.mockReset();
  mocks.applyReviewOutcome.mockReset().mockResolvedValue(null);
  mocks.materializeAcceptedIntake.mockReset();
  mocks.getContributionById.mockReset();
});

describe("record_review_decision on intake contributions", () => {
  it("materializes an accepted propose_claim before recording, and reports the result", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "propose_claim",
    });
    mocks.materializeAcceptedIntake.mockResolvedValue({
      action: "created_claim",
      claimId: "claim-1",
    });

    const result = JSON.parse(
      await executeReviewerTool("record_review_decision", DECISION_INPUT)
    );

    expect(result.success).toBe(true);
    expect(result.materialization).toEqual({
      action: "created_claim",
      claimId: "claim-1",
    });
    // Materialization ran before the review row was written.
    expect(
      mocks.materializeAcceptedIntake.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.insertValues.mock.invocationCallOrder[0]!);
  });

  it("does not record the review when materialization fails", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "propose_claim",
    });
    mocks.materializeAcceptedIntake.mockRejectedValue(
      new Error("matcher unavailable")
    );

    const result = await executeReviewerTool(
      "record_review_decision",
      DECISION_INPUT
    );

    expect(result).toContain("Error: matcher unavailable");
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.applyReviewOutcome).not.toHaveBeenCalled();
  });

  it("tells the reviewer of a platform fault by its class, and records nothing (#980)", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "propose_claim",
    });
    // The Matcher's provider out of credits, as the OpenAI SDK throws it
    // for OpenRouter.
    mocks.materializeAcceptedIntake.mockRejectedValue(
      Object.assign(new Error("402 Insufficient credits"), { status: 402 })
    );

    const raw = await executeReviewerTool("record_review_decision", DECISION_INPUT);
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.platform_fault).toBe("credits_fault");
    expect(result.error).toContain("Nothing was recorded");
    expect(result.error).toContain("do not raise_issue");
    expect(result.error).toContain("goes back to the review queue");
    expect(raw).not.toMatch(/402|Insufficient credits/);
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateWhere).not.toHaveBeenCalled();
    expect(mocks.applyReviewOutcome).not.toHaveBeenCalled();
  });

  it("does not materialize on reject", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "propose_claim",
    });

    const result = JSON.parse(
      await executeReviewerTool("record_review_decision", {
        ...DECISION_INPUT,
        decision: "reject",
      })
    );

    expect(result.success).toBe(true);
    expect(result.materialization).toBeUndefined();
    expect(mocks.materializeAcceptedIntake).not.toHaveBeenCalled();
  });

  it("does not touch the intake path for ordinary contribution types", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "challenge",
    });

    const result = JSON.parse(
      await executeReviewerTool("record_review_decision", DECISION_INPUT)
    );

    expect(result.success).toBe(true);
    expect(mocks.materializeAcceptedIntake).not.toHaveBeenCalled();
  });
});
