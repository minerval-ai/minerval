import { describe, it, expect } from "vitest";
import {
  effectiveStewardModel,
  judgeConflict,
  observedModels,
  type ScorecardConfig,
} from "../../../scripts/corpus/fingerprint.js";

const base: ScorecardConfig = {
  pipelineEpoch: "2026-08-owl-economy",
  gitCommit: "abc1234",
  models: {
    extractor: "claude-fable-5-1",
    matcher: "deepseek/deepseek-v4-flash",
    steward: "claude-fable-5-1",
    curator: "claude-fable-5-1",
    judge: "claude-sonnet-5",
  },
};

describe("observedModels", () => {
  it("groups usage rows per agent, most-called model first", () => {
    const observed = observedModels([
      { agent: "steward", model: "claude-fable-5-1", calls: 40 },
      { agent: "steward", model: "claude-opus-4-8", calls: 2 },
      { agent: "matcher", model: "deepseek/deepseek-v4-flash", calls: 30 },
      { agent: "steward", model: "claude-fable-5-1", calls: 5 },
    ]);
    expect(observed).toEqual({
      matcher: ["deepseek/deepseek-v4-flash"],
      steward: ["claude-fable-5-1", "claude-opus-4-8"],
    });
  });

  it("is empty for an empty window", () => {
    expect(observedModels([])).toEqual({});
  });
});

describe("effectiveStewardModel", () => {
  it("prefers what was observed over what was configured", () => {
    expect(effectiveStewardModel(base)).toBe("claude-fable-5-1");
    expect(
      effectiveStewardModel({ ...base, observed: { steward: ["claude-sonnet-5"] } })
    ).toBe("claude-sonnet-5");
  });
});

describe("judgeConflict", () => {
  it("is silent when the judge differs from the steward", () => {
    expect(judgeConflict(base, "claude-sonnet-5")).toBeNull();
  });

  it("refuses a judge that is the steward's configured model", () => {
    expect(judgeConflict(base, "claude-fable-5-1")).toMatch(/must not grade its own/);
  });

  it("judges against the model that actually ran, not the configured one", () => {
    // The first baseline's failure mode: config said one thing, the run did another.
    const cfg = { ...base, observed: { steward: ["claude-sonnet-5"] } };
    expect(judgeConflict(cfg, "claude-sonnet-5")).toMatch(/claude-sonnet-5/);
    expect(judgeConflict(cfg, "claude-fable-5-1")).toBeNull();
  });
});
