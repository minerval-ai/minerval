import { describe, it, expect, beforeEach, vi } from "vitest";

// The allocation scheduler's control flow: interval gating, the bounded
// staleness inflow (#295's R<1 by construction), and the cadence formula's
// wiring into the normal enqueue path. DB + priority service mocked; the
// SQL runs live in the Stage 3 smoke/corpus harness.

const { state } = vi.hoisted(() => ({
  state: {
    dueClaims: [] as Array<{ id: string; days_old: number }>,
    refreshed: 0,
    enqueued: [] as Array<{ claimId: string; trigger: string }>,
    config: {
      allocationSweepIntervalHours: 6,
      stalenessBaseDays: 60,
      stalenessMaxPerSweep: 5,
    },
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("make_interval")) {
      const limit = params[1] as number;
      return state.dueClaims.slice(0, limit);
    }
    return [];
  }),
}));

vi.mock("../../../src/services/priority-service.js", () => ({
  refreshPendingQueuePriorities: vi.fn(async () => {
    state.refreshed++;
    return 3;
  }),
}));

vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(
    async (m: { claimId: string; trigger: string }) => {
      state.enqueued.push({ claimId: m.claimId, trigger: m.trigger });
    }
  ),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => state.config,
}));

import {
  allocationSchedulerTick,
  resetAllocationScheduler,
} from "../../../src/workers/allocation-scheduler.js";

beforeEach(() => {
  resetAllocationScheduler();
  state.dueClaims = [];
  state.refreshed = 0;
  state.enqueued = [];
  state.config = {
    allocationSweepIntervalHours: 6,
    stalenessBaseDays: 60,
    stalenessMaxPerSweep: 5,
  };
});

describe("allocationSchedulerTick", () => {
  it("refreshes pending priorities and re-enqueues due claims via staleness_check", async () => {
    state.dueClaims = [
      { id: "c-1", days_old: 100 },
      { id: "c-2", days_old: 70 },
    ];
    const result = await allocationSchedulerTick(1_000_000);
    expect(result).toEqual({ prioritiesRefreshed: 3, stalenessEnqueued: 2, allocationsPlaced: 0 });
    expect(state.enqueued).toEqual([
      { claimId: "c-1", trigger: "staleness_check" },
      { claimId: "c-2", trigger: "staleness_check" },
    ]);
  });

  it("bounds the reassessment inflow to stalenessMaxPerSweep", async () => {
    state.config.stalenessMaxPerSweep = 2;
    state.dueClaims = [
      { id: "c-1", days_old: 100 },
      { id: "c-2", days_old: 90 },
      { id: "c-3", days_old: 80 },
    ];
    const result = await allocationSchedulerTick(1_000_000);
    expect(result.stalenessEnqueued).toBe(2);
  });

  it("runs at most once per interval", async () => {
    await allocationSchedulerTick(1_000_000);
    const second = await allocationSchedulerTick(1_000_000 + 60_000);
    expect(second).toEqual({ prioritiesRefreshed: 0, stalenessEnqueued: 0, allocationsPlaced: 0 });
    expect(state.refreshed).toBe(1);

    const later = await allocationSchedulerTick(1_000_000 + 7 * 3_600_000);
    expect(later.prioritiesRefreshed).toBe(3);
  });

  it("is disabled entirely by allocationSweepIntervalHours = 0", async () => {
    state.config.allocationSweepIntervalHours = 0;
    const result = await allocationSchedulerTick(1_000_000);
    expect(result).toEqual({ prioritiesRefreshed: 0, stalenessEnqueued: 0, allocationsPlaced: 0 });
    expect(state.refreshed).toBe(0);
  });
});
