import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The formalize action on the engine executor (docs/mathematics.md §5.4,
 * §6.4): a direct Steward invocation on the strong tier under the action's
 * largest funder, a second fresh-context invocation with trigger
 * formalization_review only when the first left a reviewed statement, and
 * completion with the two passes' summed metered cost.
 */

const CLAIM_ID = "c1111111-1111-4111-8111-111111111111";
const REVIEWED_ID = "f1111111-1111-4111-8111-111111111111";

const { state } = vi.hoisted(() => ({
  state: {
    action: null as null | Record<string, unknown>,
    claimState: "active",
    reviewedAfterFirstPass: true,
    invocations: [] as Array<Record<string, unknown>>,
    passCost: [400_000, 900_000],
    failOn: null as null | number,
    completed: [] as Array<{ id: string; metered: number; meteredJobId: unknown }>,
    released: [] as string[],
    cancelled: [] as unknown[][],
    funder: { jobId: "job-1", grantId: "g-1" } as Record<string, unknown>,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("FROM claims WHERE id = $1")) {
      return [{ id: params[0], state: state.claimState }];
    }
    if (q.includes("SELECT funder_user_id FROM grants")) {
      return [{ funder_user_id: "u-funder" }];
    }
    if (q.includes("FROM claim_formalizations") && q.includes("status = 'reviewed'")) {
      return state.reviewedAfterFirstPass && state.invocations.length > 0
        ? [{ id: REVIEWED_ID }]
        : [];
    }
    if (q.includes("'cancelled'")) {
      state.cancelled.push(params);
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
  completeAction: vi.fn(async (id: string, metered: number, opts: { meteredJobId?: unknown } = {}) => {
    state.completed.push({ id, metered, meteredJobId: opts.meteredJobId });
    return metered;
  }),
  largestActionFunder: vi.fn(async () => state.funder),
}));

vi.mock("../../../src/services/allocation-service.js", () => ({
  fundGrantSelfActions: vi.fn(async () => 0),
}));

vi.mock("../../../src/workers/steward-direct.js", () => ({
  invokeStewardDirect: vi.fn(async (input: Record<string, unknown>) => {
    const n = state.invocations.length;
    state.invocations.push(input);
    if (state.failOn === n) throw new Error("the Steward run failed");
    return { model: "strong-model", billedMicroUsd: state.passCost[n] ?? 0 };
  }),
}));

vi.mock("../../../src/llm/agents/grantor.js", () => ({ runGrantor: vi.fn() }));
vi.mock("../../../src/llm/agents/mandate-review.js", () => ({ runMandateReview: vi.fn() }));
vi.mock("../../../src/services/source-service.js", () => ({ submitSource: vi.fn() }));
vi.mock("../../../src/llm/usage-context.js", () => ({
  runWithUsageContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  withCostMeter: async (fn: () => Promise<unknown>) => {
    await fn();
    return { billedMicroUsd: 0 };
  },
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ owlCostMicroUsd: 1_000_000 }),
}));

import { processNextEngineAction } from "../../../src/workers/engine-executor.js";

const formalizeAction = () => ({
  id: "act-f",
  kind: "formalize",
  exclusion_group: `formalize:${CLAIM_ID}`,
  variant: "standard",
  claim_id: CLAIM_ID,
  target_ref: null,
  cost_est_micro_usd: 2_000_000,
  coverage_micro_usd: 2_000_000,
  updated_at: new Date(),
});

beforeEach(() => {
  state.action = formalizeAction();
  state.claimState = "active";
  state.reviewedAfterFirstPass = true;
  state.invocations = [];
  state.passCost = [400_000, 900_000];
  state.failOn = null;
  state.completed = [];
  state.released = [];
  state.cancelled = [];
  state.funder = { jobId: "job-1", grantId: "g-1" };
});

describe("the formalize action", () => {
  it("runs the drafting pass, then the fresh-context review pass on the reviewed row, and completes with the summed cost", async () => {
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true, kind: "formalize", grantId: "g-1" });
    expect(state.invocations).toHaveLength(2);
    expect(state.invocations[0]).toMatchObject({
      trigger: "formalize",
      claimId: CLAIM_ID,
      jobId: "job-1",
      userId: "u-funder",
    });
    expect(state.invocations[1]).toMatchObject({
      trigger: "formalization_review",
      claimId: CLAIM_ID,
      context: REVIEWED_ID,
      jobId: "job-1",
      userId: "u-funder",
    });
    expect(state.completed).toEqual([
      { id: "act-f", metered: 1_300_000, meteredJobId: "job-1" },
    ]);
  });

  it("skips the review pass when the first pass left no reviewed statement", async () => {
    state.reviewedAfterFirstPass = false;
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true });
    expect(state.invocations.map((i) => i.trigger)).toEqual(["formalize"]);
    expect(state.completed).toEqual([{ id: "act-f", metered: 400_000, meteredJobId: "job-1" }]);
  });

  it("attributes the passes to a person when a reader funded the action", async () => {
    state.funder = { userId: "u-reader" };
    await processNextEngineAction();
    expect(state.invocations[0]).toMatchObject({ userId: "u-reader" });
    expect(state.invocations[0]).not.toHaveProperty("jobId");
    expect(state.completed[0]!.meteredJobId).toBeNull();
  });

  it("cancels the group when the claim is no longer active", async () => {
    state.claimState = "merged";
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.invocations).toHaveLength(0);
    expect(state.cancelled).toEqual([[`formalize:${CLAIM_ID}`]]);
  });

  it("completes with the spend so far when the second pass fails outright", async () => {
    state.failOn = 1;
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: false, kind: "formalize" });
    expect(r.error).toMatch(/Steward run failed/);
    expect(state.completed).toEqual([{ id: "act-f", metered: 400_000, meteredJobId: "job-1" }]);
    expect(state.released).toEqual([]);
  });
});
