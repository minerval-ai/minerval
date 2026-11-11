/**
 * The claim view says when a status was carried over from a retired label by
 * a migration and not re-judged since (#848): `relabeled_from` on the
 * assessment, null otherwise, and the tool description says what it means.
 */
import { describe, it, expect } from "vitest";
import {
  CLAIM_VIEW_DESCRIPTION,
  formatClaimViewAssessment,
} from "../../../src/services/claim-view-service.js";

const base = {
  id: "11111111-1111-1111-1111-111111111111",
  status: "inconclusive",
  confidence: 0.6,
  claimCredence: null,
  summary: "The question is genuinely contested.",
  reasoningTrace: "trace",
  assessedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("formatClaimViewAssessment: relabeled_from (#848)", () => {
  it("carries the retired label on a relabeled assessment", () => {
    expect(formatClaimViewAssessment({ ...base, relabeledFrom: "contested" })?.relabeled_from).toBe("contested");
  });

  it("is null on an assessment a Steward wrote, or one from before the field", () => {
    expect(formatClaimViewAssessment({ ...base, relabeledFrom: null })?.relabeled_from).toBeNull();
    expect(formatClaimViewAssessment(base)?.relabeled_from).toBeNull();
  });

  it("is described to readers as provisional", () => {
    expect(CLAIM_VIEW_DESCRIPTION).toContain("`relabeled_from`");
    expect(CLAIM_VIEW_DESCRIPTION).toMatch(/provisional, not a finding/);
  });
});
