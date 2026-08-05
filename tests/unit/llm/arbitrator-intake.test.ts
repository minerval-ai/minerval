/**
 * record_arbitration_decision applies intake contributions on overturn
 * (#157): an escalated proposal arbitrated in the contributor's favor must
 * materialize, exactly as a reviewer accept would — otherwise it would read
 * 'accepted' with nothing in the graph.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  reverseReviewOutcome: vi.fn(async () => null),
  applyArbitrationOutcome: vi.fn(async () => null),
  materializeAcceptedIntake: vi.fn(),
  getContributionById: vi.fn(),
  requestAudit: vi.fn(async () => "run-1"),
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({
      values: async (v: unknown) => {
        mocks.insertValues(v);
      },
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
  }),
  rawQuery: vi.fn(async () => []),
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(),
  requestAudit: mocks.requestAudit,
}));
vi.mock("../../../src/services/reputation-service.js", () => ({
  reverseReviewOutcome: mocks.reverseReviewOutcome,
  applyArbitrationOutcome: mocks.applyArbitrationOutcome,
  AUDIT_SUSPENSION_PREFIX: "audit:",
  BAD_FAITH_CATEGORIES: ["spam", "vandalism", "sybil", "misinformation"],
}));
vi.mock("../../../src/services/intake-service.js", () => ({
  materializeAcceptedIntake: mocks.materializeAcceptedIntake,
  isIntakeContributionType: (t: string) =>
    t === "propose_claim" || t === "propose_source",
}));
vi.mock("../../../src/services/contribution-service.js", () => ({
  getContributionById: mocks.getContributionById,
}));

import { executeArbitratorTool } from "../../../src/llm/tools/arbitrator-tools.js";

beforeEach(() => {
  mocks.insertValues.mockReset();
  mocks.reverseReviewOutcome.mockReset().mockResolvedValue(null);
  mocks.applyArbitrationOutcome.mockReset().mockResolvedValue(null);
  mocks.materializeAcceptedIntake.mockReset();
  mocks.getContributionById.mockReset();
  mocks.requestAudit.mockClear();
});

describe("record_arbitration_decision on intake contributions", () => {
  it("materializes an overturned propose_claim and reports the result", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "propose_claim",
    });
    mocks.materializeAcceptedIntake.mockResolvedValue({
      action: "created_claim",
      claimId: "claim-1",
    });

    const result = JSON.parse(
      await executeArbitratorTool("record_arbitration_decision", {
        contribution_id: "contrib-1",
        outcome: "overturn",
        decision: "The rejection misapplied the claim bar.",
        reasoning: "Well-formed and in good faith.",
      })
    );

    expect(result.success).toBe(true);
    expect(result.materialization).toMatchObject({ action: "created_claim" });
    expect(mocks.materializeAcceptedIntake).toHaveBeenCalledWith("contrib-1");
  });

  it("does not materialize when the original decision is upheld", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "propose_claim",
    });

    const result = JSON.parse(
      await executeArbitratorTool("record_arbitration_decision", {
        contribution_id: "contrib-1",
        outcome: "uphold_original",
        decision: "The rejection stands.",
        reasoning: "Not a proposition.",
      })
    );

    expect(result.success).toBe(true);
    expect(mocks.materializeAcceptedIntake).not.toHaveBeenCalled();
  });

  it("leaves ordinary contribution overturns untouched by the intake path", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "challenge",
    });

    const result = JSON.parse(
      await executeArbitratorTool("record_arbitration_decision", {
        contribution_id: "contrib-1",
        outcome: "overturn",
        decision: "Rejection overturned.",
        reasoning: "The challenge was substantive.",
      })
    );

    expect(result.success).toBe(true);
    expect(mocks.materializeAcceptedIntake).not.toHaveBeenCalled();
    expect(mocks.reverseReviewOutcome).toHaveBeenCalled();
    // Every overturn triggers a decision audit of the overturned review
    // (#180), at most once per contribution via the dedupe key.
    expect(mocks.requestAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        auditType: "decision_audit",
        triggeredBy: "arbitration_overturn",
        dedupeKey: "overturn:contrib-1",
      })
    );
  });

  it("does not request an audit when the original decision is upheld", async () => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "challenge",
    });

    await executeArbitratorTool("record_arbitration_decision", {
      contribution_id: "contrib-1",
      outcome: "uphold_original",
      decision: "The rejection stands.",
      reasoning: "The review was sound.",
    });

    expect(mocks.requestAudit).not.toHaveBeenCalled();
  });
});

// An escalated case was never decided, so there is nothing to reverse; the
// final outcome must be applied directly or the contributor earns nothing
// from an escalated-then-accepted contribution (#179).
describe("record_arbitration_decision reputation wiring", () => {
  beforeEach(() => {
    mocks.getContributionById.mockResolvedValue({
      id: "contrib-1",
      contributionType: "challenge",
    });
  });

  it("applies acceptance directly when an overturn finds nothing to reverse", async () => {
    mocks.reverseReviewOutcome.mockResolvedValue(null);
    mocks.applyArbitrationOutcome.mockResolvedValue({
      contributorId: "c-1",
      previousScore: 50,
      newScore: 52,
      standing: "good",
      suspended: false,
      owlsAwarded: 0.75,
    });

    const result = JSON.parse(
      await executeArbitratorTool("record_arbitration_decision", {
        contribution_id: "contrib-1",
        outcome: "overturn",
        decision: "The contribution should be accepted.",
        reasoning: "The escalated question resolves in the contributor's favor.",
      })
    );

    expect(mocks.applyArbitrationOutcome).toHaveBeenCalledWith({
      contributionId: "contrib-1",
      finalDecision: "accept",
    });
    expect(result.contributor_outcome_applied).toMatchObject({
      reputation: 52,
      owls_awarded: 0.75,
    });
  });

  it("does not apply acceptance again when a reversal restored the contributor", async () => {
    mocks.reverseReviewOutcome.mockResolvedValue({
      contributorId: "c-1",
      previousScore: 34,
      newScore: 52,
      standingRestored: true,
      unsuspended: false,
      owlsAwarded: 1.25,
    });

    await executeArbitratorTool("record_arbitration_decision", {
      contribution_id: "contrib-1",
      outcome: "overturn",
      decision: "Rejection overturned.",
      reasoning: "The rejection misread the evidence.",
    });

    expect(mocks.applyArbitrationOutcome).not.toHaveBeenCalled();
  });

  it("applies the rejection outcome on uphold_original", async () => {
    await executeArbitratorTool("record_arbitration_decision", {
      contribution_id: "contrib-1",
      outcome: "uphold_original",
      decision: "The rejection stands.",
      reasoning: "The escalated question resolves against the contribution.",
    });

    expect(mocks.applyArbitrationOutcome).toHaveBeenCalledWith({
      contributionId: "contrib-1",
      finalDecision: "reject",
      suspectedBadFaith: false,
    });
    expect(mocks.reverseReviewOutcome).not.toHaveBeenCalled();
  });

  it("carries a bad-faith finding into the uphold resolution (#213)", async () => {
    mocks.applyArbitrationOutcome.mockResolvedValue({
      contributorId: "c-1",
      previousScore: 50,
      newScore: 34,
      standing: "must_pay",
      suspended: false,
      owlsAwarded: 0,
    });

    const result = JSON.parse(
      await executeArbitratorTool("record_arbitration_decision", {
        contribution_id: "contrib-1",
        outcome: "uphold_original",
        decision: "The rejection stands, and the abuse was deliberate.",
        reasoning: "Fabricated citations across the record.",
        suspected_bad_faith: true,
        bad_faith_category: "misinformation",
      })
    );

    expect(result.success).toBe(true);
    expect(mocks.applyArbitrationOutcome).toHaveBeenCalledWith({
      contributionId: "contrib-1",
      finalDecision: "reject",
      suspectedBadFaith: true,
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        suspectedBadFaith: true,
        badFaithCategory: "misinformation",
      })
    );
    expect(result.contributor_outcome_applied).toMatchObject({
      standing: "must_pay",
    });
    expect(result.note).toBeUndefined();
  });

  it("refuses a category-less flag before any write (#179 mirrored)", async () => {
    const result = JSON.parse(
      await executeArbitratorTool("record_arbitration_decision", {
        contribution_id: "contrib-1",
        outcome: "uphold_original",
        decision: "The rejection stands.",
        reasoning: "Deliberate abuse.",
        suspected_bad_faith: true,
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("bad_faith_category");
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.applyArbitrationOutcome).not.toHaveBeenCalled();
  });

  it("records the flag flag-free on a non-uphold outcome, with a note", async () => {
    const result = JSON.parse(
      await executeArbitratorTool("record_arbitration_decision", {
        contribution_id: "contrib-1",
        outcome: "mark_contested",
        decision: "A real disagreement.",
        reasoning: "Both readings survive scrutiny.",
        suspected_bad_faith: true,
        bad_faith_category: "spam",
      })
    );

    expect(result.success).toBe(true);
    expect(result.note).toContain("not 'uphold_original'");
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        suspectedBadFaith: false,
        badFaithCategory: null,
      })
    );
  });

  it("notes when the finding applies no late penalty on an appeal", async () => {
    // resolution stays null: the appealed rejection already applied its
    // outcome at review time, so the escalation path has nothing to apply.
    mocks.applyArbitrationOutcome.mockResolvedValue(null);

    const result = JSON.parse(
      await executeArbitratorTool("record_arbitration_decision", {
        contribution_id: "contrib-1",
        outcome: "uphold_original",
        decision: "The rejection stands, and the abuse was deliberate.",
        reasoning: "Sybil coordination is plain in the record.",
        suspected_bad_faith: true,
        bad_faith_category: "sybil",
      })
    );

    expect(result.success).toBe(true);
    expect(result.note).toContain("not stacked");
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ suspectedBadFaith: true })
    );
  });

  it("touches no reputation path on mark_contested", async () => {
    await executeArbitratorTool("record_arbitration_decision", {
      contribution_id: "contrib-1",
      outcome: "mark_contested",
      decision: "A real disagreement.",
      reasoning: "Both readings survive scrutiny.",
    });

    expect(mocks.applyArbitrationOutcome).not.toHaveBeenCalled();
    expect(mocks.reverseReviewOutcome).not.toHaveBeenCalled();
  });
});
