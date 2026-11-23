import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// #1028: on 2026-11-13 the ledger's housekeeping (routing subscriptions,
// releasing holds, funding mandates' own rows) ran only inside a runner
// slot's engine lane, so while every slot was inside a unit that did not
// finish, nothing was routed and a check-in due at 04:06 was delivered at
// about 21:30. The runner now runs the housekeeping on a clock of its own.
// Lanes are mocked: this is the runner's control flow.

const { state } = vi.hoisted(() => ({
  state: {
    housekeeping: 0,
    /** When set, a housekeeping pass waits on this before it returns. */
    slowHousekeeping: null as null | Promise<void>,
    engineCalls: 0,
  },
}));

vi.mock("../../../src/workers/claim-pipeline.js", () => ({ handleClaimPipeline: vi.fn() }));
vi.mock("../../../src/workers/url-extraction.js", () => ({ handleUrlExtraction: vi.fn() }));
vi.mock("../../../src/workers/contribution-pipeline.js", () => ({ handleContributionMessage: vi.fn() }));
vi.mock("../../../src/workers/arbitration-pipeline.js", () => ({ handleArbitrationMessage: vi.fn() }));
// Every slot takes up an order that never finishes: the runner is wedged.
vi.mock("../../../src/workers/order-pipeline.js", () => ({
  processNextOrderTask: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../../../src/workers/budget-job-pipeline.js", () => ({
  processNextBudgetJobTask: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/engine-executor.js", () => ({
  processNextEngineAction: vi.fn(async () => {
    state.engineCalls++;
    return { status: "empty" };
  }),
  ledgerHousekeeping: vi.fn(async () => {
    state.housekeeping++;
    if (state.slowHousekeeping) await state.slowHousekeeping;
  }),
}));
vi.mock("../../../src/workers/steward-pipeline.js", () => ({
  processNextStewardTask: vi.fn(async () => ({ status: "empty" as const })),
  pendingStewardCount: vi.fn(async () => 0),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardMaxRuns: 0, stewardConcurrency: 3 }),
}));

import { startLocalRunner, LEDGER_HOUSEKEEPING_MS } from "../../../src/workers/local-runner.js";

const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  state.housekeeping = 0;
  state.slowHousekeeping = null;
  state.engineCalls = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the ledger's housekeeping", () => {
  it("runs on its own clock while every runner slot is held by a unit that never finishes", async () => {
    const runner = startLocalRunner({ logger, intervalMs: 500 });
    await vi.advanceTimersByTimeAsync(1_000);
    // Every slot is inside its order; none has reached the engine lane.
    expect(state.engineCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(4 * LEDGER_HOUSEKEEPING_MS);
    expect(state.housekeeping).toBeGreaterThanOrEqual(4);
    expect(state.engineCalls).toBe(0);
    runner.stop();
  });

  it("does not stack a pass on one still running", async () => {
    let finish!: () => void;
    state.slowHousekeeping = new Promise<void>((r) => (finish = r));
    const runner = startLocalRunner({ logger, intervalMs: 500, housekeepingIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.housekeeping).toBe(1);
    state.slowHousekeeping = null;
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.housekeeping).toBe(2);
    runner.stop();
  });

  it("stops with the runner", async () => {
    const runner = startLocalRunner({ logger, intervalMs: 500, housekeepingIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    runner.stop();
    const after = state.housekeeping;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.housekeeping).toBe(after);
  });
});
