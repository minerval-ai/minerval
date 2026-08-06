import { describe, it, expect, beforeEach, vi } from "vitest";

// The engine executor's control flow: it self-funds then runs whatever
// covered grant_planning / mandate_review / ingest action the ledger
// resolves, completes agent runs with metered cost, leaves ingest actions
// running for the extraction worker to complete, and honors the review
// agent's continue_review by reopening its action. Services mocked.

const { state } = vi.hoisted(() => ({
  state: {
    action: null as null | Record<string, unknown>,
    grant: null as null | Record<string, unknown>,
    grantorRuns: 0,
    reviewRuns: 0,
    reviewResult: {
      note: "",
      valuationsWritten: 0,
      planItemsAdded: 0,
      continueRequested: false,
    },
    submitted: [] as string[],
    completed: [] as Array<{ id: string; metered: number }>,
    released: [] as string[],
    reopened: [] as unknown[][],
    cancelled: [] as unknown[][],
    grantSources: [] as unknown[][],
    fundCalls: 0,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("FROM grants g JOIN budget_jobs")) {
      return state.grant ? [state.grant] : [];
    }
    if (q.includes("FROM grants WHERE id = $1")) {
      return state.grant ? [state.grant] : [];
    }
    if (q.includes("UPDATE actions SET status = 'open'")) {
      state.reopened.push(params);
      return [];
    }
    if (q.includes("'cancelled'")) {
      state.cancelled.push(params);
      return [];
    }
    if (q.includes("INSERT INTO grant_sources")) {
      state.grantSources.push(params);
      return [];
    }
    return [];
  }),
}));

vi.mock("../../../src/services/action-service.js", () => ({
  nextRunnableAction: vi.fn(async () => state.action),
  claimAction: vi.fn(async () => true),
  releaseAction: vi.fn(async (id: string) => {
    state.released.push(id);
  }),
  completeAction: vi.fn(async (id: string, metered: number) => {
    state.completed.push({ id, metered });
    return metered;
  }),
  largestActionFunder: vi.fn(async () => ({
    jobId: "job-1",
    grantId: "g-1",
  })),
}));

vi.mock("../../../src/services/allocation-service.js", () => ({
  fundGrantSelfActions: vi.fn(async () => {
    state.fundCalls++;
    return 0;
  }),
}));

vi.mock("../../../src/llm/agents/grantor.js", () => ({
  runGrantor: vi.fn(async () => {
    state.grantorRuns++;
    return { strategy: "s", items: [] };
  }),
}));

vi.mock("../../../src/llm/agents/mandate-review.js", () => ({
  runMandateReview: vi.fn(async () => {
    state.reviewRuns++;
    return state.reviewResult;
  }),
}));

vi.mock("../../../src/services/source-service.js", () => ({
  submitSource: vi.fn(async (input: { url: string }) => {
    state.submitted.push(input.url);
    return { sourceId: "s-1", jobId: "j-1" };
  }),
}));

vi.mock("../../../src/llm/usage-context.js", () => ({
  runWithUsageContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  withCostMeter: async (fn: () => Promise<unknown>) => {
    await fn();
    return { billedMicroUsd: 123_000 };
  },
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ owlCostMicroUsd: 1_000_000 }),
}));

import { processNextEngineAction } from "../../../src/workers/engine-executor.js";

const action = (over: Record<string, unknown>) => ({
  id: "act-1",
  kind: "grant_planning",
  exclusion_group: "plan:g-1",
  variant: "standard",
  claim_id: null,
  target_ref: "g-1",
  cost_est_micro_usd: 1_000_000,
  coverage_micro_usd: 1_000_000,
  ...over,
});

beforeEach(() => {
  state.action = null;
  state.grant = {
    id: "g-1",
    funder_user_id: "u-1",
    budget_job_id: "job-1",
    name: "Physics",
    scope_claim_id: null,
    scope_query: null,
    status: "planning",
    budget_micro_usd: 50_000_000,
  };
  state.grantorRuns = 0;
  state.reviewRuns = 0;
  state.reviewResult = {
    note: "",
    valuationsWritten: 0,
    planItemsAdded: 0,
    continueRequested: false,
  };
  state.submitted = [];
  state.completed = [];
  state.released = [];
  state.reopened = [];
  state.cancelled = [];
  state.grantSources = [];
  state.fundCalls = 0;
});

describe("processNextEngineAction", () => {
  it("self-funds, then reports empty with nothing covered", async () => {
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.fundCalls).toBe(1);
  });

  it("runs a covered planning action and completes it with metered cost", async () => {
    state.action = action({});
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true, kind: "grant_planning" });
    expect(state.grantorRuns).toBe(1);
    expect(state.completed).toEqual([{ id: "act-1", metered: 123_000 }]);
  });

  it("runs a mandate review; continue_review reopens the action", async () => {
    state.grant!.status = "active";
    state.action = action({ kind: "mandate_review", exclusion_group: "review:g-1" });
    state.reviewResult.continueRequested = true;
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true });
    expect(state.reviewRuns).toBe(1);
    expect(state.completed).toHaveLength(1);
    expect(state.reopened).toHaveLength(1); // another pass runs next drain
  });

  it("enqueues an ingest and leaves the action running for the meter", async () => {
    state.grant!.status = "active";
    state.action = action({
      kind: "ingest",
      exclusion_group: "ingest:https://example.org/p",
      target_ref: "https://example.org/p",
    });
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true, kind: "ingest" });
    expect(state.submitted).toEqual(["https://example.org/p"]);
    // NOT completed here: the extraction worker closes it with real cost.
    expect(state.completed).toHaveLength(0);
    // The funding mandate records the source in its pipeline.
    expect(state.grantSources).toHaveLength(1);
  });

  it("cancels the group when the grant's status no longer matches", async () => {
    state.grant!.status = "active"; // planning action but grant already active
    state.action = action({});
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.cancelled).toHaveLength(1);
  });
});
