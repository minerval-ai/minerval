/**
 * Two rulings whose words must not mislead.
 *
 * A challenge to a prize claim arrives with the Reviewer's admission as the
 * decision under review, so "uphold the original" reads as "the challenge
 * stands" while the tools take it as "the challenge fails". The Arbitrator
 * names the substance with challenge_upheld and the tool refuses an outcome
 * that disagrees (#710). And a contribution sent to humans carries its
 * reason (#713).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CONTRIBUTION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PRIZE_CLAIM_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const mocks = vi.hoisted(() => ({
  contribution: null as Record<string, unknown> | null,
  inserted: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  applyArbitrationOutcome: vi.fn(async () => null),
  applyAcceptanceEffects: vi.fn(
    async (): Promise<
      { ok: true; note: string; materialization: null } | { ok: false; error: string }
    > => ({ ok: true, note: " Request req-1 filed.", materialization: null })
  ),
}));

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
  getDb: () => ({
    update: () => ({
      set: (v: Record<string, unknown>) => {
        mocks.updateSets.push(v);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        mocks.inserted.push(v);
      },
    }),
  }),
}));
vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(),
  requestAudit: vi.fn(async () => "run-1"),
}));
vi.mock("../../../../src/services/reputation-service.js", () => ({
  reverseReviewOutcome: vi.fn(async () => null),
  applyArbitrationOutcome: mocks.applyArbitrationOutcome,
  AUDIT_SUSPENSION_PREFIX: "audit:",
  BAD_FAITH_CATEGORIES: ["spam", "vandalism", "sybil", "misinformation"],
}));
vi.mock("../../../../src/services/intake-service.js", () => ({
  isIntakeContributionType: () => false,
  materializeAcceptedIntake: vi.fn(),
}));
vi.mock("../../../../src/services/contribution-service.js", () => ({
  getContributionById: vi.fn(async () => mocks.contribution),
}));
vi.mock("../../../../src/services/contribution-acceptance.js", () => ({
  acceptanceSchemaProperties: () => ({}),
  applyAcceptanceEffects: mocks.applyAcceptanceEffects,
}));

import { executeArbitratorTool } from "../../../../src/llm/tools/arbitrator-tools.js";

const decide = async (input: Record<string, unknown>) =>
  JSON.parse(
    await executeArbitratorTool("record_arbitration_decision", {
      contribution_id: CONTRIBUTION_ID,
      decision: "Ruling.",
      reasoning: "The statement omits a hypothesis the claim needs.",
      ...input,
    })
  );

beforeEach(() => {
  mocks.contribution = {
    id: CONTRIBUTION_ID,
    contributionType: "challenge",
    challengedPrizeClaimId: PRIZE_CLAIM_ID,
  };
  mocks.inserted.length = 0;
  mocks.updateSets.length = 0;
  mocks.applyArbitrationOutcome.mockClear();
  mocks.applyAcceptanceEffects.mockClear();
});

describe("a challenge to a prize claim", () => {
  it("records an upheld challenge as an overturn and says the prize claim is voided", async () => {
    const out = await decide({ outcome: "overturn", challenge_upheld: true });
    expect(out.success).toBe(true);
    expect(out.prize_claim).toMatch(/voided/);
    expect(mocks.inserted[0]).toMatchObject({ outcome: "overturn" });
  });

  it("records a failed challenge as uphold_original and says the window runs on", async () => {
    const out = await decide({ outcome: "uphold_original", challenge_upheld: false });
    expect(out.success).toBe(true);
    expect(out.prize_claim).toMatch(/window runs on/);
  });

  it("refuses the inverted reading before anything is written", async () => {
    const out = await decide({ outcome: "uphold_original", challenge_upheld: true });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/goes with outcome overturn/);
    expect(mocks.inserted).toHaveLength(0);
    expect(mocks.updateSets).toHaveLength(0);
  });

  it("requires challenge_upheld, and allows no partial ruling", async () => {
    expect((await decide({ outcome: "overturn" })).success).toBe(false);
    expect((await decide({ outcome: "mark_contested" })).success).toBe(false);
    expect((await decide({ outcome: "modify" })).success).toBe(false);
    expect(mocks.inserted).toHaveLength(0);
    expect((await decide({ outcome: "human_review" })).success).toBe(true);
  });

  it("leaves an ordinary contribution's outcomes as they were", async () => {
    mocks.contribution = { id: CONTRIBUTION_ID, contributionType: "challenge", challengedPrizeClaimId: null };
    const out = await decide({ outcome: "uphold_original" });
    expect(out.success).toBe(true);
    expect(out).not.toHaveProperty("prize_claim");
  });
});

describe("flag_for_human_review", () => {
  it("stores the reason on the contribution", async () => {
    const out = JSON.parse(
      await executeArbitratorTool("flag_for_human_review", {
        contribution_id: CONTRIBUTION_ID,
        reason: "The contribution names a private person; legal review needed.",
      })
    );
    expect(out.success).toBe(true);
    expect(mocks.updateSets[0]).toEqual({
      reviewStatus: "human_review",
      humanReviewReason: "The contribution names a private person; legal review needed.",
    });
  });

  it("refuses without a reason", async () => {
    const out = JSON.parse(
      await executeArbitratorTool("flag_for_human_review", { contribution_id: CONTRIBUTION_ID, reason: " " })
    );
    expect(out.success).toBe(false);
    expect(mocks.updateSets).toHaveLength(0);
  });
});

// An overturn accepts, so it takes effect as a Reviewer's accept would
// (#724): an overturned propose_request is filed, not left "accepted" with
// nothing on the graph.
describe("an overturn takes effect", () => {
  it("files an overturned request and says so", async () => {
    mocks.contribution = { id: CONTRIBUTION_ID, contributionType: "propose_request", reviewStatus: "rejected" };
    const out = await decide({ outcome: "overturn", request: { ask: "a", why: "b", satisfied_by: "c" } });
    expect(out.success).toBe(true);
    expect(out.message).toContain("Request req-1 filed.");
    expect(mocks.applyAcceptanceEffects).toHaveBeenCalledWith(
      CONTRIBUTION_ID,
      expect.objectContaining({ request: { ask: "a", why: "b", satisfied_by: "c" } })
    );
  });

  it("records nothing when the effects refuse", async () => {
    mocks.contribution = { id: CONTRIBUTION_ID, contributionType: "propose_request", reviewStatus: "rejected" };
    mocks.applyAcceptanceEffects.mockResolvedValueOnce({ ok: false, error: "needs request" });
    const out = await decide({ outcome: "overturn" });
    expect(out.success).toBe(false);
    expect(mocks.inserted).toHaveLength(0);
  });

  it("does not repeat the effects of an accept already applied", async () => {
    mocks.contribution = { id: CONTRIBUTION_ID, contributionType: "propose_request", reviewStatus: "accepted" };
    await decide({ outcome: "overturn" });
    expect(mocks.applyAcceptanceEffects).not.toHaveBeenCalled();
  });
});
