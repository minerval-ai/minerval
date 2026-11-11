import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A request on the engine executor (Part VIII). A run taking up a request
 * on one node runs with that node, so it records provenance on it, and one
 * on several is told which nodes it may record on (#728); every run opens
 * with the latest earlier run's notebook and report (#730); a scoping run
 * is told the tier the full work runs on, and the plan it prices is
 * recorded with its quote (#732); the work that comes back reaches the
 * request's keeper with the run that holds the full report (#718); and a
 * request bearing on one document alone is a review of it, its full work
 * examining the document and its scoping told what it prices (#865).
 */

const REQUEST = "d3333333-3333-4333-8333-333333333333";
const NODE = "c1111111-1111-4111-8111-111111111111";
const NODE2 = "c2222222-2222-4222-8222-222222222222";
const SOURCE = "e4444444-4444-4444-8444-444444444444";

const { state } = vi.hoisted(() => ({
  state: {
    covered: null as null | Record<string, unknown>,
    request: null as null | Record<string, unknown>,
    nodes: [] as Array<Record<string, unknown>>,
    prior: null as null | Record<string, unknown>,
    report: null as null | Record<string, unknown>,
    opened: [] as Array<Record<string, unknown>>,
    researcherInputs: [] as Array<Record<string, unknown>>,
    work: [] as Array<Record<string, unknown>>,
    notified: [] as unknown[][],
    budgets: [] as unknown[],
    reviews: [] as Array<Record<string, unknown>>,
    linked: [] as unknown[][],
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string) => {
    if (q.includes("SELECT id, text, domains, kind FROM claims")) return state.nodes;
    if (q.includes("length(raw_content)")) return [{ chars: 41000, segments: "17" }];
    return [];
  }),
}));
vi.mock("../../../src/services/action-service.js", () => ({
  actionBudgetMicroUsd: (a: { cost_est_micro_usd: number }) => Number(a.cost_est_micro_usd),
  nextRunnableAction: vi.fn(async () => state.covered),
  claimAction: vi.fn(async () => true),
  releaseAction: vi.fn(async () => {}),
  completeAction: vi.fn(async () => 0),
  largestActionFunder: vi.fn(async () => ({ jobId: "job-1" })),
  ensureCurateAction: vi.fn(),
  closeRequestActions: vi.fn(async () => {}),
  ensureRequestActions: vi.fn(async () => null),
}));
vi.mock("../../../src/services/request-service.js", () => ({
  getRequest: vi.fn(async () => state.request),
  notifyRequestKeeper: vi.fn(async (...args: unknown[]) => {
    state.notified.push(args);
    return true;
  }),
  recordWork: vi.fn(async (w: Record<string, unknown>) => {
    state.work.push(w);
    return { id: "w" };
  }),
  requestBrief: () => "the request as filed",
  documentUnderReview: (r: { bears_on: unknown[]; bears_on_sources: Array<Record<string, unknown>> }) =>
    r.bears_on.length === 0 && r.bears_on_sources.length === 1 ? r.bears_on_sources[0] : null,
  setRequestBudget: vi.fn(async (b: unknown) => {
    state.budgets.push(b);
  }),
}));
vi.mock("../../../src/services/research-run-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/services/research-run-service.js")>();
  return {
    ...original,
    readResearcherPaused: vi.fn(async () => false),
    modelForTier: (tier: string) => `model-${tier}`,
    latestRequestRun: vi.fn(async () => state.prior),
    openResearchRun: vi.fn(async (input: Record<string, unknown>) => {
      state.opened.push(input);
      return {
        id: "run-new",
        claim_id: input.claimId,
        grant_id: null,
        requested_by: input.requestedBy,
        task: input.task,
        model: input.model,
        model_tier: input.modelTier,
        effort: input.effort,
        include_constitution: true,
        ceiling_micro_usd: input.ceilingMicroUsd,
        notebook: input.notebook ?? {},
        job_id: "job-1",
      };
    }),
    closeResearchRun: vi.fn(async () => null),
  };
});
vi.mock("../../../src/services/examination-service.js", () => ({
  examinationForRequest: vi.fn(async (input: Record<string, unknown>) => {
    state.reviews.push(input);
    return {
      id: "exam-review", scope: "document", trigger: "request", claim_id: null, grant_id: null,
      source_id: input.sourceId, source_title: "The report", source_url: "https://x.org/r",
      brief: input.brief, facets: [], requested_by: "request", request_id: input.requestId, created_at: "2026-01-01T00:00:00Z",
    };
  }),
  getExaminationRow: vi.fn(async () => null),
  linkResearchRun: vi.fn(async (...args: unknown[]) => {
    state.linked.push(args);
  }),
}));
vi.mock("../../../src/llm/agents/researcher.js", () => ({
  runResearcher: vi.fn(async (input: Record<string, unknown>) => {
    state.researcherInputs.push(input);
    return { status: "completed", report: state.report, turns: 3, stopReason: "final_tool", servedModels: [], toolNames: [], error: null };
  }),
}));
vi.mock("../../../src/services/allocation-service.js", () => ({ fundGrantSelfActions: vi.fn(async () => 0) }));
vi.mock("../../../src/services/mandate-event-service.js", () => ({ mandateEventsTick: vi.fn(async () => ({})) }));
vi.mock("../../../src/llm/agents/grantor.js", () => ({ runGrantor: vi.fn() }));
vi.mock("../../../src/llm/agents/mandate-review.js", () => ({ runMandateReview: vi.fn() }));
vi.mock("../../../src/llm/agents/curator.js", () => ({ runCurator: vi.fn() }));
vi.mock("../../../src/llm/agents/audit-agent.js", () => ({ runAudit: vi.fn() }));
vi.mock("../../../src/services/source-service.js", () => ({ submitSource: vi.fn() }));
vi.mock("../../../src/workers/steward-direct.js", () => ({ invokeStewardDirect: vi.fn() }));
vi.mock("../../../src/llm/usage-context.js", () => ({
  // The executor opens each row's handler at the row's label; here it only passes through.
  runAtLabel: (_label: unknown, _work: string, fn: () => unknown) => fn(),
  runWithUsageContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  withPassBudget: async (_b: unknown, fn: () => Promise<unknown>) => ({ value: await fn(), billedMicroUsd: 500_000 }),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ researcherEnabled: true, backgroundFallbackLaneEnabled: false, owlCostMicroUsd: 1_000_000 }),
}));

import { processNextEngineAction } from "../../../src/workers/engine-executor.js";

const action = (variant: "scope" | "full") => ({
  id: "act-r",
  kind: "request",
  exclusion_group: `request:${REQUEST}`,
  variant,
  claim_id: null,
  target_ref: REQUEST,
  cost_est_micro_usd: 4_000_000,
  coverage_micro_usd: 4_000_000,
  sensitivity_label: "public",
  updated_at: new Date(),
});

const request = (bears: string[], sources: string[] = []) => ({
  id: REQUEST,
  ask: "Find the origin of the figure",
  state: "in_progress",
  bears_on: bears.map((id) => ({ id, text: "a node", kind: "claim" })),
  bears_on_sources: sources.map((id) => ({ id, title: "The report", url: "https://x.org/r" })),
  work: [],
});

const node = (id: string, kind = "claim") => ({ id, text: `node ${id.slice(0, 2)}`, domains: ["mathematics"], kind });

beforeEach(() => {
  state.covered = null;
  state.request = null;
  state.nodes = [];
  state.prior = null;
  state.report = null;
  state.opened = [];
  state.researcherInputs = [];
  state.work = [];
  state.notified = [];
  state.budgets = [];
  state.reviews = [];
  state.linked = [];
});

describe("a run taking up a request", () => {
  it("runs with the one node it bears on, on the strong tier, and tells the keeper where the report is", async () => {
    state.covered = action("full");
    state.request = request([NODE]);
    state.nodes = [node(NODE, "question")];
    state.report = { answer: "Traced to a 2019 survey.", request_outcome: "met" };
    await processNextEngineAction();
    expect(state.opened[0]).toMatchObject({ claimId: NODE, requestedBy: "request", modelTier: "strong", effort: "high", model: "model-strong" });
    const input = state.researcherInputs[0]!;
    expect(input.claim).toEqual({ id: NODE, text: "node c1", domains: ["mathematics"], kind: "question" });
    expect(input.requestNodes).toEqual([]);
    expect(state.notified).toHaveLength(1);
    expect(state.notified[0]![1]).toContain("Traced to a 2019 survey.");
    expect(state.notified[0]![2]).toEqual({ researchRunId: "run-new" });
  });

  it("names every node a request on several bears on, with no single claim", async () => {
    state.covered = action("full");
    state.request = request([NODE, NODE2]);
    state.nodes = [node(NODE), node(NODE2)];
    state.report = { answer: "x", request_outcome: "negative" };
    await processNextEngineAction();
    expect(state.opened[0]!.claimId).toBeNull();
    const input = state.researcherInputs[0]!;
    expect(input.claim).toBeNull();
    expect((input.requestNodes as Array<{ id: string }>).map((n) => n.id)).toEqual([NODE, NODE2]);
  });

  it("opens with the latest earlier run's notebook and report", async () => {
    state.covered = action("full");
    state.request = request([]);
    state.prior = {
      id: "abcdef12-0000-4000-8000-000000000001",
      requested_by: "request",
      status: "budget",
      notebook: { thread: "half way" },
      report: { answer: "partial" },
    };
    state.report = { answer: "x", request_outcome: "partly_met" };
    await processNextEngineAction();
    expect(state.opened[0]!.notebook).toEqual({
      "from run abcdef12: thread": "half way",
      "from run abcdef12: its report": JSON.stringify({ answer: "partial" }, null, 2),
    });
    expect(state.researcherInputs[0]!.priorRun).toEqual({
      id: "abcdef12-0000-4000-8000-000000000001",
      status: "budget",
      requestedBy: "request",
    });
  });
});

describe("a scoping run", () => {
  it("is told the tier the full work runs on, records nothing on a node, and records the plan with the quote", async () => {
    state.covered = action("scope");
    state.request = request([NODE]);
    state.nodes = [node(NODE)];
    state.report = {
      answer: "Doable from public sources.",
      plan: "1. Search the registry. 2. Read the three surveys whole.",
      request_outcome: "scoped",
      budget_quote_usd: 12,
    };
    await processNextEngineAction();
    expect(state.opened[0]).toMatchObject({ claimId: null, requestedBy: "request_scope", modelTier: "standard" });
    const input = state.researcherInputs[0]!;
    expect(input.claim).toBeNull();
    expect(input.fullWork).toEqual({ tier: "strong", model: "model-strong", effort: "high" });
    const scoped = state.work.find((w) => String(w.summary).startsWith("Scoped at about $12.00"))!;
    expect(scoped.summary).toContain("Plan: 1. Search the registry. 2. Read the three surveys whole.");
    expect(state.budgets).toEqual([{ requestId: REQUEST, budgetUsd: 12 }]);
  });
});

describe("a request bearing on one document alone (#865)", () => {
  it("takes it up as a review of the document, linked to the run", async () => {
    state.covered = action("full");
    state.request = request([], [SOURCE]);
    state.report = { answer: "Reviewed the methods and the survey.", request_outcome: "partly_met" };
    await processNextEngineAction();
    expect(state.reviews).toEqual([{ requestId: REQUEST, sourceId: SOURCE, brief: "the request as filed" }]);
    expect(state.linked).toEqual([["exam-review", "run-new"]]);
    const input = state.researcherInputs[0]!;
    expect(input.claim).toBeNull();
    expect(input.examination).toMatchObject({ id: "exam-review", source_id: SOURCE, scope: "document", facets: [] });
  });

  it("examines nothing when the request also bears on a node, or on several documents", async () => {
    state.covered = action("full");
    state.request = request([NODE], [SOURCE]);
    state.nodes = [node(NODE)];
    state.report = { answer: "x", request_outcome: "met" };
    await processNextEngineAction();
    state.covered = action("full");
    state.request = request([], [SOURCE, "e5555555-5555-4555-8555-555555555555"]);
    await processNextEngineAction();
    expect(state.reviews).toEqual([]);
    expect(state.researcherInputs.every((i) => i.examination === null)).toBe(true);
  });

  it("scopes it without examining, told what the full review would read", async () => {
    state.covered = action("scope");
    state.request = request([], [SOURCE]);
    state.report = { answer: "Readable.", plan: "Read it.", request_outcome: "scoped", budget_quote_usd: 6.4 };
    await processNextEngineAction();
    expect(state.reviews).toEqual([]);
    const input = state.researcherInputs[0]!;
    expect(input.examination).toBeNull();
    expect(input.documentReview).toEqual({ title: "The report", url: "https://x.org/r", chars: 41000, segments: 17 });
  });
});
