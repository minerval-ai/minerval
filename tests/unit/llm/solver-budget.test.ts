import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The solver breaker (docs/mathematics.md §7.3): today's math_solver spend
 * from the durable meter against SOLVER_DAILY_CAP_OWLS (the calibration cap
 * during a calibration run), raising the existing LlmBudgetExceededError;
 * and the consecutive-failure breaker copied from the steward drain.
 */
const state = vi.hoisted(() => ({
  spent: 0,
  queries: [] as Array<{ q: string; params: unknown[] }>,
  config: {
    owlCostMicroUsd: 1_000_000,
    solverDailyCapOwls: 400,
    solverCalibrationDailyCapOwls: 100,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    state.queries.push({ q, params });
    return [{ spent: state.spent }];
  }),
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => state.config }));

import { LlmBudgetExceededError } from "../../../src/llm/errors.js";
import {
  SOLVER_TRANSIENT_CIRCUIT_BREAK,
  SolverFailureBreaker,
  checkSolverBudget,
  solverDailyCapMicroUsd,
  solverSpentTodayMicroUsd,
} from "../../../src/llm/solver-budget.js";

beforeEach(() => {
  state.spent = 0;
  state.queries = [];
  state.config.solverDailyCapOwls = 400;
  state.config.solverCalibrationDailyCapOwls = 100;
});

describe("checkSolverBudget", () => {
  it("sums today's math_solver rows from llm_usage", async () => {
    state.spent = 12_000_000;
    expect(await solverSpentTodayMicroUsd()).toBe(12_000_000);
    const { q, params } = state.queries[0]!;
    expect(q).toMatch(/FROM llm_usage/);
    expect(q).toMatch(/agent = \$1/);
    expect(q).toMatch(/date_trunc\('day'/);
    expect(params).toEqual(["math_solver"]);
  });

  it("passes under the cap and throws LlmBudgetExceededError at it", async () => {
    state.spent = 399_999_999;
    await expect(checkSolverBudget()).resolves.toBeUndefined();
    state.spent = 400_000_000;
    await expect(checkSolverBudget()).rejects.toBeInstanceOf(LlmBudgetExceededError);
    try {
      await checkSolverBudget();
    } catch (err) {
      const e = err as LlmBudgetExceededError;
      expect(e.limitType).toBe("solver_daily_cap_micro_usd");
      expect(e.currentValue).toBe(400_000_000);
      expect(e.limitValue).toBe(400_000_000);
    }
  });

  it("uses the calibration cap for a calibration attempt", async () => {
    expect(solverDailyCapMicroUsd({ calibration: true })).toBe(100_000_000);
    expect(solverDailyCapMicroUsd()).toBe(400_000_000);
    state.spent = 150_000_000;
    await expect(checkSolverBudget()).resolves.toBeUndefined();
    await expect(checkSolverBudget({ calibration: true })).rejects.toThrow(
      /solver_calibration_daily_cap_micro_usd/
    );
  });

  it("admits nothing at a cap of zero", async () => {
    state.config.solverDailyCapOwls = 0;
    state.spent = 0;
    await expect(checkSolverBudget()).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });
});

describe("SolverFailureBreaker", () => {
  it("trips after the steward drain's threshold of consecutive failures and resets", () => {
    const breaker = new SolverFailureBreaker();
    expect(SOLVER_TRANSIENT_CIRCUIT_BREAK).toBe(5);
    for (let i = 1; i < SOLVER_TRANSIENT_CIRCUIT_BREAK; i++) {
      expect(breaker.recordFailure()).toBe(false);
      expect(breaker.tripped).toBe(false);
    }
    expect(breaker.recordFailure()).toBe(true);
    expect(breaker.tripped).toBe(true);
    expect(breaker.failures).toBe(5);
    breaker.reset();
    expect(breaker.tripped).toBe(false);
    expect(breaker.failures).toBe(0);
  });

  it("a success between failures resets the count", () => {
    const breaker = new SolverFailureBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.reset();
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.recordFailure()).toBe(true);
  });
});
