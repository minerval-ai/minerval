import { describe, it, expect, vi } from "vitest";

/**
 * A consistency sweep is priced by its partition's size (#756): the
 * variant's rate per assessed node, counting at least
 * CONSISTENCY_SWEEP_MIN_NODES, with the variant's cap as the ceiling. The
 * checker is told that basis beside its budget, and when the ceiling binds,
 * how far the budget reaches and to note where it stopped.
 */

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock("../../../src/llm/agents/consistency-checker.js", () => ({ runConsistencyChecker: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  // The defaults (config.ts).
  loadConfig: () => ({
    owlCostMicroUsd: 1_000_000,
    capConsistencySweepOwls: 2,
    consistencySweepOwlsPerNode: 0.005,
    capConsistencySweepStrongOwls: 10,
    consistencySweepStrongOwlsPerNode: 0.05,
  }),
}));

import {
  CONSISTENCY_SWEEP_MIN_NODES,
  consistencySweepCostMicroUsd,
  consistencySweepPrice,
} from "../../../src/services/action-service.js";
import { consistencySweepBudgetBasis } from "../../../src/workers/consistency-sweep.js";

describe("consistencySweepPrice", () => {
  it("scales with the partition's assessed nodes", () => {
    expect(consistencySweepCostMicroUsd("standard", 100)).toBe(500_000);
    expect(consistencySweepCostMicroUsd("standard", 300)).toBe(1_500_000);
    expect(consistencySweepCostMicroUsd("strong", 100)).toBe(5_000_000);
  });

  it("prices a small partition as if it held the minimum", () => {
    expect(CONSISTENCY_SWEEP_MIN_NODES).toBe(20);
    expect(consistencySweepCostMicroUsd("standard", 3)).toBe(100_000);
    expect(consistencySweepCostMicroUsd("standard", 0)).toBe(100_000);
    expect(consistencySweepPrice("standard", 3).nodesPriced).toBe(20);
  });

  it("stops at each variant's cap", () => {
    const big = consistencySweepPrice("standard", 2_000);
    expect(big.microUsd).toBe(2_000_000);
    expect(big.capped).toBe(true);
    expect(consistencySweepPrice("standard", 400).capped).toBe(false);
    expect(consistencySweepCostMicroUsd("strong", 2_000)).toBe(10_000_000);
    // Past 200 nodes the strong cap binds first, so the ratio falls below 10.
    expect(consistencySweepCostMicroUsd("strong", 400) / consistencySweepCostMicroUsd("standard", 400)).toBe(5);
  });
});

describe("consistencySweepBudgetBasis", () => {
  it("states the rate, the ceiling and what the partition came to", () => {
    const line = consistencySweepBudgetBasis(consistencySweepPrice("standard", 120), 120);
    expect(line).toContain("by the partition's size");
    expect(line).toContain("$0.0050 per assessed node");
    expect(line).toContain("at least 20");
    expect(line).toContain("ceiling of $2.00");
    expect(line).toContain("120 node(s) come to $0.60");
    expect(line).toContain("cover reading every node");
    expect(line).not.toContain("ceiling binds");
  });

  it("says when the ceiling binds, how far it reaches, and to note where it stopped", () => {
    const line = consistencySweepBudgetBasis(consistencySweepPrice("strong", 500), 500);
    expect(line).toContain("ceiling of $10.00");
    expect(line).toContain("covers about 200 of the 500 nodes");
    expect(line).toContain("where you stopped");
  });
});
