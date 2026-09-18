import { describe, it, expect } from "vitest";
import { buildAdoptPlan, summarizeAdoption, type GoldenArm } from "../../../scripts/corpus/adopt-lib.js";
import type { SwapSummary } from "../../../scripts/corpus/swap-lib.js";

const golden = (model: string, passed: number, costMicroUsd: number): GoldenArm => ({ model, passed, total: 30, passRate: passed / 30, costMicroUsd });

const swap = (over: Partial<SwapSummary> = {}): SwapSummary => ({
  cluster: "lableak",
  agent: "steward",
  referenceModel: "ref",
  swapModel: "cand",
  observed: { a: ["ref"], b: ["cand"] },
  claimSetF1: 0.9,
  credenceMeanAbsDiff: 0.05,
  statusAgreement: 0.85,
  edgeEditDistance: 3,
  cost: { a: 2_000_000, b: 1_000_000 },
  capped: { a: false, b: false },
  ...over,
});

describe("buildAdoptPlan", () => {
  it("runs the golden pairs on both models for the matcher, plus a swap when a cluster is named", () => {
    const plan = buildAdoptPlan({ agent: "matcher", model: "cand", incumbent: "inc", profile: "production" });
    expect(plan.map((p) => p.role)).toEqual(["golden-candidate", "golden-incumbent"]);
    expect(plan[0]!.args).toEqual(["--profile=production", "--model=cand"]);
    expect(plan[1]!.args).toEqual(["--profile=production", "--model=inc"]);
    const withSwap = buildAdoptPlan({ agent: "matcher", model: "cand", incumbent: "inc", cluster: "lableak", limit: 2 });
    expect(withSwap.map((p) => p.role)).toEqual(["golden-candidate", "golden-incumbent", "swap"]);
    expect(withSwap[2]!.args).toEqual(["lableak", "--agent=matcher", "--model=cand", "--limit=2"]);
  });

  it("uses a swap alone for the other agents and insists on a cluster", () => {
    const plan = buildAdoptPlan({ agent: "steward", model: "cand", incumbent: "inc", cluster: "eggs", baselineSnapshot: "base" });
    expect(plan.map((p) => p.role)).toEqual(["swap"]);
    expect(plan[0]!.args).toEqual(["eggs", "--agent=steward", "--model=cand", "--baseline=base"]);
    expect(() => buildAdoptPlan({ agent: "extractor", model: "cand", incumbent: "inc" })).toThrow(/--cluster is required/);
  });
});

describe("summarizeAdoption", () => {
  it("adopts a matcher that passes as well for less, and rejects one that regresses", () => {
    const better = summarizeAdoption({ agent: "matcher", candidate: "c", incumbent: "i", golden: { candidate: golden("c", 30, 40_000), incumbent: golden("i", 30, 60_000) } });
    expect(better.recommendation).toBe("adopt");
    expect(better.golden?.qualityPerDollar.candidate).toBe(25);
    expect(better.golden?.qualityPerDollar.incumbent).toBeCloseTo(16.67, 2);
    expect(better.reading).toMatch(/human decides/);

    const worse = summarizeAdoption({ agent: "matcher", candidate: "c", incumbent: "i", golden: { candidate: golden("c", 27, 40_000), incumbent: golden("i", 30, 60_000) } });
    expect(worse.recommendation).toBe("reject");
    expect(worse.reading).toMatch(/regression, not noise/);

    const pricier = summarizeAdoption({ agent: "matcher", candidate: "c", incumbent: "i", golden: { candidate: golden("c", 30, 90_000), incumbent: golden("i", 30, 60_000) } });
    expect(pricier.recommendation).toBe("hold");
  });

  it("reads a swap by fidelity and cost for the other agents", () => {
    const close = summarizeAdoption({ agent: "steward", candidate: "c", incumbent: "i", swap: swap() });
    expect(close.recommendation).toBe("adopt");
    expect(close.swap?.fidelityPerDollar).toBe(0.9);
    expect(close.reading).toMatch(/Close to the reference graph at lower cost/);

    const closeButPricier = summarizeAdoption({ agent: "steward", candidate: "c", incumbent: "i", swap: swap({ cost: { a: 1_000_000, b: 2_000_000 } }) });
    expect(closeButPricier.recommendation).toBe("hold");

    const far = summarizeAdoption({ agent: "curator", candidate: "c", incumbent: "i", swap: swap({ claimSetF1: 0.5 }) });
    expect(far.recommendation).toBe("reject");

    const middling = summarizeAdoption({ agent: "extractor", candidate: "c", incumbent: "i", swap: swap({ claimSetF1: 0.75, capped: { a: false, b: true } }) });
    expect(middling.recommendation).toBe("hold");
    expect(middling.reading).toMatch(/hit its Steward cap/);
  });

  it("holds a matcher whose pairs pass but whose cluster graph moved", () => {
    const s = summarizeAdoption({
      agent: "matcher",
      candidate: "c",
      incumbent: "i",
      golden: { candidate: golden("c", 30, 40_000), incumbent: golden("i", 30, 60_000) },
      swap: swap({ agent: "matcher", claimSetF1: 0.7 }),
    });
    expect(s.recommendation).toBe("hold");
    expect(s.reading).toMatch(/golden pairs pass but the cluster graph moved/);
  });

  it("says when nothing ran", () => {
    const s = summarizeAdoption({ agent: "steward", candidate: "c", incumbent: "i" });
    expect(s.recommendation).toBe("hold");
    expect(s.reading).toMatch(/Nothing ran/);
  });
});
