import { describe, it, expect } from "vitest";
import { estimateBudget, spendLine } from "../../../src/llm/instrument-harness.js";

// Budget legibility (#298): the harness translates a dollar ceiling into
// turns for a model with list rates, says nothing up front for a
// provider-priced one, and after every turn states the spend exactly.

describe("estimateBudget", () => {
  it("buys more turns with more budget, fewer on a dearer model, and prices a page over the run", () => {
    const base = { promptChars: 60_000, longRun: false };
    const small = estimateBudget({ ...base, model: "claude-sonnet-5", ceilingMicroUsd: 500_000 })!;
    const large = estimateBudget({ ...base, model: "claude-sonnet-5", ceilingMicroUsd: 2_000_000 })!;
    expect(small.turns).toBeGreaterThan(0);
    expect(large.turns).toBeGreaterThan(small.turns);
    // A page read early is re-read every later turn, so it costs more in a longer run.
    expect(large.pageUsd).toBeGreaterThan(small.pageUsd);
    const strong = estimateBudget({ ...base, model: "claude-opus-5-5", ceilingMicroUsd: 2_000_000, longRun: true })!;
    expect(strong.turns).toBeLessThan(large.turns);
  });

  it("buys no turns when the ceiling cannot cover the first", () => {
    expect(estimateBudget({ model: "claude-sonnet-5", ceilingMicroUsd: 1, promptChars: 60_000, longRun: false })!.turns).toBe(0);
  });

  it("says nothing up front for a model priced by its provider per call", () => {
    expect(estimateBudget({ model: "z-ai/glm-5.3-flash", ceilingMicroUsd: 2_000_000, promptChars: 60_000, longRun: false })).toBeNull();
  });
});

describe("spendLine", () => {
  it("states the spend, the share, and the turns left at the last turn's cost", () => {
    expect(spendLine({ spentMicroUsd: 840_000, ceilingMicroUsd: 2_000_000, lastTurnMicroUsd: 60_000 })).toBe(
      "Budget: $0.84 of $2.00 spent (42%). Your last turn cost $0.06; at that rate about 19 turns remain, fewer as the conversation grows."
    );
  });

  it("drops the projection when there is no last turn to project from, or no budget left", () => {
    expect(spendLine({ spentMicroUsd: 0, ceilingMicroUsd: 2_000_000, lastTurnMicroUsd: 0 })).toBe("Budget: $0.00 of $2.00 spent (0%).");
    expect(spendLine({ spentMicroUsd: 2_100_000, ceilingMicroUsd: 2_000_000, lastTurnMicroUsd: 90_000 })).toBe(
      "Budget: $2.10 of $2.00 spent (100%)."
    );
  });
});
