import { describe, it, expect, beforeEach, vi } from "vitest";

// The EC side of the allocation core: config priors that yield to live
// rolling averages once enough metered runs exist.

const { state } = vi.hoisted(() => ({
  state: {
    usageRow: null as null | { runs: number; avg_cost: number | null },
    config: {
      owlCostMicroUsd: 1_000_000,
      stewardModel: "claude-sonnet-5",
      stewardStrongModel: "claude-fable-5",
      estStewardRunCostOwls: 0.25,
      estStewardRunCostStrongOwls: 1,
      costEstimateWindowDays: 14,
      costEstimateMinRuns: 5,
    },
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => (state.usageRow ? [state.usageRow] : [])),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => state.config,
}));

import {
  estimateStewardRunCostMicroUsd,
  stewardTierCostEstimates,
  resetCostEstimateCache,
} from "../../../src/services/cost-estimate-service.js";

beforeEach(() => {
  state.usageRow = null;
  resetCostEstimateCache();
});

describe("estimateStewardRunCostMicroUsd", () => {
  it("falls back to the config prior when there are too few metered runs", async () => {
    state.usageRow = { runs: 2, avg_cost: 900_000 };
    expect(await estimateStewardRunCostMicroUsd("claude-sonnet-5")).toBe(
      250_000 // 0.25 owl prior at $1/owl of spend
    );
    expect(await estimateStewardRunCostMicroUsd("claude-fable-5")).toBe(
      1_000_000 // 1 owl strong prior
    );
  });

  it("uses the live rolling average once enough runs exist", async () => {
    state.usageRow = { runs: 12, avg_cost: 2_600_000 };
    expect(await estimateStewardRunCostMicroUsd("claude-sonnet-5")).toBe(
      2_600_000
    );
  });

  it("returns both tier estimates for the drain's ordering", async () => {
    const tiers = await stewardTierCostEstimates();
    expect(tiers.standardMicroUsd).toBe(250_000);
    expect(tiers.strongMicroUsd).toBe(1_000_000);
  });
});
