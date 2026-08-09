import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config.js", () => {
  let _limits = {
    llmHourlyCallLimit: 10,
    llmDailyCallLimit: 100,
    llmHourlyTokenLimit: 50000,
    llmDailyTokenLimit: 500000,
  };
  return {
    loadConfig: vi.fn(() => _limits),
    __setLimits: (limits: typeof _limits) => {
      _limits = limits;
    },
  };
});

import {
  checkBudget,
  recordUsage,
  resetBudgetCounters,
  getBudgetStatus,
  getSessionUsage,
} from "../../../src/llm/budget-tracker.js";
import { LlmBudgetExceededError } from "../../../src/llm/errors.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";

describe("BudgetTracker", () => {
  beforeEach(() => {
    resetBudgetCounters();
  });

  it("allows calls within hourly call limit", () => {
    for (let i = 0; i < 9; i++) {
      checkBudget();
      recordUsage(100, 200);
    }
    expect(getBudgetStatus().hourlyCallCount).toBe(9);
    expect(() => checkBudget()).not.toThrow();
  });

  it("throws when hourly call limit is reached", () => {
    for (let i = 0; i < 10; i++) {
      checkBudget();
      recordUsage(100, 200);
    }
    expect(() => checkBudget()).toThrow(LlmBudgetExceededError);
  });

  it("throws with correct metadata", () => {
    for (let i = 0; i < 10; i++) {
      checkBudget();
      recordUsage(100, 200);
    }
    try {
      checkBudget();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmBudgetExceededError);
      const e = err as LlmBudgetExceededError;
      expect(e.limitType).toBe("hourly_call_count");
      expect(e.currentValue).toBe(10);
      expect(e.limitValue).toBe(10);
    }
  });

  it("throws when hourly token limit is reached", () => {
    checkBudget();
    recordUsage(25000, 25000);
    expect(() => checkBudget()).toThrow(LlmBudgetExceededError);
  });

  it("tracks daily limits separately from hourly", () => {
    const status = getBudgetStatus();
    expect(status.dailyCallCount).toBe(0);
    expect(status.hourlyCallCount).toBe(0);

    checkBudget();
    recordUsage(100, 200);

    const updated = getBudgetStatus();
    expect(updated.dailyCallCount).toBe(1);
    expect(updated.hourlyCallCount).toBe(1);
    expect(updated.dailyTokenCount).toBe(300);
    expect(updated.hourlyTokenCount).toBe(300);
  });

  it("allows unlimited when limit is 0", async () => {
    const { __setLimits } = await import("../../../src/config.js") as {
      __setLimits: (limits: Record<string, number>) => void;
    };
    __setLimits({
      llmHourlyCallLimit: 0,
      llmDailyCallLimit: 0,
      llmHourlyTokenLimit: 0,
      llmDailyTokenLimit: 0,
    });

    for (let i = 0; i < 1000; i++) {
      checkBudget();
      recordUsage(10000, 10000);
    }
    // Should never throw

    // Restore
    __setLimits({
      llmHourlyCallLimit: 10,
      llmDailyCallLimit: 100,
      llmHourlyTokenLimit: 50000,
      llmDailyTokenLimit: 500000,
    });
  });

  it("accumulates session usage including cache tokens", () => {
    recordUsage(1000, 500, { readTokens: 8000, creationTokens: 200 });
    recordUsage(2000, 700);
    const u = getSessionUsage();
    expect(u.calls).toBe(2);
    expect(u.inputTokens).toBe(3000);
    expect(u.outputTokens).toBe(1200);
    expect(u.cacheReadTokens).toBe(8000);
    expect(u.cacheCreationTokens).toBe(200);
  });

  it("excludes cache-read tokens from the limit counters (only uncached input+output)", () => {
    // A large cache-read prefix must not trip the daily/hourly token limits.
    recordUsage(100, 50, { readTokens: 1_000_000 });
    const status = getBudgetStatus();
    expect(status.dailyTokenCount).toBe(150);
    expect(status.hourlyTokenCount).toBe(150);
  });

  it("resets session usage on resetBudgetCounters", () => {
    recordUsage(100, 50, { readTokens: 10 });
    resetBudgetCounters();
    const u = getSessionUsage();
    expect(u).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("resets hourly counters on hour boundary", () => {
    vi.useFakeTimers();
    // Pin a deterministic base time, then re-anchor the counters to it. Without
    // this the timers freeze at real wall-clock, and advancing one hour can also
    // cross a UTC day boundary (resetting the daily counter too) — making the
    // test flake when run in the 23:00–23:59 UTC window.
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    resetBudgetCounters();

    for (let i = 0; i < 10; i++) {
      checkBudget();
      recordUsage(100, 200);
    }
    expect(() => checkBudget()).toThrow(LlmBudgetExceededError);

    // Advance past hour boundary
    vi.advanceTimersByTime(3_600_001);
    expect(() => checkBudget()).not.toThrow();

    // Daily counter should still be at 10
    const status = getBudgetStatus();
    expect(status.hourlyCallCount).toBe(0);
    expect(status.dailyCallCount).toBe(10);

    vi.useRealTimers();
  });

  it("resets daily counters on day boundary", () => {
    vi.useFakeTimers();
    // Pin a deterministic base time (see hour-boundary test) so the rollover is
    // independent of when the suite runs.
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    resetBudgetCounters();

    for (let i = 0; i < 10; i++) {
      checkBudget();
      recordUsage(100, 200);
    }

    // Advance past day boundary
    vi.advanceTimersByTime(86_400_001);
    const status = getBudgetStatus();
    expect(status.hourlyCallCount).toBe(0);
    expect(status.dailyCallCount).toBe(0);

    vi.useRealTimers();
  });
});

/**
 * The breaker's scope. Attributed work already has a real ceiling — a user's
 * owl balance, a mandate's escrow — so these counters exist for the work
 * that has none. Sharing one process-global count across every lane meant a
 * background sweep could exhaust the hour and start refusing PAID requests,
 * and a burst of user traffic could close the breaker on the background lane.
 */
describe("what the breaker is scoped to", () => {
  beforeEach(() => {
    resetBudgetCounters();
  });

  const exhaustTheHour = () => {
    for (let i = 0; i < 10; i++) recordUsage(100, 200);
  };

  it("refuses unattributed work once the hour is spent", () => {
    exhaustTheHour();
    expect(() => checkBudget()).toThrow(LlmBudgetExceededError);
  });

  it("still serves a paying user after the background lane spent the hour", () => {
    exhaustTheHour();
    runWithUsageContext({ userId: "u-1" }, () => {
      expect(() => checkBudget()).not.toThrow();
    });
  });

  it("still serves a funded job after the background lane spent the hour", () => {
    exhaustTheHour();
    runWithUsageContext({ jobId: "job-1" }, () => {
      expect(() => checkBudget()).not.toThrow();
    });
  });

  it("does not count paid work into the limit the paid work is exempt from", () => {
    // Otherwise user traffic closes the breaker on the background lane.
    runWithUsageContext({ userId: "u-1" }, () => {
      for (let i = 0; i < 20; i++) recordUsage(1000, 1000);
    });
    expect(getBudgetStatus().hourlyCallCount).toBe(0);
    expect(() => checkBudget()).not.toThrow();
  });

  it("still reports paid work in the session totals: the cost report is whole-process", () => {
    runWithUsageContext({ userId: "u-1" }, () => recordUsage(1000, 500));
    recordUsage(10, 20);
    const session = getSessionUsage();
    expect(session.calls).toBe(2);
    expect(session.inputTokens).toBe(1010);
    expect(session.outputTokens).toBe(520);
  });
});
