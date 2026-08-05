import { describe, it, expect, beforeEach, vi } from "vitest";

// Budget-job control flow: pause at the budget floor, complete + refund when
// the subtree is exhausted, and promote deferred stubs the background lane
// deliberately skips. DB + Steward mocked; SQL runs live in the harness.

const { state, runCalls } = vi.hoisted(() => ({
  runCalls: [] as Array<{ claimId: string; trigger: string }>,
  state: {
    job: null as null | {
      id: string;
      user_id: string;
      claim_id: string;
      budget_micro_usd: number;
      checkpoint: Record<string, unknown> | null;
    },
    spent: 0,
    targets: [] as Array<{
      id: string;
      prior_state: string;
      decomposition_status: string;
      steward_trigger: string | null;
      steward_context: string | null;
    }>,
    jobUpdates: [] as Array<{ sql: string; params: unknown[] }>,
    refunds: [] as unknown[],
    throwFor: null as null | ((claimId: string) => Error | null),
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("FROM budget_jobs") && q.includes("SKIP LOCKED")) {
      return state.job ? [state.job] : [];
    }
    if (q.includes("WITH RECURSIVE") && q.includes("UPDATE claims")) {
      const target = state.targets.shift();
      return target ? [target] : [];
    }
    if (q.includes("WITH RECURSIVE")) {
      // subtree counts
      return [
        {
          pending: state.targets.filter((t) => t.prior_state === "pending")
            .length,
          deferred: state.targets.filter((t) => t.prior_state === "deferred")
            .length,
          done: 0,
        },
      ];
    }
    if (q.includes("UPDATE budget_jobs")) {
      state.jobUpdates.push({ sql: q, params });
      return [];
    }
    return [];
  }),
}));

vi.mock("../../../src/llm/agents/claim-steward.js", () => ({
  runClaimSteward: vi.fn(
    async (input: { claimId: string; trigger: string }) => {
      runCalls.push({ claimId: input.claimId, trigger: input.trigger });
      const err = state.throwFor?.(input.claimId);
      if (err) throw err;
    }
  ),
}));

vi.mock("../../../src/services/budget-job-service.js", () => ({
  getJobSpentMicroUsd: vi.fn(async () => state.spent),
  refundUnspentBudget: vi.fn(async (job: unknown) => {
    state.refunds.push(job);
    return 1;
  }),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardModel: "claude-sonnet-5" }),
}));

import { processNextBudgetJobTask } from "../../../src/workers/budget-job-pipeline.js";

function job(overrides: Partial<NonNullable<typeof state.job>> = {}) {
  return {
    id: "job-1",
    user_id: "user-1",
    claim_id: "root-1",
    budget_micro_usd: 40_000_000, // 10 owls
    checkpoint: null,
    ...overrides,
  };
}

beforeEach(() => {
  runCalls.length = 0;
  state.job = null;
  state.spent = 0;
  state.targets = [];
  state.jobUpdates = [];
  state.refunds = [];
  state.throwFor = null;
});

describe("processNextBudgetJobTask", () => {
  it("returns empty with no runnable jobs", async () => {
    expect((await processNextBudgetJobTask()).status).toBe("empty");
  });

  it("stewards the next subtree target and updates the checkpoint", async () => {
    state.job = job();
    state.targets = [
      {
        id: "sub-1",
        prior_state: "pending",
        decomposition_status: "complete",
        steward_trigger: "subclaim_change",
        steward_context: "queued context",
      },
    ];
    const r = await processNextBudgetJobTask();
    expect(r).toMatchObject({ status: "processed", ok: true, claimId: "sub-1" });
    // A pending claim keeps its queued trigger; its queued context rides along.
    expect(runCalls).toEqual([{ claimId: "sub-1", trigger: "subclaim_change" }]);
    const checkpointWrite = state.jobUpdates.find((u) =>
      u.sql.includes("checkpoint")
    );
    expect(checkpointWrite).toBeDefined();
    expect(String(checkpointWrite!.params[1])).toContain('"assessed":1');
  });

  it("gives a deferred stub its first full pass", async () => {
    state.job = job();
    state.targets = [
      {
        id: "stub-1",
        prior_state: "deferred",
        decomposition_status: "pending",
        steward_trigger: null,
        steward_context: null,
      },
    ];
    await processNextBudgetJobTask();
    expect(runCalls).toEqual([
      { claimId: "stub-1", trigger: "structure_and_assess" },
    ]);
  });

  it("pauses at the budget floor with a progress checkpoint", async () => {
    state.job = job({ budget_micro_usd: 8_000_000 });
    state.spent = 8_000_001;
    state.targets = [
      {
        id: "sub-1",
        prior_state: "pending",
        decomposition_status: "complete",
        steward_trigger: null,
        steward_context: null,
      },
    ];
    const r = await processNextBudgetJobTask();
    expect(r.status).toBe("paused");
    expect(runCalls).toHaveLength(0);
    const pause = state.jobUpdates.find((u) =>
      u.sql.includes("'paused_budget'")
    );
    expect(pause).toBeDefined();
    expect(String(pause!.params[1])).toContain("Top up to continue");
  });

  it("completes and refunds the unspent budget when the subtree is exhausted", async () => {
    state.job = job();
    state.targets = [];
    const r = await processNextBudgetJobTask();
    expect(r.status).toBe("completed");
    expect(state.refunds).toHaveLength(1);
    expect(
      state.jobUpdates.some((u) => u.sql.includes("'completed'"))
    ).toBe(true);
  });

  it("skips a genuinely failing target and keeps the job running", async () => {
    state.job = job();
    state.targets = [
      {
        id: "poison-1",
        prior_state: "pending",
        decomposition_status: "complete",
        steward_trigger: null,
        steward_context: null,
      },
    ];
    state.throwFor = () => new Error("steward logic error");
    const r = await processNextBudgetJobTask();
    expect(r).toMatchObject({ status: "processed", ok: false });
    // No pause/complete settlement — the job just records the error and moves on.
    expect(state.jobUpdates.some((u) => u.sql.includes("'paused"))).toBe(false);
    expect(state.jobUpdates.some((u) => u.sql.includes("'completed'"))).toBe(
      false
    );
  });
});
