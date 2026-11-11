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
    submittedScopes: [] as unknown[],
    completed: [] as Array<{ id: string; metered: number }>,
    released: [] as string[],
    reopened: [] as unknown[][],
    cancelled: [] as unknown[][],
    grantSources: [] as unknown[][],
    livePlans: [] as string[],
    fundCalls: 0,
    lookout: null as null | Record<string, unknown>,
    lookoutRuns: 0,
    lookoutFail: null as null | Error,
    lookoutStamps: [] as Array<Record<string, unknown>>,
    // The label each handler was opened at, and the label in force when a
    // row was claimed, a document submitted, or an agent run.
    openedAt: [] as unknown[],
    labelsInside: [] as Array<{ at: string; label: string }>,
  },
}));

/** Record the label in force, read from the real context the executor set. */
async function noteLabel(at: string): Promise<void> {
  const real = await vi.importActual<typeof import("../../../src/llm/usage-context.js")>(
    "../../../src/llm/usage-context.js"
  );
  state.labelsInside.push({ at, label: real.currentLabel() });
}

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("FROM grants g JOIN budget_jobs")) {
      return state.grant ? [state.grant] : [];
    }
    if (q.includes("FROM lookouts l JOIN grants g")) {
      return state.lookout ? [state.lookout] : [];
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
    if (q.includes("FROM ingest_focuses")) {
      return [{ focus: "the author's claims about housing policy" }];
    }
    if (q.includes("INSERT INTO grant_sources")) {
      state.grantSources.push(params);
      return [];
    }
    return [];
  }),
}));

vi.mock("../../../src/services/action-service.js", () => ({
  actionBudgetMicroUsd: (a: { cost_est_micro_usd: number | string; coverage_micro_usd: number | string }) =>
    Math.max(Number(a.cost_est_micro_usd) || 0, Number(a.coverage_micro_usd) || 0),
  nextRunnableAction: vi.fn(async () => state.action),
  // No mandate here has a Grantmaker share (a decomposition's tenth).
  grantmakerShareLeftMicroUsd: vi.fn(async () => null),
  // The mandate's own figure for a review pass (#820).
  reviewPassBudgetMicroUsd: vi.fn(async () => 7_000_000),
  // A plan that went live with its planning run places its standing orders at once (#849).
  materializeLivePlan: vi.fn(async (grantId: string) => {
    state.livePlans.push(grantId);
  }),
  claimAction: vi.fn(async () => {
    await noteLabel("claim");
    return true;
  }),
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
  // A co-funding mandate beside the largest.
  actionFunderGrants: vi.fn(async () => ["g-1", "g-2"]),
  recordGrantSource: vi.fn(async (...params: unknown[]) => {
    state.grantSources.push(params);
  }),
}));

vi.mock("../../../src/services/allocation-service.js", () => ({
  fundGrantSelfActions: vi.fn(async () => {
    state.fundCalls++;
    return 0;
  }),
}));

vi.mock("../../../src/llm/agents/grantor.js", () => ({
  runGrantor: vi.fn(async () => {
    await noteLabel("grantor");
    state.grantorRuns++;
    return { strategy: "s", items: [] };
  }),
}));

vi.mock("../../../src/llm/agents/mandate-review.js", () => ({
  runMandateReview: vi.fn(async () => {
    await noteLabel("mandate_review");
    state.reviewRuns++;
    return state.reviewResult;
  }),
}));

vi.mock("../../../src/llm/agents/lookout.js", () => ({
  runLookout: vi.fn(async () => {
    await noteLabel("lookout");
    state.lookoutRuns++;
    if (state.lookoutFail) throw state.lookoutFail;
    return { note: "nothing to report", flagsRaised: 2, ingestsProposed: 0, notesLeft: 0, eventsConsumed: 1 };
  }),
}));

vi.mock("../../../src/services/lookout-service.js", () => ({
  recordLookoutRun: vi.fn(async (input: Record<string, unknown>) => {
    state.lookoutStamps.push(input);
  }),
}));

vi.mock("../../../src/services/source-service.js", () => ({
  submitSource: vi.fn(async (input: { url: string }, _attribution: unknown, scope: unknown) => {
    await noteLabel("submit");
    state.submitted.push(input.url);
    state.submittedScopes.push(scope);
    return { sourceId: "s-1", jobId: "j-1" };
  }),
}));

vi.mock("../../../src/llm/usage-context.js", async (importOriginal) => ({
  // The executor opens each row's handler at the row's label. This is the
  // real one, so a row without a label is refused as it is in production.
  runAtLabel: async (label: string | undefined, work: string, fn: () => unknown) => {
    state.openedAt.push(label);
    const real = await importOriginal<typeof import("../../../src/llm/usage-context.js")>();
    return real.runAtLabel(label, work, fn);
  },
  runBudget: () => null,
  budgetRefusal: () => null,
  runWithUsageContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  withCostMeter: async (fn: () => Promise<unknown>) => {
    await fn();
    return { billedMicroUsd: 123_000 };
  },
  withPassBudget: async (_budget: unknown, fn: () => Promise<unknown>) => {
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
  sensitivity_label: "public",
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
  state.submittedScopes = [];
  state.completed = [];
  state.released = [];
  state.reopened = [];
  state.cancelled = [];
  state.grantSources = [];
  state.livePlans = [];
  state.fundCalls = 0;
  state.lookout = {
    id: "l-1",
    status: "active",
    grant_id: "g-1",
    grant_status: "active",
    funder_user_id: "u-1",
    budget_job_id: "job-1",
  };
  state.lookoutRuns = 0;
  state.lookoutFail = null;
  state.lookoutStamps = [];
  state.openedAt = [];
  state.labelsInside = [];
});

// A run works at the label of the work that started it (src/labels.ts). The
// executor has one place where a row becomes a run, whatever its kind.
describe("the label a ledger row is run at", () => {
  it("is the row's, for the claim and for everything its handler does, whatever the kind", async () => {
    for (const over of [
      { kind: "grant_planning" },
      { kind: "mandate_review", exclusion_group: "review:g-1" },
      { kind: "ingest", exclusion_group: "ingest:https://example.org/p", target_ref: "https://example.org/p" },
      { kind: "lookout_run", exclusion_group: "lookout:l-1", target_ref: "l-1" },
    ]) {
      state.openedAt = [];
      state.labelsInside = [];
      state.grant = { ...state.grant, status: over.kind === "grant_planning" ? "planning" : "active" };
      state.action = action({ ...over, sensitivity_label: "internal" });
      await processNextEngineAction();
      expect(state.openedAt, over.kind).toEqual(["internal"]);
      expect(state.labelsInside.length, over.kind).toBeGreaterThan(1);
      expect(new Set(state.labelsInside.map((l) => l.label)), over.kind).toEqual(new Set(["internal"]));
    }
  });

  it("is never assumed: a row read without its label is not claimed and nothing runs", async () => {
    const { MissingLabelError } = await import("../../../src/labels.js");
    state.action = action({ sensitivity_label: undefined });
    await expect(processNextEngineAction()).rejects.toBeInstanceOf(MissingLabelError);
    expect(state.labelsInside).toEqual([]);
    expect(state.grantorRuns).toBe(0);
    expect(state.completed).toEqual([]);
  });
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
    expect(state.livePlans).toEqual(["g-1"]);
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
    // Reopened at the mandate's pass budget, not at whatever the row held.
    expect(state.reopened[0]).toEqual(["act-1", 7_000_000]);
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
    // Every funding mandate records the source in its pipeline (#657).
    expect(state.grantSources.map((p) => p[0])).toEqual(["g-1", "g-2"]);
  });

  it("hands a scoped ingest's focus and group to the extraction", async () => {
    state.grant!.status = "active";
    const group = "ingest:https://example.org/p#focus:0123456789abcdef";
    state.action = action({ kind: "ingest", exclusion_group: group, target_ref: "https://example.org/p" });
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true, kind: "ingest" });
    expect(state.submittedScopes.at(-1)).toMatchObject({
      focus: "the author's claims about housing policy",
      ingestGroup: group,
    });
  });

  it("runs a covered lookout, stamps the run on the lookout, and completes with metered cost", async () => {
    state.action = action({ kind: "lookout_run", exclusion_group: "lookout:l-1", target_ref: "l-1" });
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true, kind: "lookout_run", grantId: "g-1" });
    expect(state.lookoutRuns).toBe(1);
    expect(state.lookoutStamps).toEqual([{ lookoutId: "l-1", note: "nothing to report", flagsRaised: 2 }]);
    expect(state.completed).toEqual([{ id: "act-1", metered: 123_000 }]);
  });

  it("a failed lookout run backs the lookout off and retires the group instead of spinning", async () => {
    state.action = action({ kind: "lookout_run", exclusion_group: "lookout:l-1", target_ref: "l-1" });
    state.lookoutFail = new Error("model returned garbage");
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: false, kind: "lookout_run" });
    expect(state.lookoutStamps[0]).toMatchObject({ lookoutId: "l-1", failed: true, flagsRaised: 0 });
    expect(state.cancelled).toHaveLength(1);
    expect(state.completed).toHaveLength(0);
  });

  it("cancels a lookout run whose lookout is paused or whose mandate is not active", async () => {
    state.action = action({ kind: "lookout_run", exclusion_group: "lookout:l-1", target_ref: "l-1" });
    state.lookout!.status = "paused";
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.cancelled).toHaveLength(1);
    expect(state.lookoutRuns).toBe(0);
  });

  it("cancels the group when the grant's status no longer matches", async () => {
    state.grant!.status = "active"; // planning action but grant already active
    state.action = action({});
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.cancelled).toHaveLength(1);
  });
});
