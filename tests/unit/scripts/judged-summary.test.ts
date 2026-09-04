import { describe, it, expect } from "vitest";
import { summarizeJudged } from "../../../scripts/corpus/judged-summary.js";
import type { JudgeVerdict } from "../../../scripts/corpus/judge.js";

const verdict = (over: Partial<JudgeVerdict>): JudgeVerdict => ({
  id: "c",
  text: "t",
  importanceStored: 0.5,
  status: "supported",
  readability: 4,
  reasoning_fit: 4,
  impartiality: 4,
  claim_bar: "yes",
  decomposition_granularity: "good",
  importance_judged: 0.5,
  sycophancy: "independent",
  hedging: "calibrated",
  canonical_form: "good",
  political_bias: "none",
  flags: [],
  note: "",
  ...over,
});

describe("summarizeJudged", () => {
  it("aggregates the S2 dimensions as distributions and headline miss shares", () => {
    const s = summarizeJudged("judge-model", [
      verdict({}),
      verdict({ sycophancy: "leans_source", hedging: "overhedged", canonical_form: "overstated" }),
      verdict({ sycophancy: "defers_to_source", hedging: "overconfident", political_bias: "slight", flags: ["bias"] }),
      verdict({ canonical_form: "frame_bound", claim_bar: "no", importanceStored: 0.9, importance_judged: 0.3 }),
    ]);
    expect(s.sampleSize).toBe(4);
    expect(s.model).toBe("judge-model");
    expect(s.dimensions.sycophancy).toEqual({ independent: 2, leans_source: 1, defers_to_source: 1 });
    expect(s.dimensions.hedging).toEqual({ calibrated: 2, overhedged: 1, overconfident: 1 });
    expect(s.dimensions.canonicalForm).toEqual({ good: 2, overstated: 1, frame_bound: 1 });
    expect(s.dimensions.politicalBias).toEqual({ none: 3, slight: 1 });
    expect(s.sycophancyShare).toBe(0.5);
    expect(s.overhedgedShare).toBe(0.25);
    expect(s.overconfidentShare).toBe(0.25);
    expect(s.canonicalFormMissShare).toBe(0.5);
    expect(s.politicalBiasShare).toBe(0.25);
    // The original dimensions still aggregate.
    expect(s.claimBarPassRate).toBe(0.75);
    expect(s.importanceAlignment.overratedShare).toBe(0.25);
    expect(s.flags).toEqual({ bias: 1 });
    expect(s.items).toHaveLength(4);
  });

  it("is well-defined on an empty sample", () => {
    const s = summarizeJudged("m", []);
    expect(s.sampleSize).toBe(0);
    expect(s.claimBarPassRate).toBe(0);
    expect(s.sycophancyShare).toBe(0);
    expect(s.dimensions.sycophancy).toEqual({});
  });
});
