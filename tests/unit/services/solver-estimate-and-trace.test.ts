import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Two small changes the solver needs (docs/mathematics.md §7.2, §7.4): the
 * cost estimator groups the solver's series by run_id rather than
 * claim_id, per variant, falling back to the mandate's priors; and
 * TRACE_ALWAYS_AGENTS forces tracing on for the listed agents even where
 * TRACE_LEVEL would turn it off.
 */
const state = vi.hoisted(() => ({
  queries: [] as Array<{ q: string; params: unknown[] }>,
  row: null as null | { runs: number; est_cost: number | null },
  inserts: [] as unknown[],
  config: {
    env: "production",
    traceLevel: "off" as "off" | "full" | undefined,
    traceAlwaysAgents: ["math_solver"],
    owlCostMicroUsd: 1_000_000,
    costEstimateWindowDays: 14,
    costEstimateMinRuns: 5,
    costEstimatePercentile: 0.8,
    stewardModel: "claude-sonnet-5",
    stewardStrongModel: "claude-fable-5-1",
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    state.queries.push({ q, params });
    return state.row ? [state.row] : [];
  }),
  getDb: () => ({
    insert: () => ({
      values: async (row: unknown) => {
        state.inserts.push(row);
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }),
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => state.config }));
vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getEffectiveAllocationPolicy: vi.fn(async () => ({
    est_attempt_standard_cost_owls: 60,
    est_attempt_max_cost_owls: 150,
  })),
  getMandateAllocationPolicy: vi.fn(async () => ({
    est_attempt_standard_cost_owls: 70,
    est_attempt_max_cost_owls: 170,
  })),
}));

import {
  estimateSolverAttemptCostMicroUsd,
  resetCostEstimateCache,
} from "../../../src/services/cost-estimate-service.js";
import { startAgentRun, traceLevel } from "../../../src/services/trace-service.js";

beforeEach(() => {
  state.queries = [];
  state.row = null;
  state.inserts = [];
  state.config.traceLevel = "off";
  state.config.env = "production";
  resetCostEstimateCache();
});

describe("estimateSolverAttemptCostMicroUsd", () => {
  it("groups the solver's live series by run_id and filters by variant", async () => {
    state.row = { runs: 7, est_cost: 91_000_000 };
    const est = await estimateSolverAttemptCostMicroUsd({ model: "claude-fable-5-1", variant: "max" });
    expect(est).toBe(91_000_000);
    const { q, params } = state.queries[0]!;
    const s = q.replace(/\s+/g, " ");
    expect(s).toMatch(/GROUP BY u.run_id/);
    expect(s).toMatch(/FROM proof_attempts p WHERE p.run_id = u.run_id/);
    expect(s).not.toMatch(/GROUP BY claim_id/);
    expect(params).toEqual(["math_solver", "claude-fable-5-1", 14, 0.8, "max"]);
  });

  it("falls back to the funding mandate's prior until five runs exist", async () => {
    state.row = { runs: 3, est_cost: 91_000_000 };
    expect(await estimateSolverAttemptCostMicroUsd({ model: "claude-fable-5-1", variant: "max" })).toBe(150_000_000);
    expect(await estimateSolverAttemptCostMicroUsd({ model: "claude-fable-5-1", variant: "standard" })).toBe(60_000_000);
    expect(
      await estimateSolverAttemptCostMicroUsd({ model: "claude-fable-5-1", variant: "standard", grantId: "g1" })
    ).toBe(70_000_000);
  });

  it("keeps the two variants as two series in the cache", async () => {
    state.row = { runs: 9, est_cost: 40_000_000 };
    expect(await estimateSolverAttemptCostMicroUsd({ model: "claude-fable-5-1", variant: "standard" })).toBe(40_000_000);
    state.row = { runs: 9, est_cost: 120_000_000 };
    expect(await estimateSolverAttemptCostMicroUsd({ model: "claude-fable-5-1", variant: "max" })).toBe(120_000_000);
    expect(await estimateSolverAttemptCostMicroUsd({ model: "claude-fable-5-1", variant: "standard" })).toBe(40_000_000);
  });
});

describe("TRACE_ALWAYS_AGENTS", () => {
  it("forces tracing on for the listed agents, in production and under TRACE_LEVEL=off", () => {
    expect(traceLevel()).toBe("off");
    expect(traceLevel("steward")).toBe("off");
    expect(traceLevel("math_solver")).toBe("full");
    state.config.traceLevel = undefined;
    expect(traceLevel("steward")).toBe("off");
    expect(traceLevel("math_solver")).toBe("full");
  });

  it("opens a run for the solver where another agent gets none", () => {
    expect(startAgentRun("steward", {})).toBeNull();
    const trace = startAgentRun("math_solver", { jobId: "11111111-1111-1111-1111-111111111111" });
    expect(trace).not.toBeNull();
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ agent: "math_solver", jobId: "11111111-1111-1111-1111-111111111111" });
  });
});
