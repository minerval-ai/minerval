import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The continuous runner runs up to STEWARD_CONCURRENCY drains at once and
// paces them with RunnerGovernor: a transient failure halves the live limit
// and backs off, a clean drain climbs back. Lanes are mocked; this is runner
// control flow, not the lanes' own claiming (which SKIP LOCKED covers).

const { state } = vi.hoisted(() => ({
  state: {
    orders: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    release: [] as Array<() => void>,
    orderResult: "processed" as "processed" | "transient",
    handled: [] as string[],
    contributionBudget: false,
  },
}));

vi.mock("../../../src/workers/claim-pipeline.js", () => ({ handleClaimPipeline: vi.fn() }));
vi.mock("../../../src/workers/url-extraction.js", () => ({ handleUrlExtraction: vi.fn() }));
vi.mock("../../../src/workers/contribution-pipeline.js", () => ({
  handleContributionMessage: vi.fn(async (m: { contributionId: string }) => {
    if (state.contributionBudget) {
      const { LlmBudgetExceededError } = await import("../../../src/llm/errors.js");
      throw new LlmBudgetExceededError("hourly_token_count", 2, 1);
    }
    state.handled.push(m.contributionId);
  }),
}));
vi.mock("../../../src/workers/arbitration-pipeline.js", () => ({ handleArbitrationMessage: vi.fn() }));
vi.mock("../../../src/workers/order-pipeline.js", () => ({
  processNextOrderTask: vi.fn(async () => {
    if (state.orderResult === "transient") return { status: "transient" };
    const id = state.orders.shift();
    if (!id) return { status: "empty" };
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise<void>((r) => state.release.push(r));
    state.inFlight--;
    return { status: "processed", orderId: id, claimId: id, ok: true };
  }),
}));
vi.mock("../../../src/workers/budget-job-pipeline.js", () => ({
  processNextBudgetJobTask: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/engine-executor.js", () => ({
  processNextEngineAction: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/steward-pipeline.js", () => ({
  processNextStewardTask: vi.fn(async () => ({ status: "empty" as const })),
  pendingStewardCount: vi.fn(async () => 0),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardMaxRuns: 0, stewardConcurrency: 4 }),
}));

import {
  drainLocalQueues,
  startLocalRunner,
  RunnerGovernor,
} from "../../../src/workers/local-runner.js";
import { getLocalQueue } from "../../../src/services/queue-service.js";

const logger = { info: vi.fn(), error: vi.fn() };

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  state.orders = [];
  state.inFlight = 0;
  state.maxInFlight = 0;
  state.release = [];
  state.orderResult = "processed";
  state.handled = [];
  state.contributionBudget = false;
  getLocalQueue("contribution").length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RunnerGovernor", () => {
  it("halves the live limit on a transient failure and climbs back one per clean drain", () => {
    const g = new RunnerGovernor(8);
    expect(g.limit).toBe(8);
    g.onTransient(0);
    expect(g.limit).toBe(4);
    g.onTransient(0);
    expect(g.limit).toBe(2);
    g.onTransient(0);
    g.onTransient(0);
    expect(g.limit).toBe(1); // never below one: it slows down, it does not stop
    g.onClean();
    g.onClean();
    expect(g.limit).toBe(3);
    for (let i = 0; i < 10; i++) g.onClean();
    expect(g.limit).toBe(8); // the ceiling holds
  });

  it("backs off exponentially on consecutive transient stops, capped, and resets on a clean drain", () => {
    const g = new RunnerGovernor(4);
    expect(g.onTransient(0)).toBe(5_000);
    expect(g.onTransient(0)).toBe(10_000);
    expect(g.onTransient(0)).toBe(20_000);
    for (let i = 0; i < 10; i++) g.onTransient(0);
    expect(g.onTransient(0)).toBe(RunnerGovernor.MAX_BACKOFF_MS);
    g.onClean();
    expect(g.onTransient(0)).toBe(5_000);
  });

  it("lets no slot start during a pause, and only slots under the live limit after it", () => {
    const g = new RunnerGovernor(4);
    g.onTransient(1_000); // limit 2, paused until 6_000
    expect(g.mayStart(0, 5_999)).toBe(false);
    expect(g.mayStart(0, 6_000)).toBe(true);
    expect(g.mayStart(1, 6_000)).toBe(true);
    expect(g.mayStart(2, 6_000)).toBe(false);
  });

});

describe("drainLocalQueues options", () => {
  it("reports a transient stop", async () => {
    state.orderResult = "transient";
    const stats = await drainLocalQueues();
    expect(stats.stoppedOnTransient).toBe(true);
  });

  it("leaves the in-memory queues to the singleton slot", async () => {
    getLocalQueue("contribution").push({ contributionId: "c-1" });
    await drainLocalQueues({ singletonLanes: false });
    expect(state.handled).toEqual([]);
    await drainLocalQueues();
    expect(state.handled).toEqual(["c-1"]);
  });

  it("ends when shouldContinue says so, before the next unit", async () => {
    getLocalQueue("contribution").push({ contributionId: "c-1" }, { contributionId: "c-2" });
    let units = 0;
    await drainLocalQueues({ shouldContinue: () => units++ < 1 });
    expect(state.handled).toEqual(["c-1"]);
  });
});

describe("the unattributed breaker", () => {
  it("one-shot drains still throw it, with the message requeued", async () => {
    state.contributionBudget = true;
    getLocalQueue("contribution").push({ contributionId: "c-1" });
    await expect(drainLocalQueues()).rejects.toThrow();
    expect(getLocalQueue("contribution")).toEqual([{ contributionId: "c-1" }]);
  });

  it("does not stop the funded lanes when the runner asks it not to", async () => {
    state.contributionBudget = true;
    getLocalQueue("contribution").push({ contributionId: "c-1" });
    state.orders = ["o1"];
    const drain = drainLocalQueues({ surfaceBudgetErrors: false });
    await flush();
    state.release.splice(0).forEach((r) => r());
    const stats = await drain;
    expect(stats.processed.order).toBe(1);
    expect(stats.unattributedBudgetSpent).toBe(true);
    expect(getLocalQueue("contribution")).toEqual([{ contributionId: "c-1" }]);
  });
});

describe("startLocalRunner", () => {
  it("runs up to the configured number of orders at once", async () => {
    vi.useFakeTimers();
    state.orders = ["o1", "o2", "o3", "o4", "o5", "o6"];
    const runner = startLocalRunner({ logger, intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(state.maxInFlight).toBe(4);
    // Each finished order frees its slot to take the next.
    state.release.splice(0).forEach((r) => r());
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(state.orders).toEqual([]);
    expect(state.inFlight).toBe(2);
    state.release.splice(0).forEach((r) => r());
    runner.stop();
  });

  it("with concurrency 1 runs orders one at a time, as before", async () => {
    vi.useFakeTimers();
    state.orders = ["o1", "o2", "o3"];
    const runner = startLocalRunner({ logger, intervalMs: 10, concurrency: 1 });
    await vi.advanceTimersByTimeAsync(30);
    await flush();
    expect(state.maxInFlight).toBe(1);
    state.release.splice(0).forEach((r) => r());
    runner.stop();
  });

  it("backs off after a transient stop instead of retrying every tick", async () => {
    vi.useFakeTimers();
    state.orderResult = "transient";
    const { processNextOrderTask } = await import("../../../src/workers/order-pipeline.js");
    const runner = startLocalRunner({ logger, intervalMs: 10, concurrency: 2 });
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    const afterFirst = vi.mocked(processNextOrderTask).mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    // Within the 5 s backoff no slot looks again.
    await vi.advanceTimersByTimeAsync(4_000);
    await flush();
    expect(vi.mocked(processNextOrderTask).mock.calls.length).toBe(afterFirst);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("concurrency now 1/2"));
    runner.stop();
  });
});
