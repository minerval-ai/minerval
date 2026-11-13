import { describe, it, expect, beforeEach, vi } from "vitest";

// The allocation scheduler's control flow: interval gating, the engine's
// steps running in order (reconcile ledger → order the pending list →
// self-fund what mandates decided), and the bounded staleness inflow (#295's R<1 by construction)
// wired into the normal enqueue path. DB + services mocked; the SQL runs
// live in the Stage 3 smoke/corpus harness.

const { state } = vi.hoisted(() => ({
  state: {
    dueClaims: [] as Array<{ id: string; sensitivity_label: string; days_old: number }>,
    // The label each staleness enqueue was made at (currentLabel inside it).
    enqueuedAt: [] as string[],
    reconciles: 0,
    orderLooks: 0,
    firstSittingLooks: 0,
    agentRunLooks: 0,
    tends: 0,
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
  materializeStandingOrders: vi.fn(async () => {
    state.orderLooks++;
    return 0;
  }),
  openFirstSittings: vi.fn(async () => {
    state.firstSittingLooks++;
    return 0;
  }),
  openDueAgentRuns: vi.fn(async () => {
    state.agentRunLooks++;
  }),
}));

vi.mock("../../../src/services/mandate-lifecycle-service.js", () => ({
  tendMandates: vi.fn(async () => {
    state.tends++;
    return { paused: 0, completed: 0 };
  }),
}));

vi.mock("../../../src/services/priority-service.js", () => ({
  refreshPendingQueuePriorities: vi.fn(async () => {
    state.priorityRuns++;
    return 3;
  }),
}));

vi.mock("../../../src/services/session-service.js", () => ({ sweepSessions: vi.fn(async () => 0) }));

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

vi.mock("../../../src/services/curation-service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
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
      const { currentLabel } = await import("../../../src/llm/usage-context.js");
      state.enqueuedAt.push(currentLabel());
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
  state.orderLooks = 0;
  state.firstSittingLooks = 0;
  state.agentRunLooks = 0;
  state.tends = 0;
  state.priorityRuns = 0;
  state.selfFunds = 0;
  state.followUpSweeps = 0;
  state.enqueued = [];
  state.enqueuedAt = [];
  state.scans = [];
  state.config = {
    allocationSweepIntervalHours: 6,
    stalenessBaseDays: 60,
  };
});

describe("allocationSchedulerTick", () => {
  it("reconciles, orders, self-funds, sweeps follow-ups, and re-enqueues due claims", async () => {
    state.dueClaims = [
      { id: "c-1", sensitivity_label: "public", days_old: 100 },
      { id: "c-2", sensitivity_label: "public", days_old: 70 },
    ];
    const result = await allocationSchedulerTick(1_000_000);
    expect(result).toEqual({
      actionsReconciled: 2,
      prioritiesRefreshed: 3,
      stalenessEnqueued: 2,
    });
    expect(state.reconciles).toBe(1);
    // The sweep's reconcile placed the plans' standing orders itself; the
    // mandates no agent ends are tended on top of it.
    expect(state.orderLooks).toBe(0);
    expect(state.tends).toBe(1);
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
      { id: "c-1", sensitivity_label: "public", days_old: 100 },
      { id: "c-2", sensitivity_label: "public", days_old: 90 },
      { id: "c-3", sensitivity_label: "public", days_old: 80 },
    ];
    const result = await allocationSchedulerTick(1_000_000);
    expect(result.stalenessEnqueued).toBe(3);
  });

  // The check starts from the claim, outside any run, so the pass it asks
  // for is opened at the claim's label (src/labels.ts).
  it("asks for each stale claim's fresh look at that claim's label", async () => {
    state.dueClaims = [
      { id: "c-1", sensitivity_label: "internal", days_old: 100 },
      { id: "c-2", sensitivity_label: "public", days_old: 90 },
    ];
    await allocationSchedulerTick(1_000_000);
    expect(state.enqueued.map((e) => e.claimId)).toEqual(["c-1", "c-2"]);
    expect(state.enqueuedAt).toEqual(["internal", "public"]);
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
    // Between sweeps a tick still asks for the standing orders again and
    // tends the mandates (#849): room that opens is used within minutes.
    expect(state.orderLooks).toBe(1);
    expect(state.tends).toBe(2);
    expect(state.reconciles).toBe(1);
    // And opens what runs on its own clock: a new mandate's first sitting,
    // and the lookouts and Correspondents that have fallen due, never
    // waiting for the six-hourly sweep.
    expect(state.firstSittingLooks).toBe(1);
    expect(state.agentRunLooks).toBe(1);

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
    expect(state.orderLooks).toBe(0);
    expect(state.tends).toBe(0);
  });
});
