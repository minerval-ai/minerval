import { describe, it, expect, beforeEach, vi } from "vitest";

// The EC side of the allocation core: config priors that yield to a live
// figure once enough metered runs exist.
//
// The live figure is a PERCENTILE of recent run cost, not the mean. The estimate
// is used as a cap — the allocator covers an action for it, and any excess is
// drawn off the escrow outside any allocation, escaping the mandate's daily
// rate. Run cost is right-skewed (first live epoch: mean 2.31 owls, p50 2.10,
// p80 3.30, p90 4.36, max 7.01), so a mean-based cap under-funds about half of
// all runs and always in the expensive direction.

const { state } = vi.hoisted(() => ({
  state: {
    usageRow: null as null | { runs: number; est_cost: number | null },
    /** Percentile the service asked SQL for, captured from the query params. */
    askedPercentile: null as number | null,
    config: {
      owlCostMicroUsd: 1_000_000,
      stewardModel: "claude-sonnet-5",
      stewardStrongModel: "claude-fable-5-1",
      estStewardRunCostOwls: 0.25,
      estStewardRunCostStrongOwls: 1,
      costEstimateWindowDays: 14,
      costEstimateMinRuns: 5,
      costEstimatePercentile: 0.8,
    },
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (_q: string, params: unknown[] = []) => {
    state.askedPercentile = (params[3] as number) ?? null;
    return state.usageRow ? [state.usageRow] : [];
  }),
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
  state.askedPercentile = null;
  state.config.costEstimatePercentile = 0.8;
  resetCostEstimateCache();
});

describe("estimateStewardRunCostMicroUsd", () => {
  it("falls back to the config prior when there are too few metered runs", async () => {
    state.usageRow = { runs: 2, est_cost: 900_000 };
    expect(await estimateStewardRunCostMicroUsd("claude-sonnet-5")).toBe(
      250_000 // 0.25 owl prior at $1/owl of spend
    );
    expect(await estimateStewardRunCostMicroUsd("claude-fable-5-1")).toBe(
      1_000_000 // 1 owl strong prior
    );
  });

  it("uses the live figure once enough runs exist", async () => {
    state.usageRow = { runs: 12, est_cost: 2_600_000 };
    expect(await estimateStewardRunCostMicroUsd("claude-sonnet-5")).toBe(
      2_600_000
    );
  });

  it("asks SQL for the configured percentile, not the mean", async () => {
    state.usageRow = { runs: 12, est_cost: 3_300_000 };
    await estimateStewardRunCostMicroUsd("claude-sonnet-5");
    expect(state.askedPercentile).toBe(0.8);
  });

  it("honours a re-tuned percentile", async () => {
    state.config.costEstimatePercentile = 0.95;
    state.usageRow = { runs: 12, est_cost: 5_000_000 };
    await estimateStewardRunCostMicroUsd("claude-sonnet-5");
    expect(state.askedPercentile).toBe(0.95);
  });

  it("caches per percentile, so re-tuning is not masked by a stale entry", async () => {
    state.usageRow = { runs: 12, est_cost: 3_300_000 };
    expect(await estimateStewardRunCostMicroUsd("claude-sonnet-5")).toBe(3_300_000);
    state.config.costEstimatePercentile = 0.95;
    state.usageRow = { runs: 12, est_cost: 5_000_000 };
    expect(await estimateStewardRunCostMicroUsd("claude-sonnet-5")).toBe(5_000_000);
  });

  it("returns both tier estimates for the drain's ordering", async () => {
    const tiers = await stewardTierCostEstimates();
    expect(tiers.standardMicroUsd).toBe(250_000);
    expect(tiers.strongMicroUsd).toBe(1_000_000);
  });
});
