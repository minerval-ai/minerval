import { describe, it, expect, beforeEach, vi } from "vitest";

// The allocation scheduler's control flow: interval gating, the engine's
// steps running in order (reconcile ledger → order the pending list →
// self-fund what mandates decided), and the bounded staleness inflow (#295's R<1 by construction)
// wired into the normal enqueue path. DB + services mocked; the SQL runs
// live in the Stage 3 smoke/corpus harness.

const { state } = vi.hoisted(() => ({
  state: {
    dueClaims: [] as Array<{ id: string; days_old: number }>,
    reconciles: 0,
    priorityRuns: 0,
    selfFunds: 0,
    followUpSweeps: 0,
    enqueued: [] as Array<{ claimId: string; trigger: string }>,
    scans: [] as number[],
    config: {
      allocationSweepIntervalHours: 6,
      stalenessBaseDays: 60,
    },
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("make_interval")) {
      // No LIMIT: every claim past its interval is due.
      expect(params).toHaveLength(1);
      return state.dueClaims;
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

vi.mock("../../../src/services/priority-service.js", () => ({
  refreshPendingQueuePriorities: vi.fn(async () => {
    state.priorityRuns++;
    return 3;
  }),
}));

vi.mock("../../../src/services/petition-service.js", () => ({
  sweepFollowUps: vi.fn(async () => {
    state.followUpSweeps++;
    return 0;
  }),
}));

vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getEffectiveAllocationPolicy: vi.fn(async () => ({
    reconcile_candidates_max_per_sweep: 0,
    staleness_base_days: state.config.stalenessBaseDays,
  })),
}));

vi.mock("../../../src/services/curation-service.js", () => ({
  scanReconcileCandidates: vi.fn(async (policy: { reconcile_candidates_max_per_sweep: number }) => {
    state.scans.push(policy.reconcile_candidates_max_per_sweep);
    return 0;
  }),
}));

vi.mock("../../../src/services/allocation-service.js", () => ({
  fundGrantSelfActions: vi.fn(async () => {
    state.selfFunds++;
    return 0;
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
  state.priorityRuns = 0;
  state.selfFunds = 0;
  state.followUpSweeps = 0;
  state.enqueued = [];
  state.scans = [];
  state.config = {
    allocationSweepIntervalHours: 6,
    stalenessBaseDays: 60,
  };
});

describe("allocationSchedulerTick", () => {
  it("reconciles, orders, self-funds, sweeps follow-ups, and re-enqueues due claims", async () => {
    state.dueClaims = [
      { id: "c-1", days_old: 100 },
      { id: "c-2", days_old: 70 },
    ];
    const result = await allocationSchedulerTick(1_000_000);
    expect(result).toEqual({
      actionsReconciled: 2,
      prioritiesRefreshed: 3,
      stalenessEnqueued: 2,
    });
    expect(state.reconciles).toBe(1);
    expect(state.selfFunds).toBe(1);
    expect(state.followUpSweeps).toBe(1);
    // The reconcile-candidate scan runs each sweep, under the governing
    // policy, which ships it off (#363).
    expect(state.scans).toEqual([0]);
    expect(state.enqueued).toEqual([
      { claimId: "c-1", trigger: "staleness_check" },
      { claimId: "c-2", trigger: "staleness_check" },
    ]);
  });

  it("re-enqueues every claim past its interval: the ledger decides which run", async () => {
    state.dueClaims = [
      { id: "c-1", days_old: 100 },
      { id: "c-2", days_old: 90 },
      { id: "c-3", days_old: 80 },
    ];
    const result = await allocationSchedulerTick(1_000_000);
    expect(result.stalenessEnqueued).toBe(3);
  });

  it("runs at most once per interval", async () => {
    await allocationSchedulerTick(1_000_000);
    const second = await allocationSchedulerTick(1_000_000 + 60_000);
    expect(second).toEqual({
      actionsReconciled: 0,
      prioritiesRefreshed: 0,
      stalenessEnqueued: 0,
    });
    expect(state.priorityRuns).toBe(1);

    const later = await allocationSchedulerTick(1_000_000 + 7 * 3_600_000);
    expect(later.prioritiesRefreshed).toBe(3);
  });

  it("is disabled entirely by allocationSweepIntervalHours = 0", async () => {
    state.config.allocationSweepIntervalHours = 0;
    const result = await allocationSchedulerTick(1_000_000);
    expect(result).toEqual({
      actionsReconciled: 0,
      prioritiesRefreshed: 0,
      stalenessEnqueued: 0,
    });
    expect(state.priorityRuns).toBe(0);
  });
});
