/**
 * notify_claim_steward carries the contribution itself to the Steward
 * (#697): the record as filed and the reasoning that admitted or ruled on
 * it, not a paraphrase. One schema for both agents; the trigger says which
 * kind of hand-over it is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CONTRIBUTION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CLAIM_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MERGE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const mocks = vi.hoisted(() => ({
  contribution: null as Record<string, unknown> | null,
  review: null as Record<string, unknown> | null,
  ruling: null as Record<string, unknown> | null,
  enqueueSteward: vi.fn(async () => {}),
}));

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    if (sql.includes("FROM contributions c")) return mocks.contribution ? [mocks.contribution] : [];
    if (sql.includes("FROM contribution_reviews")) return mocks.review ? [mocks.review] : [];
    if (sql.includes("FROM arbitration_results")) return mocks.ruling ? [mocks.ruling] : [];
    return [];
  }),
}));
vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueSteward: mocks.enqueueSteward,
}));
vi.mock("../../../../src/services/intake-service.js", () => ({
  isIntakeContributionType: (t: string) =>
    t === "propose_claim" || t === "propose_question" || t === "propose_source",
}));

import {
  executeNotifyClaimSteward,
  getNotifyClaimStewardToolDefinition,
  HANDOFF_CONTENT_MAX_CHARS,
} from "../../../../src/llm/tools/notify-claim-steward.js";

function contribution(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTRIBUTION_ID,
    contribution_type: "challenge",
    claim_id: CLAIM_ID,
    merge_target_claim_id: null,
    content: "The cited trial was retracted in 2024; the notice says the data were fabricated.",
    evidence_urls: ["https://example.org/retraction"],
    proposed_canonical_form: null,
    review_status: "accepted",
    merge_target_text: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.contribution = contribution();
  mocks.review = { reasoning: "The retraction notice is genuine and bears on the main instance." };
  mocks.ruling = null;
  mocks.enqueueSteward.mockClear();
});

describe("notify_claim_steward", () => {
  it("takes a contribution id, not a change_type, in both agents", () => {
    for (const role of ["contribution_reviewer", "dispute_arbitrator"] as const) {
      const def = getNotifyClaimStewardToolDefinition(role);
      expect(def.input_schema.required).toEqual(["contribution_id"]);
      expect(def.input_schema.properties).not.toHaveProperty("change_type");
    }
  });

  it("hands the Steward the record as filed and the Reviewer's reasoning", async () => {
    const out = JSON.parse(
      await executeNotifyClaimSteward({ contribution_id: CONTRIBUTION_ID, note: "Rests on the notice." }, "contribution_reviewer")
    );
    expect(out.success).toBe(true);
    expect(mocks.enqueueSteward).toHaveBeenCalledTimes(1);
    const msg = (mocks.enqueueSteward.mock.calls[0] as unknown as [{ claimId: string; trigger: string; context: string }])[0];
    expect(msg.claimId).toBe(CLAIM_ID);
    expect(msg.trigger).toBe("contribution_accepted");
    expect(msg.context).toContain(CONTRIBUTION_ID);
    expect(msg.context).toContain("data were fabricated");
    expect(msg.context).toContain("https://example.org/retraction");
    expect(msg.context).toContain("The retraction notice is genuine");
    expect(msg.context).toContain("Note: Rests on the notice.");
  });

  it("refuses before the accept is recorded", async () => {
    mocks.contribution = contribution({ review_status: "pending" });
    const out = JSON.parse(await executeNotifyClaimSteward({ contribution_id: CONTRIBUTION_ID }, "contribution_reviewer"));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/record_review_decision first/);
    expect(mocks.enqueueSteward).not.toHaveBeenCalled();
  });

  it("refuses intake contributions and claims that are not the contribution's", async () => {
    mocks.contribution = contribution({ contribution_type: "propose_claim", claim_id: null });
    expect(JSON.parse(await executeNotifyClaimSteward({ contribution_id: CONTRIBUTION_ID }, "contribution_reviewer")).success).toBe(false);

    mocks.contribution = contribution();
    const out = JSON.parse(
      await executeNotifyClaimSteward({ contribution_id: CONTRIBUTION_ID, claim_id: MERGE_ID }, "contribution_reviewer")
    );
    expect(out.success).toBe(false);
    expect(mocks.enqueueSteward).not.toHaveBeenCalled();
  });

  it("may name a proposed merge's target instead", async () => {
    mocks.contribution = contribution({
      contribution_type: "propose_merge",
      merge_target_claim_id: MERGE_ID,
      merge_target_text: "The other formulation.",
    });
    await executeNotifyClaimSteward({ contribution_id: CONTRIBUTION_ID, claim_id: MERGE_ID }, "contribution_reviewer");
    const msg = (mocks.enqueueSteward.mock.calls[0] as unknown as [{ claimId: string; context: string }])[0];
    expect(msg.claimId).toBe(MERGE_ID);
    expect(msg.context).toContain("The other formulation.");
  });

  it("says when the content is cut, and where to read the rest", async () => {
    mocks.contribution = contribution({ content: "x".repeat(HANDOFF_CONTENT_MAX_CHARS + 500) });
    await executeNotifyClaimSteward({ contribution_id: CONTRIBUTION_ID }, "contribution_reviewer");
    const msg = (mocks.enqueueSteward.mock.calls[0] as unknown as [{ context: string }])[0];
    expect(msg.context).toContain(`the first ${HANDOFF_CONTENT_MAX_CHARS} of ${HANDOFF_CONTENT_MAX_CHARS + 500} characters`);
    expect(msg.context).toContain("get_contribution_details");
  });

  it("carries an Arbitrator's ruling under its own trigger, and needs one recorded", async () => {
    mocks.contribution = contribution({ review_status: "rejected" });
    const refused = JSON.parse(await executeNotifyClaimSteward({ contribution_id: CONTRIBUTION_ID }, "dispute_arbitrator"));
    expect(refused.success).toBe(false);

    mocks.ruling = { outcome: "mark_contested", decision: "Both readings survive.", reasoning: "The notice is disputed by the authors." };
    await executeNotifyClaimSteward({ contribution_id: CONTRIBUTION_ID }, "dispute_arbitrator");
    const msg = (mocks.enqueueSteward.mock.calls[0] as unknown as [{ trigger: string; context: string }])[0];
    expect(msg.trigger).toBe("arbitration_outcome");
    expect(msg.context).toContain("mark_contested");
    expect(msg.context).toContain("disputed by the authors");
  });
});
