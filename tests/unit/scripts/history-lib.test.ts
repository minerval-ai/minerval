import { describe, it, expect } from "vitest";
import {
  analyzeHistory,
  analyzeMonotonicity,
  analyzeOverturn,
  confidenceBand,
  credenceBin,
  expectedDirection,
  renderHistory,
  type HistoryInput,
} from "../../../scripts/corpus/history-lib.js";

const t = (s: number) => new Date(Date.UTC(2026, 8, 18, 12, 0, s)).toISOString();

function fixture(): HistoryInput {
  return {
    assessments: [
      // A: supported at 0.7, a support raises it (consistent).
      { claimId: "A", status: "supported", credence: 0.7, assessedAt: t(0), trigger: "structure_and_assess" },
      { claimId: "A", status: "supported", credence: 0.8, assessedAt: t(20), trigger: "contribution_accepted" },
      // B: a challenge RAISES credence (violation).
      { claimId: "B", status: "contested", credence: 0.5, assessedAt: t(0), trigger: "structure_and_assess" },
      { claimId: "B", status: "supported", credence: 0.65, assessedAt: t(20), trigger: "contribution_accepted" },
      // C: a support leaves credence unmoved (zero).
      { claimId: "C", status: "verified", credence: 0.9, assessedAt: t(0), trigger: "structure_and_assess" },
      { claimId: "C", status: "verified", credence: 0.9, assessedAt: t(20), trigger: "contribution_accepted" },
      // D: no assessment after its accepted support (unlinked).
      { claimId: "D", status: "supported", credence: 0.6, assessedAt: t(0), trigger: "structure_and_assess" },
      // E: high credence, later reversed (crosses 0.5).
      { claimId: "E", status: "verified", credence: 0.9, assessedAt: t(0), trigger: "structure_and_assess" },
      { claimId: "E", status: "contradicted", credence: 0.2, assessedAt: t(30), trigger: "staleness_check" },
      // F: middling, reassessed, unchanged.
      { claimId: "F", status: "contested", credence: 0.5, assessedAt: t(0), trigger: "structure_and_assess" },
      { claimId: "F", status: "contested", credence: 0.52, assessedAt: t(30), trigger: "staleness_check" },
      // G: no credence.
      { claimId: "G", status: "contested", credence: null, assessedAt: t(0), trigger: "structure_and_assess" },
    ],
    contributions: [
      { id: "k1", claimId: "A", type: "support", reviewStatus: "accepted", submittedAt: t(5), reviewedAt: t(10), decision: "accept" },
      { id: "k2", claimId: "B", type: "challenge", reviewStatus: "accepted", submittedAt: t(5), reviewedAt: t(10), decision: "accept" },
      { id: "k3", claimId: "C", type: "add_instance", reviewStatus: "accepted", submittedAt: t(5), reviewedAt: t(10), decision: "accept" },
      { id: "k4", claimId: "D", type: "support", reviewStatus: "accepted", submittedAt: t(5), reviewedAt: t(10), decision: "accept" },
      // Rejected and typeless contributions are ignored.
      { id: "k5", claimId: "A", type: "challenge", reviewStatus: "rejected", submittedAt: t(5), reviewedAt: t(10), decision: "reject" },
      { id: "k6", claimId: "A", type: "propose_edit", reviewStatus: "accepted", submittedAt: t(5), reviewedAt: t(10), decision: "accept" },
    ],
  };
}

describe("expectedDirection / bins", () => {
  it("assigns a sign to support, add_instance and challenge only", () => {
    expect(expectedDirection("support")).toBe("up");
    expect(expectedDirection("add_instance")).toBe("up");
    expect(expectedDirection("challenge")).toBe("down");
    expect(expectedDirection("propose_merge")).toBeNull();
  });
  it("bins credence and confidence", () => {
    expect(credenceBin(0)).toBe("0.0-0.2");
    expect(credenceBin(0.65)).toBe("0.6-0.8");
    expect(credenceBin(1)).toBe("0.8-1.0");
    expect(confidenceBand(0.55)).toMatch(/near/);
    expect(confidenceBand(0.75)).toMatch(/moderate/);
    expect(confidenceBand(0.05)).toMatch(/confident/);
  });
});

describe("analyzeMonotonicity", () => {
  it("links accepted contributions to their reassessment and checks the sign", () => {
    const m = analyzeMonotonicity(fixture());
    expect(m.accepted).toBe(4);
    expect(m.linked).toBe(3);
    expect(m.unlinked).toBe(1);
    expect(m.consistent).toBe(1);
    expect(m.zero).toBe(1);
    expect(m.violations).toBe(1);
    const v = m.items.find((i) => i.outcome === "violation")!;
    expect(v.contributionId).toBe("k2");
    expect(v.type).toBe("challenge");
    expect(v.expected).toBe("down");
    expect(v.delta).toBe(0.15);
    expect(v.linkedBy).toBe("trigger");
    expect(m.reading).toMatch(/1 of 3 linked contribution\(s\) moved credence AGAINST/);
  });

  it("falls back to the next assessment when triggers are not recorded", () => {
    const input = fixture();
    for (const a of input.assessments) a.trigger = null;
    const m = analyzeMonotonicity(input);
    expect(m.linked).toBe(3);
    expect(m.items.every((i) => i.linkedBy === "next-assessment")).toBe(true);
  });

  it("skips an assessment that integrated contributions pulling both ways", () => {
    const input = fixture();
    input.contributions.push({ id: "k7", claimId: "A", type: "challenge", reviewStatus: "accepted", submittedAt: t(6), reviewedAt: t(11), decision: "accept" });
    const m = analyzeMonotonicity(input);
    expect(m.ambiguous).toBe(2);
    expect(m.items.find((i) => i.claimId === "A")).toBeUndefined();
  });

  it("reads an empty window", () => {
    const m = analyzeMonotonicity({ assessments: [], contributions: [] });
    expect(m.reading).toMatch(/nothing to read/);
  });
});

describe("analyzeOverturn", () => {
  it("bins first credences and counts later changes and reversals", () => {
    const o = analyzeOverturn(fixture(), { minBin: 1 });
    expect(o.claims).toBe(7);
    expect(o.noCredence).toBe(1);
    expect(o.neverReassessed).toBe(1); // D
    const hi = o.bins.find((b) => b.bin === "0.8-1.0")!;
    expect(hi.n).toBe(2); // C, E
    expect(hi.reassessed).toBe(2);
    expect(hi.changed).toBe(1); // E
    expect(hi.reversed).toBe(1); // E crossed 0.5 and flipped polarity
    expect(hi.reversedShare).toBe(0.5);
    const mid = o.bins.find((b) => b.bin === "0.4-0.6")!;
    expect(mid.n).toBe(2); // B, F
    expect(mid.changed).toBe(1); // B's status moved
    expect(mid.reversed).toBe(0);
    expect(o.extremes).toEqual({ n: 2, reversedShare: 0.5 });
    expect(o.middle.n).toBe(3); // B, F at 0.5 and D at 0.6 (inclusive)
  });

  it("flags small samples and refuses a verdict on them", () => {
    const o = analyzeOverturn(fixture());
    expect(o.bins.filter((b) => b.n > 0).every((b) => b.smallSample)).toBe(true);
    expect(o.reading).toMatch(/Too few reassessed claims/);
  });

  it("reads reversal falling with confidence when the bands are populated", () => {
    const input: HistoryInput = { assessments: [], contributions: [] };
    // 6 confident claims, 1 reversed; 6 near-0.5 claims, 4 reversed.
    for (let i = 0; i < 6; i++) {
      input.assessments.push({ claimId: `c${i}`, status: "verified", credence: 0.9, assessedAt: t(0), trigger: null });
      input.assessments.push({ claimId: `c${i}`, status: i === 0 ? "contradicted" : "verified", credence: i === 0 ? 0.2 : 0.9, assessedAt: t(10), trigger: null });
      input.assessments.push({ claimId: `n${i}`, status: "contested", credence: 0.55, assessedAt: t(0), trigger: null });
      input.assessments.push({ claimId: `n${i}`, status: "contested", credence: i < 4 ? 0.4 : 0.55, assessedAt: t(10), trigger: null });
    }
    const o = analyzeOverturn(input);
    expect(o.reading).toMatch(/Reversal falls with confidence/);
  });

  it("reads a graph nobody reassessed", () => {
    const o = analyzeOverturn({ assessments: [{ claimId: "A", status: "supported", credence: 0.7, assessedAt: t(0), trigger: null }], contributions: [] });
    expect(o.reading).toMatch(/none reassessed yet/);
  });
});

describe("analyzeHistory", () => {
  it("combines both readings and renders", () => {
    const r = analyzeHistory(fixture());
    expect(r.window.claims).toBe(7);
    expect(r.monotonicity.violations).toBe(1);
    expect(r.reading).toContain(r.monotonicity.reading);
    const text = renderHistory(r);
    expect(text).toContain("VIOLATION challenge on claim B");
    expect(text).toContain("0.8-1.0");
  });
});
