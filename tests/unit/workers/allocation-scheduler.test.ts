import { describe, it, expect, beforeEach, vi } from "vitest";

// The allocation scheduler's control flow: interval gating, the engine's
// three layers running in order (reconcile ledger → refresh valuations →
// allocate), and the bounded staleness inflow (#295's R<1 by construction)
// wired into the normal enqueue path. DB + services mocked; the SQL runs
// live in the Stage 3 smoke/corpus harness.

const { state } = vi.hoisted(() => ({
  state: {
    dueClaims: [] as Array<{ id: string; days_old: number }>,
    reconciles: 0,
    valuationRuns: 0,
    allocatorRuns: 0,
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

vi.mock("../../../src/services/action-service.js", () => ({
  reconcileActions: vi.fn(async () => {
    state.reconciles++;
    return { assessEnsured: 2, cancelled: 0 };
  }),
}));

vi.mock("../../../src/services/mandate-valuer-service.js", () => ({
  refreshAllValuations: vi.fn(async () => {
    state.valuationRuns++;
    return { mandates: 1, valuations: 3 };
  }),
}));

vi.mock("../../../src/services/allocation-service.js", () => ({
  runDailyAllocators: vi.fn(async () => {
    state.allocatorRuns++;
    return { mandates: 0, allocated: 0, allocatedMicroUsd: 0 };
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
  state.reconciles = 0;
  state.valuationRuns = 0;
  state.allocatorRuns = 0;
  state.enqueued = [];
  state.config = {
    allocationSweepIntervalHours: 6,
    stalenessBaseDays: 60,
    stalenessMaxPerSweep: 5,
  };
});

describe("allocationSchedulerTick", () => {
  it("reconciles, refreshes valuations, allocates, and re-enqueues due claims", async () => {
    state.dueClaims = [
      { id: "c-1", days_old: 100 },
      { id: "c-2", days_old: 70 },
    ];
    const result = await allocationSchedulerTick(1_000_000);
    expect(result).toEqual({
      actionsReconciled: 2,
      valuationsRefreshed: 3,
      stalenessEnqueued: 2,
      allocationsPlaced: 0,
    });
    expect(state.reconciles).toBe(1);
    expect(state.allocatorRuns).toBe(1);
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
    expect(second).toEqual({
      actionsReconciled: 0,
      valuationsRefreshed: 0,
      stalenessEnqueued: 0,
      allocationsPlaced: 0,
    });
    expect(state.valuationRuns).toBe(1);

    const later = await allocationSchedulerTick(1_000_000 + 7 * 3_600_000);
    expect(later.valuationsRefreshed).toBe(3);
  });

  it("is disabled entirely by allocationSweepIntervalHours = 0", async () => {
    state.config.allocationSweepIntervalHours = 0;
    const result = await allocationSchedulerTick(1_000_000);
    expect(result).toEqual({
      actionsReconciled: 0,
      valuationsRefreshed: 0,
      stalenessEnqueued: 0,
      allocationsPlaced: 0,
    });
    expect(state.valuationRuns).toBe(0);
  });
});
