import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A consistency sweep is priced by its partition's size (#756): the
 * variant's expected cost per assessed node, counting at least
 * CONSISTENCY_SWEEP_MIN_NODES, with the variant's cap as the ceiling only.
 * The per-node cost is the observed p80 of that variant's sweeps once
 * enough exist, else the model's list price times the tokens a node is
 * expected to take, else (a model the rate table cannot price) the policy
 * prior. The checker is told that basis beside its budget.
 */

const { state } = vi.hoisted(() => ({
  state: { observed: null as null | { runs: number; est_cost: number | null }, queries: [] as string[] },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string) => {
    state.queries.push(q);
    if (q.includes("FROM consistency_sweeps") && q.includes("percentile_cont")) {
      return state.observed ? [state.observed] : [{ runs: 0, est_cost: null }];
    }
    return [];
  }),
  withTransaction: vi.fn(),
}));
vi.mock("../../../src/llm/agents/consistency-checker.js", () => ({ runConsistencyChecker: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    owlCostMicroUsd: 1_000_000,
    capConsistencySweepOwls: 2,
    capConsistencySweepStrongOwls: 10,
    consistencyModel: "openai/gpt-6-luna",
    consistencyStrongModel: "claude-sonnet-5-5",
    costEstimateWindowDays: 14,
    costEstimateMinRuns: 5,
    costEstimatePercentile: 0.8,
  }),
}));
vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getEffectiveAllocationPolicy: vi.fn(async () => ({ est_consistency_node_cost_owls: 0.005 })),
  getMandateAllocationPolicy: vi.fn(),
}));

import {
  CONSISTENCY_SWEEP_MIN_NODES,
  consistencySweepPrice,
} from "../../../src/services/action-service.js";
import {
  CONSISTENCY_SWEEP_TOKENS_PER_NODE,
  estimateConsistencyNodeCostMicroUsd,
  resetCostEstimateCache,
} from "../../../src/services/cost-estimate-service.js";
import { consistencySweepBudgetBasis } from "../../../src/workers/consistency-sweep.js";

const flash = { microUsd: 5_000, basis: "policy_prior" as const };
const sonnet = { microUsd: 39_000, basis: "model_price" as const };

beforeEach(() => {
  state.observed = null;
  state.queries = [];
  resetCostEstimateCache();
});

describe("estimateConsistencyNodeCostMicroUsd", () => {
  it("prices a reader the rate table knows from its list rates and the per-node tokens", async () => {
    // Sonnet 5.5: $2 in, $10 out a million tokens; 12,000 in and 1,500 out a node.
    expect(CONSISTENCY_SWEEP_TOKENS_PER_NODE).toEqual({ input: 12_000, output: 1_500 });
    expect(await estimateConsistencyNodeCostMicroUsd("strong", 20)).toEqual(sonnet);
  });

  it("takes the policy prior for an OpenRouter reader the table cannot price", async () => {
    expect(await estimateConsistencyNodeCostMicroUsd("standard", 20)).toEqual(flash);
  });

  it("prefers the observed per-node cost once enough sweeps of the variant ran", async () => {
    state.observed = { runs: 6, est_cost: 900 };
    expect(await estimateConsistencyNodeCostMicroUsd("standard", 20)).toEqual({ microUsd: 900, basis: "observed" });
    resetCostEstimateCache();
    state.observed = { runs: 3, est_cost: 900 };
    expect((await estimateConsistencyNodeCostMicroUsd("standard", 20)).basis).toBe("policy_prior");
  });
});

describe("consistencySweepPrice", () => {
  it("scales with the partition's assessed nodes", () => {
    expect(consistencySweepPrice("standard", 100, flash).microUsd).toBe(500_000);
    expect(consistencySweepPrice("standard", 300, flash).microUsd).toBe(1_500_000);
    expect(consistencySweepPrice("strong", 100, sonnet).microUsd).toBe(3_900_000);
  });

  it("prices a small partition as if it held the minimum", () => {
    expect(CONSISTENCY_SWEEP_MIN_NODES).toBe(20);
    expect(consistencySweepPrice("standard", 3, flash).microUsd).toBe(100_000);
    expect(consistencySweepPrice("standard", 0, flash).nodesPriced).toBe(20);
  });

  it("stops at each variant's cap, a ceiling only", () => {
    const big = consistencySweepPrice("standard", 2_000, flash);
    expect(big.microUsd).toBe(2_000_000);
    expect(big.capped).toBe(true);
    expect(consistencySweepPrice("standard", 400, flash).capped).toBe(false);
    expect(consistencySweepPrice("strong", 2_000, sonnet).microUsd).toBe(10_000_000);
    // Where both caps bind the ratio is 5; below them it is the per-node ratio.
    expect(consistencySweepPrice("strong", 400, sonnet).microUsd / consistencySweepPrice("standard", 400, flash).microUsd).toBe(5);
  });
});

describe("consistencySweepBudgetBasis", () => {
  it("states the rate, its source, the ceiling and what the partition came to", () => {
    const line = consistencySweepBudgetBasis(consistencySweepPrice("standard", 120, flash), 120);
    expect(line).toContain("by the partition's size");
    expect(line).toContain("$0.0050 per assessed node");
    expect(line).toContain("set generously until its sweeps have run");
    expect(line).toContain("at least 20");
    expect(line).toContain("ceiling of $2.00");
    expect(line).toContain("120 node(s) come to $0.60");
    expect(line).not.toContain("ceiling binds");
    const observed = consistencySweepBudgetBasis(
      consistencySweepPrice("standard", 120, { microUsd: 900, basis: "observed" }),
      120
    );
    expect(observed).toContain("recent sweeps actually cost per node");
  });

  it("says when the ceiling binds, how far it reaches, and to note where it stopped", () => {
    const line = consistencySweepBudgetBasis(consistencySweepPrice("strong", 500, sonnet), 500);
    expect(line).toContain("model price");
    expect(line).toContain("ceiling of $10.00");
    expect(line).toContain("covers about 256 of the 500 nodes");
    expect(line).toContain("where you stopped");
  });
});
